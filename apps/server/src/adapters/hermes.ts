import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";
import { resolveCwd } from "./types.js";
import {
  AcpClient,
  beginAcpTurn,
  busyNote,
  classifyAcpSettle,
  disposeAcpSession,
  handleAcpUpdate,
  makeSessionState,
  settleAcpTurn,
  type AcpPermissionParams,
  type AcpSessionState,
  type AcpUpdate,
} from "./acp.js";

/** the truss management MCP server, attached to every new session */
function trussMcp(trussSessionId: string) {
  return [
    {
      type: "http",
      name: "truss",
      url: (process.env.TRUSS_MCP_BASE ?? "http://127.0.0.1:4040") + `/mcp/truss/${trussSessionId}`,
      headers: [], // required by the ACP schema (hermes validates strictly)
    },
  ];
}

/**
 * Hermes adapter — ACP via `hermes-acp` stdio server.
 *
 * Same wire as the dsh adapter (shared AcpClient). Hermes streams small
 * committed message chunks, reports {used,size} usage_update, and its prompt
 * settlement carries real per-turn token usage (mapped onto llm.call.done).
 *
 * Model/provider config lives in ~/.hermes/config.yaml (the
 * custom:zai route through dsh-key-proxy); the session model can be switched
 * per session with session/set_config_option... hermes uses
 * session/set_model + model state from session/new.
 */

const HERMES_BIN = process.env.TRUSS_HERMES_BIN ?? join(homedir(), ".hermes", "venv", "bin", "hermes-acp");

/** the shared hermes ACP client — exported so tests can pin how this adapter
    calls it (the turn call's budget wiring) */
export const client = new AcpClient({
  command: HERMES_BIN,
  args: [],
});

/* ── model discovery from session/new's model state ── */

interface HermesModelState {
  availableModels?: { modelId: string; name?: string }[];
  currentModelId?: string;
}

let discoveredModels: { provider: string; model: string; label: string }[] = [];

function handleServerMessage(
  h: AcpSessionState,
  rec: { method?: string; params?: Record<string, unknown>; id?: string | number },
) {
  if (rec.method === "session/request_permission") {
    const p = rec.params as AcpPermissionParams | undefined;
    const requestId = String(rec.id!);
    h.pendingPerms.add(requestId);
    h.queue.push({
      type: "perm.request",
      sessionId: h.sessionId,
      requestId,
      tool: p?.toolCall?.title ?? "tool",
      reason: p?.toolCall?.kind ?? "",
      options: (p?.options ?? []).map((o) => o.optionId),
    });
    return;
  }
  if (rec.method !== "session/update") return;
  const u = (rec.params as { update: AcpUpdate }).update;
  if (u) handleAcpUpdate(h, u);
}

