import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  themeDark,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewHeaderActionsProps,
  type DockviewTheme,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { store, useApp } from "@/lib/store";
import { setDockApi, getDockApi, openPanel, renameSessionPanels } from "@/lib/workspace";
import { ChatPanel } from "@/panels/ChatPanel";
import { TrajectoryPanel } from "@/panels/TrajectoryPanel";
import { TerminalPanel } from "@/panels/TerminalPanel";
import { ContextPanel, SkillsPanel, TeamPanel, WelcomePanel } from "@/panels/Inspectors";
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
  welcome: WelcomePanel,
} as any;

const KIND_ICON: Record<string, string> = { chat: "chat", trajectory: "wave", terminal: "term", context: "gauge", team: "tree", skills: "spark", welcome: "layout" };

const theme: DockviewTheme = { ...themeDark, name: "truss", className: "dockview-theme-dark", gap: 6, dndTabIndicator: "line" };

/* ---------------- custom tab ---------------- */
function TrussTab({ api, params }: IDockviewPanelHeaderProps<{ sessionId?: string; terminalId?: string }>) {
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    const d = api.onDidTitleChange((e: { title: string }) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);
  const kind = api.id.split(":")[0];
  const sid = params?.sessionId;
  const meta = useApp((s) => (sid ? s.sessions[sid] : undefined));
  const pending = useApp((s) => (sid ? s.views[sid]?.pending.length ?? 0 : 0));
  const close = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (kind === "terminal" && params?.terminalId) void store.deleteTerminal(params.terminalId); // never leak the pty
    api.close();
  };
  const color = meta ? harnessStyle(meta.harness).color : undefined;
  return (
    <div
      className="truss-tab group/tab flex items-center gap-1.5 h-full pl-2.5 pr-1 text-[12px] select-none"
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void close();
        }
      }}
      title={title}
    >
      <span style={{ color: kind === "chat" ? color : undefined }} className={kind === "chat" ? "" : "opacity-70"}>
        <Icon name={KIND_ICON[kind] ?? "layout"} size={12} />
      </span>
      <span className="truncate max-w-[200px]">{title}</span>
      {meta && kind === "chat" && <StateDot state={meta.state} size={6} />}
      {pending > 0 && (
        <span className="inline-grid place-items-center min-w-4 h-4 px-1 rounded-full bg-[var(--t-amber)] text-[#1b1305] text-[9.5px] font-bold t-pulse-soft" title={`${pending} permission request(s) waiting`}>
          !
        </span>
      )}
      <button onClick={close} className="ml-0.5 w-5 h-5 grid place-items-center rounded opacity-0 group-hover/tab:opacity-60 hover:!opacity-100 hover:bg-white/10" aria-label="Close tab">
        <Icon name="x" size={10} />
      </button>
    </div>
  );
}

