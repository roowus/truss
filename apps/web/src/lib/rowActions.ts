/* One descriptor source for sidebar row actions (issue #85). The sidebar
   renders rows straight from these lists, so the rules live here exactly
   once: "open" first (the row click itself), the destructive action last,
   and destructive always carries confirm:true for the two-click pattern
   the session rows established. Every action has a real label — tooltips
   are mandatory (issue #25). */

import { pinAffordance } from "./pinAffordance";

export interface RowAction {
  id: string;
  label: string;
  icon?: string;
  dangerous?: boolean;
  confirm?: boolean;
}

/* Session rows compose from one array too (issue #110): the pin LEADS the
   same cluster as every other action — one flex container, one gap, so the
   pin's spacing can never diverge from the others again. Visibility is a
   per-member rule: the pin is the only entry that may be visible:"always",
   and only while pinned (the #99 contract via pinAffordance); everything
   else is hover-only. The destructive entry still rides last (the #85
   rule). Badge/timestamp/state stay indicators — they are not actions and
   never appear in this array.

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

/* The sidebar no longer renders trash rows — deleted chats are restored or
   purged from the Trash tab (issue #146; the strip was removed on developer
   feedback, PR #153), so sessionRowActions only models live/archived rows. */
export function sessionRowActions(state: {
  pinned: boolean;
  archived?: boolean;
  dead?: boolean;
}): SessionRowAction[] {
  const pin = pinAffordance(state.pinned);
  const actions: SessionRowAction[] = [
    { id: "pin", icon: pin.icon, label: pin.actionLabel, visible: pin.visible },
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
  return actions;
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
