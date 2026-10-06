import http from "node:http";
import { Readable } from "node:stream";
import { modelCatalog } from "./modelcat.js";
import { listCredentials } from "./credentials.js";
import {
  anthropicError,
  anthropicToOpenaiRequest,
  openaiToAnthropicResponse,
  OpenaiToAnthropicStream,
  sseLine,
} from "./anthropic-openai.js";
import { modelRouterPort, resolveRoute, type RouteCatalogEntry } from "./router-resolve.js";

/**
 * The truss model router (issue #188) — one Anthropic-compatible loopback
 * endpoint that fans harnesses out to every provider the box can reach.
 *
 * A claude session points its ANTHROPIC_BASE_URL here; /v1/messages resolves
 * the model against the aggregated catalog (key-proxy routes + 9router),
 * then either passes the request through untouched (Anthropic-shaped routes
 * like z.ai) or transforms it to OpenAI chat completions and back (the
 * transformer layer borrows claude-code-router's design, narrowed to the
 * Messages API surface claude code actually uses).
 *
 * Credentials never enter this process beyond today's placeholder pattern:
 * upstream calls carry the same dummy bearer every harness sends and the
 * dsh-key-proxy injects the real keys at the edge (the #80 invariant). The
 * 9router catalog is reachable only while its key-proxy route (:45822) is
 * enabled — the proxy holds 9router's api key too.
 *
 * Env-gated (TRUSS_MODEL_ROUTER): with the gate off nothing here runs and
 * claude behaves exactly as before.
 */

export interface ProviderRoute {
  id: string;
  label: string;
  protocol: "anthropic" | "openai";
  /** anthropic protocol: base that /v1/messages and /v1/messages/count_tokens hang off */
  anthropicBase?: string;
  /** openai protocol: the chat completions URL */
  openaiChatUrl?: string;
}

/* dispatch table — the loopback routes the dsh-key-proxy serves (its config
   is the source of truth for keys; ports/paths are stable box topology) */
