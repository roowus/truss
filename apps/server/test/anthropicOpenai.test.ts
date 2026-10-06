import { test } from "node:test";
import assert from "node:assert/strict";

/* Tests for the Anthropic ↔ OpenAI protocol transform (issue #188) — the
   pure half of the model router. These pin the mapping rules claude code's
   Messages-API traffic needs when it rides an OpenAI-shaped provider route:
   system hoisting, tool_use ↔ tool_calls both ways (including interrupted
   turns), tool_choice, images, usage with cache details, and the streaming
   SSE state machine. */

import {
  anthropicToOpenaiRequest,
  mapFinishReason,
  openaiToAnthropicResponse,
  OpenaiToAnthropicStream,
  parseToolArguments,
  sseLine,
} from "../src/anthropic-openai.js";

const BASE_REQ = {
  model: "kimi-k3",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
};

test("request: system string and array hoist to one system message; anthropic-only knobs drop", () => {
  const asString = anthropicToOpenaiRequest({ ...BASE_REQ, system: "you are terse" }) as any;
  assert.equal(asString.messages[0].role, "system");
  assert.equal(asString.messages[0].content, "you are terse");

  const asArray = anthropicToOpenaiRequest({
    ...BASE_REQ,
    system: [
      { type: "text", text: "part one", cache_control: { type: "ephemeral" } },
      { type: "text", text: "part two" },
    ],
    metadata: { user_id: "u1" },
    thinking: { type: "enabled", budget_tokens: 2048 },
    top_k: 40,
  }) as any;
  assert.equal(asArray.messages[0].content, "part one\n\npart two", "system parts join; cache_control is gone");
  assert.ok(!("metadata" in asArray));
  assert.ok(!("thinking" in asArray), "anthropic thinking config never reaches an OpenAI route");
  assert.ok(!("top_k" in asArray));
});

test("request: tools, tool_choice, stop_sequences, sampling map; stream adds include_usage", () => {
  const out = anthropicToOpenaiRequest({
    ...BASE_REQ,
    tools: [{ name: "Bash", description: "run a command", input_schema: { type: "object", properties: { cmd: { type: "string" } } } }],
    tool_choice: { type: "tool", name: "Bash" },
    stop_sequences: ["</done>"],
    temperature: 0.2,
    top_p: 0.9,
    stream: true,
  }) as any;

  assert.deepEqual(out.tools, [
    { type: "function", function: { name: "Bash", description: "run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } } },
  ]);
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: "Bash" } });
  assert.deepEqual(out.stop, ["</done>"], "stop_sequences ride OpenAI's stop");
  assert.equal(out.temperature, 0.2);
  assert.equal(out.top_p, 0.9);
  assert.deepEqual(out.stream_options, { include_usage: true }, "usage chunk requested so message_delta carries real counts");
});

test("request: tool_choice matrix — any → required (OpenAI has no 'any')", () => {
  const choose = (tool_choice: any) => (anthropicToOpenaiRequest({ ...BASE_REQ, tool_choice }) as any).tool_choice;
  assert.equal(choose({ type: "auto" }), "auto");
  assert.equal(choose({ type: "any" }), "required");
  assert.equal(choose({ type: "none" }), "none");
  assert.equal(choose({ type: "bogus" }), undefined);
  assert.equal(choose(undefined), undefined);
});

test("request: assistant tool_use blocks merge into one message's tool_calls; input serializes", () => {
  const out = anthropicToOpenaiRequest({
    ...BASE_REQ,
    messages: [
      { role: "user", content: "list files then read one" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "thinking", thinking: "secret reasoning", signature: "sig" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/a" } },
        ],
      },
    ],
  }) as any;
  const assistant = out.messages[1];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "on it");
  assert.equal(assistant.tool_calls.length, 2);
  assert.deepEqual(assistant.tool_calls[0], { id: "toolu_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } });
  assert.deepEqual(assistant.tool_calls[1].function, { name: "Read", arguments: '{"file_path":"/a"}' });
  assert.ok(!JSON.stringify(assistant).includes("secret reasoning"), "thinking blocks are dropped, never forwarded");
});

test("request: tool_results become role:tool messages alongside the user text", () => {
  const out = anthropicToOpenaiRequest({
    ...BASE_REQ,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "file.txt" }] },
          { type: "text", text: "now summarize" },
        ],
      },
    ],
  }) as any;
  assert.deepEqual(
    out.messages.slice(1).map((m: any) => [m.role, m.tool_call_id ?? null, m.content === null ? null : typeof m.content === "string" ? m.content : "parts"]),
    [
      ["assistant", null, null],
      ["tool", "toolu_1", "file.txt"],
      ["user", null, "now summarize"],
    ],
    "tool answer lands between the assistant call and the user's text",
  );
});

