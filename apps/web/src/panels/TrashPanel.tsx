import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow } from "@/lib/store";
import { desktops, useDesktops } from "@/lib/desktops";
import { trashEntries, type TrashEntry, type TrashKind } from "@/lib/trashView";
import { ago } from "@/lib/format";
import { Btn, Empty, Icon } from "@/components/ui";
import { cn } from "@/utils/cn";

/**
 * Trash (issue #146): the always-discoverable recovery surface the sidebar's
 * "recently deleted" strip only hints at. One listing of deleted chats
 * (restore, delete forever, days left in the 30-day window) and closed
 * workspaces/tab groups/tabs (restore from the persisted undo stack).
 * Renders its empty state too — a trash you cannot find when empty is a
 * trash nobody trusts.
 */

const KIND_ICON: Record<TrashKind, string> = {
  session: "chat",
  workspace: "desktop",
  "tab-group": "layout",
  tab: "layout",
};

const KIND_LABEL: Record<TrashKind, string> = {
  session: "chat",
  workspace: "workspace",
  "tab-group": "tab group",
  tab: "tab",
};

export function TrashPanel(_props: IDockviewPanelProps) {
  const trash = useApp((s) => s.trash);
  const closed = useDesktops((s) => s.closed);
  const now = useNow(30_000);
  useEffect(() => {
    void store.refreshTrash();
  }, []);

  const entries = trashEntries({ sessions: trash, closed, now });

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-1.5 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="trash" size={13} className="text-[var(--t-teal)]" />
        <span className="text-[12px] text-[var(--t-fg)] font-medium">Trash</span>
        <span className="font-mono text-[10px] text-[var(--t-dim)]">{entries.length}</span>
        <span className="ml-auto text-[10.5px] text-[var(--t-dim)]">deleted chats are purged after 30 days</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto t-scroll">
        {entries.length === 0 ? (
          <Empty icon="trash" title="Trash is empty">
            Chats you delete land here for 30 days, and workspaces or tabs you close can be restored from here.
          </Empty>
        ) : (
          <div className="py-1">
            {entries.map((e) => <Row key={e.id} e={e} now={now} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ e, now }: { e: TrashEntry; now: number }) {
  const [confirmPurge, setConfirmPurge] = useState(false);
  /* restores are keyed by stack index, so a rapid second click would replay
     a stale index onto a neighbouring entry (audit round 2) — one click
     arms it, the row unlists itself when the restore lands */
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    if (!confirmPurge) return;
    const t = window.setTimeout(() => setConfirmPurge(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmPurge]);

  const restore = () => {
    if (restoring) return;
    setRestoring(true);
    /* reset the latch when the call settles and the row is still listed:
       a failed restore keeps the row, and a dead button there strands the
       user (audit round 3). A success unlists the row, making this a no-op. */
    if (e.kind === "session") {
      void store.restoreSession(e.restoreId).finally(() => setRestoring(false));
    } else if (desktops.reopenClosedAt(Number(e.restoreId)) === null) {
      setRestoring(false);
    }
  };

  const deletedLabel = ago(e.deletedAt, now);

  return (
    <div className="group flex items-center gap-2.5 px-3 py-1.5 border-b border-[var(--t-line)]/40 hover:bg-white/[0.02]">
      <Icon name={KIND_ICON[e.kind]} size={13} className="shrink-0 text-[var(--t-mute)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-[var(--t-fg)]">{e.title}</div>
        <div className="text-[10px] text-[var(--t-dim)]">
          {KIND_LABEL[e.kind]} · {deletedLabel === "now" ? "just now" : `${deletedLabel} ago`}
          {e.daysLeft !== undefined && (
            <span className={cn("ml-1.5 font-mono", e.daysLeft <= 3 ? "text-[var(--t-red)]" : "")}>
              {e.daysLeft}d left
            </span>
          )}
        </div>
      </div>
      <Btn size="xs" variant="outline" disabled={restoring} onClick={restore} title={e.kind === "session" ? "Restore this chat with its full history" : "Restore it back onto a workspace"}>
        {restoring ? "Restoring…" : "Restore"}
      </Btn>
      {e.kind === "session" && (
        <Btn
          size="xs"
          variant="ghost"
          icon="trash"
          className={cn(confirmPurge && "text-[var(--t-red)]")}
          title={confirmPurge ? "Click again: delete forever, no undo" : "Delete forever (no undo)"}
          onClick={() => {
            if (!confirmPurge) return setConfirmPurge(true);
            setConfirmPurge(false);
            void store.purgeSession(e.restoreId);
          }}
        >
          {confirmPurge ? "Sure?" : ""}
        </Btn>
      )}
    </div>
  );
}