function GroupActions(props: IDockviewHeaderActionsProps) {
  const g: any = props.api;
  const [max, setMax] = useState<boolean>(() => !!g.isMaximized?.());
  useEffect(() => {
    const d = props.containerApi.onDidMaximizedGroupChange?.(() => setMax(!!g.isMaximized?.()));
    return () => d?.dispose();
  }, [props.containerApi]);
  return (
    <div className="flex items-center h-full pr-1.5">
      <button
        className="w-6 h-6 grid place-items-center rounded text-[var(--t-dim)] hover:text-[var(--t-fg)] hover:bg-white/5"
        title={max ? "Restore" : "Maximize group"}
        onClick={() => (max ? g.exitMaximized?.() : g.maximize?.())}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          {max ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
        </svg>
      </button>
    </div>
  );
}

function Watermark() {
  return (
    <div className="h-full grid place-items-center t-grid-bg">
      <div className="text-center">
        <div className="inline-block text-[var(--t-line2)]"><TrussLogo size={36} /></div>
        <div className="mt-3 text-[12.5px] text-[var(--t-mute)]">The workspace is empty.</div>
        <div className="mt-3 flex gap-2 justify-center">
          <Btn variant="outline" icon="plus" onClick={() => window.dispatchEvent(new Event("truss:new"))}>New session</Btn>
          <Btn variant="ghost" icon="layout" onClick={() => openPanel("welcome")}>Welcome</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------------- host ---------------- */
export function Workspace() {
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const loaded = useRef(false);

  const onReady = (e: DockviewReadyEvent) => {
    const api = e.api;
    setDockApi(api);
    // Never addPanel synchronously inside onReady — defer a frame.
    requestAnimationFrame(async () => {
      let restored = false;
      try {
        const { layout } = await store.be.getLayout();
        if (layout) {
          try {
            api.fromJSON(JSON.parse(layout));
            restored = api.panels.length > 0;
          } catch (err: any) {
            setLayoutError(`Saved layout couldn't be restored (${err?.message ?? err}). Started from the default arrangement.`);
            try { api.clear(); } catch { /* noop */ }
          }
        }
      } catch (err: any) {
        setLayoutError(`Couldn't load layout from /api/layout — ${err?.message ?? err}. Changes won't persist until it's reachable.`);
      }
      if (!restored) {
        openPanel("welcome");
        const first = store.state.order[0];
        if (first) {
          openPanel("chat", { sessionId: first });
          openPanel("trajectory", { sessionId: first });
          openPanel("context", { sessionId: first });
        }
      }
      loaded.current = true;

      let timer: number | undefined;
      api.onDidLayoutChange(() => {
        if (!loaded.current) return;
        clearTimeout(timer);
        timer = window.setTimeout(async () => {
          setSaveState("saving");
          try {
            await store.be.putLayout(JSON.stringify(api.toJSON()));
            setSaveState("saved");
          } catch (err: any) {
            setSaveState("error");
            store.toast("error", "Layout not saved", err?.message ?? String(err));
          }
        }, 700);
      });
      api.onDidActivePanelChange((ev: any) => {
        const p = ev?.panel ?? ev;
        const sid = p?.params?.sessionId;
        if (sid) store.focus(sid);
      });
      const act: any = api.activePanel;
      if (act?.params?.sessionId) store.focus(act.params.sessionId);
    });
  };

  useEffect(() => () => {
    setDockApi(null);
  }, []);

  // Server auto-titles sessions from the first prompt — keep every tab in step.
  const sessions = useApp((s) => s.sessions);
  useEffect(() => {
    if (!getDockApi()) return;
    for (const s of Object.values(sessions)) renameSessionPanels(s.id, s.title);
  }, [sessions]);

  return (
    <div className="relative h-full w-full truss-dock">
      <DockviewReact
        components={components}
        tabComponents={{ truss: TrussTab }}
        defaultTabComponent={TrussTab}
        rightHeaderActionsComponent={GroupActions}
        watermarkComponent={Watermark}
        onReady={onReady}
        theme={theme}
      />
      {layoutError && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 max-w-[560px] flex items-start gap-2 rounded-md bg-[var(--t-bg2)] border border-[color-mix(in_oklab,var(--t-red)_40%,transparent)] px-3 py-2 shadow-2xl text-[12px] text-[var(--t-fg2)]">
          <Icon name="alert" size={14} className="text-[var(--t-red)] mt-0.5" />
          <span className="flex-1">{layoutError}</span>
          <button onClick={() => setLayoutError(null)} className="opacity-60 hover:opacity-100"><Icon name="x" size={12} /></button>
        </div>
      )}
      <LayoutSaveIndicator state={saveState} />
    </div>
  );
}

function LayoutSaveIndicator({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (state === "idle") return;
    setVisible(true);
    if (state === "saved") {
      const t = setTimeout(() => setVisible(false), 1400);
      return () => clearTimeout(t);
    }
  }, [state]);
  if (!visible) return null;
  return (
    <div id="layout-save" className={cn("pointer-events-none absolute bottom-2 right-3 z-40 font-mono text-[10.5px] px-2 py-0.5 rounded bg-[var(--t-bg2)]/90 border border-[var(--t-line)]", state === "error" ? "text-[var(--t-red)]" : "text-[var(--t-dim)]")}>
      {state === "saving" ? "saving layout…" : state === "saved" ? "layout saved" : "layout save failed"}
    </div>
  );
}

export const dockReady = () => !!getDockApi();
