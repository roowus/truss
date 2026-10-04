import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";
import { resolveCwd } from "./types.js";
import { lazyCatalog, type CatalogModel } from "./model-catalog-cache.js";
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

/** the truss management MCP server, attached to every new session; the URL
    carries Truss's own session id so tool calls are attributed (todo
    ownership, feed authorship) */
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
 * DeepSeek Harness adapter — ACP (JSON-RPC 2.0, NDJSON over stdio).
 *
 * `dsh --profile acp` multiplexes many sessions over one stdio connection;
 * Truss keeps ONE server process and opens a dsh session per Truss session.
 *
 * ACP carries committed updates (no token deltas) and no per-LLM-call
 * telemetry — trajectory rows are per-turn with latency only; context
 * occupancy is real (usage_update).
 *
 * Refs: vendor/deepseek-harness/packages/acp/acp/README.md (contract)
 */

const here = dirname(fileURLToPath(import.meta.url));
const PATCH =
  process.env.TRUSS_DSH_PATCH ?? join(here, "..", "..", "..", "..", "config", "truss-dsh-acp.yml");
const DSH_ENV_FILE = process.env.DSH_ENV_FILE ?? "/opt/dsh/.env";

function loadDshEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(DSH_ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* env file optional */
  }
  return out;
}

/** the shared dsh ACP client — exported so tests can pin how this adapter
    calls it (the turn call's budget wiring); TRUSS_DSH_BIN lets tests/ops
    point at a different dsh binary */
export const client = new AcpClient({
  command: process.env.TRUSS_DSH_BIN ?? "dsh",
  args: ["--profile", "acp", "--patch", PATCH],
  /* DSH_HOME pins the session store — without it a systemd-launched server
     lands dsh-acp on ~/.dsh while the real sessions live in /opt/dsh, and
     imports become unresumable ghosts ("not resumable" from stat misses) */
  env: { DSH_HOME: process.env.DSH_HOME ?? "/opt/dsh", ...loadDshEnv() },
});

/* ── model discovery from session/new configOptions ── */

interface AcpOption {
  value: string;
  name: string;
}
interface AcpOptionGroup {
  group: string;
  options?: AcpOption[];
}
interface AcpConfigOption {
  id: string;
  currentValue?: string;
  options?: (AcpOption | AcpOptionGroup)[];
}

function parseModelOptions(opts: AcpConfigOption[] | undefined): CatalogModel[] {
  const out: CatalogModel[] = [];
  const modelOpt = opts?.find((o) => o.id === "model");
  if (!modelOpt) return out;
  const walk = (o: AcpOption | AcpOptionGroup) => {
    if ("options" in o && o.options) o.options.forEach(walk);
    else if ("value" in o) {
      try {
        const [provider, model] = JSON.parse(o.value) as [string, string];
        out.push({ provider, model, label: o.name ?? model });
      } catch {
        /* non-JSON option value — skip */
      }
    }
  };
  modelOpt.options?.forEach(walk);
  return out;
}

/* same lazy-discovery shape as hermes (issue #101): the catalog arrives with
   session/new's configOptions and lived in module memory only, so a restart
   emptied the picker until the first session boot. The shared lazyCatalog
   persists every discovery, hydrates on load, and probes on first boot.
   dsh's boot pays its plugin stack (seconds), which is exactly why the probe
   must stay out of the picker request's path. */
const catalog = lazyCatalog("models:dsh", async () => {
  await client.ensure();
  const res = (await client.call("session/new", { cwd: homedir(), mcpServers: [] })) as {
    sessionId: string;
    configOptions?: AcpConfigOption[];
  };
  await client.call("session/close", { sessionId: res.sessionId }).catch(() => undefined);
  return parseModelOptions(res.configOptions);
});

function handleServerMessage(h: AcpSessionState, rec: { method?: string; params?: Record<string, unknown>; id?: string | number }) {
  const sid = h.sessionId;

  if (rec.method === "session/request_permission") {
    const p = rec.params as AcpPermissionParams | undefined;
    const requestId = String(rec.id!);
    h.pendingPerms.add(requestId);
    h.queue.push({
      type: "perm.request",
      sessionId: sid,
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

export const dshAdapter: HarnessAdapter = {
  id: "dsh",
  capabilities: { permissions: true, subagents: false, streaming: true, queueWhileRunning: false },

  async listModels() {
    return catalog.list();
  },

  probeModels: catalog.probe,

  async spawn(opts: SessionOpts): Promise<AcpSessionState> {
    await client.ensure();

    let res: { sessionId: string; configOptions?: AcpConfigOption[] };
    if (opts.resumeRef) {
      /* resume the persisted dsh session — cwd is required and must match
         the persisted session's workspace ("session/resume cwd mismatch").
         READ the response (same issue #14 shape as hermes): it carries the
         config catalog and the harness may rehome the session id */
      const r = (await client.call("session/resume", {
        sessionId: opts.resumeRef,
        cwd: opts.cwd,
        mcpServers: [],
      })) as { sessionId?: string; configOptions?: AcpConfigOption[] } | null;
      res = { sessionId: r?.sessionId ?? opts.resumeRef, configOptions: r?.configOptions };
    } else {
      res = (await client.call("session/new", { cwd: resolveCwd(opts.cwd).cwd, mcpServers: trussMcp(opts.sessionId) })) as {
        sessionId: string;
        configOptions?: AcpConfigOption[];
      };
    }

    const models = parseModelOptions(res.configOptions);
    if (models.length) catalog.set(models);

    const model = models.find((m) => m.model === opts.model)?.label ?? opts.model ?? "deepseek";

    /* honor the requested model when it differs from the profile default */
    if (opts.model && models.some((m) => m.model === opts.model)) {
      const found = models.find((m) => m.model === opts.model)!;
      await client
        .call("session/set_config_option", {
          sessionId: res.sessionId,
          configId: "model",
          value: JSON.stringify([found.provider, found.model]),
        })
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
    /* ACP: one prompt at a time per session — no steer/follow-up queue */
    if (h.busy) {
      busyNote(h, "dsh");
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
      .then(() => settleAcpTurn(h, { ok: true }))
      .catch((err: Error) => settleAcpTurn(h, { ok: false, detail: err.message }));
  },

  interrupt(handle: AdapterHandle) {
    const h = handle as AcpSessionState;
    void client.call("session/cancel", { sessionId: h.acpSessionId }).catch(() => undefined);
  },

  /** answer a permission card (server→client ACP request) */
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
