import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId, ProtoEvent } from "@truss/proto";
import { store } from "./db.js";

/**
 * DSH session import — ports persisted dsh sessions (jsonl.zstd logs under
 * /opt/dsh/sessions) into Truss: real session rows (harness "dsh", resumable
 * via ACP since harness_ref = the dsh session id) + their transcripts as
 * proto events (messages, thinking, tool rows, per-step llm.call rows with
 * real token usage).
 *
 * Idempotent: a dsh session id already known as a harness_ref is skipped.
 */

const DSH_SESSIONS = process.env.DSH_SESSIONS_DIR ?? "/opt/dsh/sessions";

interface DshRec {
  type: string;
  seq?: number;
  time?: number;
  data?: any;
  id?: string;
  createdAt?: number;
  cwd?: string;
}

interface ImportResult {
  imported: number;
  skipped: number;
  failed: { dir: string; error: string }[];
  sessions: { id: string; dshId: string; title: string; cwd: string }[];
}

function* walkSessionFiles(root: string): Generator<{ file: string; dshId: string }> {
  if (!existsSync(root)) return;
  for (const projectDir of readdirSync(root)) {
    const pdir = join(root, projectDir);
    try {
      if (!statSync(pdir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const sessDir of readdirSync(pdir)) {
      const sdir = join(pdir, sessDir);
      try {
        if (!statSync(sdir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of readdirSync(sdir)) {
        if (f === "session.jsonl.zstd" || f === "session.v3.jsonl.zstd") {
          /* the dir name IS the dsh session id — "session-<uuid>" for dsh's
             own sessions, a bare uuid for ACP-created ones. The prefix is
             load-bearing: persistence.stat() matches it exactly. */
          yield { file: join(sdir, f), dshId: sessDir };
          break;
        }
      }
    }
  }
}

function readLog(file: string): DshRec[] {
  const out = execFileSync("zstd", ["-dc", file], { maxBuffer: 256 * 1024 * 1024 });
  const lines = out.toString("utf8").split("\n");
  const recs: DshRec[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      /* partial tail line after a crash — skip */
    }
  }
  return recs;
}

function textOfContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** map one dsh log to proto events (import-prefixed ids, original timestamps) */
function mapLog(recs: DshRec[], sessionId: string): { events: ProtoEvent[]; title: string; cwd: string; createdAt: number } {
  const events: ProtoEvent[] = [];
  let title = "";
  let firstUserText = "";
  let cwd = "";
  let createdAt = Date.now();
  let msgN = 0;
  let callN = 0;
  let openMsg: string | null = null;
  let openCall: string | null = null;
  let openCallAt = 0;
  let pendingUsage: { inputTokens?: number; outputTokens?: number } | null = null;

  const closeMsg = (at: number) => {
    if (openMsg) {
      events.push({ type: "msg.done", sessionId, messageId: openMsg });
      openMsg = null;
    }
  };

  for (const rec of recs) {
    const t = rec.time ?? rec.createdAt ?? createdAt;
    switch (rec.type) {
      case "session": {
        createdAt = rec.createdAt ?? createdAt;
        cwd = rec.cwd ?? "";
        break;
      }
      case "session/title": {
        if (rec.data?.title && typeof rec.data.title === "string") title = rec.data.title;
        break;
      }
      case "user/message":
      case "agent/inbox/spliced": {
        closeMsg(t);
        const content = rec.type === "user/message" ? rec.data?.content : rec.data?.inserted?.[0]?.content;
        const text = textOfContent(content);
        if (!text.trim()) break;
        if (!firstUserText) firstUserText = text;
        const id = `imp-u-${msgN++}`;
        events.push({ type: "msg.start", sessionId, messageId: id, role: "user", at: t });
        events.push({ type: "msg.chunk", sessionId, messageId: id, text });
        events.push({ type: "msg.done", sessionId, messageId: id });
        break;
      }
      case "assistant/message": {
        closeMsg(t);
        const content = rec.data?.message?.content;
        const id = `imp-a-${msgN++}`;
        events.push({ type: "msg.start", sessionId, messageId: id, role: "assistant", at: t });
        openMsg = id;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string" && block.text) {
              events.push({ type: "msg.chunk", sessionId, messageId: id, text: block.text, channel: "text" });
            } else if (block?.type === "reasoning" && typeof block.text === "string" && block.text) {
              events.push({ type: "msg.chunk", sessionId, messageId: id, text: block.text, channel: "thinking" });
            }
          }
        }
        if (rec.data?.usage) pendingUsage = rec.data.usage;
        closeMsg(t);
        break;
      }
      case "step/start": {
        if (openCall) {
          events.push({
            type: "llm.call.done", sessionId, callId: openCall, status: 200,
            latencyMs: Math.max(0, t - openCallAt),
            tokensIn: pendingUsage?.inputTokens, tokensOut: pendingUsage?.outputTokens,
          });
          pendingUsage = null;
        }
        openCall = `imp-call-${callN++}`;
        openCallAt = t;
        events.push({ type: "llm.call.start", sessionId, callId: openCall, model: "deepseek", at: t });
        break;
      }
      case "step/end": {
        if (openCall) {
          events.push({
            type: "llm.call.done", sessionId, callId: openCall, status: 200,
            latencyMs: Math.max(0, t - openCallAt),
            tokensIn: pendingUsage?.inputTokens, tokensOut: pendingUsage?.outputTokens,
          });
          pendingUsage = null;
          openCall = null;
        }
        break;
      }
      case "tool/call": {
        const d = rec.data ?? {};
        if (!d.callId) break;
        events.push({
          type: "tool.call", sessionId, toolCallId: String(d.callId),
          name: d.name ?? "tool", args: d.arguments, callId: openCall ?? undefined,
        });
        break;
      }
      case "tool/result": {
        const content = rec.data?.message?.content;
        const link = Array.isArray(content) ? content.find((c: any) => c?.type === "tool-result") : null;
        if (!link?.toolCallId) break;
        events.push({
          type: "tool.done", sessionId, toolCallId: String(link.toolCallId),
          ok: !link.isError, output: textOfContent(link.content ?? content) || undefined,
        });
        break;
      }
      default:
        break;
    }
  }
  closeMsg(recs[recs.length - 1]?.time ?? createdAt);
  if (openCall) {
    events.push({
      type: "llm.call.done", sessionId, callId: openCall, status: 200,
      latencyMs: 0, tokensIn: pendingUsage?.inputTokens, tokensOut: pendingUsage?.outputTokens,
    });
  }
  if (!title && firstUserText) {
    title = firstUserText.replace(/\s+/g, " ").trim().slice(0, 48);
  }
  return { events, title, cwd, createdAt };
}

