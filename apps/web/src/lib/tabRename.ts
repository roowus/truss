/** Double-click tab rename (issue #141): which backend object a panel tab's
    inline rename targets, and the title cleaning the tab editor and the
    server agree on (trim, cap at 64, blank rejected — the terminal rule
    from #29). */

export interface TabRenameTab {
  kind: string;
  sessionId?: string;
  terminalId?: string;
}

export type TabRenameTarget = { kind: "session" | "terminal"; id: string };

/** chat tabs rename the SESSION, terminal tabs rename the TERMINAL; every
    other kind (feed, tasks, monitor…) isn't renamable. Missing ids → null,
    never throws. */
export function tabRenameTarget(tab: TabRenameTab): TabRenameTarget | null {
  if (tab.kind === "chat" && tab.sessionId) return { kind: "session", id: tab.sessionId };
  if (tab.kind === "terminal" && tab.terminalId) return { kind: "terminal", id: tab.terminalId };
  return null;
}

/** trimmed, ≤64 chars, empty → null (reject: a rename never blanks a title) */
export function cleanTabTitle(input: string): string | null {
  const cleaned = input.trim().slice(0, 64);
  return cleaned || null;
}
