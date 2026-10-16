/* One selection model for every list surface (issue #225; issue #226 drives
   the same module from the Files tree — the #199 lesson: one builder).

   The sidebar had no selection at all — every row acted alone (per-row
   confirm-delete, per-row pin) — so shift ranges and cmd/ctrl toggles had
   nowhere to live. This module is that model, and it is deliberately PURE:
   no React, no store, no row types, exactly like the other lib/ modules the
   surfaces render from (rowActions, pinSort, listKeys).

   Two rules make it reusable by a tree as well as a flat sidebar list:

     1. ids are OPAQUE STRINGS — the model never assumes a session, shell,
        host, or file; the caller supplies its own kind when it needs to
        (bulkActions / #226's fileBulkActions take the descriptors);
     2. ranges follow the caller's `order` — the VISIBLE order of the
        surface. A Files tree passes expanded-tree order, the sidebar passes
        the rows it is actually rendering, and both get identical semantics.
        Rows filtered out by a search or hidden in a collapsed group are not
        in `order`, so a shift range can never sweep up rows the user cannot
        see.

   The click matrix is the standard one every list on the web implements:

     plain    → select exactly that row, anchor = it;
     shift    → re-range from the (stable) anchor through the clicked row;
                the anchor does NOT move, so repeated shift-clicks re-range
                instead of marching; works upward as well as downward;
                with no anchor it behaves plainly;
     meta/ctrl→ toggle membership, anchor = the clicked row.

   Ids missing from `order` stay selectable (the row exists, the caller just
   didn't list it) and ranges clamp to what `order` holds — the model never
   throws on garbage input. */

export interface SelectionState {
  ids: Set<string>;
  anchor: string | null;
}

/** The modifier set of a click. `meta` (⌘) and `ctrl` mean the same thing:
 *  toggle membership. Both are accepted because the same model backs a Mac
 *  and a Windows/Linux client. */
export interface ClickMods {
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
}

/** An action that applies to the WHOLE selection. `disabled` carries the
 *  human reason ("mixed selection" — never a bare grey button), and
 *  `confirm` marks the destructive ones, which keep the two-click gate. */
export interface BulkAction {
  id: string;
  label: string;
  disabled?: string;
  confirm?: boolean;
}

export function createSelection(): SelectionState {
  return { ids: new Set(), anchor: null };
}

/* indexOf over the visible order; -1 for "not rendered here" */
const idx = (order: string[], id: string) => (Array.isArray(order) ? order.indexOf(id) : -1);

export function applyClick(sel: SelectionState, id: string, mods: ClickMods, order: string[]): SelectionState {
  const ids = new Set(sel?.ids ?? []);
  const anchor = sel?.anchor ?? null;
  const m = mods ?? {};

  /* cmd/ctrl: toggle membership; the anchor follows the click so a later
     shift-click ranges from where the user last pointed */
  if (m.meta || m.ctrl) {
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { ids, anchor: id };
  }

  if (m.shift) {
    const from = anchor === null ? -1 : idx(order, anchor);
    const to = idx(order, id);
    /* no anchor, or either end isn't in the visible order (a filtered-out
       anchor, a defensive unknown id) → fall back to a plain click rather
       than inventing a range the user cannot see */
    if (from === -1 || to === -1) return { ids: new Set([id]), anchor: id };
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    /* the range REPLACES the selection (the anchor may have moved out from
       under the previous range) and the anchor stays put */
    return { ids: new Set(order.slice(lo, hi + 1)), anchor };
  }

  return { ids: new Set([id]), anchor: id };
}

export function pruneSelection(sel: SelectionState, liveIds: string[]): SelectionState {
  const live = new Set(Array.isArray(liveIds) ? liveIds : []);
  const ids = new Set([...(sel?.ids ?? [])].filter((id) => live.has(id)));
  const anchor = sel?.anchor ?? null;
  /* a vanished anchor cannot keep anchoring; an emptied selection has none */
  return { ids, anchor: anchor !== null && ids.has(anchor) ? anchor : null };
}

