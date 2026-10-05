import { useCallback, useRef, useSyncExternalStore } from "react";
import type { DockviewApi, IDockviewPanel, SerializedDockview } from "dockview-react";
import { normalizeLayoutSizes } from "./layoutSanitize";
import { canClose, nextActiveAfterClose, popClosed, pushClosed, terminalIdsInLayout, type ClosedSnapshot } from "./workspaceClose";
import type { Backend } from "./backend";
import { store } from "./store";

export interface Desktop {
  id: string;
  name: string;
  layout: SerializedDockview | null;
  /** archived workspaces hide from the strip but keep their layout */
  archived?: boolean;
}

export interface HostPreference {
  alias: string;
  defaultCwd: string;
  defaultProject: string;
  preferredAdapter: string;
}

export interface FeedSourceSettings {
  permissions: boolean;
  workDone: boolean;
  taskRuns: boolean;
  errors: boolean;
  context: boolean;
}

export interface DoubletakeSettings {
  enabled: boolean;
  baseUrl: string;
  token: string;
}

export interface UiSettings {
  density: "comfortable" | "compact";
  openMode: "chat" | "daily";
  terminalFontSize: number;
  defaultCwd: string;
  groupMode: "project" | "folder";
  /** which system events auto-post to the feed (read server-side too) */
  feedSources: FeedSourceSettings;
  /** doubletake integration (research-ready feed cards); read server-side */
  doubletake: DoubletakeSettings;
}

interface DesktopState {
  spaces: Desktop[];
  activeId: string;
  hosts: Record<string, HostPreference>;
  settings: UiSettings;
  loadError?: string;
  saveStatus: "idle" | "saving" | "saved" | "error";
}

interface SavedDocument {
  version: 2;
  activeId: string;
  spaces: Desktop[];
  hosts: Record<string, HostPreference>;
  settings: UiSettings;
}

const defaultSettings: UiSettings = {
  density: "comfortable",
  openMode: "chat",
  terminalFontSize: 13,
  defaultCwd: "",
  groupMode: "project",
  feedSources: { permissions: true, workDone: true, taskRuns: true, errors: true, context: true },
  doubletake: { enabled: false, baseUrl: "", token: "" },
};

function freshState(): DesktopState {
  return {
    spaces: [{ id: "main", name: "Main", layout: null }],
    activeId: "main",
    hosts: {},
    settings: { ...defaultSettings },
    saveStatus: "idle",
  };
}

function parseSaved(raw: string): DesktopState {
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object") throw new Error("layout is not an object");
  const doc = data as Record<string, any>;
  // A pre-workspaces install stored Dockview JSON directly in /api/layout.
  if (doc.grid && doc.panels) {
    return { ...freshState(), spaces: [{ id: "main", name: "Main", layout: doc as SerializedDockview }] };
  }
  if (doc.version !== 2 || !Array.isArray(doc.spaces) || !doc.spaces.length) {
    throw new Error("unknown layout format");
  }
  const spaces: Desktop[] = doc.spaces.map((s: any) => {
    if (!s || typeof s.id !== "string" || typeof s.name !== "string") throw new Error("invalid workspace entry");
    return { id: s.id, name: s.name, layout: s.layout?.grid && s.layout?.panels ? s.layout : null, archived: s.archived === true };
  });
  const ids = new Set(spaces.map((s) => s.id));
  if (ids.size !== spaces.length) throw new Error("duplicate workspace ids");
  const cfg = doc.settings && typeof doc.settings === "object" ? doc.settings : {};
  return {
    spaces,
    activeId: ids.has(doc.activeId) ? doc.activeId : spaces[0].id,
    hosts: doc.hosts && typeof doc.hosts === "object" && !Array.isArray(doc.hosts) ? doc.hosts : {},
    settings: {
      density: cfg.density === "compact" ? "compact" : "comfortable",
      openMode: cfg.openMode === "daily" ? "daily" : "chat",
      terminalFontSize: [11, 12, 13, 14, 16].includes(cfg.terminalFontSize) ? cfg.terminalFontSize : 13,
      defaultCwd: typeof cfg.defaultCwd === "string" ? cfg.defaultCwd : "",
      groupMode: cfg.groupMode === "folder" ? "folder" : "project",
      feedSources: {
        permissions: cfg.feedSources?.permissions !== false,
        workDone: cfg.feedSources?.workDone !== false,
        taskRuns: cfg.feedSources?.taskRuns !== false,
        errors: cfg.feedSources?.errors !== false,
        context: cfg.feedSources?.context !== false,
      },
      doubletake: {
        enabled: cfg.doubletake?.enabled === true,
        baseUrl: typeof cfg.doubletake?.baseUrl === "string" ? cfg.doubletake.baseUrl : "",
        token: typeof cfg.doubletake?.token === "string" ? cfg.doubletake.token : "",
      },
    },
    saveStatus: "idle",
  };
}

