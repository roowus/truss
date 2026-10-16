import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";
import { resolveCwd } from "./types.js";
import { deliverablesGuidance } from "../deliverables.js";
import { lazyCatalog, type CatalogModel } from "./model-catalog-cache.js";
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

/** dsh's ACP launch spec.

    `--patch` is applied in order, so the second patch (the generated catalog,
    issue #232) layers over the hand-written one and replaces its `llm-pi-ai`
    providers map. The generated file lives in the runtime data dir, NOT in
    the repo tree: a boot-time write inside the checkout would dirty
    `git status` for every worker and for the audit.

    `args` is mutated in place rather than replaced, because AcpClient reads
    `this.launch.args` at each spawn (acp.ts) — so a patch generated after
    this module loaded is picked up by the next process start. The static
    patch stays FIRST and stays authoritative for everything except the model
    list: on a generation failure dsh simply keeps reporting its static
    models, which is the #232 degradation rule. */
const launch = {
  command: process.env.TRUSS_DSH_BIN ?? "dsh",
  args: ["--profile", "acp", "--patch", PATCH] as string[],
  /* DSH_HOME pins the session store — without it a systemd-launched server
     lands dsh-acp on ~/.dsh while the real sessions live in /opt/dsh, and
     imports become unresumable ghosts ("not resumable" from stat misses) */
  env: { DSH_HOME: process.env.DSH_HOME ?? "/opt/dsh", ...loadDshEnv() },
};

/* the generated catalog patch, if generation has succeeded in this process.

   Set by the boot-time sync, but READ AT SPAWN TIME (below) rather than
   applied once at startup: generation runs concurrently with the server
   coming up (the key-proxy fetch is I/O), so a boot-time mutation races the
   first dsh spawn — observed on the preview, where dsh came up on the static
   27 because its ACP process had already been started from the old args. */
let generatedPatch: string | null = null;

/** resolves once the boot-time generation attempt has settled — the harvest
    awaits it so the picker's first probe cannot start dsh before the
    generated catalog patch is known (the race that left the preview on 27).
    Resolves immediately when nothing ever calls it (tests, agent bundle). */
let generationSettled: Promise<void> = Promise.resolve();
export function markGenerationSettled(p: Promise<void>) {
  generationSettled = p.catch(() => undefined);
}

/** record the generated catalog patch for future spawns (idempotent) */
export function useGeneratedCatalogPatch(path: string) {
  if (!path) return;
  generatedPatch = path;
  refreshLaunchArgs();
}

/** compose the launch args from the static patch plus, when available, the
    generated catalog patch — which must come SECOND so it layers over the
    static llm-pi-ai block rather than being overridden by it */
function refreshLaunchArgs() {
  launch.args = generatedPatch
    ? ["--profile", "acp", "--patch", PATCH, "--patch", generatedPatch]
    : ["--profile", "acp", "--patch", PATCH];
}
refreshLaunchArgs();

/* Test seams for the launch wiring (the static-then-generated --patch order
   is a contract, not an implementation detail) */
export const __launchArgs = (): string[] => [...launch.args];
export const __staticPatchPath = (): string => PATCH;

/** the shared dsh ACP client — exported so tests can pin how this adapter
    calls it (the turn call's budget wiring); TRUSS_DSH_BIN lets tests/ops
    point at a different dsh binary */
export const client = new AcpClient(launch);

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
  /* wait for the boot-time generation attempt, then re-read the generated
     patch: generation is I/O and can finish after this module loaded, so the
     harvest must not start dsh on stale args (that race left the preview
     reporting the static 27) */
  await generationSettled;
  refreshLaunchArgs();
  await client.ensure();
  const res = (await client.call("session/new", { cwd: homedir(), mcpServers: [] })) as {
    sessionId: string;
    configOptions?: AcpConfigOption[];
  };
  await client.call("session/close", { sessionId: res.sessionId }).catch(() => undefined);
  return parseModelOptions(res.configOptions);
});

