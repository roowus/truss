import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { store, useApp } from "@/lib/store";
import { desktops, useDesktops } from "@/lib/desktops";
import { openFreeShell, openPanel } from "@/lib/workspace";
import { shortPath } from "@/lib/format";
import { HarnessMark, Icon } from "./ui";

const ICONS: Record<string, string> = {
  chat: "chat", trajectory: "wave", context: "gauge", team: "tree",
  skills: "spark", files: "folder", git: "tree", tasks: "check", todos: "check", feed: "bolt", monitor: "gauge",
  terminal: "term", host: "host", settings: "settings", welcome: "layout",
};

interface Props {
  anchor: HTMLElement;
  spaceId: string;
  groupId?: string;
  onClose: () => void;
}

/** One picker for the prominent + Tab button and each dock group's + button. */
export function TabPicker({ anchor, spaceId, groupId, onClose }: Props) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const order = useApp((s) => s.order);
  const sessionMap = useApp((s) => s.sessions);
  const sessions = order.map((id) => sessionMap[id]).filter(Boolean);
  const agents = useApp((s) => s.agents);
  const agentError = useApp((s) => s.agentsError);
  const hostPrefs = useDesktops((s) => s.hosts);
  const spaces = useDesktops((s) => s.spaces);
  const [pos, setPos] = useState(() => position(anchor));

  useEffect(() => {
    input.current?.focus();
    const update = () => setPos(position(anchor));
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", update);
    };
  }, [anchor, onClose]);

  const q = query.toLowerCase().trim();
  const match = (str: string) => !q || str.toLowerCase().includes(q);
  const currentApi = desktops.getApi(spaceId);
  const targetGroupId = groupId ?? currentApi?.activePanel?.group.id;
  const groupSession = targetGroupId ? currentApi?.getGroup(targetGroupId)?.activePanel?.params?.sessionId : undefined;
  const focusId = (groupSession ?? currentApi?.activePanel?.params?.sessionId ?? store.state.focused) as string | undefined;
  const focus = focusId ? store.state.sessions[focusId] : undefined;
  const filteredSessions = sessions.filter((s) => match(`${s.title} ${s.harness} ${s.cwd} ${s.project ?? ""}`)).slice(0, 14);
  const otherTabs = useMemo(() => desktops.findOtherTabs(spaceId).filter(({ panel, spaceName }) =>
    !currentApi?.getPanel(panel.id) && match(`${panel.title} ${spaceName} ${panel.id}`),
  ).slice(0, 10), [spaceId, spaces, sessions, query]);

  const run = (fn: () => void) => { onClose(); fn(); };
  const panel = (kind: "chat" | "trajectory" | "context" | "team" | "skills" | "files" | "git" | "tasks") =>
    focusId && run(() => openPanel(kind, { sessionId: focusId, spaceId, groupId: targetGroupId, cwd: focus?.cwd }));

  return createPortal(
    <>
      <div className="fixed inset-0 z-[170]" onPointerDown={onClose} />
      <div
        role="dialog"
        aria-label="Add tab"
        className="fixed z-[171] w-[320px] max-w-[calc(100vw-16px)] max-h-[min(500px,calc(100vh-24px))] flex flex-col rounded-lg border border-[var(--t-line2)] bg-[var(--t-bg2)] shadow-2xl t-pop"
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-[var(--t-line)]">
          <Icon name="search" size={13} className="text-[var(--t-dim)]" />
          <input ref={input} aria-label="Search tabs" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add a tab…" className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
        </div>
        <div className="overflow-y-auto t-scroll py-1.5">
          {(!q || match("new session")) && (
            <Row icon="plus" label="New session" onClick={() => run(() => window.dispatchEvent(new CustomEvent("truss:new", { detail: { spaceId, groupId: targetGroupId } })))} />
          )}
          {(!q || match("new shell terminal")) && (
            <Row icon="term" label="New shell" onClick={() => run(() => void openFreeShell(undefined, { spaceId, groupId: targetGroupId }))} />
          )}
          {(!q || match("settings preferences")) && (
            <Row icon="settings" label="Settings" onClick={() => run(() => openPanel("settings", { spaceId, groupId: targetGroupId }))} />
          )}
          {(!q || match("todos checklist tasks user")) && (
            <Row icon="check" label="Todos" onClick={() => run(() => openPanel("todos", { spaceId, groupId: targetGroupId }))} />
          )}
          {(!q || match("feed inbox notifications reports")) && (
            <Row icon="bolt" label="Feed" onClick={() => run(() => openPanel("feed", { spaceId, groupId: targetGroupId }))} />
          )}
          {(!q || match("monitor vitals cpu memory devices")) && (
            <Row icon="gauge" label="Monitor" onClick={() => run(() => openPanel("monitor", { spaceId, groupId: targetGroupId }))} />
          )}
          {(!q || match("cost tokens ledger")) && (
            <Row icon="cost" label="Cost & tokens" onClick={() => run(() => openPanel("cost", { spaceId, groupId: targetGroupId }))} />
          )}
          {(!q || match("credentials keys providers proxy")) && (
            <Row icon="lock" label="Credentials" onClick={() => run(() => openPanel("credentials", { spaceId, groupId: targetGroupId }))} />
          )}
          {(!q || match("router models gateway catalog")) && (
            <Row icon="host" label="Model router" onClick={() => run(() => openPanel("router", { spaceId, groupId: targetGroupId }))} />
          )}
          {(!q || match("welcome")) && (
            <Row icon="layout" label="Welcome" onClick={() => run(() => openPanel("welcome", { spaceId, groupId: targetGroupId }))} />
          )}

          {focus && (
            <>
              <Section>For {focus.title}</Section>
              {(["chat", "trajectory", "context", "team", "files", "git", "skills", "tasks"] as const).filter((kind) => match(kind === "git" ? "git changes branches graph" : kind === "files" ? "files browser workspace" : kind === "tasks" ? "tasks board kanban" : kind)).map((kind) => (
                <Row key={kind} icon={ICONS[kind]} label={kind[0].toUpperCase() + kind.slice(1)} hint={focus.harness} onClick={() => panel(kind)} />
              ))}
            </>
          )}

          {agents.some((a) => match(`${a.hostname} ${hostPrefs[a.hostId]?.alias ?? ""} host`)) && (
            <>
              <Section>Remote hosts</Section>
              {agents.filter((a) => match(`${a.hostname} ${hostPrefs[a.hostId]?.alias ?? ""} host`)).map((a) => (
                <Row key={a.hostId} icon="host" label={hostPrefs[a.hostId]?.alias || a.hostname} hint={a.adapters.join(", ")} onClick={() => run(() => openPanel("host", { hostId: a.hostId, title: hostPrefs[a.hostId]?.alias || a.hostname, spaceId, groupId: targetGroupId }))} />
              ))}
            </>
          )}
          {agentError && match("remote host error") && <div className="px-3 py-1 text-[11px] text-[var(--t-red)]">Remote hosts unavailable: {agentError}</div>}

          {filteredSessions.length > 0 && (
            <>
              <Section>Sessions · open chat</Section>
              {filteredSessions.map((s) => (
                <button key={s.id} onClick={() => run(() => openPanel("chat", { sessionId: s.id, spaceId, groupId: targetGroupId }))} className="w-full flex items-center gap-2.5 px-3 h-8 text-left hover:bg-white/[0.05]">
                  <HarnessMark harness={s.harness} size={16} />
                  <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--t-fg2)]">{s.title}</span>
                  <span className="text-[10.5px] text-[var(--t-dim)] truncate max-w-[90px]">{shortPath(s.cwd)}</span>
                </button>
              ))}
            </>
          )}

          {otherTabs.length > 0 && (
            <>
              <Section>From another workspace</Section>
              {otherTabs.map(({ panel: tab, spaceId: from, spaceName }) => (
                <Row key={`${from}:${tab.id}`} icon={ICONS[tab.id.split(":")[0]] || "layout"} label={tab.title || tab.id} hint={spaceName} onClick={() => run(() => desktops.transferPanel(from, tab.id, spaceId, false, targetGroupId, false))} />
              ))}
            </>
          )}

          {q && !filteredSessions.length && !otherTabs.length && !agents.some((a) => match(a.hostname)) &&
            !["new session", "new shell", "settings", "welcome", "chat", "trajectory", "context", "team", "skills"].some(match) && (
              <div className="py-5 text-center text-[12px] text-[var(--t-dim)]">No matching tabs.</div>
            )}
        </div>
        <div className="shrink-0 border-t border-[var(--t-line)] px-3 py-1.5 text-[10.5px] text-[var(--t-dim)]">
          Tabs can also be copied or moved between workspaces by right-clicking a tab.
        </div>
      </div>
    </>,
    document.body,
  );
}

function position(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 16);
  return {
    left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 512)),
  };
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--t-dim)] truncate">{children}</div>;
}

function Row({ icon, label, hint, onClick }: { icon: string; label: string; hint?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2.5 px-3 h-8 text-left hover:bg-white/[0.05]">
      <Icon name={icon} size={13} className="text-[var(--t-mute)]" />
      <span className="flex-1 truncate text-[12px] text-[var(--t-fg2)]">{label}</span>
      {hint && <span className="text-[10.5px] text-[var(--t-dim)] truncate max-w-[84px]">{hint}</span>}
    </button>
  );
}