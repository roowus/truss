#!/usr/bin/env tsx
/**
 * truss-node-agent — run harness adapters on this host, tunnel them to a
 * Truss server over one outbound WebSocket.
 *
 *   truss-node-agent --server ws://truss.host:4040 --token <shared>
 *
 * The agent dials OUT (NAT/tailnet-friendly): the server never needs inbound
 * reachability to the host. Adapters run exactly as they would on the server
 * (same code, imported from the monorepo) — pi RPC mode, claude stream-json.
 *
 * Tunnel protocol (JSON lines over WS):
 *   agent→server  {type:"hello", hostId, hostname, adapters:[{id,capabilities}]}
 *   server→agent  {type:"spawn", reqId, adapterId, opts:{sessionId,cwd,model,provider,resumeRef}}
 *   agent→server  {type:"spawned", reqId, ok, error?}
 *   agent→server  {type:"event", sessionId, ev}          (proto events)
 *   server→agent  {type:"send", sessionId, text}
 *   server→agent  {type:"interrupt", sessionId}
 *   server→agent  {type:"resolve", sessionId, requestId, choice}
 *   server→agent  {type:"dispose", sessionId}
 */

import { hostname as osHostname } from "node:os";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { dialFailureHint } from "./dialHint.js";
import { applyServerEnv } from "./serverEnv.js";
import type { HarnessAdapter, AdapterHandle, SessionOpts } from "../../../apps/server/src/adapters/types.js";
import { piAdapter } from "../../../apps/server/src/adapters/pi.js";
import { claudeAdapter } from "../../../apps/server/src/adapters/claude.js";
import { dshAdapter } from "../../../apps/server/src/adapters/dsh.js";
import { hermesAdapter } from "../../../apps/server/src/adapters/hermes.js";
import { collectMetrics } from "@truss/proto";

/* every adapter Truss ships runs on a node host (all are child processes:
   pi RPC, claude stream-json, dsh/hermes over ACP). The remote host needs the
   harness CLIs it hosts (pi/claude/dsh/hermes-acp) on PATH. */
const localAdapters: HarnessAdapter[] = [piAdapter, claudeAdapter, dshAdapter, hermesAdapter];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const SERVER = arg("--server") ?? process.env.TRUSS_SERVER ?? "ws://127.0.0.1:4040";
const TOKEN = arg("--token") ?? process.env.TRUSS_AGENT_TOKEN ?? "";
const HOST_ID =
  arg("--host-id") ??
  process.env.TRUSS_HOST_ID ??
  createHash("sha1").update(osHostname()).digest("hex").slice(0, 8);

/* the management MCP + permission hosts live on the Truss SERVER — from a
   remote host, 127.0.0.1 would be the wrong machine. Derive the http(s)
   bases from the ws(s) server URL before any adapter spawn reads it
   (issue #100, item 16: the claude adapter used to freeze the loopback
   defaults at module scope, before this code ever ran). */
applyServerEnv(SERVER);

interface LiveEntry {
  adapter: HarnessAdapter;
  handle: AdapterHandle;
}

const live = new Map<string, LiveEntry>();
let ws: WebSocket | null = null;
let reconnectDelay = 1000;
/* consecutive dial failures — drives dialFailureHint (issue #100): the raw
   ECONNREFUSED loop told the user nothing; after a few tries the log names
   the cause and both fixes */
let dialFailures = 0;