export const MODEL_ROUTER_PROVIDERS: ProviderRoute[] = [
  { id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: "http://127.0.0.1:45821/api/anthropic" },
  { id: "fireworks", label: "Fireworks", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45820/inference/v1/chat/completions" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45823/api/v1/chat/completions" },
  { id: "huggingface", label: "HuggingFace", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45824/v1/chat/completions" },
  { id: "router", label: "9router", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45822/v1/chat/completions" },
];

const FALLBACK_PROVIDER = "zai"; // today's route: unknown models behave exactly as pre-router
const ROUTER_CATALOG_URL = "http://127.0.0.1:20128/v1/models"; // 9router, open on loopback
const ROUTER_PROXY_PORT = 45822; // the key-proxy route that injects 9router's key
const CATALOG_TTL_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** the placeholder every truss harness sends; the key-proxy swaps it for the real key */
const PLACEHOLDER_AUTH = "Bearer truss-key-proxy";

export interface ModelRouterDeps {
  /** catalog source (tests inject a static list) */
  catalogFn?: () => Promise<RouteCatalogEntry[]>;
  providers?: ProviderRoute[];
  fetchImpl?: typeof fetch;
}

async function fetchJson(url: string, fetchImpl: typeof fetch, timeoutMs = 5000): Promise<any | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetchImpl(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function routerRouteEnabled(): boolean {
  try {
    return listCredentials().routes.some((r) => r.port === ROUTER_PROXY_PORT && r.enabled);
  } catch {
    return false;
  }
}

/**
 * The aggregated catalog, in preference order — MODEL_ROUTER_PROVIDERS order,
 * NOT the discovery order: z.ai's Anthropic route leads so GLM duplicates
 * pass through untransformed, the 9router aggregator trails (a direct route
 * always beats the aggregator's alias for the same id). Cache: per-request
 * upstream probes would multiply every completion into four catalog fetches.
 */
let catalogCache: { at: number; entries: RouteCatalogEntry[] } | null = null;

/** pure: assemble the resolution catalog from per-provider model id lists,
    in provider-table preference order */
export function assembleCatalog(
  discovered: { provider: string; models: string[] }[],
  providers: ProviderRoute[] = MODEL_ROUTER_PROVIDERS,
): RouteCatalogEntry[] {
  const byId = new Map(discovered.map((d) => [d.provider, d.models]));
  const entries: RouteCatalogEntry[] = [];
  for (const p of providers) {
    for (const id of byId.get(p.id) ?? []) entries.push({ provider: p.id, model: id, protocol: p.protocol });
  }
  return entries;
}

export async function routerCatalog(opts: { force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<RouteCatalogEntry[]> {
  if (!opts.force && !opts.fetchImpl && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.entries;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const discovered: { provider: string; models: string[] }[] = [];

  const providers = await modelCatalog(opts.force).catch(() => [] as Awaited<ReturnType<typeof modelCatalog>>);
  for (const p of providers) discovered.push({ provider: p.id, models: p.models.map((m) => m.id) });

  if (routerRouteEnabled()) {
    const live = await fetchJson(ROUTER_CATALOG_URL, fetchImpl);
    discovered.push({
      provider: "router",
      models: (live?.data ?? []).map((m: any) => m?.id).filter((id: any) => typeof id === "string" && id.length > 0),
    });
  }

  const entries = assembleCatalog(discovered);
  if (!opts.fetchImpl) catalogCache = { at: Date.now(), entries };
  return entries;
}

/** picker rows for the claude adapter when the gate is on — the rich catalog */
export async function routerPickerModels(): Promise<{ provider: string; model: string; label: string }[]> {
  const labels = new Map(MODEL_ROUTER_PROVIDERS.map((p) => [p.id, p.label]));
  const catalog = await routerCatalog();
  return catalog.map((e) => ({
    provider: e.provider,
    model: e.model,
    label: `${e.model.split("/").pop() ?? e.model} (${labels.get(e.provider) ?? e.provider})`,
  }));
}

/* ── HTTP plumbing ── */

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendAnthropicError(res: http.ServerResponse, status: number, message: string) {
  const err = anthropicError(status, message);
  sendJson(res, err.status, err.body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** incremental SSE parser: feed bytes, get complete `data:` payloads */
function makeSseParser(onData: (payload: string) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    /* SSE frames end with a blank line (\n\n or \r\n\r\n — whichever is FIRST) */
    for (;;) {
      const nn = buf.indexOf("\n\n");
      const rr = buf.indexOf("\r\n\r\n");
      let idx = -1;
      let skip = 0;
      if (rr !== -1 && (nn === -1 || rr < nn)) {
        idx = rr;
        skip = 4;
      } else if (nn !== -1) {
        idx = nn;
        skip = 2;
      }
      if (idx === -1) return;
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + skip);
      const payload = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (payload) onData(payload);
    }
  };
}

function pipeResponse(upstream: Response, res: http.ServerResponse) {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    ...(upstream.headers.get("content-type")?.includes("text/event-stream")
      ? { "cache-control": "no-cache", connection: "keep-alive" }
      : {}),
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
  stream.pipe(res);
  stream.on("error", () => res.end());
  res.on("close", () => stream.destroy());
}

/** rough token estimate for providers with no count_tokens endpoint */
function estimateTokens(body: any): number {
  let chars = 0;
  let messages = 0;
  const walk = (v: unknown) => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(body.system);
  for (const m of body.messages ?? []) {
    messages += 1;
    walk(m.content);
  }
  walk((body.tools ?? []).map((t: any) => [t.name, t.description, t.input_schema]));
  return Math.ceil(chars / 4) + messages * 4 + 16;
}

export function createModelRouterHandler(deps: ModelRouterDeps = {}): http.RequestListener {
  const providers = deps.providers ?? MODEL_ROUTER_PROVIDERS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const catalogFn = deps.catalogFn ?? (() => routerCatalog({ fetchImpl }));

  const providerById = new Map(providers.map((p) => [p.id, p]));
  const fallback = providerById.get(FALLBACK_PROVIDER) ?? providers[0];

  const passthrough = async (
    res: http.ServerResponse,
    anthropicBase: string,
    path: string,
    rawBody: Buffer,
    reqHeaders: http.IncomingHttpHeaders,
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: PLACEHOLDER_AUTH,
      "x-api-key": "truss-key-proxy",
    };
    if (typeof reqHeaders["anthropic-version"] === "string") headers["anthropic-version"] = reqHeaders["anthropic-version"];
    if (typeof reqHeaders["anthropic-beta"] === "string") headers["anthropic-beta"] = reqHeaders["anthropic-beta"];
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${anthropicBase}${path}`, {
        method: "POST",
        headers,
        body: new Uint8Array(rawBody),
      });
    } catch (err) {
      sendAnthropicError(res, 502, `provider route unreachable: ${String(err)}`);
      return;
    }
    pipeResponse(upstream, res);
  };

  const handleMessages = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const rawBody = await readBody(req);
    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      sendAnthropicError(res, 400, "request body is not valid JSON");
      return;
    }
    const model = typeof body.model === "string" ? body.model : "";
    const catalog = await catalogFn().catch(() => [] as RouteCatalogEntry[]);
    const route = resolveRoute(model, catalog);
    /* unknown model → today's fallback route, exactly pre-router behavior */
    const provider = route ? providerById.get(route.provider) : fallback;
    if (!provider) {
      sendAnthropicError(res, 500, "model router has no provider routes configured");
      return;
    }

    if (provider.protocol === "anthropic" && provider.anthropicBase) {
      await passthrough(res, provider.anthropicBase, "/v1/messages", rawBody, req.headers);
      return;
    }
    if (!provider.openaiChatUrl) {
      sendAnthropicError(res, 502, `provider ${provider.id} has no usable route`);
      return;
    }

    const oaiReq = anthropicToOpenaiRequest(body);
    let upstream: Response;
    try {
      upstream = await fetchImpl(provider.openaiChatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: PLACEHOLDER_AUTH },
        body: JSON.stringify(oaiReq),
      });
    } catch (err) {
      sendAnthropicError(res, 502, `${provider.label} route unreachable: ${String(err)}`);
      return;
    }

    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 600);
      sendAnthropicError(res, upstream.status, `${provider.label}: ${detail || `HTTP ${upstream.status}`}`);
      return;
    }

    if (body.stream !== true) {
      const json = await upstream.json().catch(() => null);
      if (!json) {
        sendAnthropicError(res, 502, `${provider.label}: unreadable response`);
        return;
      }
      sendJson(res, 200, openaiToAnthropicResponse(json, model));
      return;
    }

    /* streaming: transform OpenAI chunks into the Anthropic SSE sequence */
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const tx = new OpenaiToAnthropicStream(model);
    const emit = (events: { event: string; data: Record<string, unknown> }[]) => {
      for (const ev of events) res.write(sseLine(ev));
    };
    const parse = makeSseParser((payload) => {
      if (payload === "[DONE]") return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return; /* unparseable keepalive-ish noise — skip */
      }
      emit(tx.push(chunk));
    });
    if (!upstream.body) {
      emit(tx.finish());
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      try {
        parse(chunk);
      } catch {
        /* a malformed frame must not kill the stream */
      }
    });
    stream.on("end", () => {
      emit(tx.finish());
      res.end();
    });
    stream.on("error", () => {
      emit(tx.finish());
      res.end();
    });
    res.on("close", () => stream.destroy());
  };

  const handleCountTokens = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const rawBody = await readBody(req);
    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      sendAnthropicError(res, 400, "request body is not valid JSON");
      return;
    }
    const catalog = await catalogFn().catch(() => [] as RouteCatalogEntry[]);
    const route = resolveRoute(typeof body.model === "string" ? body.model : "", catalog);
    const provider = route ? providerById.get(route.provider) : fallback;
    if (provider?.protocol === "anthropic" && provider.anthropicBase) {
      await passthrough(res, provider.anthropicBase, "/v1/messages/count_tokens", rawBody, req.headers);
      return;
    }
    /* OpenAI-shaped routes have no count_tokens — a chars/4 estimate keeps
       claude's context tracking sane enough until the next real usage event */
    sendJson(res, 200, { input_tokens: estimateTokens(body) });
  };

  const handleModels = async (res: http.ServerResponse) => {
    const catalog = await catalogFn().catch(() => [] as RouteCatalogEntry[]);
    /* duplicates are dead rows — resolution is first-wins, so a second
       provider's entry for the same id could never be served */
    const seen = new Set<string>();
    const data = catalog
      .filter((e) => (seen.has(e.model) ? false : (seen.add(e.model), true)))
      .map((e) => ({
        type: "model",
        id: e.model,
        display_name: e.model.split("/").pop() ?? e.model,
        created_at: "2026-01-01T00:00:00Z",
      }));
    sendJson(res, 200, {
      object: "list",
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    });
  };

  return async (req, res) => {
    try {
      const path = (req.url ?? "").split("?")[0].replace(/\/$/, "");
      if (req.method === "POST" && path === "/v1/messages") return await handleMessages(req, res);
      if (req.method === "POST" && path === "/v1/messages/count_tokens") return await handleCountTokens(req, res);
      if (req.method === "GET" && path === "/v1/models") return await handleModels(res);
      if (req.method === "GET" && (path === "" || path === "/health")) {
        return sendJson(res, 200, { ok: true, service: "truss-model-router" });
      }
      sendAnthropicError(res, 404, `unknown path: ${path || req.url}`);
    } catch (err) {
      /* the loop's backstop: one bad request must never take the router down */
      if (!res.headersSent) sendAnthropicError(res, 500, String(err));
      else res.end();
    }
  };
}

export async function startModelRouter(
  opts: { port?: number; host?: string } & ModelRouterDeps = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts.port ?? modelRouterPort();
  const host = opts.host ?? "127.0.0.1";
  const server = http.createServer(createModelRouterHandler(opts));
  /* completions can stream for minutes — no blanket request timeout */
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const bound = server.address();
  return {
    port: bound && typeof bound === "object" ? bound.port : port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
