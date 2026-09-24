import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessId } from "@truss/proto";
import { store } from "./db.js";
import {
  closeSession,
  createSession,
  deleteSession,
  interrupt,
  isLive,
  listHarnesses,
  listModels,
  reconcileOnBoot,
  resolvePermission,
  sendPrompt,
  setBroadcaster,
  type EventFrame,
} from "./sessions.js";
import { attachTerminal, closeTerminal, createTerminal, listTerminals } from "./terminal.js";
import { listSkills } from "./skills.js";
import { registerMcpPerms } from "./mcp-perms.js";
import { importDshSessions } from "./import-dsh.js";
import {
  agentBye,
  agentFrame,
  agentHello,
  listAgents,
  wireRemoteRegistry,
} from "./remote.js";
import { registerAdapter, unregisterAdapter } from "./sessions.js";

const PORT = Number(process.env.TRUSS_PORT ?? 4040);
const app = Fastify({ logger: true });

await app.register(websocket);

/* ── WS fan-out ── */
const clients = new Set<{ send: (s: string) => void }>();

setBroadcaster((frame: EventFrame) => {
  const line = JSON.stringify(frame);
  for (const c of clients) c.send(line);
});

/* pi processes from a previous server run are gone — close their sessions. */
reconcileOnBoot();

app.get("/health", async () => ({ ok: true, service: "truss", time: Date.now() }));

app.get("/events", { websocket: true }, (socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
});

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
  if (token !== AGENT_TOKEN || !host) {
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

/* pi skills visible to a working directory (global + project) */
app.get("/api/skills", async (req) => {
  const { cwd } = req.query as { cwd?: string };
  return { skills: listSkills(cwd) };
});

/* MCP permission host for claude-code sessions */
registerMcpPerms(app);

/* import persisted dsh sessions (transcripts + resumable refs) */
app.post("/api/import/dsh", async () => importDshSessions());

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