test("request: interrupted turn — a tool_use with no answer gets a placeholder tool message (OpenAI 400s otherwise)", () => {
  const out = anthropicToOpenaiRequest({
    ...BASE_REQ,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "sleep 99" } }] },
      { role: "user", content: "actually never mind" },
    ],
  }) as any;
  assert.deepEqual(
    out.messages.map((m: any) => m.role),
    ["user", "assistant", "tool", "user"],
    "placeholder tool answer keeps the transcript legal",
  );
  assert.equal(out.messages[2].tool_call_id, "toolu_9");
});

test("request: orphan tool_result (its tool_use compacted away) degrades to user text, not an upstream 400", () => {
  const out = anthropicToOpenaiRequest({
    ...BASE_REQ,
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ghost", content: "partial output" }, { type: "text", text: "continue" }] },
    ],
  }) as any;
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, "user");
  assert.match(out.messages[0].content, /tool result toolu_ghost/);
  assert.match(out.messages[0].content, /partial output/);
});

test("request: a thinking-only assistant turn becomes empty-string content, not null (strict providers 400 bare null)", () => {
  const out = anthropicToOpenaiRequest({
    ...BASE_REQ,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }] },
      { role: "user", content: "continue" },
    ],
  }) as any;
  assert.equal(out.messages[1].role, "assistant");
  assert.equal(out.messages[1].content, "");
  assert.ok(!("tool_calls" in out.messages[1]));
});

test("request: images map to image_url parts (base64 → data URL, url passthrough)", () => {
  const out = anthropicToOpenaiRequest({
    ...BASE_REQ,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
    ],
  }) as any;
  assert.deepEqual(out.messages[0].content, [
    { type: "text", text: "what is this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
});

test("request: max_tokens defaults when absent (OpenAI routes still need a bound)", () => {
  const out = anthropicToOpenaiRequest({ model: "m", messages: [{ role: "user", content: "hi" }] } as any) as any;
  assert.equal(typeof out.max_tokens, "number");
  assert.ok(out.max_tokens > 0);
});

test("response: text + tool_calls assemble; reasoning becomes thinking; usage is cache-aware", () => {
  const out = openaiToAnthropicResponse(
    {
      id: "chatcmpl-123",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "checking",
            reasoning_content: "let me think",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 110, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 } },
    },
    "kimi-k3",
  ) as any;

  assert.equal(out.type, "message");
  assert.equal(out.role, "assistant");
  assert.equal(out.model, "kimi-k3");
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(
    out.content.map((b: any) => b.type),
    ["thinking", "text", "tool_use"],
  );
  assert.deepEqual(out.content[2], { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } });
  assert.equal(out.usage.input_tokens, 10, "cached tokens are not billed as fresh input");
  assert.equal(out.usage.cache_read_input_tokens, 100);
  assert.equal(out.usage.output_tokens, 7);
});

test("response: empty upstream answer still yields legal content (Anthropic rejects [])", () => {
  const out = openaiToAnthropicResponse({ choices: [{ message: {}, finish_reason: "stop" }] }, "m") as any;
  assert.deepEqual(out.content, [{ type: "text", text: "" }]);
  assert.equal(out.stop_reason, "end_turn");
});

test("finish reasons map; parseToolArguments repairs truncated JSON", () => {
  assert.equal(mapFinishReason("stop"), "end_turn");
  assert.equal(mapFinishReason("length"), "max_tokens");
  assert.equal(mapFinishReason("tool_calls"), "tool_use");
  assert.equal(mapFinishReason("content_filter"), "refusal");
  assert.equal(mapFinishReason(null), null);

  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments(""), {});
  assert.deepEqual(parseToolArguments('{"command":"ls -la'), { command: "ls -la" }, "a length-cut string closes once");
  assert.deepEqual(parseToolArguments("not json at all"), {});
});

test("stream: text-only response produces the full Anthropic event sequence", () => {
  const tx = new OpenaiToAnthropicStream("glm-x");
  const events = [
    ...tx.push({ model: "glm-x", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
    ...tx.push({ choices: [{ index: 0, delta: { content: "Hel" } }] }),
    ...tx.push({ choices: [{ index: 0, delta: { content: "lo" } }] }),
    ...tx.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2 } }),
    ...tx.finish(),
  ];
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal(events[1].data.index, 0);
  assert.equal((events[2].data.delta as any).text, "Hel");
  assert.equal((events[3].data.delta as any).text, "lo");
  const delta = events.find((e) => e.event === "message_delta")!;
  assert.equal((delta.data.delta as any).stop_reason, "end_turn");
  assert.equal((delta.data.usage as any).output_tokens, 2);
  assert.equal((delta.data.usage as any).input_tokens, 12);
});

