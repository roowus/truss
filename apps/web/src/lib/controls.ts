/** One source of truth for control heights (issue #11): the compact
   filter-bar row (24px, the search box's h-6) vs the default form size
   (34px, t-input). Select triggers derive from selectTriggerHeight so the
   two can never drift apart. */
export const CONTROL_HEIGHTS = { bar: 24, form: 34 } as const;

export function selectTriggerHeight(size: "bar" | "form" = "form"): number {
  return CONTROL_HEIGHTS[size];
}