/* THE REAL FIX for the stale/narrow dsh catalog (issue #232).

   The #231 patch here widened the PICKER with the key-proxy catalog whenever
   the harness report looked stale. That was a symptom fix, and it introduced a
   worse bug than it cured: the picker offered ~825 rows while the harness
   could only ROUTE 27, so ~798 rows rendered and then silently failed to apply
   (the set_config_option gate in spawn() below checks the harness report).
   Production confirmed both halves at once — `models:dsh` = 27 rows while the
   picker served 825.

   The decisive experiment (raw session/new configOptions over ACP) showed why
   the report was 27, and it was none of the four candidates in the issue:

     dsh --profile acp --patch config/truss-dsh-acp.yml  -> 27 leaves, fireworks
     dsh --profile acp                                   ->  3 leaves, deepseek

   The harness reports its configuration faithfully, and TRUSS is that
   configuration: the --patch flag. config/truss-dsh-acp.yml listed exactly 27
   hand-written fireworks models, and the acp profile never loads the web
   profile's cordis.patch.yml (the 113-model file) — a different profile in a
   different process. "27 vs 113" compared two unrelated things.

   So the fix is to stop hand-maintaining the list inside the profile and
   GENERATE it from the live key-proxy catalog — the same source pi-config.ts
   already uses, which is why pi was always rich and correct. The generated
   patch is a second --patch (dsh-catalog-gen.ts), so the harness now routes
   every row the picker offers and the two lists cannot disagree.

   That makes the #231 fallback unnecessary rather than merely redundant, so it
   is deleted here (the issue itself said a fixed report should mean deleting
   it, not tuning it). With both lists equal, listModels() is just the report —
   keeping a merge function around would only invite someone to re-widen the
   picker past what the harness can route. */

/** the rows the HARNESS can actually route — the authority for what a session
    may select. spawn() validates opts.model against this same list, so
    offering anything outside it is what produced the render-but-cannot-apply
    bug. Exported so the routability test can pin that the picker and the
    router agree. */
export async function routableModels(): Promise<CatalogModel[]> {
  return catalog.list();
}

/* spawned handles that already sent the deliverables guidance — ACP has no
   system-prompt channel, so the briefing rides the session's first prompt
   (issue #203); WeakSet, dead handles drop out with GC */
const guidanceSent = new WeakSet<object>();

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
    /* the harness report IS the picker list (issue #232): keeping a second,
       wider list here is what made ~798 rows selectable-but-unroutable */
    return catalog.list();
  },

  probeModels: catalog.probe,

  async spawn(opts: SessionOpts): Promise<AcpSessionState> {
    /* re-read the generated patch before the client boots: generation may
       have finished after module load (see generatedPatch above) */
    refreshLaunchArgs();
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
      /* an ACK without a sessionId is not a resume — adopting the requested
         (dead) ref re-arms the ghost: every later frame is unroutable and
         prompts settle instantly-empty forever (issue #97) */
      if (!r?.sessionId) {
        throw new Error(
          `session/resume answered without a sessionId; refusing to adopt the dead ref ${opts.resumeRef}`,
        );
      }
      res = { sessionId: r.sessionId, configOptions: r.configOptions };
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
        detail: `dsh process died: ${err.message}`,
      });
      h.queue.close();
    });
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
    /* the deliverables guidance rides the first prompt this spawned session
       sends (issue #203) — after the busy check so a swallowed prompt can't
       burn the one-shot; appended so the user's text still leads */
    const first = !guidanceSent.has(handle);
    if (first) {
      text = `${text}\n\n[truss bootstrap — deliverables guidance]\n${deliverablesGuidance()}\n[/truss bootstrap]`;
    }
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
      /* read the result before settling: an instant refusal/empty settle is
         the ghost black hole, a loud failure, never a silent 200 (#97) */
      .then((result) => {
        /* the marker moves only once the harness answered the prompt — a
           rejected call never delivered the briefing and the retry must still
           carry it (sessions.ts documents the same for the practices
           preamble). Race-free: busy blocks any second send meanwhile. */
        if (first) guidanceSent.add(handle);
        settleAcpTurn(h, classifyAcpSettle(h, result));
      })
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
