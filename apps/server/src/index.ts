import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessId } from "@truss/proto";
import { store } from "./db.js";
import {
  broadcastRaw,
  closeSession,
  createSession,
  deleteSession,
  setProjectArchived,
  setSessionArchived,
  interrupt,
  isLive,
  listHarnesses,
  listModels,
  reconcileOnBoot,
  resolvePermission,
  sendPrompt,
  switchModel,
  setBroadcaster,
  deleteSessions,
  purgeSession,
  restoreSession,
  type EventFrame,
} from "./sessions.js";
import { attachTerminal, closeTerminal, createTerminal, listTerminals } from "./terminal.js";
import { createSkill, listSkills, setSkillDisabled, trashSkill } from "./skills.js";
import {
  createPath as createWorkspacePath,
  listDir,
  readFile as readWorkspaceFile,
  searchFiles,
  writeFile as writeWorkspaceFile,
} from "./files.js";
import { gitBranches, gitDiff, gitGraph, gitStatus, gitSwitch } from "./git.js";
import { createTask, deleteTask, listTasks, runTask, updateTask, type TaskStatus } from "./tasks.js";
import { createTodo, listTodos, resolveTodoAccess, setTodoBroadcaster, userUpdateTodo } from "./todos.js";
import { listFeed, setFeedBroadcaster, setFeedState, shareFeedItem } from "./feed.js";
import { startFeedAutopost } from "./feed-autopost.js";
import { composePractices, getGlobalPractices, saveGlobalPractices } from "./practices.js";
import { createHost, deleteHost, listHosts, rotateHostToken, setHostRevoked, verifyAgentToken } from "./hosts.js";
import { netInfo, tailscalePeers, tailscaleServe } from "./net.js";
import { agentBundleError, ensureAgentBundle, installScript } from "./agentbundle.js";
import { registerMcpPerms } from "./mcp-perms.js";
import { importDshSessions } from "./import-dsh.js";
import { registerMcpTruss } from "./mcp-truss.js";
import { controlService, deleteRoute, listCredentials, upsertRoute } from "./credentials.js";
import { controlRouter, harnessRouting, routerStatus } from "./router.js";
import { modelCatalog } from "./modelcat.js";
import { syncPiModelsJson } from "./pi-config.js";
import { setClaudeModels } from "./adapters/claude.js";
import {
  agentBye,
  agentFrame,
  agentHello,
  listAgents,
  requestMetrics,
  wireRemoteRegistry,
} from "./remote.js";
import { collectMetrics } from "@truss/proto";
import { registerAdapter, unregisterAdapter } from "./sessions.js";

const PORT = Number(process.env.TRUSS_PORT ?? 4040);
const app = Fastify({ logger: process.env.TRUSS_TEST ? false : true });

await app.register(websocket);

/* ── WS fan-out ── */
const clients = new Set<{ send: (s: string) => void }>();

setBroadcaster((frame: EventFrame) => {
  const line = JSON.stringify(frame);
  for (const c of clients) c.send(line);
});

/* feed/todo mutations ride the same bus as broadcast-only frames */
setFeedBroadcaster((item) => broadcastRaw({ type: "feed.upsert", sessionId: item.sessionId ?? "", item }));
setTodoBroadcaster((todo) => broadcastRaw({ type: "todo.upsert", sessionId: todo.sessionId ?? "", todo }));
startFeedAutopost();

/* pi processes from a previous server run are gone — close their sessions. */
reconcileOnBoot();

/* build the downloadable node-agent bundle in the background (the add-host
   wizard serves it at /agent/install.sh) */
void ensureAgentBundle()
  .then(() => app.log.info("node-agent bundle ready"))
  .catch(() => app.log.warn(`node-agent bundle build failed: ${agentBundleError()}`));

/* pi's model picker is a static file read at spawn — sync it from the live
   key-proxy catalog so the dialog offers everything the credentials cover */
void syncPiModelsJson()
  .then((r) => app.log.info(`pi models.json synced: ${r.providers} providers, ${r.models} models`))
  .catch((err) => app.log.warn(`pi models.json sync failed: ${err}`));

/* claude's anthropic-compatible models = whatever z.ai serves right now */
void modelCatalog()
  .then((providers) => {
    const zai = providers.find((p) => p.id === "zai");
    if (zai?.models.length) {
      setClaudeModels(zai.models.map((m) => ({
        provider: "zai-local",
        model: m.id,
        label: `${m.id} (z.ai via key-proxy)`,
      })));
    }
  })
  .catch(() => undefined);

