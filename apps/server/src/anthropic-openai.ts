/**
 * Anthropic Messages API ↔ OpenAI Chat Completions protocol transform
 * (issue #188) — the piece that lets an Anthropic-only harness (claude code)
 * ride OpenAI-shaped provider routes.
 *
 * Pure functions plus a streaming state machine; no I/O, fully unit-tested.
 * The mapping is the claude-code-router transformer's core, narrowed to what
 * the Messages API actually carries: text, images, tool_use/tool_result,
 * system prompts, tool choice, and (on the way back) reasoning_content as
 * thinking blocks.
 *
 * Anthropic-only knobs that have no OpenAI counterpart are DROPPED on the way
 * out (metadata, cache_control, thinking budgets, top_k) — never rejected:
 * the router's job is to make the request rideable, not to police it.
 */

/* ── shared shapes (structural, deliberately loose at the edges) ── */

interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  cache_control?: unknown;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: { role: string; content: string | AnthropicBlock[] }[];
  system?: string | AnthropicBlock[];
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type: string; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  [k: string]: unknown;
}

interface OpenAIMessage {
  role: string;
  content?: string | null | unknown[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/* ── request: Anthropic → OpenAI ── */

function systemText(system: AnthropicRequest["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  const text = system
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");
  return text || undefined;
}

function imagePart(b: AnthropicBlock): unknown | null {
  const src = b.source;
  if (!src) return null;
  if (src.type === "base64" && src.data) {
    return { type: "image_url", image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data}` } };
  }
  if (src.type === "url" && src.url) {
    return { type: "image_url", image_url: { url: src.url } };
  }
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as AnthropicBlock[])
      .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * One Anthropic turn can become SEVERAL OpenAI messages: a user turn mixing
 * tool_results with text splits into role:"tool" messages plus a user text
 * message; an assistant turn's text and tool_use blocks ride ONE message
 * (content + tool_calls), consecutive tool_use blocks merge into its
 * tool_calls array.
 *
 * Tool-call pairing repair: OpenAI rejects an assistant tool_call whose
 * role:"tool" answer is missing, and a role:"tool" message no preceding
 * tool_call claims. Anthropic's contract puts results in the NEXT user turn,
 * so per assistant turn we collect the pending ids; the following user turn
 * answers them (missing ids get a placeholder answer — interrupted turns
 * otherwise 400 the whole request) and any result naming an id nobody
 * claimed degrades to a user text note instead of a hard upstream error.
 */
function convertMessages(input: AnthropicRequest["messages"]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  let pendingToolIds: string[] = [];

  const flushOrphanToolCalls = () => {
    for (const id of pendingToolIds) {
      out.push({ role: "tool", tool_call_id: id, content: "(interrupted before the tool result was recorded)" });
    }
    pendingToolIds = [];
  };

  for (const msg of input ?? []) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") {
      /* a plain-text turn never carries tool_results — any pending ids are
         orphans, and their placeholder answers must land BEFORE this turn */
      flushOrphanToolCalls();
      out.push({ role, content: msg.content });
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];

    if (role === "assistant") {
      flushOrphanToolCalls();
      let text = "";
      const calls: OpenAIToolCall[] = [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
        else if (b?.type === "tool_use" && b.id && b.name) {
          calls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: safeJsonStringify(b.input ?? {}) },
          });
        }
        /* thinking blocks are dropped: OpenAI-shaped providers own their
           reasoning and never verify anthropic signatures */
      }
      out.push({ role, content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      pendingToolIds = calls.map((c) => c.id);
      continue;
    }

    /* user turn: tool_result blocks peel off into role:"tool" messages,
       text/image blocks stay together in one user message */
    const parts: unknown[] = [];
    let textOnly = "";
    for (const b of blocks) {
      if (b?.type === "tool_result" && b.tool_use_id) {
        const claimed = pendingToolIds.includes(b.tool_use_id);
        if (claimed) {
          pendingToolIds = pendingToolIds.filter((id) => id !== b.tool_use_id);
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: toolResultText(b.content) });
        } else {
          /* orphan result (its tool_use was compacted away): keep the
             information as user text rather than 400 the request */
          const note = `[tool result ${b.tool_use_id}]: ${toolResultText(b.content)}`;
          parts.push({ type: "text", text: note });
          textOnly += (textOnly ? "\n" : "") + note;
        }
      } else if (b?.type === "text" && typeof b.text === "string") {
        parts.push({ type: "text", text: b.text });
        textOnly += (textOnly ? "\n" : "") + b.text;
      } else if (b?.type === "image") {
        const p = imagePart(b);
        if (p) parts.push(p);
      }
    }
    flushOrphanToolCalls();
    if (parts.length) {
      const hasNonText = parts.some((p: any) => p?.type !== "text");
      out.push({ role, content: hasNonText ? (parts as any) : textOnly });
    }
  }
  flushOrphanToolCalls();
  return out;
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "{}";
  } catch {
    return "{}";
  }
}

function convertTools(tools: AnthropicRequest["tools"]) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools
    .filter((t) => t && typeof t.name === "string" && t.name.length > 0)
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
}

function convertToolChoice(choice: AnthropicRequest["tool_choice"]): unknown {
  if (!choice || typeof choice !== "object") return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return typeof choice.name === "string" && choice.name
        ? { type: "function", function: { name: choice.name } }
        : undefined;
    default:
      return undefined;
  }
}

export function anthropicToOpenaiRequest(req: AnthropicRequest): Record<string, unknown> {
  const messages = convertMessages(req.messages);
  const sys = systemText(req.system);
  if (sys !== undefined) messages.unshift({ role: "system", content: sys });

  const out: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens ?? 8192,
    stream: req.stream === true,
  };
  const tools = convertTools(req.tools);
  if (tools) out.tools = tools;
  const toolChoice = convertToolChoice(req.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) out.stop = req.stop_sequences;
  if (req.stream === true) out.stream_options = { include_usage: true };
  return out;
}

/* ── response: OpenAI → Anthropic ── */

export function mapFinishReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return reason ? "end_turn" : null;
  }
}

/** truncated JSON from a length-cut tool call gets one repair attempt */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    /* unterminated string/object: close what the stream cut off */
    for (const suffix of ['"}', '"}]', "}", "]}"]) {
      try {
        const v = JSON.parse(raw + suffix);
        if (v && typeof v === "object") return v as Record<string, unknown>;
      } catch {
        /* try the next repair */
      }
    }
    return {};
  }
}

/** OpenAI usage → Anthropic usage, cache-aware (prompt_tokens includes cached) */
function mapUsage(u: any): Record<string, number> {
  const prompt = u?.prompt_tokens ?? 0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: u?.completion_tokens ?? 0,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

export function openaiToAnthropicResponse(resp: any, model: string): Record<string, unknown> {
  const choice = resp?.choices?.[0];
  const message = choice?.message ?? {};
  const content: Record<string, unknown>[] = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content, signature: "" });
  }
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const tc of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function?.name ?? "tool",
      input: parseToolArguments(tc.function?.arguments ?? ""),
    });
  }
  /* Anthropic rejects empty content arrays; a truly empty upstream answer
     becomes one empty text block rather than a client-side parse failure */
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: typeof resp?.id === "string" && resp.id.startsWith("msg_") ? resp.id : `msg_${resp?.id ?? Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: mapUsage(resp?.usage),
  };
}

/* ── streaming: OpenAI SSE chunks → Anthropic SSE events ── */

export interface AnthropicSseEvent {
  event: string;
  data: Record<string, unknown>;
}

interface OpenBlock {
  type: "text" | "thinking" | "tool_use";
  index: number;
}

/**
 * Streaming state machine. Feed one parsed OpenAI chunk per push(); it
 * returns the Anthropic events that chunk implies (possibly none, possibly
 * several). Call finish() at stream end ([DONE] or EOF) to close any open
 * blocks and emit the terminal message_delta/message_stop exactly once.
 *
 * Block bookkeeping: OpenAI multiplexes content + parallel tool calls into
 * one delta stream (tool_calls carry their own `index`); Anthropic wants
 * strictly sequential content blocks. So: a text/thinking delta opens its
 * block on demand; a NEW tool call first closes any open text/thinking
 * block, then opens its tool_use block; argument fragments map back through
 * the tool_call index → block index table.
 */
export class OpenaiToAnthropicStream {
  private started = false;
  private model: string;
  private id: string;
  private nextIndex = 0;
  private openText: OpenBlock | null = null;
  private openThinking: OpenBlock | null = null;
  private toolBlocks = new Map<number, OpenBlock>();
  private finishReason: string | null | undefined;
  private usage: Record<string, any> = {};
  private ended = false;

  constructor(model: string) {
    this.model = model;
    this.id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  private startMessage(): AnthropicSseEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.id,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: this.usage.prompt_tokens ?? 0, output_tokens: 0 },
          },
        },
      },
    ];
  }

  private closeTextAndThinking(): AnthropicSseEvent[] {
    const out: AnthropicSseEvent[] = [];
    for (const key of ["openThinking", "openText"] as const) {
      const b = this[key];
      if (b) {
        out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: b.index } });
        this[key] = null;
      }
    }
    return out;
  }

  private openBlock(type: "text" | "thinking"): { events: AnthropicSseEvent[]; block: OpenBlock } {
    const events = this.startMessage();
    /* text and thinking are singletons; switching kinds closes the other */
    const existing = type === "text" ? this.openText : this.openThinking;
    if (existing) return { events, block: existing };
    events.push(...this.closeTextAndThinking());
    const block: OpenBlock = { type, index: this.nextIndex++ };
    if (type === "text") this.openText = block;
    else this.openThinking = block;
    events.push({
      event: "content_block_start",
      data: { type: "content_block_start", index: block.index, content_block: type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" } },
    });
    return { events, block };
  }

  private openToolBlock(call: { id: string; name: string }): { events: AnthropicSseEvent[]; block: OpenBlock } {
    const events = this.startMessage();
    events.push(...this.closeTextAndThinking());
    const block: OpenBlock = { type: "tool_use", index: this.nextIndex++ };
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      },
    });
    return { events, block };
  }

  push(chunk: any): AnthropicSseEvent[] {
    if (this.ended) return [];
    const out: AnthropicSseEvent[] = [];

    /* some providers signal mid-stream failures as an error chunk */
    if (chunk?.error && typeof chunk.error === "object") {
      const msg = typeof chunk.error.message === "string" ? chunk.error.message : "upstream stream error";
      out.push({ event: "error", data: { type: "error", error: { type: "api_error", message: msg } } });
      return out;
    }

    /* a final usage-only chunk carries empty choices */
    if (chunk?.usage && typeof chunk.usage === "object") {
      this.usage = { ...this.usage, ...chunk.usage };
    }

    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
    const delta = choice?.delta ?? {};

    if (typeof chunk?.model === "string" && chunk.model) this.model = chunk.model;

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      const { events, block } = this.openBlock("thinking");
      out.push(...events);
      out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: block.index, delta: { type: "thinking_delta", thinking: delta.reasoning_content } } });
    }

    if (typeof delta.content === "string" && delta.content) {
      const { events, block } = this.openBlock("text");
      out.push(...events);
      out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: block.index, delta: { type: "text_delta", text: delta.content } } });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const tcIndex = typeof tc.index === "number" ? tc.index : 0;
        const hasArgs = typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0;
        const startsNew = typeof tc.id === "string" && tc.id.length > 0;
        let block = this.toolBlocks.get(tcIndex);
        if (!block && (startsNew || hasArgs || typeof tc.function?.name === "string")) {
          /* first sight of this tool_call index. Providers occasionally
             split id/name into a later chunk — a placeholder keeps the
             block openable; ids are opaque end to end (the tool_result
             comes back carrying whatever id we emitted) */
          const opened = this.openToolBlock({
            id: startsNew ? tc.id : `call_${Date.now()}_${tcIndex}`,
            name: typeof tc.function?.name === "string" && tc.function.name ? tc.function.name : "tool",
          });
          out.push(...opened.events);
          block = opened.block;
          this.toolBlocks.set(tcIndex, block);
        }
        /* argument fragments ride the block their tool_call index names;
           late name fragments are safe to ignore — the start block already
           carried the name */
        if (block && hasArgs) {
          out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: tc.function.arguments } } });
        }
      }
    }

    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      this.finishReason = choice.finish_reason;
    }
    return out;
  }

  finish(): AnthropicSseEvent[] {
    if (this.ended) return [];
    this.ended = true;
    const out = this.startMessage();
    out.push(...this.closeTextAndThinking());
    /* close tool blocks in index order */
    const tools = [...this.toolBlocks.values()].sort((a, b) => a.index - b.index);
    for (const b of tools) out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: b.index } });
    this.toolBlocks.clear();
    out.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: mapFinishReason(this.finishReason) ?? "end_turn", stop_sequence: null },
        usage: mapUsage(this.usage),
      },
    });
    out.push({ event: "message_stop", data: { type: "message_stop" } });
    return out;
  }
}

/** serialize one event into the SSE wire format */
export function sseLine(ev: AnthropicSseEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

/** an upstream failure, in the shape Anthropic clients parse */
export function anthropicError(status: number, message: string): { status: number; body: Record<string, unknown> } {
  const type = status === 429 ? "rate_limit_error" : status === 401 || status === 403 ? "authentication_error" : status === 404 ? "not_found_error" : "api_error";
  return { status, body: { type: "error", error: { type, message } } };
}
