import type { DockviewApi, AddPanelOptions } from "dockview-react";
import { store } from "./store";

/** Bridge between the rest of the app and the Dockview instance (the "dockBus"). */
export type PanelKind = "chat" | "trajectory" | "terminal" | "context" | "team" | "skills" | "welcome";

let api: DockviewApi | null = null;
export const setDockApi = (a: DockviewApi | null) => (api = a);
export const getDockApi = () => api;

const TITLES: Record<PanelKind, string> = {
  chat: "Chat",
  trajectory: "Trajectory",
  terminal: "Shell",
  context: "Context",
  team: "Team",
  skills: "Skills",
  welcome: "Welcome",
};

export function panelId(kind: PanelKind, key?: string) {
  return key ? `${kind}:${key}` : kind;
}

function titleFor(kind: PanelKind, sessionId?: string, fallback?: string) {
  const s = sessionId ? store.state.sessions[sessionId] : undefined;
  if (kind === "chat") return s?.title ?? fallback ?? "Chat";
  return s ? `${TITLES[kind]} · ${s.title}` : fallback ?? TITLES[kind];
}

/** Open or focus a panel. Side panels dock next to the session's chat when it's open. */
export function openPanel(kind: PanelKind, opts: { sessionId?: string; terminalId?: string; cwd?: string; title?: string } = {}) {
  if (!api) return;
  const key = kind === "terminal" ? opts.terminalId : kind === "skills" ? opts.sessionId ?? opts.cwd : opts.sessionId;
  const id = panelId(kind, key);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return existing;
  }
  const welcome = api.getPanel("welcome");
  const params = { sessionId: opts.sessionId, terminalId: opts.terminalId, cwd: opts.cwd };
  let position: AddPanelOptions["position"] | undefined;
  const chat = opts.sessionId ? api.getPanel(panelId("chat", opts.sessionId)) : undefined;
  if (kind === "chat") {
    const anyChat = api.panels.find((p) => p.id.startsWith("chat:"));
    if (anyChat) position = { referencePanel: anyChat.id, direction: "within" };
    else if (welcome) position = { referencePanel: "welcome", direction: "within" };
  } else if (kind === "trajectory" && chat) {
    const sibling = api.panels.find((p) => p.id.startsWith("trajectory:") && p.group !== chat.group);
    position = sibling ? { referencePanel: sibling.id, direction: "within" } : { referencePanel: chat.id, direction: "right" };
  } else if (kind === "terminal") {
    const other = api.panels.find((p) => p.id.startsWith("terminal:"));
    position = other ? { referencePanel: other.id, direction: "within" } : chat ? { referencePanel: chat.id, direction: "below" } : undefined;
  } else if (kind === "context" || kind === "team" || kind === "skills") {
    const other = api.panels.find((p) => /^(context|team|skills):/.test(p.id));
    const traj = opts.sessionId ? api.getPanel(panelId("trajectory", opts.sessionId)) : undefined;
    position = other
      ? { referencePanel: other.id, direction: "within" }
      : traj
        ? { referencePanel: traj.id, direction: "below" }
        : chat
          ? { referencePanel: chat.id, direction: "right" }
          : undefined;
  }
  const panel = api.addPanel({
    id,
    component: kind,
    tabComponent: "truss",
    title: opts.title ?? titleFor(kind, opts.sessionId),
    params,
    ...(position ? { position } : {}),
  });
  if (welcome && kind === "chat") welcome.api.close();
  return panel;
}

export function renameSessionPanels(sessionId: string, title: string) {
  if (!api) return;
  for (const kind of ["chat", "trajectory", "context", "team", "skills"] as PanelKind[]) {
    const p = api.getPanel(panelId(kind, sessionId));
    const want = kind === "chat" ? title : `${TITLES[kind]} · ${title}`;
    if (p && p.title !== want) p.api.setTitle(want);
  }
}

/** The daily driver: chat | trajectory over context, shell below. */
export async function openDailyDriver(sessionId: string) {
  openPanel("chat", { sessionId });
  openPanel("trajectory", { sessionId });
  openPanel("context", { sessionId });
}

export async function openAgentShell(sessionId: string) {
  const s = store.state.sessions[sessionId];
  if (!s) return;
  try {
    const t = await store.createTerminal({ cwd: s.cwd, title: `shell · ${s.title}` });
    openPanel("terminal", { terminalId: t.id, sessionId, title: t.title ?? `shell · ${s.title}` });
  } catch (e: any) {
    store.toast("error", "Couldn't start agent shell", e.message);
  }
}

export async function openFreeShell(cwd?: string) {
  try {
    const t = await store.createTerminal({ cwd, title: "shell" });
    openPanel("terminal", { terminalId: t.id, title: t.title ?? "shell" });
  } catch (e: any) {
    store.toast("error", "Couldn't start shell", e.message);
  }
}
