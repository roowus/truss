/**
 * Pinned-first ordering for the sidebar (issue #86). One rule for every
 * section: pinned rows float to the top, everything else keeps its existing
 * order (recency for chats, insertion for shells, creation for hosts).
 *
 * A stable partition — never reorders within the pinned or unpinned halves —
 * and pure: the input array is never mutated.
 */
export function sortWithPinned<T>(items: T[], isPinned?: (item: T) => boolean): T[] {
  const key = isPinned ?? ((item: T) => (item as { pinned?: unknown }).pinned === true);
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    (key(item) ? pinned : rest).push(item);
  }
  return [...pinned, ...rest];
}
