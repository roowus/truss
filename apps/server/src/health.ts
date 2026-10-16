import { constants, accessSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HealthSnapshot, HealthState, SubsystemHealth } from "@truss/proto";
import { dataDir } from "./db.js";

/* Startup health report (issue #219).
 *
 * The server's own state used to be discoverable only per-feature, from
 * whatever panel happened to error first. This module builds ONE typed
 * readiness payload — server identity plus a row per subsystem — served at
 * GET /api/health, broadcast as `health.snapshot` on the event bus, and
 * summarized as one parseable line at boot.
 *
 * ── the tri-state, which is the whole point ──
 *
 *   ok       the subsystem came up
 *   degraded "works with less" — an adapter missing from PATH, a remote
 *            host offline. The server serves everything it still can, and
 *            says so, instead of pretending it is whole.
 *   down     "the server refuses to pretend" — the SQLite store is not
 *            usable, the bind failed. There is no honest partial mode.
 *
 * An adapter missing on PATH is `degraded`, NEVER fatal (issue #219 is
 * explicit). A server with ZERO harnesses is still `degraded`, not `down`:
 * it serves the UI, the session history, and the event log — that is
 * "works with less".
 */

/** the honest tri-state, defined in the shared proto so the server builder
    and the web status bar cannot drift (re-exported for local convenience) */
export type { HealthSnapshot, HealthState, SubsystemHealth };

/** severity ranking for worst-wins. Deliberately explicit rather than
    relying on declaration order of the union, so reordering the type can
    never silently change the rollup. */
const STATE_RANK: Record<HealthState, number> = { ok: 0, degraded: 1, down: 2 };

/**
 * Worst-wins rollup over subsystem states.
 *
 * Pure and TOTAL (developer constraint on the agreed design):
 *  - an empty list returns "ok" — a defined value, never undefined; a
 *    server with no probed subsystems has nothing wrong to report;
 *  - an UNKNOWN state string must NOT silently rank as "ok". Anything we
 *    cannot recognize is treated as the worst case, because reporting `ok`
 *    for a state we failed to understand is exactly the dishonesty this
 *    issue exists to remove.
 */
export function healthRollup(subsystems: { state: string }[]): HealthState {
  let worst: HealthState = "ok";
  for (const s of subsystems) {
    const known = s.state as HealthState;
    /* unrecognized state → treated as down (fail loud, never fail silent-open) */
    const state: HealthState = STATE_RANK[known] === undefined ? "down" : known;
    if (STATE_RANK[state] > STATE_RANK[worst]) worst = state;
  }
  return worst;
}

/* ── probes ──────────────────────────────────────────────────────────
 *
 * Everything below is CHEAP and side-effect-free, by contract: /api/health
 * re-probes live on every call, so a probe that spawned a harness would be
 * a denial-of-service on ourselves (issue #219). PATH lookups and in-memory
 * reads only — never a child process.
 */

/**
 * Resolve a command name against PATH without executing anything. Mirrors
 * what `spawn` would find: a bare name searches PATH, a name containing a
 * separator is used as a path directly.
 */
export function whichSync(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!cmd) return null;
  const hasSep = cmd.includes("/");
  const dirs = hasSep ? [""] : (env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const full = hasSep ? cmd : `${dir}/${cmd}`;
    try {
      if (!existsSync(full)) continue;
      if (!statSync(full).isFile()) continue;
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* not executable, or raced away — keep looking */
    }
  }
  return null;
}

/** an adapter and the binary the spawn path would actually run */
export interface AdapterProbe {
  id: string;
  bin: string;
}

/**
 * The binary resolution for each adapter, kept in ONE place so the probe can
 * never drift from what the adapters spawn: pi.ts, claude.ts, dsh.ts, and
 * hermes.ts read the same env vars (hermes ships inside its own venv, so its
 * default is an absolute path rather than a PATH name).
 */
export function adapterProbes(env: NodeJS.ProcessEnv = process.env): AdapterProbe[] {
  return [
    { id: "pi", bin: env.TRUSS_PI_BIN ?? "pi" },
    { id: "claude", bin: env.TRUSS_CLAUDE_BIN ?? "claude" },
    { id: "dsh", bin: env.TRUSS_DSH_BIN ?? "dsh" },
    { id: "hermes", bin: env.TRUSS_HERMES_BIN ?? join(homedir(), ".hermes", "venv", "bin", "hermes-acp") },
  ];
}

/**
 * One row per adapter — the issue's own test ("hide a harness binary: THAT
 * adapter reports degraded with detail, others stay ok") cannot be expressed
 * by an aggregate row. A missing binary is `degraded`, never fatal.
 */
export function probeAdapters(env: NodeJS.ProcessEnv = process.env): SubsystemHealth[] {
  return adapterProbes(env).map(({ id, bin }) => {
    const found = whichSync(bin, env);
    return found
      ? { name: `adapter:${id}`, state: "ok" as const, detail: found }
      : { name: `adapter:${id}`, state: "degraded" as const, detail: `not found on PATH: ${bin}` };
  });
}

/** bind + data dir, read from the modules/env that own them so the report
    can never disagree with reality */
export function identity(env: NodeJS.ProcessEnv = process.env): { bind: string; dataDir: string } {
  const host = env.TRUSS_HOST ?? "0.0.0.0";
  const port = Number(env.TRUSS_PORT ?? 4040);
  return { bind: `${host}:${port}`, dataDir };
}

/** the one parseable startup line (stdout). key=value so a log pipeline can
    parse it with awk/sed and no JSON dependency. Details go to stderr. */
export function startupLine(snap: Pick<HealthSnapshot, "state" | "subsystems" | "bind" | "commit">): string {
  const count = (s: HealthState) => snap.subsystems.filter((x) => x.state === s).length;
  return `truss: ready state=${snap.state} ok=${count("ok")} degraded=${count("degraded")} down=${count("down")} bind=${snap.bind} commit=${snap.commit}`;
}
