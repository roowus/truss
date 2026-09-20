import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { ProtoEvent } from "@truss/proto";

const PORT = Number(process.env.TRUSS_PORT ?? 4040);
const app = Fastify({ logger: true });

await app.register(websocket);

/* ── in-memory client set (M0) ── */
const clients = new Set<{ send: (s: string) => void }>();

export function broadcast(event: ProtoEvent) {
  const line = JSON.stringify(event);
  for (const c of clients) c.send(line);
}

app.get("/health", async () => ({ ok: true, service: "truss", time: Date.now() }));

app.get("/events", { websocket: true }, (socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
});

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