/* ---------------- sidebar bulk actions (issue #225) ----------------
   The actions that make sense for the WHOLE set. Kinds decide what is
   honest: archiving is a session concept, pinning covers all three, and
   delete means three different things (session → trash, shell → kill,
   host → delete) — so it is offered only when every selected row is the
   same kind, and otherwise DISABLED WITH THE REASON, never silently
   widened into a mixed-kind mass delete.

   Ids in the selection that are absent from `items` are ignored: a row can
   vanish between the render and the click, and a stale id must never
   enable an action whose target is gone. pruneSelection clears the set on
   the next render. */

const KIND_NOUN: Record<string, string> = {
  session: "chat",
  shell: "shell",
  host: "host",
};

function kindsOf(sel: SelectionState, items: BulkItem[]): Set<string> {
  const present = new Set((items ?? []).map((i) => i.id));
  const kinds = new Set<string>();
  for (const id of sel?.ids ?? []) {
    if (!present.has(id)) continue; /* stale id — its row is gone */
    kinds.add(items.find((i) => i.id === id)!.kind);
  }
  return kinds;
}

/** A row descriptor handed to `bulkActions`. `pinned` is optional and only
 *  read for the pin action's honesty: a surface that doesn't track pinning
 *  (a Files tree, #226) simply omits it and gets a live pin, exactly as
 *  before. */
export interface BulkItem {
  id: string;
  kind: string;
  pinned?: boolean;
}

export function bulkActions(sel: SelectionState, items: BulkItem[]): BulkAction[] {
  const kinds = kindsOf(sel, items);
  /* nothing (live) selected → no actions at all, not a row of dead buttons */
  if (kinds.size === 0) return [];

  const live = (items ?? []).filter((i) => (sel?.ids ?? new Set<string>()).has(i.id));
  const n = live.length;
  const single = kinds.size === 1;
  const only = single ? [...kinds][0] : null;
  const noun = (only && KIND_NOUN[only]) || "item";
  const plural = n === 1 ? noun : `${noun}s`;
  const actions: BulkAction[] = [];

  /* pin covers all three kinds — the one action a mixed set can still take.
     Round 2 (B2): it must be HONEST about the set's current state. When the
     surface reports pinned flags and every selected row already carries one,
     pinning again is a silent no-op (and the bar would still clear the
     selection) — so the action says so instead. The per-row pin toggles, so
     "all pinned" is the only state where the set-level pin has nothing to do;
     a partial set still has work, and unpinning a mixed set is a different
     verb than the label promises, so it isn't silently substituted. */
  const pinKnown = live.length > 0 && live.every((i) => typeof i.pinned === "boolean");
  if (pinKnown && live.every((i) => i.pinned)) {
    actions.push({ id: "pin", label: n === 1 ? `Unpin ${plural}` : `Unpin ${n} ${plural}`, disabled: "already pinned" });
  } else {
    actions.push({
      id: "pin",
      label: n === 1 ? `Pin ${plural}` : `Pin ${n} ${plural}`,
    });
  }

  /* archiving is a session concept; mixed sets can't be archived wholesale */
  actions.push(
    single && only === "session"
      ? { id: "archive", label: n === 1 ? "Archive chat" : `Archive ${n} chats` }
      : { id: "archive", label: "Archive", disabled: "only chats can be archived" },
  );

  if (single) {
    const verb = only === "session" ? "Move to trash" : only === "shell" ? "Kill" : "Delete";
    actions.push({
      id: "delete",
      label: n === 1 ? verb : `${verb} ${n} ${plural}`,
      confirm: true,
    });
  } else {
    /* the kinds disagree about what delete even means (trash vs kill vs
       drop the host), so the honest answer is a reason, not (b)/(c) */
    actions.push({ id: "delete", label: "Delete", disabled: "mixed selection — pick one kind" });
  }

  return actions;
}
