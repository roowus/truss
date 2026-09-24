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
import { ContextPanel, CostPanel, SkillsPanel, TeamPanel, WelcomePanel } from "@/panels/Inspectors";
import { HostPanel } from "@/panels/HostPanel";
import { SettingsPanel } from "@/panels/SettingsPanel";
import { DesktopStrip } from "./DesktopStrip";
import { TabPicker } from "./TabPicker";
import { Btn, Icon, StateDot, TrussLogo } from "./ui";
import { harnessStyle } from "@/lib/format";

const components = {
  chat: ChatPanel,
  trajectory: TrajectoryPanel,
  terminal: TerminalPanel,
  context: ContextPanel,
  team: TeamPanel,
  skills: SkillsPanel,
  welcome: WelcomePanel,
  host: HostPanel,
  settings: SettingsPanel,
  cost: CostPanel,
} as any;

const KIND_ICON: Record<string, string> = {
  chat: "chat", trajectory: "wave", terminal: "term", context: "gauge",
  team: "tree", skills: "spark", welcome: "layout", host: "host", settings: "settings", cost: "cost",
};

const theme: DockviewTheme = { ...themeDark, name: "truss", className: "dockview-theme-dark", gap: 6, dndTabIndicator: "line" };

function TrussTab({ api, params }: IDockviewPanelHeaderProps<{ sessionId?: string }>) {
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    const d = api.onDidTitleChange((e: { title: string }) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);
  const kind = api.id.split(":")[0];
  const sid = params?.sessionId;
  const meta = useApp((s) => (sid ? s.sessions[sid] : undefined));
  const pending = useApp((s) => (sid ? s.views[sid]?.pending.length ?? 0 : 0));
  const color = meta ? harnessStyle(meta.harness).color : undefined;
  return (
    <div
      className="truss-tab group/tab flex items-center gap-1.5 h-full pl-2.5 pr-1 text-[12px] select-none"
      onMouseDown={(e) => {
        if (e.button === 1) { e.preventDefault(); api.close(); }
      }}
      title={`${title}\nRight-click to copy or move to another workspace`}
    >
      <span style={{ color: kind === "chat" ? color : undefined }} className={kind === "chat" ? "" : "opacity-70"}>
        <Icon name={KIND_ICON[kind] ?? "layout"} size={12} />
      </span>
      <span className="truncate max-w-[200px]">{title}</span>
      {meta && kind === "chat" && <StateDot state={meta.state} size={6} />}
      {pending > 0 && (
        <span className="inline-grid place-items-center min-w-4 h-4 px-1 rounded-full bg-[var(--t-amber)] text-[#1b1305] text-[9.5px] font-bold t-pulse-soft" title={`${pending} permission request(s) waiting`}>!</span>
      )}
      <button onClick={(e) => { e.stopPropagation(); api.close(); }} className="ml-0.5 w-5 h-5 grid place-items-center rounded opacity-0 group-hover/tab:opacity-60 focus:opacity-100 hover:!opacity-100 hover:bg-white/10" aria-label="Close tab">
        <Icon name="x" size={10} />
      </button>
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