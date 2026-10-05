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
 * Tunnel protocol (JSON lines over WS), level 2 (issue #100):
 *   agent→server  {type:"hello", hostId, hostname, adapters:[{id,capabilities}],
 *                  sessions:[sessionId], protocol, bundleHash,
 *                  home, suggestedCwds}                  ← reattach + version
 *                  handshake (sessions are the harnesses STILL ALIVE here
 *                  after a blip) + directory discovery (issue #123): home and
 *                  the existing projects-family dirs, so the server can
 *                  prefill a sensible remote cwd
 *   server→agent  {type:"welcome", protocol, bundleHash}  ← skew warning input
 *   server→agent  {type:"spawn", reqId, adapterId, opts:{sessionId,cwd,model,provider,resumeRef}}
 *   agent→server  {type:"spawned", reqId, ok, error?}
 *   server→agent  {type:"models.list", reqId, adapterId}  ← catalog probe
 *   agent→server  {type:"models.result", reqId, models}  (issue #123)
 *   agent→server  {type:"event", sessionId, ev}          (proto events)
 *   server→agent  {type:"send", sessionId, text}
 *   server→agent  {type:"interrupt", sessionId}
 *   server→agent  {type:"resolve", sessionId, requestId, choice}
 *   server→agent  {type:"dispose", sessionId}
 *
 * Blip tolerance: a disconnect no longer disposes local harnesses — frames
 * buffer (capped) while the tunnel is down and flush after the next hello,
 * and a watchdog reconnects when the server goes silent on a half-open path.
 */

import { hostname as osHostname } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { dialFailureHint } from "./dialHint.js";
import { applyServerEnv } from "./serverEnv.js";
import { discoverCwds } from "./discovery.js";
import type { HarnessAdapter, AdapterHandle, SessionOpts } from "../../../apps/server/src/adapters/types.js";
import { piAdapter } from "../../../apps/server/src/adapters/pi.js";
import { claudeAdapter } from "../../../apps/server/src/adapters/claude.js";
import { dshAdapter } from "../../../apps/server/src/adapters/dsh.js";
import { hermesAdapter } from "../../../apps/server/src/adapters/hermes.js";
import { collectMetrics } from "@truss/proto";

/* every adapter Truss ships runs on a node host (all are child processes:
   pi RPC, claude stream-json, dsh/hermes over ACP). The remote host needs the
   harness CLIs it hosts (pi/claude/dsh/hermes-acp) on PATH. */
const localAdapters: HarnessAdapter[] = [piAdapter, claudeAdapter, dshAdapter, hermesAdapter];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const SERVER = arg("--server") ?? process.env.TRUSS_SERVER ?? "ws://127.0.0.1:4040";
const TOKEN = arg("--token") ?? process.env.TRUSS_AGENT_TOKEN ?? "";
const HOST_ID =
  arg("--host-id") ??
  process.env.TRUSS_HOST_ID ??
  createHash("sha1").update(osHostname()).digest("hex").slice(0, 8);

/* the management MCP + permission hosts live on the Truss SERVER — from a
   remote host, 127.0.0.1 would be the wrong machine. Derive the http(s)
   bases from the ws(s) server URL before any adapter spawn reads it
   (issue #100, item 16: the claude adapter used to freeze the loopback
   defaults at module scope, before this code ever ran). */
applyServerEnv(SERVER);

interface LiveEntry {
  adapter: HarnessAdapter;
  handle: AdapterHandle;
}

const live = new Map<string, LiveEntry>();
let ws: WebSocket | null = null;
let reconnectDelay = 1000;
/* consecutive dial failures — drives dialFailureHint (issue #100): the raw
   ECONNREFUSED loop told the user nothing; after a few tries the log names
   the cause and both fixes */
let dialFailures = 0;
/* the 4403 explanation prints once per revocation stretch — the hourly log
   stays readable while the slow watch runs */
let revokedNoted = false;

/* tunnel protocol level + this bundle's identity (issue #100 version
   handshake): the bundle is this file compiled — hashing our own source at
   startup needs no build-time plumbing and matches the server's hash of the
   bundle it builds, byte for byte, when the two are in sync */
const PROTOCOL = 2;
const BUNDLE_HASH = (() => {
  try {
    return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 12);
  } catch {
    return "dev";
  }
})();

/* frames emitted while the tunnel is down ride the next connection instead
   of vanishing (issue #100, item 8). Capped: a long outage drops the oldest
   events rather than growing memory without bound — the transcript on the
   server shows a gap, never a lie about ordering. */
const offlineQueue: string[] = [];
const OFFLINE_CAP = 1000;
let warnedCap = false;

function sendFrame(frame: Record<string, unknown>) {
  const line = JSON.stringify(frame);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(line);
    return;
  }
  if (offlineQueue.length >= OFFLINE_CAP) {
    offlineQueue.shift();
    if (!warnedCap) {
      warnedCap = true;
      console.error(`[node-agent] offline buffer full (${OFFLINE_CAP} frames) — dropping the oldest events until the server is back`);
    }
  }
  offlineQueue.push(line);
}

function connect() {
  /* the token rides the Authorization header — in the query string it lands
     in the server's access log (issue #100, item 13). Protocol-1 servers
     still accept the query form, but new agents stop leaking it. */
  const url = `${SERVER.replace(/\/$/, "")}/agent/connect?host=${encodeURIComponent(HOST_ID)}`;
  console.log(`[node-agent] connecting to ${SERVER} as ${HOST_ID}…`);
  ws = new WebSocket(url, TOKEN ? { headers: { authorization: `Bearer ${TOKEN}` } } : undefined);

  let opened = false;
  /* liveness watchdog (issue #100, item 9): the server pings every 15s. On a
     blackholed path the socket stays OPEN-but-dead (writes vanish into a
     kernel buffer) — no close event ever fires on its own. Three missed
     contacts and we force the reconnect ourselves. */
  let lastContact = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastContact > 45_000) {
      console.error("[node-agent] the server has gone silent (45s, no ping/message) — the path is dead; reconnecting");
      ws?.terminate();
    }
  }, 15_000);
  ws.on("ping", () => {
    lastContact = Date.now();
  });

  ws.on("open", () => {
    opened = true;
    lastContact = Date.now();
    reconnectDelay = 1000;
    dialFailures = 0;
    revokedNoted = false;
    sendFrame({
      type: "hello",
      hostId: HOST_ID,
      hostname: osHostname(),
      adapters: localAdapters.map((a) => ({ id: a.id, capabilities: a.capabilities })),
      /* reattach handshake: what is still alive HERE. The server errors only
         what we lost and disposes only what it forgot — a blip no longer
         wipes running turns (issue #100, item 7) */
      sessions: [...live.keys()],
      protocol: PROTOCOL,
      bundleHash: BUNDLE_HASH,
      /* directory discovery (issue #123): home always, the projects-family
         dirs that exist here — recomputed per hello so a dir created while
         the tunnel was down shows up after the next reconnect */
      ...discoverCwds(),
    });
    /* then flush whatever piled up while the tunnel was down */
    for (const line of offlineQueue.splice(0)) ws!.send(line);
    warnedCap = false;
    console.log(`[node-agent] connected; hosting: ${localAdapters.map((a) => a.id).join(", ")}${live.size ? `; reattached ${live.size} session(s)` : ""}`);
  });

  ws.on("message", async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    lastContact = Date.now();
    switch (msg.type) {
      case "welcome": {
        /* version handshake (issue #100, item 18): installed agents never
           auto-update, but skew is no longer silent — say so once per
           connect when this bundle differs from the server's current one */
        const serverHash = typeof msg.bundleHash === "string" ? msg.bundleHash : undefined;
        if (serverHash && BUNDLE_HASH !== "dev" && serverHash !== BUNDLE_HASH) {
          console.log(
            `[node-agent] this agent (bundle ${BUNDLE_HASH}) is older than the server's current bundle (${serverHash}) — re-run the installer from the add-host wizard to upgrade`,
          );
        }
        return;
      }
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
      case "models.list": {
        /* catalog probe (issue #123): the server asks what THIS host's
           harness can offer, so the picker's `pi@host` rows are the remote's
           real models, not the bare default */
        const { reqId, adapterId } = msg as { reqId: string; adapterId: string };
        const adapter = localAdapters.find((a) => a.id === adapterId);
        if (!adapter) {
          sendFrame({ type: "models.result", reqId, models: [], error: `no adapter ${adapterId} on ${HOST_ID}` });
          return;
        }
        try {
          const models = await adapter.listModels();
          sendFrame({ type: "models.result", reqId, models });
        } catch (err) {
          sendFrame({ type: "models.result", reqId, models: [], error: String(err) });
        }
        return;
      }
      case "metrics_req": {
        const { reqId } = msg as { reqId: string };
        try {
          const m = await collectMetrics();
          sendFrame({ type: "metrics", reqId, m });
        } catch (err) {
          sendFrame({ type: "metrics", reqId, m: { error: String(err) } });
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
    clearInterval(watchdog);
    ws = null;
    /* 4404 = the host was deleted on the server: retrying can never succeed
       (the id is tombstoned), so say so once and stop instead of spamming
       "unauthorized" every 15s forever (issue #85, audit round 3). Re-adding
       the host means a new id + token, which takes a restart anyway. This is
       the one close that also disposes local harnesses — the host is gone,
       nothing will ever ask about them again. */
    if (code === 4404) {
      for (const [, entry] of live) {
        try {
          entry.adapter.dispose(entry.handle);
        } catch {
          /* gone */
        }
      }
      live.clear();
      offlineQueue.length = 0;
      console.log("[node-agent] this host was deleted on the server; not retrying — re-add it (new id + token) and restart the agent");
      return;
    }
    /* every other close is a BLIP, not a death sentence (issue #100, item 7):
       harnesses keep running locally, their events buffer, and the next
       hello's session list reattaches them. A 1s flap no longer kills a
       running turn. */
    if (live.size) console.log(`[node-agent] tunnel down — keeping ${live.size} session(s) alive locally until reconnect`);
    /* 4403 = revoked/bad token: retrying at the normal cadence spams a line
       the user can't act on every 15s (issue #100). Explain once, then keep
       a slow watch — an admin un-revoking lets it reconnect on its own. */
    if (code === 4403) {
      if (!revokedNoted) {
        revokedNoted = true;
        console.log(
          "[node-agent] the server refuses this host's token (revoked or rotated) — fix it in the host panel (rotate/enable), update ~/.truss/agent-*.env, restart the agent. Checking again every 60s.",
        );
      } else {
        console.log("[node-agent] still refused (4403); next check in 60s");
      }
      setTimeout(connect, 60000);
      return;
    }
    console.log(`[node-agent] disconnected (${code} ${reason}); retrying in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  ws.on("error", (err: Error) => {
    console.error(`[node-agent] ws error: ${err.message}`);
    /* a dead dial must explain itself within a few attempts (issue #100) —
       the user should never have to decode ECONNREFUSED. Only errors before
       the socket ever opened count as dial failures. */
    if (opened) return;
    const code = (err as NodeJS.ErrnoException).code ?? /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.exec(err.message)?.[0] ?? "";
    dialFailures += 1;
    const hint = dialFailureHint({ code, url: SERVER, attempts: dialFailures });
    if (hint) console.error(`[node-agent] ${hint}`);
  });
}

connect();
console.log(`[node-agent] host ${HOST_ID} (${osHostname()})`);
