import { useCallback, useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  themeAbyss,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { api, type SessionMeta } from "./api";
import { connectEvents, store, useStore, useStoreVersion } from "./store";
import { Sprite } from "./icons";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { TrajectoryPanel } from "./components/TrajectoryPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { ContextPanel } from "./components/ContextPanel";
import { SubagentsPanel } from "./components/SubagentsPanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { StubPanel } from "./components/StubPanel";
import { StatusBar } from "./components/StatusBar";

/* ── dockview panel registry ── */

type PanelParams = { sessionId?: string; terminalId?: string };

/** native panel titles (memory stays a stub until harnesses expose memory APIs) */
const PANEL_DEFS: Record<
  string,
  { title: string; icon: Parameters<typeof StubPanel>[0]["icon"]; lands: string }
> = {
  memory: { title: "memory", icon: "brain", lands: "with a harness that has one" },
};

/** panels whose content follows the focused chat's session */
const SESSION_SCOPED = ["trajectory", "context", "subagents", "skills"];

function ChatWrapper(props: IDockviewPanelProps<PanelParams>) {
  return (
    <div className="pbody">
      <ChatPanel sessionId={props.params.sessionId!} />
    </div>
  );
}

function TrajectoryWrapper(props: IDockviewPanelProps<PanelParams>) {
  return (
    <div className="pbody">
      <TrajectoryPanel sessionId={props.params.sessionId ?? null} />
    </div>
  );
}

function TerminalWrapper(props: IDockviewPanelProps<PanelParams>) {
  return (
    <div className="pbody">
      <TerminalPanel terminalId={props.params.terminalId!} />
    </div>
  );
}

function ContextWrapper(props: IDockviewPanelProps<PanelParams>) {
  return (
    <div className="pbody">
      <ContextPanel sessionId={props.params.sessionId ?? null} />
    </div>
  );
}

function SubagentsWrapper(props: IDockviewPanelProps<PanelParams>) {
  return (
    <div className="pbody">
      <SubagentsPanel sessionId={props.params.sessionId ?? null} />
    </div>
  );
}

function SkillsWrapper(props: IDockviewPanelProps<PanelParams>) {
  return (
    <div className="pbody">
      <SkillsPanel sessionId={props.params.sessionId ?? null} />
    </div>
  );
}

function makeStub(kind: string) {
  const def = PANEL_DEFS[kind];
  return function Stub() {
    return (
      <div className="pbody">
        <StubPanel title={def.title} icon={def.icon} lands={def.lands} />
      </div>
    );
  };
}

const dockComponents: Record<
  string,
  React.FunctionComponent<IDockviewPanelProps<PanelParams>>
> = {
  chat: ChatWrapper,
  trajectory: TrajectoryWrapper,
  terminal: TerminalWrapper,
  context: ContextWrapper,
  subagents: SubagentsWrapper,
  skills: SkillsWrapper,
  ...Object.fromEntries(Object.keys(PANEL_DEFS).map((k) => [k, makeStub(k)])),
};

/* ── app ── */

export function App() {
  const s = useStore();
  const version = useStoreVersion();
  const dockApi = useRef<DockviewReadyEvent["api"] | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeSessionId;
  const [showNew, setShowNew] = useState(false);
  const [sideWidth, setSideWidth] = useState(236);

  useEffect(() => {
    void store.init();
    connectEvents();
  }, []);

  /* keep dockview tab titles in step with session titles (auto-title on first prompt) */
  useEffect(() => {
    const a = dockApi.current;
    if (!a) return;
    for (const [id, sess] of store.sessions) {
      const panel = a.getPanel(`chat:${id}`);
      if (panel && panel.title !== sess.title) panel.api.setTitle(sess.title);
    }
  }, [version]);

  /* session-scoped panels follow the focused chat */
  const syncTrajectory = useCallback((sessionId: string | null) => {
    const a = dockApi.current;
    if (!a) return;
    for (const id of SESSION_SCOPED) {
      a.getPanel(id)?.api.updateParameters({ sessionId });
    }
  }, []);

  const openChatPanel = useCallback(
    (sess: SessionMeta) => {
      const a = dockApi.current;
      if (!a) return;
      const id = `chat:${sess.id}`;
      const existing = a.getPanel(id);
      if (existing) {
        existing.api.setActive();
      } else {
        /* chats tab together: later chats join the first chat's group,
           only the first chat carves out the left window */
        const anyChat = a.panels.find((p) => p.id.startsWith("chat:"));
        a.addPanel({
          id,
          component: "chat",
          title: sess.title,
          params: { sessionId: sess.id },
          position: anyChat
            ? { referencePanel: anyChat.id, direction: "within" }
            : { direction: "left" },
        });
      }
      setActiveSessionId(sess.id);
      syncTrajectory(sess.id);
    },
    [syncTrajectory],
  );

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const a = event.api;
      dockApi.current = a;
      dockReady.current = true;

      a.addPanel({
        id: "trajectory",
        component: "trajectory",
        title: "trajectory",
        params: { sessionId: null },
      });

      /* closing a terminal tab kills its pty */
      a.onDidRemovePanel((panel) => {
        if (panel.id.startsWith("term:")) void api.closeTerminal(panel.id.slice(5));
      });

      a.onDidActivePanelChange((panel) => {
        const id = panel?.id.startsWith("chat:") ? panel.id.slice(5) : null;
        if (id) {
          setActiveSessionId(id);
          syncTrajectory(id);
        }
      });

      /* defer mutations past the ready frame — synchronous adds during onReady
         hit dockview's parentless-element race ("Invalid grid element") */
      requestAnimationFrame(() => {
        void openTerminalPanel(); /* initial terminal tab below the trajectory */
        openInitialSession();
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [openChatPanel, syncTrajectory],
  );

  /* open the most recent live session once — fires when BOTH dock + sessions are ready */
  const dockReady = useRef(false);
  const initialOpened = useRef(false);
  function openInitialSession() {
    if (!dockReady.current || initialOpened.current || store.sessions.size === 0) return;
    initialOpened.current = true;
    /* latest session even if closed — its transcript is the point of persistence */
    const latest = [...store.sessions.values()].sort((x, y) => y.updated_at - x.updated_at)[0];
    if (latest) openChatPanel(latest);
  }

  /* sessions may arrive after dock ready (async init) */
  useEffect(() => {
    openInitialSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const onOpenSession = useCallback(
    (id: string) => {
      const sess = store.sessions.get(id);
      if (sess) openChatPanel(sess);
    },
    [openChatPanel],
  );

  /** spawn a fresh pty and open it as a terminal tab in the bottom-right stack */
  async function openTerminalPanel() {
    const a = dockApi.current;
    if (!a) return;
    const t = await api.createTerminal({});
    const anyTerm = a.panels.find((p) => p.id.startsWith("term:"));
    a.addPanel({
      id: `term:${t.id}`,
      component: "terminal",
      title: t.title,
      params: { terminalId: t.id },
      position: anyTerm
        ? { referencePanel: anyTerm.id, direction: "within" }
        : { referencePanel: "trajectory", direction: "below" },
    });
  }

  const onOpenPanel = useCallback((kind: string) => {
    const a = dockApi.current;
    if (!a) return;
    if (kind === "trajectory") {
      a.getPanel("trajectory")?.api.setActive();
      return;
    }
    if (kind === "terminal") {
      void openTerminalPanel(); // every click = a fresh shell tab
      return;
    }
    const existing = a.getPanel(kind);
    if (existing) {
      existing.api.setActive();
      /* late-opened session-scoped panels get the current selection immediately */
      if (SESSION_SCOPED.includes(kind)) {
        existing.api.updateParameters({ sessionId: activeRef.current });
      }
    } else {
      a.addPanel({
        id: kind,
        component: kind,
        title: PANEL_DEFS[kind]?.title ?? kind,
        params: SESSION_SCOPED.includes(kind) ? { sessionId: activeRef.current } : {},
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* sidebar drag — 1px overlay handle, ±3px target */
  const startSideDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sideWidth;
      const move = (ev: MouseEvent) => {
        setSideWidth(Math.min(480, Math.max(140, startW + ev.clientX - startX)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [sideWidth],
  );

  return (
    <div className="frame">
      <Sprite />
      <div style={{ width: sideWidth, flex: "none", display: "flex", minWidth: 0 }}>
        <Sidebar
          activeSessionId={activeSessionId}
          onOpenSession={onOpenSession}
          onOpenPanel={onOpenPanel}
          onNewSession={() => setShowNew(true)}
        />
      </div>
      <div className="splitside" onMouseDown={startSideDrag} title="drag to resize sidebar" />
      <div className="ws">
        <div className="dock-host">
          <DockviewReact components={dockComponents} onReady={onReady} theme={themeAbyss} />
        </div>
      </div>
      <StatusBar activeSessionId={activeSessionId} />
      {showNew && (
        <NewSessionModal
          onClose={() => setShowNew(false)}
          onCreated={(sess) => {
            setShowNew(false);
            openChatPanel(sess);
          }}
        />
      )}
    </div>
  );
}

/* ── new session modal ── */

function NewSessionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: SessionMeta) => void;
}) {
  const s = useStore();
  const [harness, setHarness] = useState("pi");
  const [cwd, setCwd] = useState("~/projects");
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = s.models.filter((m) => m.harness === harness);
  const chosen = models.find((m) => m.model === model) ?? models[0];

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await api.createSession({
        harness,
        cwd: cwd.replace(/^~/, "/home/ubuntu"),
        model: chosen?.model,
        provider: chosen?.provider,
        project: project.trim() || undefined,
      });
      await store.refreshSessions();
      onCreated(session);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>new session</h2>
        <div>
          <label>harness</label>
          <select
            value={harness}
            onChange={(e) => {
              setHarness(e.target.value);
              setModel("");
            }}
          >
            {s.harnesses.map((h) => (
              <option key={h.id} value={h.id}>
                {h.id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>model</label>
          {models.length > 0 ? (
            <select value={chosen?.model ?? ""} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <input value="harness default" disabled />
          )}
        </div>
        <div>
          <label>working directory</label>
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </div>
        <div>
          <label>project group (optional)</label>
          <input
            value={project}
            placeholder="ungrouped"
            onChange={(e) => setProject(e.target.value)}
          />
        </div>
        {error && <div style={{ color: "var(--red)", fontSize: 11.5 }}>{error}</div>}
        <div className="row2">
          <button className="btn-ghost" onClick={onClose}>
            cancel
          </button>
          <button className="btn-solid" disabled={busy || !chosen} onClick={() => void create()}>
            {busy ? "spawning…" : "create"}
          </button>
        </div>
      </div>
    </div>
  );
}
