/** One source of truth for control heights (issue #11): the compact
   filter-bar row (24px, the search box's h-6) vs the default form size
   (34px, t-input). Select triggers derive from selectTriggerHeight so the
   two can never drift apart.

   The search box's own height is the Tailwind h-6 class on its wrapper in
   TodosPanel/FeedPanel, which this module cannot derive — so `bar` must stay
   equal to it by hand, and test/filterBarSize.test.ts pins the two together
   by reading the rendered wrapper. */
export const CONTROL_HEIGHTS = { bar: 24, form: 34 } as const;

export function selectTriggerHeight(size: "bar" | "form" = "form"): number {
  return CONTROL_HEIGHTS[size];
}