function sendFrame(frame: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function connect() {
  const url = `${SERVER.replace(/\/$/, "")}/agent/connect?host=${encodeURIComponent(HOST_ID)}&token=${encodeURIComponent(TOKEN)}`;
  console.log(`[node-agent] connecting to ${SERVER} as ${HOST_ID}…`);
  ws = new WebSocket(url);

  let opened = false;
  ws.on("open", () => {
    opened = true;
    reconnectDelay = 1000;
    dialFailures = 0;
    sendFrame({
      type: "hello",
      hostId: HOST_ID,
      hostname: osHostname(),
      adapters: localAdapters.map((a) => ({ id: a.id, capabilities: a.capabilities })),
    });
    console.log(`[node-agent] connected; hosting: ${localAdapters.map((a) => a.id).join(", ")}`);
  });

  ws.on("message", async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      case "spawn": {
        const { reqId, adapterId, opts } = msg as {
          reqId: string;
          adapterId: string;
          opts: SessionOpts;
        };
        const adapter = localAdapters.find((a) => a.id === adapterId);
        if (!adapter) {
          sendFrame({ type: "spawned", reqId, ok: false, error: `no adapter ${adapterId} on ${HOST_ID}` });
          return;
        }
        try {
          const handle = await adapter.spawn(opts);
          live.set(opts.sessionId, { adapter, handle });
          /* pump harness events back over the tunnel */
          void (async () => {
            for await (const ev of adapter.events(handle)) {
              sendFrame({ type: "event", sessionId: opts.sessionId, ev });
            }
          })();
          sendFrame({ type: "spawned", reqId, ok: true });
        } catch (err) {
          sendFrame({ type: "spawned", reqId, ok: false, error: String(err) });
        }
        return;
      }
      case "metrics_req": {
        const { reqId } = msg as { reqId: string };
        try {
          const m = await collectMetrics();
          sendFrame({ type: "metrics", reqId, m });
        } catch (err) {
          sendFrame({ type: "metrics", reqId, m: { error: String(err) } });
        }
        return;
      }
      case "send": {
        const { sessionId, text } = msg as { sessionId: string; text: string };
        live.get(sessionId)?.adapter.send(live.get(sessionId)!.handle, text);
        return;
      }
      case "interrupt": {
        const { sessionId } = msg as { sessionId: string };
        live.get(sessionId)?.adapter.interrupt(live.get(sessionId)!.handle);
        return;
      }
      case "resolve": {
        const { sessionId, requestId, choice } = msg as {
          sessionId: string;
          requestId: string;
          choice: string;
        };
        const entry = live.get(sessionId);
        entry?.adapter.resolve?.(entry.handle, requestId, choice);
        return;
      }
      case "dispose": {
        const { sessionId } = msg as { sessionId: string };
        const entry = live.get(sessionId);
        if (entry) {
          entry.adapter.dispose(entry.handle);
          live.delete(sessionId);
        }
        return;
      }
      default:
        return;
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    /* dispose local sessions — the server marks them closed on its side */
    for (const [, entry] of live) {
      try {
        entry.adapter.dispose(entry.handle);
      } catch {
        /* gone */
      }
    }
    live.clear();
    ws = null;
    /* 4404 = the host was deleted on the server: retrying can never succeed
       (the id is tombstoned), so say so once and stop instead of spamming
       "unauthorized" every 15s forever (issue #85, audit round 3). Re-adding
       the host means a new id + token, which takes a restart anyway. */
    if (code === 4404) {
      console.log("[node-agent] this host was deleted on the server; not retrying — re-add it (new id + token) and restart the agent");
      return;
    }
    /* 4403 = revoked/bad token: retrying at the normal cadence spams a line
       the user can't act on every 15s (issue #100). Explain once, then keep
       a slow watch — an admin un-revoking lets it reconnect on its own. */
    if (code === 4403) {
      console.log(
        "[node-agent] the server refuses this host's token (revoked or rotated) — fix it in the host panel (rotate/enable), update ~/.truss/agent-*.env, restart the agent. Checking again every 60s.",
      );
      setTimeout(connect, 60000);
      return;
    }
    console.log(`[node-agent] disconnected (${code} ${reason}); retrying in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  ws.on("error", (err: Error) => {
    console.error(`[node-agent] ws error: ${err.message}`);
    /* a dead dial must explain itself within a few attempts (issue #100) —
       the user should never have to decode ECONNREFUSED. Only errors before
       the socket ever opened count as dial failures. */
    if (opened) return;
    const code = (err as NodeJS.ErrnoException).code ?? /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.exec(err.message)?.[0] ?? "";
    dialFailures += 1;
    const hint = dialFailureHint({ code, url: SERVER, attempts: dialFailures });
    if (hint) console.error(`[node-agent] ${hint}`);
  });
}

connect();
console.log(`[node-agent] host ${HOST_ID} (${osHostname()})`);
