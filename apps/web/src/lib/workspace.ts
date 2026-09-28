import type { AddPanelOptions } from "dockview-react";
import { store } from "./store";
import { desktops } from "./desktops";

/** Bridge between the rest of the app and the Dockview instance (the "dockBus"). */
export type PanelKind = "chat" | "trajectory" | "terminal" | "context" | "team" | "skills" | "files" | "git" | "tasks" | "todos" | "feed" | "monitor" | "welcome" | "host" | "settings" | "cost" | "credentials" | "router";

export const getDockApi = (spaceId?: string) => desktops.getApi(spaceId);

const TITLES: Record<PanelKind, string> = {
  chat: "Chat",
  trajectory: "Trajectory",
  terminal: "Shell",
  context: "Context",
  team: "Team",
  skills: "Skills",
  files: "Files",
  git: "Git",
  tasks: "Tasks",
  todos: "Todos",
  feed: "Feed",
  monitor: "Monitor",
  welcome: "Welcome",
  host: "Host",
  settings: "Settings",
  cost: "Cost",
  credentials: "Credentials",
  router: "Router",
};

export function panelId(kind: PanelKind, key?: string) {
  return key ? `${kind}:${key}` : kind;
}

function titleFor(kind: PanelKind, sessionId?: string, fallback?: string) {
  const s = sessionId ? store.state.sessions[sessionId] : undefined;
  if (kind === "chat") return s?.title ?? fallback ?? "Chat";
  return s ? `${TITLES[kind]} · ${s.title}` : fallback ?? TITLES[kind];
}

export interface OpenPanelOptions {
  sessionId?: string;
  terminalId?: string;
  hostId?: string;
  cwd?: string;
  title?: string;
  spaceId?: string;
  groupId?: string;
}

/** Open in the current desktop. A session can have a tab in *every* desktop. */
export function openPanel(kind: PanelKind, opts: OpenPanelOptions = {}) {
  const api = getDockApi(opts.spaceId);
  if (!api || !desktops.isReady(opts.spaceId)) {
    store.toast("info", "Workspace is still opening", "Try adding the tab again in a moment.");
    return;
  }
  const key =
    kind === "terminal" ? opts.terminalId
    : kind === "host" ? opts.hostId
    : kind === "skills" || kind === "files" || kind === "git" ? opts.sessionId ?? opts.cwd
    : kind === "tasks" ? (opts.sessionId ?? opts.cwd ?? "global")
    : kind === "todos" || kind === "feed" || kind === "monitor" ? undefined
    
    : opts.sessionId;
  const id = panelId(kind, key);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return existing;
  }
  const welcome = api.getPanel("welcome");
  const params = { sessionId: opts.sessionId, terminalId: opts.terminalId, hostId: opts.hostId, cwd: opts.cwd };
  let position: AddPanelOptions["position"] | undefined;
  const chat = opts.sessionId ? api.getPanel(panelId("chat", opts.sessionId)) : undefined;
  if (opts.groupId && api.getGroup(opts.groupId)) {
    position = { referenceGroup: opts.groupId, direction: "within" };
  } else if (kind === "host" || kind === "settings" || kind === "welcome") {
    if (api.activePanel) position = { referencePanel: api.activePanel.id, direction: "within" };
  } else if (kind === "chat") {
    const anyChat = api.panels.find((p) => p.id.startsWith("chat:"));
    if (anyChat) position = { referencePanel: anyChat.id, direction: "within" };
    else if (welcome) position = { referencePanel: "welcome", direction: "within" };
  } else if (kind === "trajectory" && chat) {
    const sibling = api.panels.find((p) => p.id.startsWith("trajectory:") && p.group !== chat.group);
    position = sibling ? { referencePanel: sibling.id, direction: "within" } : { referencePanel: chat.id, direction: "right" };
  } else if (kind === "terminal") {
    const other = api.panels.find((p) => p.id.startsWith("terminal:"));
    position = other ? { referencePanel: other.id, direction: "within" } : chat ? { referencePanel: chat.id, direction: "below" } : undefined;
  } else if (kind === "context" || kind === "team" || kind === "skills" || kind === "files" || kind === "git" || kind === "tasks") {
    const other = api.panels.find((p) => /^(context|team|skills|files|git|tasks):/.test(p.id));
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
  for (const space of desktops.state.spaces) {
    const api = getDockApi(space.id);
    if (!api) continue;
    for (const kind of ["chat", "trajectory", "context", "team", "skills"] as PanelKind[]) {
      const p = api.getPanel(panelId(kind, sessionId));
      const want = kind === "chat" ? title : `${TITLES[kind]} · ${title}`;
      if (p && p.title !== want) p.api.setTitle(want);
    }
  }
}

export function renameHostPanels(hostId: string, title: string) {
  for (const space of desktops.state.spaces) {
    const panel = getDockApi(space.id)?.getPanel(`host:${hostId}`);
    if (panel && panel.title !== title) panel.api.setTitle(title);
  }
}

export function openSession(sessionId: string) {
  if (desktops.state.settings.openMode === "daily") return openDailyDriver(sessionId);
  openPanel("chat", { sessionId });
}

/** The daily driver: chat | trajectory over context, shell below. */
export function openDailyDriver(sessionId: string) {
  openPanel("chat", { sessionId });
  openPanel("trajectory", { sessionId });
  openPanel("context", { sessionId });
}

export async function openAgentShell(sessionId: string, opts: { spaceId?: string; groupId?: string } = {}) {
  const s = store.state.sessions[sessionId];
  if (!s) return;
  const spaceId = opts.spaceId ?? desktops.state.activeId;
  let terminalId: string | undefined;
  try {
    const t = await store.createTerminal({ cwd: s.cwd, title: `shell · ${s.title}` });
    terminalId = t.id;
    const panel = openPanel("terminal", { terminalId: t.id, sessionId, title: t.title ?? `shell · ${s.title}`, spaceId, groupId: opts.groupId });
    if (!panel) await store.deleteTerminal(t.id);
  } catch (e: any) {
    if (terminalId) await store.deleteTerminal(terminalId);
    store.toast("error", "Couldn't start agent shell", e.message);
  }
}

export async function openFreeShell(cwd?: string, opts: { spaceId?: string; groupId?: string } = {}) {
  const spaceId = opts.spaceId ?? desktops.state.activeId;
  let terminalId: string | undefined;
  try {
    const t = await store.createTerminal({ cwd, title: "shell" });
    terminalId = t.id;
    const panel = openPanel("terminal", { terminalId: t.id, title: t.title ?? "shell", spaceId, groupId: opts.groupId });
    if (!panel) await store.deleteTerminal(t.id);
  } catch (e: any) {
    if (terminalId) await store.deleteTerminal(terminalId);
    store.toast("error", "Couldn't start shell", e.message);
  }
}
