import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";
import {
  AcpClient,
  beginAcpTurn,
  busyNote,
  handleAcpUpdate,
  makeSessionState,
  settleAcpTurn,
  type AcpPermissionParams,
  type AcpSessionState,
  type AcpUpdate,
} from "./acp.js";

/**
 * Hermes adapter — ACP via `hermes-acp` stdio server.
 *
 * Same wire as the dsh adapter (shared AcpClient). Hermes streams small
 * committed message chunks, reports {used,size} usage_update, and its prompt
 * settlement carries real per-turn token usage (mapped onto llm.call.done).
 *
 * Model/provider config lives in ~/.hermes/config.yaml (on rewvis: the
 * custom:zai route through dsh-key-proxy); the session model can be switched
 * per session with session/set_config_option... hermes uses
 * session/set_model + model state from session/new.
 */

const HERMES_BIN = process.env.TRUSS_HERMES_BIN ?? join(homedir(), ".hermes", "venv", "bin", "hermes-acp");

const client = new AcpClient({
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

    const res = (await client.call("session/new", { cwd: opts.cwd, mcpServers: [] })) as {
      sessionId: string;
      models?: HermesModelState;
    };

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
    client.onSession(res.sessionId, (rec) => handleServerMessage(h, rec));
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
      .call("session/prompt", {
        sessionId: h.acpSessionId,
        prompt: [{ type: "text", text }],
      })
      .then((result) => {
        /* hermes settles with real per-turn usage */
        const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } } | null)
          ?.usage;
        settleAcpTurn(h, {
          ok: true,
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
    const h = handle as AcpSessionState;
    client.offSession(h.acpSessionId);
    void client.call("session/close", { sessionId: h.acpSessionId }).catch(() => undefined);
    h.queue.close();
  },
} as HarnessAdapter & { resolve(handle: AdapterHandle, requestId: string, choice: string): void };