test("stream: a fragmented tool call assembles; prose closes before the tool block", () => {
  const tx = new OpenaiToAnthropicStream("m");
  const events = [
    ...tx.push({ choices: [{ index: 0, delta: { content: "let me run that" } }] }),
    ...tx.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: "" } }] } }] }),
    ...tx.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] }),
    ...tx.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] }),
    ...tx.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ...tx.finish(),
  ];
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, [
    "message_start",
    "content_block_start", // text
    "content_block_delta",
    "content_block_stop", // text closes BEFORE the tool block
    "content_block_start", // tool_use
    "content_block_delta",
    "content_block_delta",
    "content_block_stop", // tool_use closes in finish()
    "message_delta",
    "message_stop",
  ]);
  const toolStart = events[4];
  assert.deepEqual(toolStart.data.content_block, { type: "tool_use", id: "call_1", name: "Bash", input: {} });
  assert.equal(toolStart.data.index, 1);
  const argText = events
    .filter((e) => e.event === "content_block_delta" && (e.data.delta as any).type === "input_json_delta")
    .map((e) => (e.data.delta as any).partial_json)
    .join("");
  assert.deepEqual(JSON.parse(argText), { command: "ls" }, "fragments concatenate into the real arguments");
  const delta = events.find((e) => e.event === "message_delta")!;
  assert.equal((delta.data.delta as any).stop_reason, "tool_use");
});

test("stream: parallel tool calls get separate blocks by tool_call index", () => {
  const tx = new OpenaiToAnthropicStream("m");
  const events = [
    ...tx.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: '{"f' } },
              { index: 1, id: "call_b", type: "function", function: { name: "Bash", arguments: '{"c' } },
            ],
          },
        },
      ],
    }),
    ...tx.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'ile":"/a"}' } },
              { index: 1, function: { arguments: 'md":"ls"}' } },
            ],
          },
        },
      ],
    }),
    ...tx.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ...tx.finish(),
  ];
  const starts = events.filter((e) => e.event === "content_block_start");
  assert.equal(starts.length, 2);
  assert.equal((starts[0].data.content_block as any).name, "Read");
  assert.equal((starts[1].data.content_block as any).name, "Bash");
  const byIndex = (i: number) =>
    events
      .filter((e) => e.event === "content_block_delta" && e.data.index === i)
      .map((e) => (e.data.delta as any).partial_json)
      .join("");
  assert.equal(byIndex(starts[0].data.index as number), '{"file":"/a"}');
  assert.equal(byIndex(starts[1].data.index as number), '{"cmd":"ls"}');
});

test("stream: reasoning_content rides thinking_delta blocks", () => {
  const tx = new OpenaiToAnthropicStream("m");
  const events = [
    ...tx.push({ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] }),
    ...tx.push({ choices: [{ index: 0, delta: { reasoning_content: "…yes" } }] }),
    ...tx.push({ choices: [{ index: 0, delta: { content: "answer" } }] }),
    ...tx.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ...tx.finish(),
  ];
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds.slice(0, 5), [
    "message_start",
    "content_block_start", // thinking
    "content_block_delta",
    "content_block_delta",
    "content_block_stop", // thinking closes when text starts
  ]);
  assert.equal((events[1].data.content_block as any).type, "thinking");
  assert.equal((events[2].data.delta as any).thinking, "hmm");
  const textStart = events.find((e) => e.event === "content_block_start" && (e.data.content_block as any).type === "text")!;
  assert.equal(textStart.data.index, 1, "text is a NEW block after thinking, not the same one");
});

test("stream: a tool_call whose id arrives late still opens (placeholder id), args flow", () => {
  const tx = new OpenaiToAnthropicStream("m");
  const events = [
    ...tx.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "Bash", arguments: '{"a":' } }] } }] }),
    ...tx.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }),
    ...tx.finish(),
  ];
  const start = events.find((e) => e.event === "content_block_start")!;
  assert.equal((start.data.content_block as any).type, "tool_use");
  assert.match((start.data.content_block as any).id, /^call_/, "placeholder id synthesized");
  const args = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => (e.data.delta as any).partial_json)
    .join("");
  assert.equal(args, '{"a":1}');
});

test("stream: mid-stream error chunk surfaces as an Anthropic error event; truncated streams still terminate cleanly", () => {
  const tx = new OpenaiToAnthropicStream("m");
  const errEvents = tx.push({ error: { message: "provider exploded" } });
  assert.deepEqual(errEvents, [{ event: "error", data: { type: "error", error: { type: "api_error", message: "provider exploded" } } }]);

  /* network cut with no finish_reason: finish() still closes the sequence */
  const tail = tx.finish();
  const kinds = tail.map((e) => e.event);
  assert.deepEqual(kinds.slice(-2), ["message_delta", "message_stop"]);
  assert.equal((tail.find((e) => e.event === "message_delta")!.data.delta as any).stop_reason, "end_turn");
  /* and finish is idempotent */
  assert.deepEqual(tx.finish(), []);
});

test("sseLine: the wire format Anthropic clients parse", () => {
  assert.equal(sseLine({ event: "message_stop", data: { type: "message_stop" } }), 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
});
