import { COMMIT, VERSION } from "./version.js";
import { store } from "./db.js";
import { listAgents } from "./remote.js";
import { listHosts } from "./hosts.js";
import { transcribeConfigFromEnv } from "./transcribe.js";
import { modelRouterEnabled, modelRouterPort } from "./router-resolve.js";
import { lazyCatalogStates } from "./adapters/model-catalog-cache.js";
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

/** Remote hosts carry the real fleet signal: how many configured hosts are
    dialed in right now. Any configured host offline is `degraded` — the
    server works, with less. No hosts configured is `ok` (nothing to lose);
    a revoked host is not part of the fleet, since it is not expected to dial
    in, so it does not drag the row down.

    PURE: takes the configured hosts and the currently-connected ids, so the
    degraded/logic branches are testable with no store state at all — driving
    this through the live store makes tests race each other, since node
    --test runs cases concurrently (audit round 4 review). */
export function hostsRow(
  hosts: { id: string; revoked?: boolean }[],
  onlineIds: Iterable<string>,
): SubsystemHealth {
  const configured = hosts.filter((h) => !h.revoked);
  if (!configured.length) return { name: "remote-hosts", state: "ok", detail: "none configured" };
  const online = new Set(onlineIds);
  const up = configured.filter((h) => online.has(h.id)).length;
  const detail = `${up}/${configured.length} online`;
  return up === configured.length
    ? { name: "remote-hosts", state: "ok", detail }
    : { name: "remote-hosts", state: "degraded", detail };
}

/** the live remote-hosts probe: joins the configured hosts to the connected
    agents and delegates the decision to hostsRow. A registry that cannot be
    read at all is `degraded`, not fatal. */
function probeHosts(): SubsystemHealth {
  try {
    return hostsRow(listHosts(), listAgents().map((a) => a.hostId));
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

/** Model catalog / key proxy (issue #219, audit round 1 B2).
 *
 * Round 1 called out that this row was hardcoded `ok` on both branches —
 * permanently green even when the catalog is dead, while the issue names "a
 * model catalog fails to load" as a scenario the report must surface.
 *
 * Round 3 (B1) correctly called out that the first fix overcorrected. The
 * dsh and hermes lazy catalogs are registered at MODULE LOAD and both
 * modules are imported by the server's startup graph, so `lazy.length` is
 * always 2 and their caches are empty until someone opens the New Session
 * dialog (their probe is opt-in). Reporting `degraded` whenever those caches
 * were cold meant a perfectly healthy install showed a permanently AMBER dot
 * and printed `degraded` at boot — noise that trains people to ignore the
 * list, which is the same failure the transcribe row avoids.
 *
 * So: `ok` once ANYTHING was discovered (a populated lazy cache, or the
 * router gate on, which supplies models regardless of the lazy caches), and
 * `degraded` only when nothing has loaded at all. Still a cheap in-memory
 * read — no network call, no spawn — so the live re-probe contract holds.
 * The detail states plainly what was observed, including how many lazy
 * adapters have not discovered anything yet, so the row never overstates
 * what it knows. */
function probeCatalog(): SubsystemHealth {
  const gateOn = modelRouterEnabled();
  const gate = gateOn
    ? `model router gate ON → 127.0.0.1:${modelRouterPort()}`
    : "model router gate off (direct provider routes)";
  try {
    const lazy = lazyCatalogStates();
    const discovered = lazy.reduce((n, l) => n + l.count, 0);
    const undecided = lazy.filter((l) => l.count === 0).map((l) => l.harness);

    /* anything loaded — or the gate serving models independently of the lazy
       caches — means the catalog is up */
    if (discovered > 0) {
      const pending = undecided.length ? `; not yet discovered from ${undecided.join(", ")}` : "";
      return { name: "model-catalog", state: "ok", detail: `${gate}; ${discovered} models discovered${pending}` };
    }
    if (gateOn) {
      return { name: "model-catalog", state: "ok", detail: `${gate}; models served by the router` };
    }
    /* nothing has loaded from any source: the picker falls back to "harness
       default" (issue #101) — works with less, so degraded, never down */
    return {
      name: "model-catalog",
      state: "degraded",
      detail: lazy.length
        ? `${gate}; no catalog discovered yet from ${undecided.join(", ")}`
        : `${gate}; no catalog discovered yet`,
    };
  } catch (err) {
    return { name: "model-catalog", state: "degraded", detail: `catalog state unreadable: ${String(err)}` };
  }
}

/** the cron scheduler is started at boot and is always running by the time
    anything can ask — a stopped scheduler would be a code bug, not a
    degraded mode, so this row reflects liveness, not a probe. */
function probeScheduler(): SubsystemHealth {
  return { name: "scheduler", state: "ok", detail: "cron running" };
}

/** transcribe is OMITTED entirely when unconfigured — an `ok` row for a
    feature that is not on is noise that trains people to ignore the list.

    The reported URL is reduced to scheme+host+path (audit round 3, B4):
    /api/health has no auth and the same snapshot is broadcast to every
    connected client, so a credential or token embedded in the configured URL
    (userinfo, or a `?token=…` query) must never ride into the payload. We
    still report WHICH endpoint is configured, which is the diagnostic value;
    the secrets are not. */
function probeTranscribe(env: NodeJS.ProcessEnv): SubsystemHealth[] {
  const cfg = transcribeConfigFromEnv(env);
  if (!cfg.url) return [];
  return [{ name: "transcribe", state: "ok", detail: redactUrl(cfg.url) }];
}

/** reduce a URL to scheme://host/path, dropping userinfo, query and fragment.
    Falls back to a non-URL-safe placeholder when the value will not parse —
    never echo the raw string, since the unparsed form is the risky one. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<configured endpoint (unparseable — value withheld)>";
  }
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
    version: VERSION,
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
