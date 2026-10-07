import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/* Tests for the model router frontend (issue #188) — the HTTP half. Fake
   provider upstreams stand in for the key-proxy routes; the router under
   test runs on an ephemeral loopback port with an injected catalog and
   provider table.

   The contract these pin:
   - Anthropic-protocol routes get the request VERBATIM (byte-identical body,
     placeholder auth — key injection stays at the key-proxy edge, #80) and
     the response streams back untouched;
   - OpenAI-protocol routes get a transformed chat-completions request and
     their SSE/JSON comes back as the Anthropic event sequence / message;
   - an unknown model falls through to today's z.ai route (pre-router
     behavior);
   - upstream failures come back in the Anthropic error envelope with the
     upstream's status;
   - /v1/models serves the aggregated catalog, /v1/messages/count_tokens
     passes through on Anthropic routes and estimates on OpenAI ones. */

import { assembleCatalog, createModelRouterHandler, type ProviderRoute } from "../src/model-router.js";
import {
  claudeAnthropicBaseUrl,
  modelRouterBaseUrl,
  modelRouterEnabled,
  modelRouterPort,
  resolveRoute,
  type RouteCatalogEntry,
} from "../src/router-resolve.js";

interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  requests: { body: string; headers: http.IncomingHttpHeaders }[];
}