app.get("/health", async () => ({ ok: true, service: "truss", time: Date.now() }));

app.get("/events", { websocket: true }, (socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
});

/* heartbeat: an app-level ping every 15s keeps the tailnet/NAT path warm and
   lets the client watchdog spot zombie sockets (browser WebSockets never see
   protocol-level ping/pong, so liveness has to ride the JSON channel).
   Non-frame shape — clients filter it out of the event stream by `seq`. */
const heartbeat = setInterval(() => {
  const line = JSON.stringify({ type: "ping", at: Date.now() });
  for (const c of clients) {
    try {
      c.send(line);
    } catch {
      clients.delete(c);
    }
  }
}, 15_000);
heartbeat.unref();

/* ── node-agent channel (remote hosts dial OUT to here) ── */
const AGENT_TOKEN = process.env.TRUSS_AGENT_TOKEN ?? "truss-dev";

wireRemoteRegistry({
  register: registerAdapter,
  unregister: unregisterAdapter,
  sessionGone: (sessionId, detail) => {
    if (store.getSession(sessionId)) store.setSessionState(sessionId, "error");
    app.log.warn(`remote session ${sessionId} lost: ${detail}`);
  },
});

app.get("/agent/connect", { websocket: true }, (socket, req) => {
  const { host, token } = req.query as { host?: string; token?: string };
  /* per-host tokens (hosts table) first; the shared env token is a dev
     fallback that auto-registers the host into the same registry */
  if (!host || !token || !verifyAgentToken(host, token, AGENT_TOKEN)) {
    socket.close(4403, "unauthorized");
    return;
  }
  let helloed = false;

  /* heartbeat: agents that stop ponging are dead (killed mid-frame leaves
     no close handshake) — terminate so the registry reaps them */
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      clearInterval(heartbeat);
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 15000);

  socket.on("message", (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!helloed) {
      if (msg.type !== "hello") {
        socket.close(4400, "hello first");
        return;
      }
      helloed = true;
      agentHello(
        host,
        String(msg.hostname ?? host),
        (msg.adapters ?? []) as { id: string; capabilities: never }[],
        socket,
      );
      return;
    }
    agentFrame(host, msg);
  });
  socket.on("close", () => {
    clearInterval(heartbeat);
    if (helloed) agentBye(host);
  });
});

app.get("/api/agents", async () => ({ agents: listAgents() }));