export function importDshSessions(): ImportResult {
  /* trashed rows keep their ref: deduping against listSessions() alone would
     let a re-import resurrect a chat the user deleted (issue #5) */
  const known = new Set(store.knownHarnessRefs());
  const result: ImportResult = { imported: 0, skipped: 0, failed: [], sessions: [] };

  for (const { file, dshId } of walkSessionFiles(DSH_SESSIONS)) {
    if (known.has(dshId)) {
      result.skipped++;
      continue;
    }
    try {
      const recs = readLog(file);
      if (!recs.length || recs[0].type !== "session") {
        result.failed.push({ dir: dshId, error: "no session header" });
        continue;
      }
      /* events must carry the row id — the events table FK-references it.
         row id from the uuid part; harness_ref keeps the full dsh id
         (including the "session-" prefix dsh persistence matches on) */
      const id = `dsh-${dshId.replace(/^session-/, "").slice(0, 8)}`;
      const { events, title, cwd, createdAt } = mapLog(recs, id);
      if (store.getSession(id)) {
        result.skipped++;
        continue;
      }
      const lastAt = recs[recs.length - 1]?.time ?? recs[recs.length - 1]?.createdAt ?? Date.now();
      store.createSessionRaw({
        id,
        harness: "dsh" as HarnessId,
        title: title || "dsh session",
        cwd: cwd || "/home/ubuntu",
        project: "imported:dsh",
        state: "closed",
        created_at: createdAt,
        updated_at: lastAt,
      });
      store.setHarnessRef(id, dshId);
      for (const ev of events) store.appendEvent(ev);

      result.imported++;
      result.sessions.push({ id, dshId, title: title || "dsh session", cwd });
    } catch (err) {
      result.failed.push({ dir: dshId, error: String(err) });
    }
  }
  return result;
}