class DesktopManager {
  state: DesktopState = freshState();
  private subscribers = new Set<() => void>();
  private apis = new Map<string, DockviewApi>();
  private ready = new Set<string>();
  private timer: number | undefined;
  private revision = 0;
  private writing = false;
  private suppressedTerminals = new Set<string>();
  /** Undo stack for "reopen what I closed" (Chrome's Cmd+Shift+T); session-only, capped. */
  private closedStack: ClosedSnapshot[] = [];

  subscribe = (listener: () => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  private set(patch: Partial<DesktopState>) {
    this.state = { ...this.state, ...patch };
    this.subscribers.forEach((fn) => fn());
  }

  async load(backend: Backend) {
    try {
      const { layout } = await backend.getLayout();
      this.set(layout ? parseSaved(layout) : freshState());
    } catch (e: any) {
      const msg = `Could not restore workspaces from /api/layout: ${e?.message ?? e}. A temporary Main workspace is shown; changes will retry saving.`;
      this.set({ ...freshState(), loadError: msg });
      store.toast("error", "Workspace restore failed", msg);
    }
  }

  getApi(id = this.state.activeId) {
    return this.apis.get(id) ?? null;
  }

  isReady(id = this.state.activeId) {
    return this.ready.has(id);
  }

  /** Each desktop stays mounted, keeping its tabs, scroll positions, and live sockets. */
  register(id: string, api: DockviewApi) {
    this.apis.set(id, api);
    let alive = true;
    let restoring = true;
    const layoutChanged = api.onDidLayoutChange(() => {
      if (!restoring && alive) this.capture(id);
    });
    const removed = api.onDidRemovePanel((panel) => {
      if (restoring || !alive) return;
      if (panel.id.startsWith("terminal:")) this.cleanupTerminalLater(panel.id.slice("terminal:".length));
    });
    const active = api.onDidActivePanelChange((event) => {
      if (!alive || this.state.activeId !== id) return;
      const panel = event.panel;
      store.focus(panel?.params?.sessionId as string | undefined);
    });

    // Dockview's grid is not ready during onReady; adding panels here synchronously throws.
    requestAnimationFrame(() => {
      if (!alive) return;
      const space = this.state.spaces.find((s) => s.id === id);
      if (space?.layout) {
        try {
          /* clamp phantom-thin groups back to usable sizes first — a squeezed
             layout restores forever otherwise (the 2px group whose header
             painted its tabs over the neighbor) */
          api.fromJSON(normalizeLayoutSizes(space.layout));
        } catch (e: any) {
          const msg = `Workspace "${space.name}" could not restore its tabs: ${e?.message ?? e}`;
          this.set({ loadError: msg });
          store.toast("error", "Layout error", msg);
          api.clear();
        }
      } else if (id === "main" && !space?.layout) {
        const first = store.state.order[0];
        if (first) {
          api.addPanel({ id: `chat:${first}`, component: "chat", tabComponent: "truss", title: store.state.sessions[first]?.title ?? "Chat", params: { sessionId: first } });
        } else {
          api.addPanel({ id: "welcome", component: "welcome", tabComponent: "truss", title: "Welcome" });
        }
      }
      restoring = false;
      this.ready.add(id);
      if (id === this.state.activeId) store.focus(api.activePanel?.params?.sessionId as string | undefined);
      this.capture(id);
    });

    return () => {
      alive = false;
      layoutChanged.dispose();
      removed.dispose();
      active.dispose();
      if (this.apis.get(id) === api) {
        this.apis.delete(id);
        this.ready.delete(id);
      }
    };
  }

  private capture(id: string) {
    const api = this.apis.get(id);
    if (!api || !this.state.spaces.some((s) => s.id === id)) return;
    try {
      const layout = api.toJSON();
      this.set({ spaces: this.state.spaces.map((s) => (s.id === id ? { ...s, layout } : s)) });
      this.queueSave();
    } catch (e: any) {
      store.toast("error", "Could not snapshot workspace", e?.message ?? String(e));
    }
  }

  private snapshot(): SavedDocument {
    return {
      version: 2,
      activeId: this.state.activeId,
      spaces: this.state.spaces.map((s) => {
        const api = this.apis.get(s.id);
        return { ...s, layout: api ? api.toJSON() : s.layout };
      }),
      hosts: this.state.hosts,
      settings: this.state.settings,
    };
  }

  private queueSave() {
    this.revision++;
    this.set({ saveStatus: "saving" });
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 650);
  }

