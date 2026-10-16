import { COMMIT } from "./version.js";
import { store } from "./db.js";
import { listAgents } from "./remote.js";
import { listHosts } from "./hosts.js";
import { transcribeConfigFromEnv } from "./transcribe.js";
import { modelRouterEnabled, modelRouterPort } from "./router-resolve.js";
import {
  healthRollup,
  identity,
  probeAdapters,
  type HealthSnapshot,
  type SubsystemHealth,
} from "./health.js";

/* The live snapshot builder (issue #219).
 *
 * /api/health RE-PROBES on every call so a binary that appears on PATH, or a
 * host that comes back, is reflected without a restart. Every probe below is
 * cheap and side-effect-free: PATH lookups, in-memory registry reads, and a
 * sqlite SELECT. NOTHING here spawns a harness process — a health request
 * that spawned children would be a denial-of-service on ourselves.
 */

/* the store is the one subsystem whose failure is fatal, and it is opened
   synchronously at import (db.ts) — if that throw fired, we never got here
   to serve a snapshot at all. So reaching this code means the store opened;
   we still exercise it live (a SELECT), because a disk that went read-only
   AFTER boot is exactly the case a boot-time-only snapshot would miss. */
function probeStore(): SubsystemHealth {
  try {
    /* cheap liveness read against the real handle */
    store.getKv("health-probe");
    return { name: "store", state: "ok", detail: "sqlite open" };
  } catch (err) {
    /* runtime-reachable down: the handle is open but no longer usable */
    return { name: "store", state: "down", detail: `store unusable: ${String(err)}` };
  }
}

/** remote hosts carry the real fleet signal: how many configured hosts are
    dialed in right now. Any configured host offline is `degraded` — the
    server works, with less. No hosts configured is `ok` (nothing to lose). */
function probeHosts(): SubsystemHealth {
  try {
    const hosts = listHosts().filter((h) => !h.revoked);
    if (!hosts.length) return { name: "remote-hosts", state: "ok", detail: "none configured" };
    const online = new Set(listAgents().map((a) => a.hostId));
    const up = hosts.filter((h) => online.has(h.id)).length;
    const detail = `${up}/${hosts.length} online`;
    return up === hosts.length
      ? { name: "remote-hosts", state: "ok", detail }
      : { name: "remote-hosts", state: "degraded", detail };
  } catch (err) {
    return { name: "remote-hosts", state: "degraded", detail: `host registry unreadable: ${String(err)}` };
  }
}

/** the node-agent listener is the /agent/connect WS route on this very
    Fastify instance — if we are answering this request, it is listening.
    There is no separate socket to probe, and inventing a fake one would be
    dishonest reporting (agreed design). */
function probeAgentListener(bind: string): SubsystemHealth {
  return { name: "node-agent-listener", state: "ok", detail: `listening on ${bind}` };
}

/** model catalog / key proxy: report the routing gate that is actually
    configured, without a network call. The full catalog lives behind
    routerStatus() (which fetches) — too heavy for a live health probe. */
function probeCatalog(): SubsystemHealth {
  if (modelRouterEnabled()) {
    return { name: "model-catalog", state: "ok", detail: `model router gate ON → 127.0.0.1:${modelRouterPort()}` };
  }
  return { name: "model-catalog", state: "ok", detail: "direct provider routes (model router gate off)" };
}

/** the cron scheduler is started at boot and is always running by the time
    anything can ask — a stopped scheduler would be a code bug, not a
    degraded mode, so this row reflects liveness, not a probe. */
function probeScheduler(): SubsystemHealth {
  return { name: "scheduler", state: "ok", detail: "cron running" };
}

/** transcribe is OMITTED entirely when unconfigured — an `ok` row for a
    feature that is not on is noise that trains people to ignore the list. */
function probeTranscribe(env: NodeJS.ProcessEnv): SubsystemHealth[] {
  const cfg = transcribeConfigFromEnv(env);
  if (!cfg.url) return [];
  return [{ name: "transcribe", state: "ok", detail: cfg.url }];
}

/**
 * Build the full readiness snapshot, re-probing live. Cheap things only.
 */
export function buildHealthSnapshot(env: NodeJS.ProcessEnv = process.env): HealthSnapshot {
  const { bind, dataDir } = identity(env);
  const subsystems: SubsystemHealth[] = [
    ...probeAdapters(env),
    probeCatalog(),
    probeAgentListener(bind),
    probeHosts(),
    probeStore(),
    probeScheduler(),
    ...probeTranscribe(env),
  ];
  return {
    commit: COMMIT,
    version: "0.2.0",
    bind,
    dataDir,
    state: healthRollup(subsystems),
    time: Date.now(),
    subsystems,
  };
}

/** diagnostics for stderr: the human detail behind the one stdout summary
    line (issue #219 keeps stdout parseable and stderr verbose) */
export function healthDiagnostics(snap: HealthSnapshot): string {
  const lines = snap.subsystems.map(
    (s) => `  ${s.state.padEnd(8)} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`,
  );
  return [`truss: health detail (state=${snap.state})`, ...lines].join("\n");
}