/* ── network reachability + the agent installer ── */
app.get("/api/net", async () => netInfo(PORT));
app.get("/api/net/tailscale/peers", async () => tailscalePeers());
app.post("/api/net/tailscale-serve", async (req, reply) => {
  const { on } = (req.body ?? {}) as { on?: boolean };
  try {
    return { tailscale: await tailscaleServe(!!on, PORT) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
/* the add-host wizard's one-liner (token arrives as $1, shown once) */
app.get("/agent/install.sh", async (req, reply) => {
  const { host, server } = req.query as { host?: string; server?: string };
  try {
    if (!host) throw new Error("missing host");
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const serverUrl = server ?? `${proto}://${req.headers.host ?? `127.0.0.1:${PORT}`}`;
    await ensureAgentBundle().catch(() => {});
    const script = installScript(host, serverUrl);
    return reply.header("Content-Type", "text/x-shellscript; charset=utf-8").send(script);
  } catch (e: any) {
    return reply.code(400).type("text/plain").send(`error: ${e.message ?? e}\n`);
  }
});

/* ── monitor: this host + every connected agent, with rolling history ── */
interface HistPoint { t: number; cpu: number; mem: number; rx: number; tx: number }
const metricsHistory = new Map<string, HistPoint[]>();
function pushHistory(key: string, m: any) {
  const ring = metricsHistory.get(key) ?? [];
  const last = ring[ring.length - 1];
  if (last && m.at - last.t < 2000) return; /* don't double-sample on fast polls */
  ring.push({
    t: m.at,
    cpu: m.cpu?.usage ?? 0,
    mem: m.mem?.total ? (m.mem.used / m.mem.total) * 100 : 0,
    rx: (m.net ?? []).reduce((a: number, n: any) => a + (n.rxBps || 0), 0),
    tx: (m.net ?? []).reduce((a: number, n: any) => a + (n.txBps || 0), 0),
  });
  if (ring.length > 240) ring.shift();
  metricsHistory.set(key, ring);
}

app.get("/api/metrics", async () => {
  const local = await collectMetrics();
  pushHistory("local", local);
  const agentsOut: Record<string, unknown> = {};
  await Promise.all(
    listAgents().map(async (a) => {
      try {
        const m = (await requestMetrics(a.hostId)) as any;
        if (m && !m.error) {
          pushHistory(a.hostId, m);
          agentsOut[a.hostId] = { hostname: a.hostname, metrics: m, history: metricsHistory.get(a.hostId) ?? [] };
          return;
        }
        agentsOut[a.hostId] = null;
      } catch {
        agentsOut[a.hostId] = null;
      }
    }),
  );
  return { local: { metrics: local, history: metricsHistory.get("local") ?? [] }, agents: agentsOut };
});

/* ── registered remote hosts (registry + per-host tokens) ── */
app.get("/api/hosts", async () => {
  const live = new Set(listAgents().map((a) => a.hostId));
  return {
    hosts: listHosts().map((h) => ({
      ...h,
      online: live.has(h.id),
      agent: listAgents().find((a) => a.hostId === h.id),
    })),
  };
});
app.post("/api/hosts", async (req, reply) => {
  const { label, note } = (req.body ?? {}) as { label?: string; note?: string };
  try {
    if (!label?.trim()) throw new Error("missing label");
    /* the plaintext token returns exactly once — the wizard embeds it in the
       setup command; afterwards only its prefix is known */
    return createHost(label, note ?? "");
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.post("/api/hosts/:id/token", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    return rotateHostToken(id);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.post("/api/hosts/:id/revoke", async (req) => {
  const { id } = req.params as { id: string };
  const { revoked } = (req.body ?? {}) as { revoked?: boolean };
  setHostRevoked(id, revoked !== false);
  return { ok: true };
});
app.delete("/api/hosts/:id", async (req) => {
  const { id } = req.params as { id: string };
  deleteHost(id);
  return { ok: true };
});

/* ── REST ── */

app.get("/api/harnesses", async () => ({ harnesses: listHarnesses(), models: await listModels() }));

app.get("/api/sessions", async () => ({
  sessions: store.listSessions().map((s) => ({ ...s, live: isLive(s.id) })),
}));

app.post("/api/sessions", async (req, reply) => {
  const body = req.body as {
    harness?: HarnessId;
    cwd?: string;
    model?: string;
    provider?: string;
    title?: string;
    project?: string;
  };
  if (!body?.harness) return reply.code(400).send({ error: "harness is required" });
  try {
    const session = await createSession({
      harness: body.harness,
      cwd: body.cwd ?? process.cwd(),
      model: body.model,
      provider: body.provider,
      title: body.title,
      project: body.project,
    });
    return { session };
  } catch (err) {
    return reply.code(500).send({ error: String(err) });
  }
});

app.get("/api/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const session = store.getSession(id);
  if (!session) return reply.code(404).send({ error: "not found" });
  return { session: { ...session, live: isLive(id) } };
});

/** Full event replay for a session — clients rebuild transcript + trajectory from this. */
app.get("/api/sessions/:id/events", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!store.getSession(id)) return reply.code(404).send({ error: "not found" });
  return { events: store.listEvents(id) };
});

app.post("/api/sessions/:id/prompt", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text?.trim()) return reply.code(400).send({ error: "text is required" });
  try {
    await sendPrompt(id, text);
    return { ok: true };
  } catch (err) {
    return reply.code(409).send({ error: String(err) });
  }
});

app.post("/api/sessions/:id/model", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { model, provider } = (req.body ?? {}) as { model?: string; provider?: string };
  if (!model?.trim()) return reply.code(400).send({ error: "model is required" });
  try {
    return await switchModel(id, model.trim(), provider);
  } catch (err) {
    return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) });
  }
});

app.post("/api/sessions/:id/interrupt", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    interrupt(id);
    return { ok: true };
  } catch (err) {
    return reply.code(409).send({ error: String(err) });
  }
});

/** permission card answer — the agent→user round-trip closes here */
app.post("/api/sessions/:id/permission", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { requestId, choice } = (req.body ?? {}) as { requestId?: string; choice?: string };
  if (!requestId || !choice) return reply.code(400).send({ error: "requestId and choice required" });
  try {
    resolvePermission(id, requestId, choice);
    return { ok: true };
  } catch (err) {
    return reply.code(409).send({ error: String(err) });
  }
});

