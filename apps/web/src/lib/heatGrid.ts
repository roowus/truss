/* Pure helpers for the cost heat grid and its refresh rule (issue #158):
   the heatmap used to go stale because refetches rode a tick that only
   counts llm.call.dones in hydrated views, and "today" was computed inside
   HeatGrid once per render so midnight never rolled on its own.

   Nothing here reads the clock — callers pass `now` in, so time moves only
   when the app's 30s tick re-renders, and tests can pin it. */

import { fmtCost, fmtTokens } from "./format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface HeatDay {
  day: string; // YYYY-MM-DD local
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/** GitHub-style cell info: "Oct 5 · 12 calls · 45.2k tokens · $0.31".
    Cost is omitted when the harness didn't report one; a day with nothing
    on it reads "No usage" (GitHub's honest phrasing) instead of "0 calls". */
export function heatTooltip(day: HeatDay): string {
  const [, m, d] = day.day.split("-").map(Number);
  const date = `${MONTHS[(m ?? 1) - 1]} ${d}`;
  if (day.calls === 0 && day.tokensIn + day.tokensOut === 0) return `${date} · No usage`;
  const parts = [`${date} · ${day.calls} calls · ${fmtTokens(day.tokensIn + day.tokensOut)} tokens`];
  if (day.costUsd != null) parts.push(fmtCost(day.costUsd));
  return parts.join(" · ");
}

const DEFAULT_STALE_MS = 2 * 60 * 1000; // "within a couple minutes" per the issue

/** Time-based staleness for the cost ledger: due when the last fetch is
    older than the window (default 2min), or when nothing was ever fetched.
    Deliberately independent of which sessions are hydrated — work in chats
    you haven't opened still costs money and must still show up. */
export function costsRefreshDue(input: { lastFetchAt: number; now: number; staleAfterMs?: number }): boolean {
  const { lastFetchAt, now, staleAfterMs = DEFAULT_STALE_MS } = input;
  if (!lastFetchAt) return true;
  return now - lastFetchAt >= staleAfterMs;
}

/** Where to draw the shared cell tooltip inside the grid wrapper: centered
    on the cell, slid fully inside when it would poke out either side (the
    per-cell anchor used to clip at the panel edge on narrow docks), above
    the cell by default (GitHub-style), flipped below for the top row, and
    nudged inside when even that would spill past the bottom. */
export function clampTipPos(
  anchor: { left: number; top: number; width: number; height: number },
  tip: { width: number; height: number },
  wrap: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(0, Math.min(anchor.left + anchor.width / 2 - tip.width / 2, wrap.width - tip.width));
  let top = anchor.top - tip.height - 6; // above the cell
  if (top < 0) top = anchor.top + anchor.height + 6; // top row: below instead
  if (top + tip.height > wrap.height) top = Math.max(0, wrap.height - tip.height); // bottom rows: hug the edge
  return { left, top };
}
