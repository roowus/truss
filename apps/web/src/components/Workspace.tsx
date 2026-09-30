import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewReact,
  themeDark,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewHeaderActionsProps,
  type DockviewTheme,
  type GetTabContextMenuItemsParams,
  type BuiltInContextMenuItem,
  type ReactContextMenuItemConfig,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useApp } from "@/lib/store";
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
import { DesktopStrip } from "./DesktopStrip";
import { crampedVerdict, tabCloseBehavior, ultraVerdict } from "@/lib/tabClose";
import { TAB_DRAG_MIME, encodeTabDrag } from "@/lib/tabDnd";
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
} as any;

const KIND_ICON: Record<string, string> = {
  chat: "chat", trajectory: "wave", terminal: "term", context: "gauge",
  team: "tree", skills: "spark", files: "folder", git: "tree", tasks: "check", todos: "check", feed: "bolt", monitor: "gauge",
  welcome: "layout", host: "host", settings: "settings", cost: "cost", credentials: "lock", router: "host",
};

const theme: DockviewTheme = { ...themeDark, name: "truss", className: "dockview-theme-dark", gap: 6, dndTabIndicator: "line" };

function TrussTab({ api, params }: IDockviewPanelHeaderProps<{ sessionId?: string }>) {
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    const d = api.onDidTitleChange((e: { title: string }) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);
  /* active (focused) tab — ultra-cramped strips only keep the X here */
  const [active, setActive] = useState(api.isActive);
  useEffect(() => {
    setActive(api.isActive);
    const d = api.onDidActiveChange?.(() => setActive(api.isActive));
    return () => d?.dispose();
  }, [api]);
  const kind = api.id.split(":")[0];
  const sid = params?.sessionId;
  const meta = useApp((s) => (sid ? s.sessions[sid] : undefined));
  const pending = useApp((s) => (sid ? s.views[sid]?.pending.length ?? 0 : 0));
  const color = meta ? harnessStyle(meta.harness).color : undefined;
  /* Space-aware close button: inline + always visible when the tab has room;
     a hover popup only when the strip is overcrowded and has squeezed the tab
     below its natural width. The probe row below is out-of-flow and never
     compressed, so it reports the natural content width regardless of the
     strip's squeeze — no measurement oscillation when the X flips modes. */
  const rootRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [cramped, setCramped] = useState(false);
  const [ultra, setUltra] = useState(false);
  useEffect(() => {
    const tab = rootRef.current?.closest(".dv-tab") as HTMLElement | null;
    const probe = probeRef.current;
    if (!tab || !probe) return;
    /* Strip-level verdict, Chrome-style: overcrowded ⇔ every tab at its
       natural width (probe, never compressed) PLUS an inline X each would
       overflow the strip. Mode-independent (computed from probes, not live
       tabs) so it can't oscillate; uniform across the strip like Chrome.
       The strip is re-resolved on every measure and the observers re-attach
       when the tab is dragged/transferred to another strip — otherwise the
       verdict goes stale (the "works for some tabs" bug).
       Ultra (<64px) ⇒ the hover X pops over the ICON (Chrome's favicon
       swap), leaving the rest of the tab a safe click-to-activate target. */
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    let observed: Element | null = null;
    const measure = () => {
      const strip = tab.closest(".dv-tabs-container");
      if (!strip) return;
      const probes = [...strip.querySelectorAll(".truss-tab-probe")].map((p) => (p as HTMLElement).offsetWidth);
      let natural = 0;
      for (const w of probes) natural += w + 38;
      /* sticky verdicts (issue #21): a sash drag wobbles the strip width by a
         pixel or two near the boundary — without the deadband every tab's X
         flipped mode on the same pixel, mid-drag */
      setCramped((prev) => crampedVerdict(prev, natural, strip.clientWidth));
      setUltra((prev) => crampedVerdict(prev, natural, strip.clientWidth) && ultraVerdict(prev, tab.getBoundingClientRect().width));
    };
    const attach = () => {
      const strip = tab.closest(".dv-tabs-container");
      if (strip === observed) return;
      ro?.disconnect();
      mo?.disconnect();
      observed = strip;
      if (strip) {
        ro = new ResizeObserver(measure);
        ro.observe(strip);
        ro.observe(probe);
        mo = new MutationObserver(() => {
          if (tab.closest(".dv-tabs-container") !== observed) attach();
          measure();
        });
        mo.observe(strip, { childList: true });
      }
      measure();
    };
    attach();
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [title, pending, meta?.state]);
  return (
    <div
      ref={rootRef}
      className="truss-tab group/tab relative flex items-center gap-1.5 h-full pl-2 pr-1 text-[12px] select-none"
      onMouseDown={(e) => {
        if (e.button === 1) { e.preventDefault(); api.close(); }
      }}
      /* cross-workspace drag (issue #9): dockview's native drag can't leave
         its instance, so the tab also carries an HTML5 payload for the
         workspace strip. The two coexist — dockview keeps the strip, the
         strip takes the workspace transfer. */
      draggable
      onDragStart={(e) => {
        const from = desktops.spaceOfPanel(api.id);
        if (!from) return;
        e.dataTransfer.setData(TAB_DRAG_MIME, encodeTabDrag({ from, panelId: api.id }));
        e.dataTransfer.effectAllowed = "move";
      }}
      title={`${title}\nDrag onto a workspace above to move it there\nRight-click to copy or move to another workspace\n(middle-click closes)`}
    >
      <span style={{ color: kind === "chat" ? color : undefined }} className={cn("shrink-0", kind === "chat" ? "" : "opacity-70")}>
        <Icon name={KIND_ICON[kind] ?? "layout"} size={12} />
      </span>
      <span className="truncate min-w-0 max-w-[200px]">{title}</span>
      {meta && kind === "chat" && <StateDot state={meta.state} size={6} />}
      {pending > 0 && (
        <span className="inline-flex items-center gap-0.5 min-w-4 h-4 px-1 rounded-full bg-[var(--t-amber)] text-[#1b1305] text-[9.5px] font-bold t-pulse-soft shrink-0" title={`${pending} permission request(s) waiting`}>
          <Icon name="lock" size={9} />
          {pending > 1 && <span>{pending}</span>}
        </span>
      )}
      {/* one rule everywhere (lib/tabClose.ts): inline right after the title
          when roomy; right-edge overlay when squeezed; hover-reveal except
          the active tab (always visible) — and ultra slivers only ever show
          the X on the active tab, never on the left over the icon */}
      {(() => {
        const { placement, visible } = tabCloseBehavior({ cramped, ultra, active });
        if (visible === "never") return null;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); api.close(); }}
            className={cn(
              "truss-tab-close grid place-items-center rounded hover:!opacity-100 hover:bg-white/10 focus:opacity-100 focus:pointer-events-auto",
              placement === "overlay-right" && "absolute right-0.5 top-1/2 -translate-y-1/2 w-5 h-5 bg-[var(--t-bg1)] shadow-sm",
              /* centered and 16px so it fits INSIDE a sliver tab instead of
                 overhanging into the left neighbor (which ate its clicks) */
              placement === "overlay-center" && "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 bg-[var(--t-bg1)] shadow-sm",
              placement === "inline" && "shrink-0 w-5 h-5 opacity-60",
              placement !== "inline" &&
                (visible === "always"
                  ? "opacity-60"
                  : "opacity-0 pointer-events-none group-hover/tab:opacity-60 group-hover/tab:pointer-events-auto"),
            )}
            aria-label="Close tab"
          >
            <Icon name="x" size={10} />
          </button>
        );
      })()}
      {/* measurement probe: same content, never compressed, invisible */}
      <span ref={probeRef} aria-hidden className="truss-tab-probe absolute invisible pointer-events-none flex items-center gap-1.5 text-[12px] whitespace-nowrap">
        <Icon name={KIND_ICON[kind] ?? "layout"} size={12} />
        <span className="max-w-[200px] whitespace-nowrap">{title}</span>
        {meta && kind === "chat" && <StateDot state={meta.state} size={6} />}
        {pending > 0 && (
          <span className="inline-flex items-center gap-0.5 min-w-4 h-4 px-1 rounded-full text-[9.5px] font-bold">
            <Icon name="lock" size={9} />
            {pending > 1 && <span>{pending}</span>}
          </span>
        )}
      </span>
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
  const actions = useMemo(() => (props: IDockviewHeaderActionsProps) => <GroupActions props={props} spaceId={id} />, [id]);
  const contextMenu = useCallback(({ panel }: GetTabContextMenuItemsParams): (BuiltInContextMenuItem | ReactContextMenuItemConfig)[] => {
    const others = desktops.state.spaces.filter((s) => s.id !== id);
    return [
      "close", "closeOthers", "separator",
      ...others.map((space) => ({ label: `Copy to ${space.name}`, action: () => desktops.transferPanel(id, panel.id, space.id) })),
      ...(others.length ? ["separator" as const] : []),
      ...others.map((space) => ({ label: `Move to ${space.name}`, action: () => desktops.transferPanel(id, panel.id, space.id, true) })),
    ];
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
        onReady={(e: DockviewReadyEvent) => { dispose.current = desktops.register(id, e.api); }}
        theme={theme}
        /* no chevron-arrow overflow dropdown: tabs keep their natural width
           and the strip scrolls horizontally instead of clipping tabs away */
        disableTabsOverflowList
      />
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