/* One descriptor source for sidebar row actions (issue #85). The sidebar
   renders rows straight from these lists, so the rules live here exactly
   once: "open" first (the row click itself), the destructive action last
   (the session array excepted — there the pin anchors the right edge and
   destructive rides just inside it, issue #156), and destructive always
   carries confirm:true for the two-click pattern the session rows
   established. Every action has a real label — tooltips are mandatory
   (issue #25). */

import { pinAffordance } from "./pinAffordance";

export interface RowAction {
  id: string;
  label: string;
  icon?: string;
  dangerous?: boolean;
  confirm?: boolean;
}

/* Session rows compose from one array too (issue #110): the pin shares the
   same cluster as every other action — one flex container, one gap, so the
   pin's spacing can never diverge from the others again. The pin anchors
   LAST (issue #156, amending #110's pin-first): the same right-edge index
   at rest and on hover, so a pinned row's solid pin never dodges the
   pointer — and the destructive entry rides just inside it, never at the
   edge a cursor aimed at the pin would hit. Visibility is a per-member
   rule: the pin is the only entry that may be visible:"always", and only
   while pinned (the #99 contract via pinAffordance); everything else is
   hover-only. Badge/timestamp/state stay indicators — they are not actions
   and never appear in this array.

   The session contract spells the destructive flag "danger" (the #110 spec
   tests read it); the shell/host contract above keeps its #85 "dangerous". */
export interface SessionRowAction {
  id: string;
  icon: string;
  label: string;
  danger?: boolean;
  confirm?: boolean;
  visible: "always" | "hover";
}

export function sessionRowActions(state: {
  pinned: boolean;
  archived?: boolean;
  dead?: boolean;
  trashView?: boolean;
}): SessionRowAction[] {
  /* a trash row's session is out of the live list — pin/close/archive don't
     apply; restore or purge are the only moves (and pin stays hidden there,
     as before) */
  if (state.trashView) {
    return [
      { id: "restore", icon: "retry", label: "Restore (back to the sidebar, history intact)", visible: "hover" },
      { id: "purge", icon: "trash", label: "Delete forever (no undo)", danger: true, confirm: true, visible: "hover" },
    ];
  }
  const pin = pinAffordance(state.pinned);
  const actions: SessionRowAction[] = [
    /* the displaced gesture (issue #147): the row's double-click used to
       open chat + trajectory + context; the name's double-click is rename
       now, so the layout open lives on as an explicit action */
    { id: "open-all", icon: "layout", label: "Open chat + trajectory + context", visible: "hover" },
  ];
  if (state.archived) {
    actions.push({ id: "unarchive", icon: "archive", label: "Restore to the sidebar", visible: "hover" });
  } else {
    actions.push(
      { id: "shell", icon: "term", label: "Shell in cwd", visible: "hover" },
      { id: "archive", icon: "archive", label: "Archive (hide from sidebar; keeps history)", visible: "hover" },
    );
    /* a dead session has no process left to stop */
    if (!state.dead) {
      actions.push({ id: "close", icon: "power", label: "Close (stop process, keep history)", visible: "hover" });
    }
  }
  actions.push({ id: "trash", icon: "trash", label: "Move to trash (recoverable for 30 days)", danger: true, confirm: true, visible: "hover" });
  /* the pin anchors LAST (issue #156): the identical right-edge index at
     rest and on hover, so it never dodges the pointer — and trash rides
     just inside it, never at the edge the pin owns */
  actions.push({ id: "pin", icon: pin.icon, label: pin.actionLabel, visible: pin.visible });
  return actions;
}

/* Issue #140: how the session row's action cluster rests. A cluster with no
   always-visible member hides wholesale until hover — nothing reserves
   space, so the timestamp+dot sit at the row's true right edge (before this,
   the unpinned pin kept a ~24px slot via opacity-0, floating the cluster off
   the edge). A pinned row's cluster rests visible with ONLY the solid pin.
   Hover members take zero layout space at rest. */
export function clusterRestState(acts: SessionRowAction[]): { cls: string; resting: SessionRowAction[] } {
  const resting = acts.filter((a) => a.visible === "always");
  return { cls: resting.length > 0 ? "flex" : "hidden group-hover:flex", resting };
}

export function shellRowActions(shell: { id: string; alive?: boolean }): RowAction[] {
  /* an exited shell is already dead — there is nothing to kill, only a
     ghost row to remove */
  const dead = shell.alive === false;
  return [
    { id: "open", label: "Open shell", icon: "term" },
    { id: "rename", label: "Rename shell", icon: "edit" },
    {
      id: "kill",
      label: dead ? "Remove from the list" : "Kill shell",
      icon: dead ? "trash" : "x",
      dangerous: true,
      confirm: true,
    },
  ];
}

export function hostRowActions(host: { id: string; online?: boolean; revoked?: boolean }): RowAction[] {
  void host; /* delete is offered in every state — an offline or revoked box is exactly the one you want gone */
  return [
    { id: "open", label: "Open host details", icon: "chev" },
    { id: "delete", label: "Delete host", icon: "trash", dangerous: true, confirm: true },
  ];
}