app.post("/api/sessions/:id/archive", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { archived } = (req.body ?? {}) as { archived?: boolean };
  try {
    setSessionArchived(id, archived !== false);
    return { ok: true };
  } catch (err) {
    return reply.code(404).send({ error: String(err) });
  }
});

app.post("/api/projects/archive", async (req, reply) => {
  const { project, archived } = (req.body ?? {}) as { project?: string; archived?: boolean };
  if (project == null) return reply.code(400).send({ error: "project required" });
  const n = setProjectArchived(project, archived !== false);
  return { ok: true, archived: archived !== false, sessions: n };
});

/* the 30-day trash (issue #5): list, restore, delete-forever */
app.get("/api/trash", async () => ({ sessions: store.listDeletedSessions() }));
app.post("/api/sessions/:id/restore", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    restoreSession(id);
    return { ok: true };
  } catch (err) {
    return reply.code(404).send({ error: String(err instanceof Error ? err.message : err) });
  }
});
app.post("/api/sessions/:id/purge", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    purgeSession(id);
    return { ok: true };
  } catch (err) {
    return reply.code(404).send({ error: String(err instanceof Error ? err.message : err) });
  }
});

app.post("/api/sessions/bulk-delete", async (req, reply) => {
  const { ids } = (req.body ?? {}) as { ids?: string[] };
  if (!Array.isArray(ids)) return reply.code(400).send({ error: "ids[] required" });
  return { deleted: deleteSessions(ids) };
});

app.delete("/api/sessions/:id", async (req) => {
  const { id } = req.params as { id: string };
  const { hard } = req.query as { hard?: string };
  if (hard === "1") deleteSession(id);
  else closeSession(id);
  return { ok: true };
});

/* ── terminals (M2) ── */

app.get("/api/terminals", async () => ({ terminals: listTerminals() }));

app.post("/api/terminals", async (req) => {
  const body = (req.body ?? {}) as { cwd?: string; shell?: string; title?: string };
  const t = createTerminal(body);
  return t;
});

app.delete("/api/terminals/:id", async (req) => {
  const { id } = req.params as { id: string };
  closeTerminal(id);
  return { ok: true };
});

app.get("/api/terminal/:id/ws", { websocket: true }, (socket, req) => {
  const { id } = req.params as { id: string };
  if (!attachTerminal(id, socket)) {
    /* unknown/gone terminal (e.g. a layout-restored tab after a server
       restart) — tell the client explicitly instead of a bare close */
    try {
      socket.send(JSON.stringify({ type: "exit", code: null }));
    } catch {
      /* already gone */
    }
    socket.close();
  }
});

