import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewHeaderActionsProps,
  type DockviewTheme,
  type GetTabContextMenuItemsParams,
  type BuiltInContextMenuItem,
  type ReactContextMenuItemConfig,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { store, useApp } from "@/lib/store";
import { tabContextMenuItems } from "@/lib/contextMenu";
import { cleanTabTitle, tabRenameTarget } from "@/lib/tabRename";
import { desktops, useDesktops } from "@/lib/desktops";
import { getDockApi, renameSessionPanels, renameHostPanels } from "@/lib/workspace";
import { ChatPanel } from "@/panels/ChatPanel";
import { TrajectoryPanel } from "@/panels/TrajectoryPanel";
import { TerminalPanel } from "@/panels/TerminalPanel";
import { ContextPanel, CostPanel, CredentialsPanel, RouterPanel, SkillsPanel, TeamPanel, WelcomePanel } from "@/panels/Inspectors";
import { FilesPanel } from "@/panels/FilesPanel";
import { GitPanel } from "@/panels/GitPanel";
import { TasksPanel } from "@/panels/TasksPanel";
import { TodosPanel } from "@/panels/TodosPanel";
import { FeedPanel } from "@/panels/FeedPanel";
import { MonitorPanel } from "@/panels/MonitorPanel";
import { HostPanel } from "@/panels/HostPanel";
import { SettingsPanel } from "@/panels/SettingsPanel";
import { TrashPanel } from "@/panels/TrashPanel";
import { DesktopStrip } from "./DesktopStrip";
import { SplitJunctionHandles } from "./SplitJunctions";
import { chromeTabLayout, chromeTabsAvailableWidth, tabTrailingReserve, type ChromeTabView } from "@/lib/chromeTabs";
import { tabClosePlacement } from "@/lib/tabClose";
import { TabPicker } from "./TabPicker";
import { Btn, Icon, StateDot, TrussLogo } from "./ui";
import { harnessStyle } from "@/lib/format";
import { cn } from "@/utils/cn";

const components = {
  chat: ChatPanel,
  trajectory: TrajectoryPanel,
  terminal: TerminalPanel,
  context: ContextPanel,
  team: TeamPanel,
  skills: SkillsPanel,
  files: FilesPanel,
  git: GitPanel,
  tasks: TasksPanel,
  todos: TodosPanel,
  feed: FeedPanel,
  monitor: MonitorPanel,
  welcome: WelcomePanel,
  host: HostPanel,
  settings: SettingsPanel,
  cost: CostPanel,
  credentials: CredentialsPanel,
  router: RouterPanel,
  trash: TrashPanel,
} as any;

const KIND_ICON: Record<string, string> = {
  chat: "chat", trajectory: "wave", terminal: "term", context: "gauge",
  team: "tree", skills: "spark", files: "folder", git: "tree", tasks: "check", todos: "check", feed: "bolt", monitor: "gauge",
  welcome: "layout", host: "host", settings: "settings", cost: "cost", credentials: "lock", router: "host",
  trash: "trash",
};

const theme: DockviewTheme = { ...themeDark, name: "truss", className: "dockview-theme-dark", gap: 6, dndTabIndicator: "line" };

