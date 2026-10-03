/* One descriptor source for sidebar row actions (issue #85). The sidebar
   renders rows straight from these lists, so the rules live here exactly
   once: "open" first (the row click itself), the destructive action last,
   and destructive always carries confirm:true for the two-click pattern
   the session rows established. Every action has a real label — tooltips
   are mandatory (issue #25). */

export interface RowAction {
  id: string;
  label: string;
  icon?: string;
  dangerous?: boolean;
  confirm?: boolean;
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
