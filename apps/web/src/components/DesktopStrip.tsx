import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { desktops, useDesktops } from "@/lib/desktops";
import { openPanel } from "@/lib/workspace";
import { Icon, IconBtn } from "./ui";
import { TabPicker } from "./TabPicker";
import { cn } from "@/utils/cn";
import { TAB_DRAG_MIME, isTabDrag, resolveTabDrop } from "@/lib/tabDnd";

export function DesktopStrip() {
  const spaces = useDesktops((s) => s.spaces);
  const activeId = useDesktops((s) => s.activeId);
  const saveStatus = useDesktops((s) => s.saveStatus);
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const addTabRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

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
        {spaces.filter((sp) => !sp.archived).map((space, index) => (
          <div
            key={space.id}
            className={cn("group relative shrink-0 flex items-center h-[30px] rounded-md", space.id === activeId ? "bg-[var(--t-bg2)]" : "hover:bg-white/[0.03]", dragOver === space.id && "ring-1 ring-[var(--t-amber)] bg-[var(--t-amber)]/10")}
            onDragOver={(e) => {
              if (isTabDrag(e.dataTransfer.types)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOver(space.id);
              }
            }}
            onDragLeave={() => setDragOver((d) => (d === space.id ? null : d))}
            onDrop={(e) => {
              setDragOver(null);
              const decision = resolveTabDrop(e.dataTransfer.getData(TAB_DRAG_MIME), space.id, spaces);
              if (decision?.kind === "move") desktops.transferPanel(decision.from, decision.panelId, decision.to, true);
            }}
          >
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
            <button
              aria-label={`Options for ${space.name}`}
              title={`Options for ${space.name}`}
              className={cn("w-[21px] h-6 mr-0.5 grid place-items-center rounded hover:bg-white/[0.07] text-[var(--t-dim)] hover:text-[var(--t-fg)]", menu === space.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
              onClick={(e) => { menuRef.current = e.currentTarget; setDeleteConfirm(false); setMenu(menu === space.id ? null : space.id); }}
            >
              <Icon name="dots" size={12} />
            </button>
          </div>
        ))}
      </div>
      <IconBtn icon="plus" label="New workspace" onClick={() => {
        const id = desktops.create();
        setTimeout(() => beginRename(id), 80);
      }} className="w-7 h-7 shrink-0" />
      <span className="mx-1 h-4 w-px bg-[var(--t-line2)] shrink-0" />
      <button
        ref={addTabRef}
        onClick={() => setPicker((v) => !v)}
        title="Add a tab to this workspace (Alt+Shift+T)"
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
          <div className="fixed z-[161] w-48 rounded-lg bg-[var(--t-bg2)] border border-[var(--t-line2)] shadow-2xl py-1 t-pop" style={menuPosition(menuRef.current)}>
            <MenuItem icon="edit" onClick={() => beginRename(menu)}>Rename</MenuItem>
            <MenuItem icon="copy" onClick={() => { desktops.duplicate(menu); setMenu(null); }}>Duplicate layout</MenuItem>
            <MenuItem icon="archive" onClick={() => { desktops.archive(menu, true); setMenu(null); }}>Archive workspace</MenuItem>
            <div className="my-1 border-t border-[var(--t-line)]" />
            <MenuItem icon="trash" dangerous disabled={spaces.length < 2} onClick={() => {
              if (!deleteConfirm) { setDeleteConfirm(true); return; }
              desktops.remove(menu);
              setMenu(null);
            }}>{deleteConfirm ? "Confirm delete" : "Delete workspace"}</MenuItem>
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

function MenuItem({ icon, children, onClick, disabled, dangerous }: { icon: string; children: string; onClick: () => void; disabled?: boolean; dangerous?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className={cn("w-full flex items-center gap-2 px-3 h-8 text-left text-[12px] hover:bg-white/[0.05] disabled:opacity-35", dangerous ? "text-[var(--t-red)]" : "text-[var(--t-fg2)]")}>
      <Icon name={icon} size={12} />{children}
    </button>
  );
}