async function fakeUpstream(
  respond: (body: string, req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<FakeUpstream> {
  const requests: FakeUpstream["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ body, headers: req.headers });
      respond(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    requests,
  };
}

async function bootRouter(deps: {
  catalog: RouteCatalogEntry[];
  providers: ProviderRoute[];
}): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(
    createModelRouterHandler({ catalogFn: async () => deps.catalog, providers: deps.providers }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const CATALOG: RouteCatalogEntry[] = [
  { provider: "zai", model: "glm-4.7", protocol: "anthropic" },
  { provider: "fw", model: "kimi-k3", protocol: "openai" },
  { provider: "router", model: "glm-4.7", protocol: "openai" }, // duplicate: zai wins
];

function anthropicReply(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_upstream",
      type: "message",
      role: "assistant",
      model: "glm-4.7",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 3 },
    }),
  );
}

test("assembleCatalog orders by the provider table, not discovery order (z.ai first so GLM duplicates pass through)", () => {
  /* discovery yields fireworks before zai (modelCatalog's ROUTES order) —
     the resolution catalog must NOT inherit it */
  const discovered = [
    { provider: "fireworks", models: ["accounts/fireworks/models/kimi-k3", "glm-4.7"] },
    { provider: "zai", models: ["glm-4.7", "glm-4.6"] },
    { provider: "router", models: ["glm/glm-4.7"] },
  ];
  const entries = assembleCatalog(discovered);
  assert.deepEqual(
    entries.map((e) => [e.provider, e.model]),
    [
      ["zai", "glm-4.7"],
      ["zai", "glm-4.6"],
      ["fireworks", "accounts/fireworks/models/kimi-k3"],
      ["fireworks", "glm-4.7"],
      ["router", "glm/glm-4.7"],
    ],
  );
  /* the pinned consequence: a bare GLM id resolves to z.ai's Anthropic
     route (pass-through), never to a provider that would transform it */
  assert.deepEqual(resolveRoute("glm-4.7", entries), { provider: "zai", protocol: "anthropic" });
  /* unknown providers in discovery are dropped (no table row → no route) */
  assert.deepEqual(assembleCatalog([{ provider: "mystery", models: ["m-1"] }]), []);
});

test("the rollout gate: TRUSS_MODEL_ROUTER switches claude's default base URL; an explicit TRUSS_CLAUDE_BASE_URL always wins", () => {
  const savedGate = process.env.TRUSS_MODEL_ROUTER;
  const savedPort = process.env.TRUSS_MODEL_ROUTER_PORT;
  try {
    delete process.env.TRUSS_MODEL_ROUTER;
    assert.equal(modelRouterEnabled(), false, "gate off by default — claude behaves exactly as today");

    for (const on of ["1", "true", "on"]) {
      process.env.TRUSS_MODEL_ROUTER = on;
      assert.equal(modelRouterEnabled(), true, `gate reads ${on}`);
    }
    process.env.TRUSS_MODEL_ROUTER = "0";
    assert.equal(modelRouterEnabled(), false);

    process.env.TRUSS_MODEL_ROUTER = "1";
    delete process.env.TRUSS_MODEL_ROUTER_PORT;
    assert.equal(modelRouterPort(), 45826);
    assert.equal(modelRouterBaseUrl(), "http://127.0.0.1:45826");
    process.env.TRUSS_MODEL_ROUTER_PORT = "45900";
    assert.equal(modelRouterBaseUrl(), "http://127.0.0.1:45900");
  } finally {
    if (savedGate === undefined) delete process.env.TRUSS_MODEL_ROUTER;
    else process.env.TRUSS_MODEL_ROUTER = savedGate;
    if (savedPort === undefined) delete process.env.TRUSS_MODEL_ROUTER_PORT;
    else process.env.TRUSS_MODEL_ROUTER_PORT = savedPort;
  }
});

test("claudeAnthropicBaseUrl: the adapter's precedence line, pinned (audit B4)", () => {
  const savedGate = process.env.TRUSS_MODEL_ROUTER;
  const savedExplicit = process.env.TRUSS_CLAUDE_BASE_URL;
  const savedPort = process.env.TRUSS_MODEL_ROUTER_PORT;
  try {
    delete process.env.TRUSS_MODEL_ROUTER_PORT;

    /* gate off → today's direct z.ai route, untouched */
    delete process.env.TRUSS_MODEL_ROUTER;
    delete process.env.TRUSS_CLAUDE_BASE_URL;
    assert.equal(claudeAnthropicBaseUrl(), "http://127.0.0.1:45821/api/anthropic");

    /* gate on → the router's loopback endpoint */
    process.env.TRUSS_MODEL_ROUTER = "1";
    assert.equal(claudeAnthropicBaseUrl(), "http://127.0.0.1:45826");

    /* explicit env beats the gate — remote node-agents always set it from
       --server, so the gate can never reroute them */
    process.env.TRUSS_CLAUDE_BASE_URL = "http://100.64.0.1:45821/api/anthropic";
    assert.equal(claudeAnthropicBaseUrl(), "http://100.64.0.1:45821/api/anthropic");
    delete process.env.TRUSS_MODEL_ROUTER;
    assert.equal(claudeAnthropicBaseUrl(), "http://100.64.0.1:45821/api/anthropic", "explicit env also beats the off-state default");
  } finally {
    if (savedGate === undefined) delete process.env.TRUSS_MODEL_ROUTER;
    else process.env.TRUSS_MODEL_ROUTER = savedGate;
    if (savedExplicit === undefined) delete process.env.TRUSS_CLAUDE_BASE_URL;
    else process.env.TRUSS_CLAUDE_BASE_URL = savedExplicit;
    if (savedPort === undefined) delete process.env.TRUSS_MODEL_ROUTER_PORT;
    else process.env.TRUSS_MODEL_ROUTER_PORT = savedPort;
  }
});

test("anthropic-protocol route: body passes through byte-identical with placeholder auth; response streams back", async () => {
  const zai = await fakeUpstream((body, req, res) => {
    assert.equal(JSON.parse(body).stream, true);
    assert.equal(req.headers.authorization, "Bearer truss-key-proxy", "placeholder token — the key-proxy injects the real key at the edge");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"glm-4.7","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const router = await bootRouter({
    catalog: CATALOG,
    providers: [{ id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: zai.url }],
  });
  try {
    const payload = { model: "glm-4.7", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "u" } };
    const res = await fetch(`${router.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: "Bearer placeholder" },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /"text":"hi"/);
    assert.match(text, /event: message_stop/);
    /* byte-identical pass-through — metadata and all, no transform */
    assert.equal(zai.requests[0].body, JSON.stringify(payload));
    assert.equal(zai.requests[0].headers["anthropic-version"], "2023-06-01", "client protocol headers ride along");
  } finally {
    await router.close();
    await zai.close();
  }
});

test("unknown model falls back to the z.ai route — exactly pre-router behavior", async () => {
  const zai = await fakeUpstream((_body, _req, res) => anthropicReply(res, "fallback answer"));
  const router = await bootRouter({
    catalog: CATALOG,
    providers: [{ id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: zai.url }],
  });
  try {
    const res = await fetch(`${router.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "never-heard-of-it-9b", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.content[0].text, "fallback answer");
    assert.equal(zai.requests.length, 1, "the fallback route served it");
    assert.equal(JSON.parse(zai.requests[0].body).model, "never-heard-of-it-9b", "model id forwarded untouched");
  } finally {
    await router.close();
    await zai.close();
  }
});

test("openai-protocol route: request transforms to chat completions; non-stream response comes back Anthropic-shaped", async () => {
  const fw = await fakeUpstream((body, _req, res) => {
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, "kimi-k3");
    assert.equal(parsed.messages[0].role, "system", "anthropic system hoisted");
    assert.equal(parsed.messages[1].role, "user");
    assert.deepEqual(parsed.tools, [{ type: "function", function: { name: "Bash", description: "run", parameters: { type: "object", properties: {} } } }]);
    assert.ok(!("thinking" in parsed) && !("metadata" in parsed), "anthropic-only fields dropped");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-9",
        model: "kimi-k3",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello from fireworks" } }],
        usage: { prompt_tokens: 21, completion_tokens: 4 },
      }),
    );
  });
  const router = await bootRouter({
    catalog: CATALOG,
    providers: [
      { id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: "http://127.0.0.1:1" },
      { id: "fw", label: "Fireworks", protocol: "openai", openaiChatUrl: `${fw.url}/chat/completions` },
    ],
  });
  try {
    const res = await fetch(`${router.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        max_tokens: 64,
        system: "be brief",
        metadata: { user_id: "u" },
        tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: "say hi" }],
      }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.type, "message");
    assert.equal(json.role, "assistant");
    assert.equal(json.model, "kimi-k3");
    assert.deepEqual(json.content, [{ type: "text", text: "hello from fireworks" }]);
    assert.equal(json.stop_reason, "end_turn");
    assert.equal(json.usage.input_tokens, 21);
    assert.equal(json.usage.output_tokens, 4);
  } finally {
    await router.close();
    await fw.close();
  }
});

test("openai-protocol streaming: OpenAI SSE chunks become the Anthropic event sequence", async () => {
  const fw = await fakeUpstream((body, _req, res) => {
    const parsed = JSON.parse(body);
    assert.equal(parsed.stream, true);
    assert.deepEqual(parsed.stream_options, { include_usage: true });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}],"model":"kimi-k3"}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"content":"run "}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"Bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":9}}\n\n');
    res.end("data: [DONE]\n\n");
  });
  const router = await bootRouter({
    catalog: CATALOG,
    providers: [
      { id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: "http://127.0.0.1:1" },
      { id: "fw", label: "Fireworks", protocol: "openai", openaiChatUrl: `${fw.url}/chat/completions` },
    ],
  });
  try {
    const res = await fetch(`${router.base}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", max_tokens: 64, stream: true, messages: [{ role: "user", content: "go" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();

    /* parse the frames properly: event line + data JSON per blank-line frame */
    const frames = text
      .split("\n\n")
      .filter((f) => f.trim())
      .map((f) => {
        const event = /^event: (\S+)$/m.exec(f)?.[1];
        const data = JSON.parse(f.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim());
        return { event, data };
      });
    assert.deepEqual(
      frames.map((f) => f.event),
      [
        "message_start",
        "content_block_start", // text
        "content_block_delta",
        "content_block_stop",
        "content_block_start", // tool_use
        "content_block_delta", // the arguments, one fragment
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    const toolStart = frames.find((f) => f.event === "content_block_start" && f.data.content_block?.type === "tool_use")!;
    assert.deepEqual(toolStart.data.content_block, { type: "tool_use", id: "call_7", name: "Bash", input: {} });
    const argDelta = frames.find((f) => f.data.delta?.type === "input_json_delta")!;
    assert.equal(argDelta.data.delta.partial_json, '{"cmd":"ls"}', "arguments arrived verbatim");
    const delta = frames.find((f) => f.event === "message_delta")!;
    assert.equal(delta.data.delta.stop_reason, "tool_use");
    assert.equal(delta.data.usage.output_tokens, 9, "the trailing usage chunk landed in message_delta");
  } finally {
    await router.close();
    await fw.close();
  }
});

test("duplicate model id: the catalog's first provider wins (z.ai pass-through beats router transform)", async () => {
  const zai = await fakeUpstream((_b, _r, res) => anthropicReply(res, "from zai"));
  const fw = await fakeUpstream((_b, _r, res) => {
    res.writeHead(500);
    res.end("must not be called");
  });
  const router = await bootRouter({
    catalog: CATALOG,
    providers: [
      { id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: zai.url },
      { id: "router", label: "9router", protocol: "openai", openaiChatUrl: `${fw.url}/v1/chat/completions` },
    ],
  });
  try {
    const res = await fetch(`${router.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.7", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    const json = (await res.json()) as any;
    assert.equal(json.content[0].text, "from zai");
    assert.equal(zai.requests.length, 1);
    assert.equal(fw.requests.length, 0, "the duplicate route never saw the request");
  } finally {
    await router.close();
    await zai.close();
    await fw.close();
  }
});

test("upstream failure surfaces as the Anthropic error envelope with the upstream status", async () => {
  const fw = await fakeUpstream((_b, _r, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "rate limited", type: "tokens" } }));
  });
  const router = await bootRouter({
    catalog: CATALOG,
    providers: [
      { id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: "http://127.0.0.1:1" },
      { id: "fw", label: "Fireworks", protocol: "openai", openaiChatUrl: `${fw.url}/chat/completions` },
    ],
  });
  try {
    const res = await fetch(`${router.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 429, "status passes through so client backoff still works");
    const json = (await res.json()) as any;
    assert.equal(json.type, "error");
    assert.equal(json.error.type, "rate_limit_error");
    assert.match(json.error.message, /Fireworks/);
    assert.match(json.error.message, /rate limited/);
  } finally {
    await router.close();
    await fw.close();
  }
});

test("/v1/models serves the aggregated catalog; count_tokens passes through on anthropic routes and estimates on openai ones", async () => {
  const zai = await fakeUpstream((body, _req, res) => {
    assert.ok(JSON.parse(body).messages);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 42 }));
  });
  const router = await bootRouter({
    catalog: CATALOG,
    providers: [
      { id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: zai.url },
      { id: "fw", label: "Fireworks", protocol: "openai", openaiChatUrl: "http://127.0.0.1:1/chat/completions" },
    ],
  });
  try {
    const models = (await (await fetch(`${router.base}/v1/models`)).json()) as any;
    assert.equal(models.object, "list");
    assert.deepEqual(
      models.data.map((m: any) => m.id),
      ["glm-4.7", "kimi-k3"],
      "first occurrence wins for duplicates — the list is deduped by resolution order",
    );

    const counted = (await (
      await fetch(`${router.base}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.7", messages: [{ role: "user", content: "hello" }] }),
      })
    ).json()) as any;
    assert.equal(counted.input_tokens, 42, "anthropic route answers for real");

    const estimated = (await (
      await fetch(`${router.base}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", messages: [{ role: "user", content: "hello there, a slightly longer prompt to estimate" }] }),
      })
    ).json()) as any;
    assert.ok(estimated.input_tokens > 0, "openai route gets a heuristic estimate");
  } finally {
    await router.close();
    await zai.close();
  }
});

