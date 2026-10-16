import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { desktops, useDesktops } from "@/lib/desktops";
import { workspaceTabCloseMode } from "@/lib/workspaceClose";
import { useMenuCursor, type MenuCursor } from "@/lib/useMenuCursor";
import { openPanel } from "@/lib/workspace";
import { Icon, IconBtn } from "./ui";
import { TabPicker } from "./TabPicker";
import { cn } from "@/utils/cn";

export function DesktopStrip() {
  const spaces = useDesktops((s) => s.spaces);
  const activeId = useDesktops((s) => s.activeId);
  const saveStatus = useDesktops((s) => s.saveStatus);
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const addTabRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  /* which workspace the menu belongs to, read when a key opens it */
  const menuTarget = useRef<string | null>(null);
  /* the menu container mounts once per open. Focus and reset must happen on
     THAT mount only: a callback ref re-runs on every render, so resetting
     there would wipe the highlight each time an arrow moved it. */
  const cursorRef = useRef<MenuCursor | null>(null);
  const menuFocusRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    cursorRef.current?.reset();
    el.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (editing) editRef.current?.select();
  }, [editing]);
  const beginRename = (id: string) => {
    setMenu(null);
    setEditValue(desktops.state.spaces.find((s) => s.id === id)?.name ?? "");
    setEditing(id);
  };
  const finishRename = () => {
    if (editing) desktops.rename(editing, editValue);
    setEditing(null);
  };
  const showPicker = useCallback(() => setPicker(true), []);
  const live = spaces.filter((sp) => !sp.archived);

  /* issue #227: the ⋯ menu is keyboard-operable through the shared roving
     focus model. The rendered rows, the arrow order and the typeahead
     labels all read from this one list, so they cannot drift apart. */
  const menuItems = useMemo(
    () =>
      menu
        ? menuSpec({
            canDelete: live.length >= 2,
            deleteConfirm,
            onRename: () => beginRename(menu),
            onDuplicate: () => { desktops.duplicate(menu); setMenu(null); },
            onArchive: () => { desktops.archive(menu, true); setMenu(null); },
            onDelete: () => {
              if (!deleteConfirm) { setDeleteConfirm(true); return; }
              desktops.remove(menu);
              setMenu(null);
            },
          })
        : [],
    [menu, live.length, deleteConfirm],
  );
  const menuLabels = useMemo(() => menuItems.map((it) => it.label), [menuItems]);
  const cursor = useMenuCursor(menuItems.length, {
    open: !!menu,
    onOpen: () => { setDeleteConfirm(false); setMenu(menuTarget.current); },
    onClose: () => setMenu(null),
    labels: menuLabels,
    trigger: () => menuRef.current,
  });
  cursorRef.current = cursor;
  const activateRow = useCallback(
    (i: number) => {
      const item = menuItems[i];
      if (!item || item.disabled) return;
      item.action();
    },
    [menuItems],
  );

  useEffect(() => setPicker(false), [activeId]);

  useEffect(() => {
    const onAdd = () => showPicker();
    window.addEventListener("truss:add-tab", onAdd);
    return () => window.removeEventListener("truss:add-tab", onAdd);
  }, [showPicker]);

  return (
    <div className="relative shrink-0 h-10 flex items-center gap-1 border-b border-[var(--t-line)] bg-[var(--t-bg0)] px-2">
      <div className="flex items-center gap-1.5 px-1.5 text-[var(--t-dim)] shrink-0" title="Independent workspaces; open any session in any workspace">
        <Icon name="desktop" size={14} />
      </div>
      <div role="tablist" aria-label="Workspaces" className="flex items-center gap-0.5 min-w-0 overflow-x-auto t-scroll-x h-full">
        {live.map((space, index) => (
          <div key={space.id} className={cn("group relative shrink-0 flex items-center h-[30px] rounded-md", space.id === activeId ? "bg-[var(--t-bg2)]" : "hover:bg-white/[0.03]")}>
            {space.id === activeId && <span className="absolute left-2 right-2 -bottom-[5px] h-[2px] bg-[var(--t-amber)] rounded-full" />}
            {editing === space.id ? (
              <input
                ref={editRef}
                aria-label="Workspace name"
                value={editValue}
                maxLength={32}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") finishRename(); else if (e.key === "Escape") setEditing(null); }}
                onBlur={finishRename}
                className="w-32 px-2 bg-transparent outline-none text-[12px] text-[var(--t-fg)]"
              />
            ) : (
              <button
                role="tab"
                aria-selected={space.id === activeId}
                onClick={() => desktops.switchTo(space.id)}
                onDoubleClick={() => beginRename(space.id)}
                title={`${space.name}${index < 9 ? ` · Alt+${index + 1}` : ""} · double-click to rename`}
                className={cn("flex items-center gap-1.5 h-full pl-2.5 pr-1.5 text-[12px] max-w-[165px]", space.id === activeId ? "text-[var(--t-fg)]" : "text-[var(--t-mute)]")}
              >
                <span className="text-[10px] tabular-nums text-[var(--t-dim)]">{String(index + 1).padStart(2, "0")}</span>
                <span className="truncate">{space.name}</span>
              </button>
            )}
            {/* Chrome's rule: the ACTIVE workspace pins its X, the rest reveal
                on hover; the last workspace standing gets none (pinned in
                lib/workspaceClose.ts: workspaceTabCloseMode). */}
            {(() => {
              const closeMode = workspaceTabCloseMode(live, space.id, activeId);
              if (!closeMode) return null;
              return (
                <button
                  aria-label={`Close workspace ${space.name}`}
                  title={`Close workspace ${space.name} and its tabs (Alt+Shift+W closes the active one; Alt+Shift+T reopens)`}
                  className={cn(
                    "w-[21px] h-6 grid place-items-center rounded hover:bg-white/[0.07] text-[var(--t-dim)] hover:text-[var(--t-red)]",
                    closeMode === "always" ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
                  )}
                  onClick={(e) => { e.stopPropagation(); desktops.remove(space.id); }}
                >
                  <Icon name="x" size={11} />
                </button>
              );
            })()}
            <button
              ref={menu === space.id ? menuRef : undefined}
              aria-label={`Options for ${space.name}`}
              aria-haspopup="menu"
              aria-expanded={menu === space.id}
              title={`Options for ${space.name}`}
              className={cn("w-[21px] h-6 mr-0.5 grid place-items-center rounded hover:bg-white/[0.07] text-[var(--t-dim)] hover:text-[var(--t-fg)]", menu === space.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
              onClick={(e) => { menuRef.current = e.currentTarget; menuTarget.current = space.id; setDeleteConfirm(false); setMenu(menu === space.id ? null : space.id); }}
              onKeyDown={(e) => {
                menuRef.current = e.currentTarget;
                menuTarget.current = space.id;
                cursor.onTriggerKeyDown(e);
              }}
            >
              <Icon name="dots" size={12} />
            </button>
          </div>
        ))}
      </div>
      <IconBtn icon="plus" label="New workspace (Alt+N)" onClick={() => {
        const id = desktops.create();
        setTimeout(() => beginRename(id), 80);
      }} className="w-7 h-7 shrink-0" />
      <span className="mx-1 h-4 w-px bg-[var(--t-line2)] shrink-0" />
      <button
        ref={addTabRef}
        onClick={() => setPicker((v) => !v)}
        title="Add a tab to this workspace (Alt+T)"
        className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-[12px] text-[var(--t-fg2)] hover:text-[var(--t-fg)] hover:bg-white/[0.06]"
      >
        <Icon name="plus" size={13} /> Tab
      </button>
      {/* one Settings entry point lives at the bottom of the sidebar */}
      <span className="ml-auto" />
      {saveStatus === "error" && <button onClick={() => openPanel("settings")} className="shrink-0 text-[var(--t-red)]" title="Workspace save failed. Open Settings to retry." aria-label="Workspace save failed"><Icon name="alert" size={13} /></button>}
      {picker && addTabRef.current && <TabPicker anchor={addTabRef.current} spaceId={activeId} onClose={() => setPicker(false)} />}
      {menu && menuRef.current && createPortal(
        <>
          <div className="fixed inset-0 z-[160]" onPointerDown={() => setMenu(null)} />
          <div
            role="menu"
            aria-label="Workspace options"
            /* the container owns focus, so it names the active row */
            aria-activedescendant={cursor.index >= 0 && menuItems[cursor.index] ? `ws-menu-${cursor.index}` : undefined}
            ref={menuFocusRef}
            tabIndex={-1}
            onKeyDown={(e) => cursor.onMenuKeyDown(e, activateRow)}
            className="fixed z-[161] w-48 rounded-lg bg-[var(--t-bg2)] border border-[var(--t-line2)] shadow-2xl py-1 t-pop"
            style={menuPosition(menuRef.current)}
          >
            {menuItems.map((item, i) => (
              <Fragment key={item.label}>
                {/* the separator is a sibling of the row, never a substitute
                    for it — a group divider must not swallow its own item */}
                {item.separatorBefore && <div className="my-1 border-t border-[var(--t-line)]" />}
                <MenuItem
                  id={`ws-menu-${i}`}
                  icon={item.icon}
                  dangerous={item.dangerous}
                  disabled={item.disabled}
                  highlighted={cursor.index === i}
                  onPointerEnter={() => cursor.setIndex(i)}
                  onClick={item.action}
                >
                  {item.label}
                </MenuItem>
              </Fragment>
            ))}
            {deleteConfirm && <p className="px-3 pt-1 pb-1.5 text-[10.5px] text-[var(--t-dim)] leading-snug">Closes its tabs, not the sessions. A shell with no other tabs will be stopped.</p>}
          </div>
        </>, document.body,
      )}
    </div>
  );
}

function menuPosition(button: HTMLButtonElement) {
  const rect = button.getBoundingClientRect();
  return {
    top: Math.min(rect.bottom + 5, window.innerHeight - 180),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 200)),
  };
}

