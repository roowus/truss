import { crampedVerdict, ultraVerdict } from "./tabClose";
import { layoutTabStrip, STANDARD_TAB_WIDTH } from "./tabStrip";

/**
 * The tab size manager (issue #34): ONE pure function owns the whole decision
 * — widths AND verdicts together, so they can never disagree. It composes
 * #23's width rules with #21's sticky verdicts instead of duplicating them.
 *
 * Self-healing by construction: the only history is the explicit prev inputs,
 * and a fresh mount (no prev) converges to the steady state in a single pass —
 * a missed or broken measurement corrects itself on the next one. No reloads.
 */

export interface TabInput {
  id: string;
  naturalWidth: number;
  active: boolean;
  prevCramped?: boolean;
  prevUltra?: boolean;
}

export interface TabStripDecision {
  widths: Record<string, number>;
  verdicts: Record<string, { cramped: boolean; ultra: boolean }>;
}

export function computeTabStrip(input: { stripWidth: number; tabs: TabInput[] }): TabStripDecision {
  /* degenerate probes (0/NaN before first layout) degrade to standard —
     they never poison the strip */
  const tabs: TabInput[] = input.tabs.map((t) => ({
    ...t,
    naturalWidth: Number.isFinite(t.naturalWidth) && t.naturalWidth > 0 ? t.naturalWidth : STANDARD_TAB_WIDTH,
  }));
  const widths = Object.fromEntries(layoutTabStrip({ stripWidth: input.stripWidth, tabs }).map((w) => [w.id, w.width]));

  /* the strip verdict, sticky PER TAB (prevCramped) — and the active tab
     never reports cramped (it's never compressed, per #23). ultra reads THIS
     pass's cramped + THIS pass's width, with only its own history — the old
     code fed ultra's history into cramped (crossed wiring) */
  const naturalTotal = tabs.length * STANDARD_TAB_WIDTH;
  const verdicts: TabStripDecision["verdicts"] = {};
  for (const t of tabs) {
    const cramped = t.active ? false : crampedVerdict(t.prevCramped ?? false, naturalTotal, input.stripWidth);
    const ultra = cramped && ultraVerdict(t.prevUltra ?? false, widths[t.id]);
    verdicts[t.id] = { cramped, ultra };
  }
  return { widths, verdicts };
}

/**
 * The component-side glue, made pure so it can be pinned by tests: scan the
 * strip as (shell, probe-width) pairs and decide for the CALLER's tab,
 * identified by ELEMENT IDENTITY — never by a DOM attribute. (The old code
 * matched on a `data-tab-panel-id` attribute that nothing in the app or
 * dockview-core ever sets, so `mine` was always null and the cramped/ultra
 * verdicts never reached the component — the close button stayed inline and
 * always-visible no matter how squeezed the strip got.)
 *
 * Positional ids keep the width bookkeeping consistent within a single pass;
 * the verdict lookup rides the same identity match, and only the caller's
 * tab carries prev* history (each tab component tracks its own verdict).
 */
export function decideStrip<TShell>(input: {
  stripWidth: number;
  tabs: { shell: TShell; naturalWidth: number; active: boolean }[];
  mine: TShell;
  prev: { cramped: boolean; ultra: boolean };
}): { widths: { shell: TShell; width: number }[]; verdict: { cramped: boolean; ultra: boolean } | null } {
  const mineIndex = input.tabs.findIndex((t) => t.shell === input.mine);
  const tabs: TabInput[] = input.tabs.map((t, i) => ({
    id: String(i),
    naturalWidth: t.naturalWidth,
    active: t.active,
    ...(i === mineIndex ? { prevCramped: input.prev.cramped, prevUltra: input.prev.ultra } : {}),
  }));
  const out = computeTabStrip({ stripWidth: input.stripWidth, tabs });
  return {
    widths: input.tabs.map((t, i) => ({ shell: t.shell, width: out.widths[String(i)] })),
    verdict: mineIndex >= 0 ? out.verdicts[String(mineIndex)] : null,
  };
}
