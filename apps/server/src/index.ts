import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { HarnessId } from "@truss/proto";
import { store } from "./db.js";
import {
  closeSession,
  createSession,
  interrupt,
  isLive,
  listHarnesses,
  listModels,
  reconcileOnBoot,
  sendPrompt,
  setBroadcaster,
  type EventFrame,
} from "./sessions.js";
import { attachTerminal, closeTerminal, createTerminal, listTerminals } from "./terminal.js";
import { listSkills } from "./skills.js";

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
    sendPrompt(id, text);
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

app.delete("/api/sessions/:id", async (req) => {
  const { id } = req.params as { id: string };
  closeSession(id);
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
  if (!attachTerminal(id, socket)) socket.close();
});

/* pi skills visible to a working directory (global + project) */
app.get("/api/skills", async (req) => {
  const { cwd } = req.query as { cwd?: string };
  return { skills: listSkills(cwd) };
});

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