function TrussTab({ api, params }: IDockviewPanelHeaderProps<{ sessionId?: string; terminalId?: string }>) {
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    const d = api.onDidTitleChange((e: { title: string }) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);
  /* double-click inline rename (issue #141, the DesktopStrip pattern):
     chats rename the session, shells the terminal (lib/tabRename picks the
     target); other kinds never offer the gesture */
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);
  /* active (focused) tab — an ultra-cramped strip shows an X only here
     (hover-revealed); inactive slivers get none */
  const [active, setActive] = useState(api.isActive);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    setActive(api.isActive);
    const d = api.onDidActiveChange?.(() => setActive(api.isActive));
    return () => d?.dispose();
  }, [api]);
  const kind = api.id.split(":")[0];
  const sid = params?.sessionId;
  const renameTarget = tabRenameTarget({ kind, sessionId: sid, terminalId: params?.terminalId });
  const beginRename = () => {
    if (!renameTarget) return;
    setRenameValue(title);
    setRenaming(true);
  };
  const commitRename = () => {
    if (!renaming) return;
    setRenaming(false);
    if (!renameTarget) return;
    const next = cleanTabTitle(renameValue);
    if (!next || next === title) return;
    if (renameTarget.kind === "session") void store.renameSession(renameTarget.id, next);
    else void store.renameTerminal(renameTarget.id, next);
  };
  const meta = useApp((s) => (sid ? s.sessions[sid] : undefined));
  const pending = useApp((s) => (sid ? s.views[sid]?.pending.length ?? 0 : 0));
  const color = meta ? harnessStyle(meta.harness).color : undefined;
  /* Chrome-parity tab layout (lib/chromeTabs.ts): the strip's width is
     shared evenly across its tabs — every tab the same width, the active
     one included — and that one uniform width decides the title and the
     close X (the Chrome matrix). The verdict is a pure function of strip
     width × tab count, never of the X's mode or the title's length, so it
     cannot oscillate and needs no hysteresis.

     The width fed to it must be EXOGENOUS: the header row minus its fixed
     action trays. Dockview content-sizes the tabs container itself
     (flex: 0 1 auto beside a flex-grow void), so measuring that container
     while also writing tab widths into it is a feedback loop that ratcheted
     every tab narrower on each click (the round-2 bug). We therefore
     observe the header for resizes (sash/window) and the strip's childList
     only for tab add/remove — never the strip's own width. */
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ChromeTabView>({ showTitle: true, showClose: "always", closeOverIcon: false, showIndicator: true, showBadge: true });
  const measureRef = useRef<() => void>(() => {});
  useEffect(() => {
    /* The dockview tab element is resolved LAZILY, on every measure — never
       captured once. Dragging a tab to rearrange it destroys and recreates
       that element around this same component, so a captured reference goes
       stale and every later write lands on a detached node (the round-4
       bug: the dragged tab kept its natural width forever). */
    const findTab = () => rootRef.current?.closest(".dv-tab") as HTMLElement | null;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    let observed: Element | null = null;
    let raf = 0;
    const measure = () => {
      const tab = findTab();
      if (!tab) return;
      const strip = tab.closest(".dv-tabs-container");
      const header = tab.closest(".dv-tabs-and-actions-container");
      if (!strip || !header) return;
      const tabEls = [...strip.querySelectorAll(".dv-tab")] as HTMLElement[];
      const self = tabEls.indexOf(tab);
      if (self < 0) return;
      const stripWidth = chromeTabsAvailableWidth(
        header.clientWidth,
        [...header.querySelectorAll(":scope > .dv-pre-actions-container, :scope > .dv-left-actions-container, :scope > .dv-right-actions-container")].map(
          (el) => (el as HTMLElement).offsetWidth,
        ),
      );
      const layout = chromeTabLayout({
        stripWidth,
        tabs: tabEls.map((el, i) => ({
          id: String(i),
          active: i === self ? activeRef.current : el.classList.contains("dv-active-tab"),
        })),
      });
      /* uniform width straight onto the dockview tab element — every tab
         computes the same value, so the strip agrees with itself */
      tab.style.width = `${layout.width}px`;
      tab.style.flex = "0 0 auto";
      setView(layout.perTab[String(self)]);
    };
    measureRef.current = measure;
    const attach = () => {
      const tab = findTab();
      const header = tab?.closest(".dv-tabs-and-actions-container");
      const strip = tab?.closest(".dv-tabs-container");
      /* after a drag the recreated element can mount a frame or two before
         it lands in the strip — retry until connected (bounded; unmount
         cancels) */
      if (!header || !strip) {
        raf = requestAnimationFrame(attach);
        return;
      }
      if (header !== observed) {
        ro?.disconnect();
        mo?.disconnect();
        observed = header;
        ro = new ResizeObserver(measure);
        ro.observe(header);
        mo = new MutationObserver(() => {
          const t = findTab();
          if (t?.closest(".dv-tabs-and-actions-container") !== observed) attach();
          measure();
        });
        mo.observe(strip, { childList: true });
      }
      measure();
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
      measureRef.current = () => {};
      const tab = findTab();
      if (tab) {
        tab.style.width = "";
        tab.style.flex = "";
      }
    };
  }, []);
  /* active flips change only the X's mode (width is active-independent) —
     re-measure without re-attaching the observers */
  useEffect(() => {
    measureRef.current();
  }, [active]);
  /* the trailing reserve (issue #125): when the X is hover-hidden or absent
     and an indicator (dot/badge) is showing, the X's slot stays reserved as
     right padding — the indicator never kisses the edge, and hover-revealing
     the X can't shift the row (reserve, not reflow). 0 when the X is inline
     (it is the trailing element), on slivers, or with no indicator (the
     title fades to the edge, like Chrome). Below the indicator floor
     (issue #129) the row renders no indicator, so nothing is reserved and
     the title keeps the full width; each indicator gates on its own floor
     (the badge's is higher — audit round 1). */
  const hasIndicator = Boolean((view.showIndicator && kind === "chat" && meta) || (view.showBadge && pending > 0));
  const trailingReserve = tabTrailingReserve(view, hasIndicator);
  return (
    <div
      ref={rootRef}
      className={cn(
        "truss-tab group/tab relative flex items-center gap-1.5 h-full w-full text-[12px] select-none",
        /* icon-only slivers center their favicon, like Chrome */
        view.showTitle ? "pl-2" : "justify-center px-0",
      )}
      style={view.showTitle ? { paddingRight: 4 + trailingReserve } : undefined}
      onMouseDown={(e) => {
        if (e.button === 1) { e.preventDefault(); api.close(); }
      }}
      title={`${title}\nRight-click to copy or move to another workspace\n(middle-click or Alt+W closes)${renameTarget ? "\n(double-click renames)" : ""}`}
    >
      <span
        style={{ color: kind === "chat" ? color : undefined }}
        className={cn(
          "shrink-0",
          kind === "chat" ? "" : "opacity-70",
          /* the favicon swap: on a sliver the hover X takes the icon's place */
          view.closeOverIcon && "group-hover/tab:opacity-0",
        )}
      >
        <Icon name={KIND_ICON[kind] ?? "layout"} size={12} />
      </span>
      {/* the tab's name, fading out at the cut — Chrome-style, no ellipsis.
          The span grows to fill the tab's free space, so the fade zone sits
          on empty space when the title fits and only touches text that
          actually overflows. Double-click swaps it for an inline rename
          input (DesktopStrip's beginRename pattern) on renamable kinds. */}
      {view.showTitle &&
        (renaming ? (
          <input
            ref={renameRef}
            aria-label="Rename tab"
            value={renameValue}
            maxLength={64}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={commitRename}
            /* mousedown must not reach the tab root (middle-click close,
               dockview drag) while editing */
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            /* reads as a field, not as tab text (the search box's recipe):
               darker than the tab's own bg1, a visible border that warms on
               focus, an amber caret so "you can type" is unmistakable. The
               negative margin is LEFT-only: the right edge stays where the
               title text ended, out of the indicator/X's reserved zone */
            style={{ caretColor: "var(--t-amber)" }}
            className="min-w-0 flex-1 h-[18px] px-1 -ml-1 mr-1 rounded border border-[var(--t-line2)] bg-[var(--t-bg0)] outline-none focus:border-[var(--t-amber)] text-[12px] text-[var(--t-fg)]"
          />
        ) : (
          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap t-fade-r" onDoubleClick={renameTarget ? beginRename : undefined}>
            {title}
          </span>
        ))}
      {/* indicators drop below the indicator floor (issue #129): a narrow
          titled tab shows its title instead of a dot it has no room for —
          the same tradeoff slivers make one band lower */}
      {view.showTitle && view.showIndicator && meta && kind === "chat" && <StateDot state={meta.state} size={6} />}
      {/* the badge waits for its own, higher floor (issue #129 audit):
          in the dot-only band it would still swallow the title; the
          sidebar badge and the global pending pill carry the signal */}
      {view.showTitle && view.showBadge && pending > 0 && (
        <span className="inline-flex items-center gap-0.5 min-w-4 h-4 px-1 rounded-full bg-[var(--t-amber)] text-[#1b1305] text-[9.5px] font-bold t-pulse-soft shrink-0" title={`${pending} permission request(s) waiting`}>
          <Icon name="lock" size={9} />
          {pending > 1 && <span>{pending}</span>}
        </span>
      )}
      {/* one rule everywhere (lib/chromeTabs.ts decides, lib/tabClose.ts
          places): the roomy active tab pins an inline X; everything else
          hover-reveals — at the right edge on titled tabs, over the icon on
          slivers (the favicon swap). Inactive tight tabs and slivers get no
          X at all, so a click can never close one. */}
      {(() => {
        const placement = tabClosePlacement(view);
        if (!placement) return null;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); api.close(); }}
            className={cn(
              "truss-tab-close grid place-items-center rounded hover:!opacity-100 hover:bg-white/10 focus:opacity-100 focus:pointer-events-auto",
              placement === "inline" && "shrink-0 w-5 h-5 opacity-60",
              placement === "overlay-right" &&
                "absolute right-0.5 top-1/2 -translate-y-1/2 w-5 h-5 bg-[var(--t-bg1)] shadow-sm opacity-0 pointer-events-none group-hover/tab:opacity-60 group-hover/tab:pointer-events-auto",
              /* centered on the sliver's (centered) icon: stays INSIDE the
                 tab instead of overhanging into the left neighbor */
              placement === "overlay-icon" &&
                "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 bg-[var(--t-bg1)] shadow-sm opacity-0 pointer-events-none group-hover/tab:opacity-100 group-hover/tab:pointer-events-auto",
            )}
            aria-label="Close tab"
          >
            <Icon name="x" size={10} />
          </button>
        );
      })()}
    </div>
  );
}
function GroupActions({ props, spaceId }: { props: IDockviewHeaderActionsProps; spaceId: string }) {
  const g = props.api;
  const [max, setMax] = useState(() => g.isMaximized());
  const [picker, setPicker] = useState(false);
  const activeSpace = useDesktops((s) => s.activeId);
  const plusRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeSpace !== spaceId) setPicker(false);
  }, [activeSpace, spaceId]);
  useEffect(() => {
    const d = props.containerApi.onDidMaximizedGroupChange?.(() => setMax(g.isMaximized()));
    return () => d?.dispose();
  }, [props.containerApi, g]);
  return (
    <div className="flex items-center h-full pr-1.5 gap-0.5">
      <button
        ref={plusRef}
        className="w-6 h-6 grid place-items-center rounded text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/5"
        aria-label="Add tab to this group"
        title="Add tab to this group"
        onClick={() => setPicker((p) => !p)}
      >
        <Icon name="plus" size={13} />
      </button>
      <button
        className="w-6 h-6 grid place-items-center rounded text-[var(--t-dim)] hover:text-[var(--t-fg)] hover:bg-white/5"
        title={max ? "Restore group" : "Maximize group"}
        aria-label={max ? "Restore group" : "Maximize group"}
        onClick={() => (max ? g.exitMaximized() : g.maximize())}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          {max ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
        </svg>
      </button>
      {/* a batch tab close, at the group's corner: closes every tab in the
          group in one gesture, remembered as ONE undo entry so the reopen
          chord (Cmd/Ctrl+Shift+Z) restores the group whole (issue #124;
          orphaned shells stop via onDidRemovePanel -> cleanupTerminalLater
          in desktops.register) */}
      <button
        className="w-6 h-6 grid place-items-center rounded text-[var(--t-dim)] hover:text-[var(--t-red)] hover:bg-white/5"
        title="Close this whole tab group (Alt+Shift+T reopens)"
        aria-label="Close this whole tab group"
        onClick={() => desktops.closeGroup(spaceId, [...props.group.panels])}
      >
        <Icon name="x" size={12} />
      </button>
      {picker && plusRef.current && <TabPicker anchor={plusRef.current} spaceId={spaceId} groupId={props.group.id} onClose={() => setPicker(false)} />}
    </div>
  );
}

