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