export const hermesAdapter: HarnessAdapter = {
  id: "hermes",
  capabilities: { permissions: true, subagents: false, streaming: true, queueWhileRunning: false },

  async listModels() {
    return discoveredModels;
  },

  async spawn(opts: SessionOpts): Promise<AcpSessionState> {
    await client.ensure();

    let res: { sessionId: string; models?: HermesModelState };
    if (opts.resumeRef) {
      /* hermes-acp advertises sessionCapabilities.resume; cwd is required.
         READ the response (issue #14): it carries the model catalog and may
         carry the real session id — hermes mints a fresh one when the
         persisted session is gone, and addressing the dead id makes every
         later call a whisper into the void.
         Current hermes-acp omits the id entirely (probed live: the ACK is
         {models, modes} for a live session AND for a dead ref it silently
         recreates) — the real id arrives as params.sessionId of the
         session/update frames right after. Adopt THAT id; an ACK with
         neither id nor following update is the ghost and must fail (issue
         #97). The watcher claims its id so two cold resumes can't both
         adopt the first one reported. */
      const watching = client.watchForSessionUpdate(Number(process.env.TRUSS_ACP_RESUME_WATCH_MS) || 5000);
      try {
        const r = (await client.call("session/resume", {
          sessionId: opts.resumeRef,
          cwd: opts.cwd,
          mcpServers: [],
        })) as { sessionId?: string; models?: HermesModelState } | null;
        const sessionId = r?.sessionId ?? (await watching.promise);
        if (!sessionId) {
          throw new Error(
            `session/resume answered without a sessionId and no session/update followed; refusing to adopt the dead ref ${opts.resumeRef}`,
          );
        }
        res = { sessionId, models: r?.models };
      } finally {
        /* a rejected resume call must not leave the watcher armed to its
           timeout — a late fire would hold a claim only a future onSession
           for that id could release */
        watching.cancel();
      }
    } else {
      res = (await client.call("session/new", { cwd: resolveCwd(opts.cwd).cwd, mcpServers: trussMcp(opts.sessionId) })) as {
        sessionId: string;
        models?: HermesModelState;
      };
    }

    if (res.models?.availableModels?.length) {
      discoveredModels = res.models.availableModels.map((m) => ({
        provider: "hermes",
        model: m.modelId,
        label: m.name ?? m.modelId,
      }));
    }

    const model = opts.model ?? res.models?.currentModelId ?? "default";

    /* honor the requested model when offered */
    if (opts.model && res.models?.availableModels?.some((m) => m.modelId === opts.model)) {
      await client
        .call("session/set_model", { sessionId: res.sessionId, modelId: opts.model })
        .catch(() => undefined);
    }

    const h = makeSessionState(opts.sessionId, res.sessionId, model);
    h.harnessRef = res.sessionId;
    h.resumed = Boolean(opts.resumeRef);
    h.onFrame = (rec) => handleServerMessage(h, rec);
    client.onSession(res.sessionId, h.onFrame);
    /* the shared process dying strands every session it served: close the
       queue with a terminal error so the event pump ends, the session leaves
       `live`, and the next prompt resumes instead of writing into a dead
       handle (issue #97). push-after-close is a no-op, so a dispose racing
       the exit is safe. */
    h.offProcessExit = client.onProcessExit((err) => {
      h.queue.push({
        type: "session.state",
        sessionId: opts.sessionId,
        state: "error",
        detail: `hermes process died: ${err.message}`,
      });
      h.queue.close();
    });
    h.queue.push({ type: "session.state", sessionId: opts.sessionId, state: "idle" });
    return h;
  },

  send(handle: AdapterHandle, text: string) {
    const h = handle as AcpSessionState;
    if (h.busy) {
      busyNote(h, "hermes");
      return;
    }
    h.busy = true;
    beginAcpTurn(h);

    void client
      .call(
        "session/prompt",
        {
          sessionId: h.acpSessionId,
          prompt: [{ type: "text", text }],
        },
        /* the turn call resolves only when the whole agent turn settles, so it
           carries no per-request budget — a turn past the budget must finish,
           not fail and lose its output (issue #12 budgets the spawn phase) */
        0,
      )
      .then((result) => {
        /* hermes settles with real per-turn usage — but read the result
           first: an instant refusal/empty settle is the ghost black hole,
           a loud failure, never a silent 200 (issue #97) */
        const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } } | null)
          ?.usage;
        settleAcpTurn(h, {
          ...classifyAcpSettle(h, result),
          tokensIn: usage?.inputTokens,
          tokensOut: usage?.outputTokens,
        });
      })
      .catch((err: Error) => settleAcpTurn(h, { ok: false, detail: err.message }));
  },

  interrupt(handle: AdapterHandle) {
    const h = handle as AcpSessionState;
    void client.call("session/cancel", { sessionId: h.acpSessionId }).catch(() => undefined);
  },

  resolve(handle: AdapterHandle, requestId: string, choice: string) {
    const h = handle as AcpSessionState;
    if (!h.pendingPerms.has(requestId)) return;
    h.pendingPerms.delete(requestId);
    client.respond(requestId, { outcome: { outcome: "selected", optionId: choice } });
  },

  events(handle: AdapterHandle) {
    return (handle as AcpSessionState).queue;
  },

  dispose(handle: AdapterHandle) {
    /* the ownership guard both ACP adapters share — see disposeAcpSession */
    disposeAcpSession(client, handle as AcpSessionState);
  },
} as HarnessAdapter & { resolve(handle: AdapterHandle, requestId: string, choice: string): void };
