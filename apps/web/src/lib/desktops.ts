import { useCallback, useRef, useSyncExternalStore } from "react";
import type { DockviewApi, IDockviewPanel, SerializedDockview } from "dockview-react";
import { normalizeLayoutSizes } from "./layoutSanitize";
import {
  activePanelToClose,
  canClose,
  canRestore,
  freshPanels,
  nextActiveAfterClose,
  panelsEntry,
  parseClosed,
  pushClosed,
  restoreSpaceId,
  serializeClosed,
  suppressionKey,
  terminalIdsInLayout,
  type ClosedEntry,
} from "./workspaceClose";
import type { Backend } from "./backend";
import { store, toMs } from "./store";
import { marksForFocusChange, seedReadMarks } from "./unread";

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
  /** Undo stack for "reopen what I closed" (Chrome's gesture; the advertised chord is Alt+Shift+T — Chrome's own shape with Alt for Ctrl — with Cmd/Ctrl+Shift+Z as an "undo the close" alias; browsers reserve Cmd/Ctrl+Shift+T). Capped. Mixed: workspaces AND tabs. Lives in state so the Trash panel (issue #146) can browse it live; persisted with the layout doc. */
  closed: ClosedEntry[];
  /** Per-session "read up to here" marks (ms epoch) for the sidebar's
      unread badge (issue #173), persisted with the layout doc. undefined
      means the loaded doc predates the feature — the first-load seed runs
      once sessions arrive and this never stays undefined after that. */
  readAt?: Record<string, number>;
  loadError?: string;
  saveStatus: "idle" | "saving" | "saved" | "error";
}

interface SavedDocument {
  version: 2;
  activeId: string;
  spaces: Desktop[];
  hosts: Record<string, HostPreference>;
  settings: UiSettings;
  /** the closed stack, serialized via serializeClosed (validated on the way back in) */
  closed?: string;
  /** unread read-marks (issue #173); absent on docs written before the feature */
  readAt?: Record<string, number>;
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
    closed: [],
    saveStatus: "idle",
  };
}