function Watermark() {
  return (
    <div className="h-full grid place-items-center t-grid-bg">
      <div className="text-center">
        <div className="inline-block text-[var(--t-line2)]"><TrussLogo size={34} /></div>
        <div className="mt-3 text-[12.5px] text-[var(--t-mute)]">A clear desk.</div>
        <div className="mt-3 flex gap-2 justify-center">
          <Btn variant="outline" icon="plus" onClick={() => window.dispatchEvent(new Event("truss:add-tab"))}>Add tab</Btn>
          <Btn variant="ghost" onClick={() => window.dispatchEvent(new Event("truss:new"))}>New session</Btn>
        </div>
      </div>
    </div>
  );
}

const DesktopCanvas = memo(function DesktopCanvas({ id, visible }: { id: string; visible: boolean }) {
  const dispose = useRef<(() => void) | null>(null);
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  const actions = useMemo(() => (props: IDockviewHeaderActionsProps) => <GroupActions props={props} spaceId={id} />, [id]);
  const contextMenu = useCallback(({ panel }: GetTabContextMenuItemsParams): (BuiltInContextMenuItem | ReactContextMenuItemConfig)[] => {
    const others = desktops.state.spaces.filter((s) => s.id !== id);
    const group = panel.group;
    return tabContextMenuItems({
      others,
      /* the batch close goes through the undo stack as ONE entry, matching
         the group-corner X (built-in closeOthers would record N singles) */
      closeOthers: group ? () => desktops.closeGroup(id, group.panels.filter((p) => p.id !== panel.id)) : undefined,
      copyTo: (spaceId) => desktops.transferPanel(id, panel.id, spaceId),
      moveTo: (spaceId) => desktops.transferPanel(id, panel.id, spaceId, true),
    });
  }, [id]);

  useEffect(() => () => { dispose.current?.(); dispose.current = null; }, []);
  return (
    <div
      aria-hidden={!visible}
      className="absolute inset-0 truss-dock t-desktop-surface"
      data-active={visible}
    >
      <DockviewReact
        components={components}
        tabComponents={{ truss: TrussTab }}
        defaultTabComponent={TrussTab}
        rightHeaderActionsComponent={actions}
        watermarkComponent={Watermark}
        getTabContextMenuItems={contextMenu}
        onReady={(e: DockviewReadyEvent) => { dispose.current = desktops.register(id, e.api); setDockApi(e.api); }}
        theme={theme}
        /* no chevron-arrow overflow dropdown: tabs share one uniform clamped
           width (lib/chromeTabs.ts), and past the icon floor the strip clips
           by design — overflowed tabs stay reachable via the + picker */
        disableTabsOverflowList
      />
      {/* grab handles where two sashes cross (issue #148) — the theme gap
          recenters the handle on the visual crossing */}
      {dockApi && <SplitJunctionHandles api={dockApi} gap={theme.gap ?? 0} />}
    </div>
  );
});

