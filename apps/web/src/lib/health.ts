import type { HealthSnapshot, HealthState, SubsystemHealth } from "./proto";

/* Server readiness, client side (issue #219).
 *
 * The status bar's dot and its popover both derive from ONE pure helper so
 * the payload → rendered-rows mapping is unit-testable without a DOM (the
 * issue's fourth test is exactly this). Keep this file free of React and of
 * any store import: it is the contract, the components are the rendering.
 */

/** severity ranking for worst-wins. Explicit, not union-order dependent, so
    reordering the type can never silently change the rollup. Mirrors the
    server's STATE_RANK in apps/server/src/health.ts. */
const STATE_RANK: Record<HealthState, number> = { ok: 0, degraded: 1, down: 2 };

/**
 * Worst-wins rollup over subsystem states.
 *
 * Pure and TOTAL (developer constraint on the agreed design):
 *  - an empty list returns "ok" — a defined value, never undefined, so the
 *    dot has something to render before the first snapshot arrives;
 *  - an UNKNOWN state string must NOT silently rank as "ok". An unrecognized
 *    state is treated as the worst case: showing green for a state we failed
 *    to understand is precisely the dishonesty this issue removes.
 */
export function healthRollup(subsystems: { state: string }[]): HealthState {
  let worst: HealthState = "ok";
  for (const s of subsystems) {
    const known = s.state as HealthState;
    const state: HealthState = STATE_RANK[known] === undefined ? "down" : known;
    if (STATE_RANK[state] > STATE_RANK[worst]) worst = state;
  }
  return worst;
}

/** how the status-bar dot reads a snapshot that may not have arrived yet */
export function healthDotState(snapshot: HealthSnapshot | null): HealthState | "unknown" {
  if (!snapshot) return "unknown";
  return healthRollup(snapshot.subsystems);
}

/** display meta for a state — the dot colour and the word the popover shows.
    `unknown` (no snapshot yet) is deliberately NOT green: we do not claim
    health we have not been told about. */
export const HEALTH_META: Record<HealthState | "unknown", { label: string; color: string; hint: string }> = {
  ok: { label: "healthy", color: "var(--t-teal)", hint: "Every subsystem came up" },
  degraded: { label: "degraded", color: "var(--t-amber)", hint: "Running with less — see the details" },
  down: { label: "down", color: "var(--t-red)", hint: "A subsystem the server cannot pretend about is down" },
  unknown: { label: "unknown", color: "var(--t-dim)", hint: "No health snapshot yet" },
};

/** one popover row, derived from a snapshot. This is the shape the reducer
    test asserts against — a plain list, no JSX. */
export interface HealthRow {
  name: string;
  state: HealthState;
  label: string;
  detail: string;
}

/** the popover's rows. Degraded and down bubble to the top so the reason for
    a non-green dot is the first thing read, not buried under twelve oks. */
export function healthRows(snapshot: HealthSnapshot | null): HealthRow[] {
  if (!snapshot) return [];
  const rows: HealthRow[] = snapshot.subsystems.map((s: SubsystemHealth) => ({
    name: s.name,
    state: s.state,
    label: HEALTH_META[s.state]?.label ?? HEALTH_META.down.label,
    detail: s.detail ?? "",
  }));
  return [...rows].sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state]);
}

/** the one-line summary under the popover heading */
export function healthSummary(snapshot: HealthSnapshot | null): string {
  if (!snapshot) return "no snapshot yet";
  const n = (s: HealthState) => snapshot.subsystems.filter((x) => x.state === s).length;
  const parts = [`${n("ok")} ok`];
  if (n("degraded")) parts.push(`${n("degraded")} degraded`);
  if (n("down")) parts.push(`${n("down")} down`);
  return parts.join(" · ");
}

/* The health frame's whole effect on app state (issue #219), as a PURE
   reducer. It lives here rather than in store.ts because store.ts touches
   `window` at module scope, which makes the frame path untestable in a node
   test — the gap audit round 3 (B3) called out. Returns null when a frame
   carries nothing usable, so a malformed payload can never blank a good
   snapshot (the dot would otherwise be stuck on "unknown"). */
export function healthFramePatch(ev: { health?: HealthSnapshot } | undefined): { health: HealthSnapshot } | null {
  if (!ev?.health || typeof ev.health !== "object") return null;
  if (!Array.isArray(ev.health.subsystems)) return null;
  return { health: ev.health };
}