  private async flush() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (true) {
        const revision = this.revision;
        try {
          await store.be.putLayout(JSON.stringify(this.snapshot()));
        } catch (e: any) {
          this.set({ saveStatus: "error" });
          store.toast("error", "Workspace changes not saved", e?.message ?? String(e));
          return;
        }
        if (revision === this.revision) {
          this.set({ saveStatus: "saved", loadError: undefined });
          return;
        }
      }
    } finally {
      this.writing = false;
    }
  }

  retrySave() {
    this.queueSave();
  }

  dismissLoadError() {
    this.set({ loadError: undefined });
  }

  switchTo(id: string) {
    if (id === this.state.activeId || !this.state.spaces.some((s) => s.id === id)) return;
    this.set({ activeId: id });
    const active = this.apis.get(id)?.activePanel;
    store.focus(active?.params?.sessionId as string | undefined);
    this.queueSave();
  }

  create(name?: string, layout?: SerializedDockview | null) {
    const used = new Set(this.state.spaces.map((s) => s.name));
    let n = this.state.spaces.length + 1;
    while (used.has(`Workspace ${n}`)) n++;
    const id = `desk-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    const space = { id, name: name?.trim() || `Workspace ${n}`, layout: layout ?? null };
    this.set({ spaces: [...this.state.spaces, space], activeId: id });
    store.focus(undefined);
    this.queueSave();
    return id;
  }

  duplicate(id: string) {
    const space = this.state.spaces.find((s) => s.id === id);
    if (!space) return;
    const layout = this.apis.get(id)?.toJSON() ?? space.layout;
    return this.create(`${space.name} copy`, layout);
  }

  rename(id: string, name: string) {
    const trimmed = name.trim().slice(0, 32);
    if (!trimmed) return;
    this.set({ spaces: this.state.spaces.map((s) => (s.id === id ? { ...s, name: trimmed } : s)) });
    this.queueSave();
  }

  archive(id: string, archived = true) {
    const live = this.state.spaces.filter((s) => !s.archived);
    if (archived && live.length < 2) return; // never archive the last visible workspace
    let activeId = this.state.activeId;
    if (archived && id === activeId) activeId = live.find((s) => s.id !== id)?.id ?? live[0]?.id ?? activeId;
    this.set({ spaces: this.state.spaces.map((s) => (s.id === id ? { ...s, archived } : s)), activeId });
    this.queueSave();
  }

  remove(id: string) {
    const index = this.state.spaces.findIndex((s) => s.id === id);
    if (index < 0) return;
    const live = this.state.spaces.filter((s) => !s.archived);
    if (!canClose(live, id)) return; // the last visible workspace always stands
    const api = this.apis.get(id);
    const space = this.state.spaces[index];
    const layout = api ? api.toJSON() : space.layout;
    this.closedStack = pushClosed(this.closedStack, { name: space.name, layout, at: Date.now() });
    const terminals = api
      ? api.panels.filter((p) => p.id.startsWith("terminal:")).map((p) => p.id.slice(9))
      : terminalIdsInLayout(space.layout);
    const spaces = this.state.spaces.filter((s) => s.id !== id);
    const activeId = nextActiveAfterClose(live, id, this.state.activeId);
    this.set({ spaces, activeId });
    store.focus(this.apis.get(activeId)?.activePanel?.params?.sessionId as string | undefined);
    for (const tid of terminals) this.cleanupTerminalLater(tid);
    this.queueSave();
    /* The chord is browser-reserved in some tabs, so name the sure path too. */
    store.toast("info", `Closed workspace "${space.name}"`, "Reopen it from the command palette (Ctrl/⌘ K) or with Ctrl/⌘ Shift+T.");
  }

  /** The workspace reopenClosed() would restore, or null when the undo stack is empty. */
  peekClosed() {
    return this.closedStack[this.closedStack.length - 1] ?? null;
  }

  /** Chrome's Cmd+Shift+T: the last closed workspace returns with its name and layout. */
  reopenClosed() {
    const popped = popClosed(this.closedStack);
    if (!popped) return null;
    this.closedStack = popped.rest;
    return this.create(popped.snapshot.name, (popped.snapshot.layout as SerializedDockview | null) ?? null);
  }

  updateSettings(patch: Partial<UiSettings>) {
    this.set({ settings: { ...this.state.settings, ...patch } });
    this.queueSave();
  }

  updateHost(hostId: string, patch: Partial<HostPreference>) {
    const current = this.state.hosts[hostId] ?? { alias: "", defaultCwd: "", defaultProject: "", preferredAdapter: "" };
    this.set({ hosts: { ...this.state.hosts, [hostId]: { ...current, ...patch } } });
    this.queueSave();
  }

  transferPanel(from: string, panelId: string, to: string, move = false, groupId?: string, switchAfter = true) {
    if (from === to) return;
    const source = this.apis.get(from)?.getPanel(panelId);
    const target = this.apis.get(to);
    if (!source || !target || !this.ready.has(from) || !this.ready.has(to)) {
      store.toast("error", "Could not transfer tab", "One workspace is still loading. Try again shortly.");
      return;
    }
    try {
      let panel = target.getPanel(panelId);
      if (!panel) {
        const data = source.toJSON();
        panel = target.addPanel({
          id: source.id,
          component: data.contentComponent ?? source.id.split(":")[0],
          tabComponent: data.tabComponent ?? "truss",
          title: source.title,
          params: source.params,
          ...(groupId && target.getGroup(groupId) ? { position: { referenceGroup: groupId, direction: "within" as const } } : {}),
        });
      }
      panel.api.setActive();
      if (move) source.api.close();
      if (switchAfter) this.switchTo(to);
    } catch (e: any) {
      store.toast("error", "Could not transfer tab", e?.message ?? String(e));
    }
  }

  findOtherTabs(targetId: string): { spaceId: string; spaceName: string; panel: IDockviewPanel }[] {
    return this.state.spaces.flatMap((space) => {
      if (space.id === targetId) return [];
      const api = this.apis.get(space.id);
      return (api?.panels ?? []).map((panel) => ({ spaceId: space.id, spaceName: space.name, panel }));
    });
  }

  private cleanupTerminalLater(id: string) {
    window.setTimeout(() => {
      if (this.suppressedTerminals.has(id)) return;
      const stillOpen = this.state.spaces.some((s) => {
        const api = this.apis.get(s.id);
        return api ? !!api.getPanel(`terminal:${id}`) : !!s.layout?.panels[`terminal:${id}`];
      });
      if (!stillOpen && store.state.terminals.some((t) => t.id === id)) void store.deleteTerminal(id);
    }, 240);
  }

  /** Killing from the shell list closes every view, then disposes the pty once. */
  async killTerminal(id: string) {
    this.suppressedTerminals.add(id);
    for (const api of this.apis.values()) api.getPanel(`terminal:${id}`)?.api.close();
    await store.deleteTerminal(id);
    window.setTimeout(() => this.suppressedTerminals.delete(id), 500);
  }
}

export const desktops = new DesktopManager();

export function useDesktops<T>(selector: (state: DesktopState) => T): T {
  const ref = useRef(selector);
  ref.current = selector;
  const get = useCallback(() => ref.current(desktops.state), []);
  return useSyncExternalStore(desktops.subscribe, get, get);
}