/* agent skills visible to a working directory (user + project dirs) */
app.get("/api/skills", async (req) => {
  const { cwd } = req.query as { cwd?: string };
  return { skills: listSkills(cwd) };
});
app.post("/api/skills/toggle", async (req, reply) => {
  const { source, disabled } = (req.body ?? {}) as { source?: string; disabled?: boolean };
  try {
    if (!source || typeof disabled !== "boolean") throw new Error("missing source/disabled");
    return { skill: setSkillDisabled(source, disabled) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.post("/api/skills/create", async (req, reply) => {
  const { cwd, name, description } = (req.body ?? {}) as { cwd?: string; name?: string; description?: string };
  try {
    if (!cwd || !name) throw new Error("missing cwd/name");
    return { skill: createSkill(cwd, name, description ?? "") };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.post("/api/skills/delete", async (req, reply) => {
  const { source } = (req.body ?? {}) as { source?: string };
  try {
    if (!source) throw new Error("missing source");
    return trashSkill(source);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});

/* ── todos (user-facing tasks filed by agents) + feed (the inbox) ── */
app.get("/api/todos", async () => ({ todos: listTodos() }));
app.post("/api/todos", async (req, reply) => {
  const b = (req.body ?? {}) as any;
  try {
    if (!b.title) throw new Error("missing title");
    return { todo: createTodo({ ...b, createdBy: "user", postToFeed: false }) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.patch("/api/todos/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    return { todo: userUpdateTodo(id, (req.body ?? {}) as any) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.post("/api/todos/:id/access", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { requesterId, approve } = (req.body ?? {}) as { requesterId?: string; approve?: boolean };
  try {
    if (!requesterId || typeof approve !== "boolean") throw new Error("missing requesterId/approve");
    return { todo: resolveTodoAccess(id, requesterId, approve) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});

app.get("/api/feed", async (req) => {
  const { state } = req.query as { state?: string };
  return { items: listFeed(state ? { state: state as never } : {}) };
});
app.post("/api/feed/:id/state", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { state } = (req.body ?? {}) as { state?: string };
  try {
    if (!state) throw new Error("missing state");
    return { item: setFeedState(id, state as never) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.post("/api/feed/:id/share", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  try {
    if (!sessionId) throw new Error("missing sessionId");
    const item = shareFeedItem(id, sessionId);
    /* share = both: the post lands in the target session's chat too */
    const text = `**[shared from your feed]** ${item.title}${item.body ? `\n\n${item.body}` : ""}`;
    await sendPrompt(sessionId, text);
    return { item };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});

/* ── practices (TRUSS.md) ── */
app.get("/api/practices", async () => ({ text: getGlobalPractices(), path: "~/.truss/TRUSS.md" }));
app.put("/api/practices", async (req) => {
  const { text } = (req.body ?? {}) as { text?: string };
  saveGlobalPractices(typeof text === "string" ? text : "");
  return { ok: true };
});
app.get("/api/practices/compose", async (req) => {
  const { cwd, project } = req.query as { cwd?: string; project?: string };
  return composePractices(cwd, project ?? null);
});

/* ── task board (kanban; run spawns a real session with the task prompt) ── */
app.get("/api/tasks", async () => ({ tasks: listTasks() }));
app.post("/api/tasks", async (req, reply) => {
  const b = (req.body ?? {}) as { title?: string; prompt?: string; cwd?: string; harness?: string };
  try {
    if (!b.title || !b.cwd || !b.harness) throw new Error("missing title/cwd/harness");
    return { task: createTask({ title: b.title, prompt: b.prompt ?? "", cwd: b.cwd, harness: b.harness }) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.patch("/api/tasks/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as { title?: string; prompt?: string; status?: TaskStatus };
  try {
    return { task: updateTask(id, b) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.delete("/api/tasks/:id", async (req) => {
  const { id } = req.params as { id: string };
  deleteTask(id);
  return { ok: true };
});
app.post("/api/tasks/:id/run", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    const { session } = await runTask(id);
    return { session };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});

/* ── git panel (status / diff / branches / graph; switch is the only mutation) ── */
app.get("/api/git/status", async (req, reply) => {
  const { cwd } = req.query as { cwd?: string };
  try {
    if (!cwd) throw new Error("missing cwd");
    return await gitStatus(cwd);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.get("/api/git/branches", async (req, reply) => {
  const { cwd } = req.query as { cwd?: string };
  try {
    if (!cwd) throw new Error("missing cwd");
    return await gitBranches(cwd);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.get("/api/git/graph", async (req, reply) => {
  const { cwd, n } = req.query as { cwd?: string; n?: string };
  try {
    if (!cwd) throw new Error("missing cwd");
    return await gitGraph(cwd, n ? Number(n) : undefined);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.get("/api/git/diff", async (req, reply) => {
  const { cwd, path, staged } = req.query as { cwd?: string; path?: string; staged?: string };
  try {
    if (!cwd || !path) throw new Error("missing cwd/path");
    return await gitDiff(cwd, path, staged === "1");
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.post("/api/git/switch", async (req, reply) => {
  const { cwd, branch, create } = (req.body ?? {}) as { cwd?: string; branch?: string; create?: boolean };
  try {
    if (!cwd || !branch) throw new Error("missing cwd/branch");
    return await gitSwitch(cwd, branch, !!create);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});

/* ── workspace files (Files panel; every op confined to the given root) ── */
app.get("/api/files", async (req, reply) => {
  const { root, path, q } = req.query as { root?: string; path?: string; q?: string };
  try {
    if (!root) throw new Error("missing root");
    if (q) return { entries: searchFiles(root, q) };
    return { entries: listDir(root, path) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.get("/api/file", async (req, reply) => {
  const { root, path } = req.query as { root?: string; path?: string };
  try {
    if (!root || !path) throw new Error("missing root/path");
    return readWorkspaceFile(root, path);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.put("/api/file", async (req, reply) => {
  const { root, path, content } = (req.body ?? {}) as { root?: string; path?: string; content?: string };
  try {
    if (!root || !path || typeof content !== "string") throw new Error("missing root/path/content");
    return writeWorkspaceFile(root, path, content);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});
app.post("/api/files/create", async (req, reply) => {
  const { root, path, kind } = (req.body ?? {}) as { root?: string; path?: string; kind?: "file" | "dir" };
  try {
    if (!root || !path || (kind !== "file" && kind !== "dir")) throw new Error("missing root/path/kind");
    return createWorkspacePath(root, path, kind);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message ?? String(e) });
  }
});

/* MCP permission host for claude-code sessions */
registerMcpPerms(app);

/* MCP management server — agents get mcp__truss__* tools */
registerMcpTruss(app);

/* aggregated model catalog across the enabled key-proxy routes */
app.get("/api/models/catalog", async (req) => {
  const { force } = req.query as { force?: string };
  return { providers: await modelCatalog(force === "1") };
});

/* ── credentials (dsh-key-proxy route management; keys are write-only) ── */
app.get("/api/credentials", async () => listCredentials());
app.post("/api/credentials", async (req, reply) => {
  try {
    return upsertRoute((req.body ?? {}) as never);
  } catch (err) {
    return reply.code(400).send({ error: String(err) });
  }
});
app.delete("/api/credentials/:port", async (req, reply) => {
  try {
    return deleteRoute(Number((req.params as { port: string }).port));
  } catch (err) {
    return reply.code(400).send({ error: String(err) });
  }
});
app.post("/api/credentials/service", async (req) => {
  const { action } = (req.body ?? {}) as { action?: "start" | "stop" | "restart" };
  if (!action || !["start", "stop", "restart"].includes(action))
    return { ok: false, detail: "action must be start|stop|restart" };
  return controlService(action);
});

/* ── router (9router status/control + harness routing snapshot) ── */
app.get("/api/router", async () => ({ ...(await routerStatus()), harnesses: harnessRouting() }));
app.post("/api/router/service", async (req) => {
  const { action } = (req.body ?? {}) as { action?: "start" | "stop" | "restart" };
  if (!action || !["start", "stop", "restart"].includes(action))
    return { ok: false, detail: "action must be start|stop|restart" };
  return controlRouter(action);
});

/* import persisted dsh sessions (transcripts + resumable refs) */
app.post("/api/import/dsh", async () => importDshSessions());

/* per-day token/cost buckets for the Cost panel heat grid (last 35 days) */
app.get("/api/costs/daily", async () => ({ days: store.costDaily(35) }));

/* cost rollup across every session (not just hydrated ones) */
app.get("/api/costs", async () => {
  const sessions = store.costRollup();
  const totals = sessions.reduce(
    (a, s) => ({
      calls: a.calls + s.calls,
      tokensIn: a.tokensIn + s.tokensIn,
      tokensOut: a.tokensOut + s.tokensOut,
      costUsd: a.costUsd + (s.costUsd ?? 0),
      hasCost: a.hasCost || s.costUsd != null,
    }),
    { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, hasCost: false },
  );
  return { sessions, totals };
});

/* ── layout persistence (dockview serialized state) ── */
app.get("/api/layout", async () => ({ layout: store.getKv("dockview-layout") ?? null }));
app.put("/api/layout", async (req) => {
  const { layout } = (req.body ?? {}) as { layout?: string | null };
  /* null clears a saved layout (e.g. after a cleanup, or stale session refs) */
  if (layout !== null && typeof layout !== "string") return { ok: false };
  store.setKv("dockview-layout", layout ?? "");
  return { ok: true };
});

/* ── static hosting: serve the built web app when dist exists (prod mode) ── */
const here = dirname(fileURLToPath(import.meta.url));
const webDist = process.env.TRUSS_WEB_DIST ?? join(here, "..", "..", "web", "dist");
if (existsSync(join(webDist, "index.html"))) {
  await app.register(fastifyStatic, { root: webDist });
  /* SPA fallback — anything not /api, /events, or a file goes to the shell */
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/events")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found" });
  });
  app.log.info(`serving web app from ${webDist}`);
}

/* exported for in-process integration tests (test/server-harness.ts) */
export { app };

app
  .listen({ port: PORT, host: process.env.TRUSS_HOST ?? "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

/* ── fast graceful shutdown: close HTTP/WS, dispose harness children, hard-exit
   after a short grace so systemd restarts don't stall ~90s ── */
let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${sig} — shutting down`);
  const hard = setTimeout(() => process.exit(0), 4000);
  hard.unref();
  void (async () => {
    try {
      for (const id of [...store.listSessions().map((s) => s.id)]) {
        try {
          closeSession(id); // closes adapter children (stdin end → orderly)
        } catch {
          /* keep closing the rest */
        }
      }
      await app.close();
    } finally {
      clearTimeout(hard);
      process.exit(0);
    }
  })();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