test("the production default catalog path: a handler with NO injected catalogFn still resolves and falls back", async () => {
  /* audit round 3 warning: every HTTP test injects catalogFn, so the B1
     cache fix (default catalogFn = () => routerCatalog(), no fetchImpl)
     had no pin. This boots the handler with zero deps-injection on the
     catalog side: routerCatalog() really runs — on a box with key-proxy
     routes it returns the live catalog, in CI it returns [] (fetches fail
     fast, the missing config reads as "no 9router route"). Either way an
     impossible model id resolves to null and the fallback provider serves
     the request — which is the behavior the production default must keep. */
  const zai = await fakeUpstream((_b, _r, res) => anthropicReply(res, "served by fallback"));
  const server = http.createServer(
    createModelRouterHandler({
      providers: [{ id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: zai.url }],
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "definitely-not-a-model-188-test", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).content[0].text, "served by fallback");
    assert.equal(zai.requests.length, 1, "the default catalogFn resolved (to null) and the fallback route served");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await zai.close();
  }
});

test("unknown paths 404 in the Anthropic error shape; junk bodies 400", async () => {
  const router = await bootRouter({
    catalog: CATALOG,
    providers: [{ id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: "http://127.0.0.1:1" }],
  });
  try {
    const notFound = await fetch(`${router.base}/v1/telemetry`);
    assert.equal(notFound.status, 404);
    assert.equal(((await notFound.json()) as any).type, "error");

    const bad = await fetch(`${router.base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as any).error.type, "api_error");
  } finally {
    await router.close();
  }
});
