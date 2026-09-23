#!/usr/bin/env tsx
/**
 * truss-node-agent — run harness adapters on this host, tunnel them to a
 * Truss server over one outbound WebSocket.
 *
 *   truss-node-agent --server ws://truss.host:4040 --token <shared>
 *
 * The agent dials OUT (NAT/tailnet-friendly): the server never needs inbound
 * reachability to the host. Adapters run exactly as they would on the server
 * (same code, imported from the monorepo) — pi RPC mode, claude stream-json.
 *
 * Tunnel protocol (JSON lines over WS):
 *   agent→server  {type:"hello", hostId, hostname, adapters:[{id,capabilities}]}
 *   server→agent  {type:"spawn", reqId, adapterId, opts:{sessionId,cwd,model,provider,resumeRef}}
 *   agent→server  {type:"spawned", reqId, ok, error?}
 *   agent→server  {type:"event", sessionId, ev}          (proto events)
 *   server→agent  {type:"send", sessionId, text}
 *   server→agent  {type:"interrupt", sessionId}
 *   server→agent  {type:"resolve", sessionId, requestId, choice}
 *   server→agent  {type:"dispose", sessionId}
 */

import { hostname as osHostname } from "node:os";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import type { HarnessAdapter, AdapterHandle, SessionOpts } from "../../../apps/server/src/adapters/types.js";
import { piAdapter } from "../../../apps/server/src/adapters/pi.js";
import { claudeAdapter } from "../../../apps/server/src/adapters/claude.js";

/* adapters that can run on a node host (process-spawning ones; ACP harnesses
   like dsh/hermes run where their servers live — they COULD run here too, but
   their identity is host-bound config, so v1 tunnels the portable two) */
const localAdapters: HarnessAdapter[] = [piAdapter, claudeAdapter];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const SERVER = arg("--server") ?? process.env.TRUSS_SERVER ?? "ws://127.0.0.1:4040";
const TOKEN = arg("--token") ?? process.env.TRUSS_AGENT_TOKEN ?? "";
const HOST_ID =
  arg("--host-id") ??
  createHash("sha1").update(osHostname()).digest("hex").slice(0, 8);

interface LiveEntry {
  adapter: HarnessAdapter;
  handle: AdapterHandle;
}

const live = new Map<string, LiveEntry>();
let ws: WebSocket | null = null;
let reconnectDelay = 1000;

function sendFrame(frame: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function connect() {
  const url = `${SERVER.replace(/\/$/, "")}/agent/connect?host=${encodeURIComponent(HOST_ID)}&token=${encodeURIComponent(TOKEN)}`;
  console.log(`[node-agent] connecting to ${SERVER} as ${HOST_ID}…`);
  ws = new WebSocket(url);

  ws.on("open", () => {
    reconnectDelay = 1000;
    sendFrame({
      type: "hello",
      hostId: HOST_ID,
      hostname: osHostname(),
      adapters: localAdapters.map((a) => ({ id: a.id, capabilities: a.capabilities })),
    });
    console.log(`[node-agent] connected; hosting: ${localAdapters.map((a) => a.id).join(", ")}`);
  });

  ws.on("message", async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      case "spawn": {
        const { reqId, adapterId, opts } = msg as {
          reqId: string;
          adapterId: string;
          opts: SessionOpts;
        };
        const adapter = localAdapters.find((a) => a.id === adapterId);
        if (!adapter) {
          sendFrame({ type: "spawned", reqId, ok: false, error: `no adapter ${adapterId} on ${HOST_ID}` });
          return;
        }
        try {
          const handle = await adapter.spawn(opts);
          live.set(opts.sessionId, { adapter, handle });
          /* pump harness events back over the tunnel */
          void (async () => {
            for await (const ev of adapter.events(handle)) {
              sendFrame({ type: "event", sessionId: opts.sessionId, ev });
            }
          })();
          sendFrame({ type: "spawned", reqId, ok: true });
        } catch (err) {
          sendFrame({ type: "spawned", reqId, ok: false, error: String(err) });
        }
        return;
      }
      case "send": {
        const { sessionId, text } = msg as { sessionId: string; text: string };
        live.get(sessionId)?.adapter.send(live.get(sessionId)!.handle, text);
        return;
      }
      case "interrupt": {
        const { sessionId } = msg as { sessionId: string };
        live.get(sessionId)?.adapter.interrupt(live.get(sessionId)!.handle);
        return;
      }
      case "resolve": {
        const { sessionId, requestId, choice } = msg as {
          sessionId: string;
          requestId: string;
          choice: string;
        };
        const entry = live.get(sessionId);
        entry?.adapter.resolve?.(entry.handle, requestId, choice);
        return;
      }
      case "dispose": {
        const { sessionId } = msg as { sessionId: string };
        const entry = live.get(sessionId);
        if (entry) {
          entry.adapter.dispose(entry.handle);
          live.delete(sessionId);
        }
        return;
      }
      default:
        return;
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    console.log(`[node-agent] disconnected (${code} ${reason}); retrying in ${reconnectDelay}ms`);
    /* dispose local sessions — the server marks them closed on its side */
    for (const [, entry] of live) {
      try {
        entry.adapter.dispose(entry.handle);
      } catch {
        /* gone */
      }
    }
    live.clear();
    ws = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  ws.on("error", (err: Error) => {
    console.error(`[node-agent] ws error: ${err.message}`);
  });
}

connect();
console.log(`[node-agent] host ${HOST_ID} (${osHostname()})`);
