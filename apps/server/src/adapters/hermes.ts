import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";
import { resolveCwd } from "./types.js";
import { readCatalogCache, writeCatalogCache, type CatalogModel } from "./model-catalog-cache.js";
import {
  AcpClient,
  beginAcpTurn,
  busyNote,
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

/* the picker catalog is lazy: hermes reports it only in session/new and
   session/resume responses, kept in module memory — a server restart emptied
   the picker until the next session booted (issue #101). Persist every
   discovery and hydrate on load. */
const CATALOG_KV_KEY = "models:hermes";

let discoveredModels: CatalogModel[] = readCatalogCache(CATALOG_KV_KEY);

function setDiscovered(models: CatalogModel[]) {
  discoveredModels = models;
  writeCatalogCache(CATALOG_KV_KEY, models);
}

function mapModels(state: HermesModelState | undefined): CatalogModel[] {
  return (state?.availableModels ?? []).map((m) => ({
    provider: "hermes",
    model: m.modelId,
    label: m.name ?? m.modelId,
  }));
}

/* First boot on a fresh server: nothing discovered, nothing persisted — the
   picker would sit empty until somebody spawns a session. Probe instead: one
   throwaway session/new with no MCP servers, harvest the model state, close
   it again. Concurrent picker fetches share one in-flight probe, and a
   missing/wedged harness isn't re-probed on every fetch. */
let probeInflight: Promise<boolean> | null = null;
let lastProbeAt = 0;
const PROBE_COOLDOWN_MS = 30_000;

async function probeModels(): Promise<boolean> {
  if (discoveredModels.length) return false;
  if (probeInflight) return probeInflight;
  if (Date.now() - lastProbeAt < PROBE_COOLDOWN_MS) return false;
  lastProbeAt = Date.now();
  probeInflight = (async () => {
    try {
      await client.ensure();
      const res = (await client.call("session/new", { cwd: homedir(), mcpServers: [] })) as {
        sessionId: string;
        models?: HermesModelState;
      };
      await client.call("session/close", { sessionId: res.sessionId }).catch(() => undefined);
      const models = mapModels(res.models);
      if (!models.length) return false;
      setDiscovered(models);
      return true;
    } catch {
      return false; /* no hermes here — the picker stays on "harness default" */
    } finally {
      probeInflight = null;
    }
  })();
  return probeInflight;
}

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

  probeModels,

  async spawn(opts: SessionOpts): Promise<AcpSessionState> {
    await client.ensure();

    let res: { sessionId: string; models?: HermesModelState };
    if (opts.resumeRef) {
      /* hermes-acp advertises sessionCapabilities.resume; cwd is required.
         READ the response (issue #14): it carries the model catalog AND the
         real session id — hermes mints a fresh one when the persisted session
         is gone, and addressing the dead id makes every later call a whisper
         into the void */
      const r = (await client.call("session/resume", {
        sessionId: opts.resumeRef,
        cwd: opts.cwd,
        mcpServers: [],
      })) as { sessionId?: string; models?: HermesModelState } | null;
      res = { sessionId: r?.sessionId ?? opts.resumeRef, models: r?.models };
    } else {
      res = (await client.call("session/new", { cwd: resolveCwd(opts.cwd).cwd, mcpServers: trussMcp(opts.sessionId) })) as {
        sessionId: string;
        models?: HermesModelState;
      };
    }

    if (res.models?.availableModels?.length) setDiscovered(mapModels(res.models));

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
    /* the ownership guard both ACP adapters share — see disposeAcpSession */
    disposeAcpSession(client, handle as AcpSessionState);
  },
} as HarnessAdapter & { resolve(handle: AdapterHandle, requestId: string, choice: string): void };