/* the doc crosses the wire — keep only sane session-id → ms-epoch entries */
export function parseReadAt(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
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
    closed: parseClosed(doc.closed),
    readAt: parseReadAt(doc.readAt),
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
  /** Panel removals that are machinery, not user closes (moves, kills, batch-close replays) — never undoable. */
  private suppressedPanels = new Set<string>();
  /** Workspaces mid-teardown: any panel removals attributed to them are the workspace entry's business, never tab closes. */
  private closingSpaces = new Set<string>();

  subscribe = (listener: () => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  private set(patch: Partial<DesktopState>) {
    this.state = { ...this.state, ...patch };
    this.subscribers.forEach((fn) => fn());
  }

  async load(backend: Backend) {
    this.wireReadMarks();
    try {
      const { layout } = await backend.getLayout();
      this.set(layout ? parseSaved(layout) : freshState());
    } catch (e: any) {
      const msg = `Could not restore workspaces from /api/layout: ${e?.message ?? e}. A temporary Main workspace is shown; changes will retry saving.`;
      this.set({ ...freshState(), loadError: msg });
      store.toast("error", "Workspace restore failed", msg);
    }
  }

  /* ---- unread read-marks (issue #173) ----
     Focus drives the marks: opening a session (or switching away from it)
     means everything up to that moment was seen. The map persists with the
     layout doc, so the badges survive a reload. */

  private readWired = false;
  private lastReadFocus: string | undefined;

  /** One store subscription for the whole feature; load() is the boot path. */
  private wireReadMarks() {
    if (this.readWired) return;
    this.readWired = true;
    store.subscribe(() => this.onStoreForReadMarks());
    this.onStoreForReadMarks();
  }

  private onStoreForReadMarks() {
    this.maybeSeedReadAt();
    /* legacy doc but the session list is not in yet: the seed (below) will
       baseline everything at once — marking just the focused row now would
       define the map early and skip it */
    if (this.state.readAt === undefined) return;
    const id = store.state.focused;
    if (id === this.lastReadFocus) return;
    const prev = this.lastReadFocus;
    this.lastReadFocus = id;
    /* the mark compares against server-stamped updated_at, so the client
       clock alone is not enough (audit B3): a server running ahead of the
       browser would put activity past the mark and the just-read badge
       would reappear and never clear. Mark up to the newest activity the
       rows on either side of the focus change are already showing. */
    let now = Date.now();
    for (const x of [prev, id]) {
      const s = x ? store.state.sessions[x] : undefined;
      if (s) now = Math.max(now, toMs(s.updated_at));
    }
    const readAt = marksForFocusChange(this.state.readAt, prev, id, now);
    if (readAt) {
      this.set({ readAt });
      this.queueSave();
    }
  }

  /* First boot on a doc that predates the feature: everything already in
     the list is the baseline, marked read at its own updated_at, so the
     upgrade does not paint every row unread. Sessions that appear later
     start unmarked and speak for themselves. */
  private maybeSeedReadAt() {
    if (this.state.readAt !== undefined) return;
    if (!store.state.sessionsLoaded) return;
    const listed = store.state.order.flatMap((id) => {
      const s = store.state.sessions[id];
      return s ? [{ id, updatedAt: toMs(s.updated_at) }] : [];
    });
    this.set({ readAt: seedReadMarks(listed) });
    this.queueSave();
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
      this.recordPanelClose(id, panel);
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
      /* Lift the teardown flag: the canvas is gone and the removal listener
         disposed, so nothing more can arrive for this space. */
      this.closingSpaces.delete(id);
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
      closed: serializeClosed(this.state.closed),
      readAt: this.state.readAt,
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
    const closed = pushClosed(this.state.closed, { type: "workspace", name: space.name, layout, at: Date.now() });
    /* dockview's dispose() does NOT fire onDidRemovePanel (verified in its
       source, round-3 audit) — the flag is pure defense in case a future
       dockview starts emitting removal events during unmount. A flag, not a
       TTL: register's cleanup lifts it whenever the teardown lands. */
    this.closingSpaces.add(id);
    const terminals = api
      ? api.panels.filter((p) => p.id.startsWith("terminal:")).map((p) => p.id.slice(9))
      : terminalIdsInLayout(space.layout);
    const spaces = this.state.spaces.filter((s) => s.id !== id);
    const activeId = nextActiveAfterClose(live, id, this.state.activeId);
    this.set({ spaces, activeId, closed });
    store.focus(this.apis.get(activeId)?.activePanel?.params?.sessionId as string | undefined);
    for (const tid of terminals) this.cleanupTerminalLater(tid);
    this.queueSave();
    /* The chord is browser-reserved in some tabs, so name the sure path too. */
    store.toast("info", `Closed workspace "${space.name}"`, "Reopen it from the command palette (Ctrl/⌘ K) or with Alt+Shift+T.");
  }

  /** The entry reopenClosed() would restore, or null when the undo stack is empty. */
  peekClosed() {
    return this.state.closed[this.state.closed.length - 1] ?? null;
  }

  /**
   * Chrome's reopen gesture on ONE mixed stack: the last thing you closed comes
   * back, whatever it was — a workspace returns with its name and layout; a
   * tab (or a whole group closed in one gesture) re-adds to the workspace it
   * left, or the active one when that workspace is gone. Restored terminals
   * whose shells already stopped degrade to the panel's "shell ended"
   * affordance; reopening inside the 240ms cleanup window keeps the shell.
   */
  reopenClosed() {
    return this.reopenClosedAt(this.state.closed.length - 1);
  }

  /** The Trash panel's targeted restore (issue #146): same semantics as the chord, at a picked index. */
  reopenClosedAt(index: number) {
    const stack = this.state.closed;
    if (index < 0 || index >= stack.length) return null;
    const entry = stack[index];
    const rest = [...stack.slice(0, index), ...stack.slice(index + 1)];
    if (entry.type === "workspace") {
      this.set({ closed: rest });
      return this.create(entry.name, (entry.layout as SerializedDockview | null) ?? null);
    }
    if (!canRestore(entry)) {
      /* a persisted row we cannot restore (another build's shape, or a
         panels row with no panels): say so, then drop it — a silent vanish
         on a Restore click reads as data loss */
      store.toast("info", "That entry can't be restored", "It was written by a different build of truss. Removing it from the list.");
      this.set({ closed: rest });
      this.queueSave();
      return null;
    }
    const spaceId = restoreSpaceId(entry, this.state.spaces, this.state.activeId);
    const api = this.apis.get(spaceId);
    if (!api || !this.ready.has(spaceId)) {
      /* Nothing lost: the entry stays on the stack for the next chord. */
      store.toast("info", "Workspace is still opening", "Try reopening the tab again in a moment.");
      return null;
    }
    try {
      const fresh = freshPanels(entry.panels, (pid) => !!api.getPanel(pid));
      let first: IDockviewPanel | undefined;
      for (const d of fresh) {
        const panel = api.addPanel({
          id: d.id,
          component: d.component,
          tabComponent: d.tabComponent,
          title: d.title,
          params: d.params,
          /* a group close rebuilds its tabs INSIDE one group; a lone tab lands
             in the active group (Chrome reopens at the strip's end, not the
             old slot) */
          position: first ? { referencePanel: first.id, direction: "within" as const } : undefined,
        });
        first ??= panel;
      }
      /* popped only once the restore succeeded: a throw mid-group keeps the
         entry on the stack for the next chord instead of losing the tabs
         silently (audit round 2, N1) */
      this.set({ closed: rest });
      this.queueSave();
      const shown = first ?? (entry.panels.length ? api.getPanel(entry.panels[0].id) : undefined);
      shown?.api.setActive();
      if (spaceId !== this.state.activeId) this.switchTo(spaceId);
      return shown ?? null;
    } catch (e: any) {
      store.toast("error", "Could not restore the closed tab", e?.message ?? String(e));
      return null;
    }
  }

  /**
   * A user closed a tab (its X, middle-click, the context menu): remember it
   * on the undo stack. Machinery removals are not closes: workspace teardown
   * (flagged in closingSpaces), suppressed moves/kills/batch replays, and
   * the welcome tab's auto-close.
   */
  private recordPanelClose(spaceId: string, panel: IDockviewPanel) {
    if (this.closingSpaces.has(spaceId)) return;
    if (this.suppressedPanels.delete(suppressionKey(spaceId, panel.id))) return;
    const entry = panelsEntry(spaceId, [panel], Date.now());
    if (entry) {
      this.set({ closed: pushClosed(this.state.closed, entry) });
      this.queueSave();
    }
  }

  /** Mark a panel removal as machinery so the undo recorder ignores it. Callers close synchronously, so the event lands in the same task; the TTL only reaps a key whose close never came. The workspace id is mandatory — keying off whatever happens to be active is how the wrong workspace gets suppressed (round 1, B1). */
  suppressPanelClose(spaceId: string, panelId: string) {
    const key = suppressionKey(spaceId, panelId);
    this.suppressedPanels.add(key);
    window.setTimeout(() => this.suppressedPanels.delete(key), 1000);
  }

  /** A batch tab close (the group-corner X, "close others"): one gesture, ONE undo entry, so the chord restores the batch whole. */
  closeGroup(spaceId: string, panels: IDockviewPanel[]) {
    const entry = panelsEntry(spaceId, panels, Date.now());
    if (entry) {
      this.set({ closed: pushClosed(this.state.closed, entry) });
      this.queueSave();
    }
    for (const p of panels) {
      this.suppressPanelClose(spaceId, p.id);
      p.api.close();
    }
  }

  /**
   * The Alt+W chord (Chrome's Ctrl+W): close the active workspace's active
   * tab. Goes through plain api.close() so the undo capture is the same one
   * the tab's own X gets (recordPanelClose pushes the single-panel entry;
   * machinery tabs like welcome close without one). No active tab, no-op.
   */
  closeActivePanel() {
    activePanelToClose((id) => this.apis.get(id), this.state.activeId)?.api.close();
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
      /* a move, not a close — the tab lives on in the target workspace */
      if (move) {
        this.suppressPanelClose(from, panelId);
        source.api.close();
      }
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

  /** Killing from the shell list closes every view, then disposes the pty once. An explicit destroy, not a tab close — not undoable. */
  async killTerminal(id: string) {
    this.suppressedTerminals.add(id);
    for (const [sid, api] of this.apis) {
      if (!api.getPanel(`terminal:${id}`)) continue;
      this.suppressPanelClose(sid, `terminal:${id}`);
      api.getPanel(`terminal:${id}`)?.api.close();
    }
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