export function Workspace() {
  const spaces = useDesktops((s) => s.spaces);
  const activeId = useDesktops((s) => s.activeId);
  const loadError = useDesktops((s) => s.loadError);
  const saveStatus = useDesktops((s) => s.saveStatus);
  const sessions = useApp((s) => s.sessions);
  const hosts = useApp((s) => s.agents);
  const hostPrefs = useDesktops((s) => s.hosts);

  // First prompt renames a session. Update its tabs in every desktop, not just the active one.
  useEffect(() => {
    for (const s of Object.values(sessions)) renameSessionPanels(s.id, s.title);
  }, [sessions, spaces.length]);
  useEffect(() => {
    for (const h of hosts) renameHostPanels(h.hostId, hostPrefs[h.hostId]?.alias || h.hostname);
  }, [hosts, hostPrefs, spaces.length]);

  return (
    <div className="relative h-full min-h-0 w-full flex flex-col">
      <DesktopStrip />
      <div className="relative flex-1 min-h-0 m-1.5">
        {spaces.map((space) => <DesktopCanvas key={space.id} id={space.id} visible={space.id === activeId} />)}
        {loadError && (
          <div role="alert" className="absolute top-2 left-1/2 -translate-x-1/2 z-50 max-w-[560px] flex items-start gap-2 rounded-md bg-[var(--t-bg2)] border border-[color-mix(in_oklab,var(--t-red)_40%,transparent)] px-3 py-2 shadow-2xl text-[12px] text-[var(--t-fg2)]">
            <Icon name="alert" size={14} className="text-[var(--t-red)] mt-0.5" />
            <span className="flex-1">{loadError}</span>
            <button onClick={() => desktops.dismissLoadError()} aria-label="Dismiss workspace error" className="shrink-0 text-[var(--t-mute)] hover:text-[var(--t-fg)]"><Icon name="x" size={12} /></button>
          </div>
        )}
        {saveStatus === "saving" && <div className="pointer-events-none absolute bottom-2 right-3 z-40 text-[10.5px] text-[var(--t-dim)]">Saving workspaces…</div>}
      </div>
    </div>
  );
}

export const dockReady = () => !!getDockApi();