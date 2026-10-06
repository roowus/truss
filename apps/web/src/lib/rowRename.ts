/* Which sidebar rows take the double-click rename gesture (issue #147).
   Sessions, remote hosts, and shells rename inline, right on the row's
   name; anything else (section headers, group rows…) is not a target.
   Pure and shared so the row components and the tests read the same rule. */

export interface SidebarRowRef {
  kind: string;
  id: string;
}

export interface RowRenameTarget {
  kind: "session" | "host" | "terminal";
  id: string;
}

export function rowRenameTarget(row: SidebarRowRef): RowRenameTarget | null {
  if (!row?.id) return null;
  switch (row.kind) {
    case "session":
    case "host":
    case "terminal":
      return { kind: row.kind, id: row.id };
    default:
      return null;
  }
}