/** One row of the workspace ⋯ menu. The rendered menu, the arrow order and
 *  the typeahead labels all read from `menuSpec`, so they cannot drift. */
interface MenuRow {
  label: string;
  icon: string;
  action: () => void;
  disabled?: boolean;
  dangerous?: boolean;
  separatorBefore?: boolean;
}

/** The workspace ⋯ menu rows, in render order (issue #227). Pure, so the
 *  keyboard model and the rendered menu share one source of truth. */
function menuSpec(opts: {
  canDelete: boolean;
  deleteConfirm: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onDelete: () => void;
}): MenuRow[] {
  return [
    { label: "Rename", icon: "edit", action: opts.onRename },
    { label: "Duplicate layout", icon: "copy", action: opts.onDuplicate },
    { label: "Archive workspace", icon: "archive", action: opts.onArchive },
    {
      /* the confirm row relabels itself, so the typeahead label is the one
         currently on screen */
      label: opts.deleteConfirm ? "Confirm delete" : "Delete workspace",
      icon: "trash",
      dangerous: true,
      disabled: !opts.canDelete,
      separatorBefore: true,
      action: opts.onDelete,
    },
  ];
}

function MenuItem({ id, icon, children, onClick, disabled, dangerous, highlighted, onPointerEnter }: { id?: string; icon: string; children: string; onClick: () => void; disabled?: boolean; dangerous?: boolean; highlighted?: boolean; onPointerEnter?: () => void }) {
  return (
    <button
      id={id}
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
      onPointerEnter={disabled ? undefined : onPointerEnter}
      className={cn(
        "w-full flex items-center gap-2 px-3 h-8 text-left text-[12px] disabled:opacity-35",
        !disabled && "hover:bg-white/[0.05]",
        /* a disabled row is still reachable by the arrows (so the menu can
           explain itself), which means it must still SHOW the cursor —
           otherwise the highlight silently vanishes on the last row */
        highlighted && (disabled ? "bg-white/[0.04] ring-1 ring-inset ring-[var(--t-line2)]" : "bg-white/[0.07]"),
        dangerous ? "text-[var(--t-red)]" : "text-[var(--t-fg2)]",
      )}
    >
      <Icon name={icon} size={12} />{children}
    </button>
  );
}