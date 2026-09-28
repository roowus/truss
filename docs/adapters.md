# Truss harness adapters

Each adapter spawns or drives one harness in its structured machine mode and normalizes everything to the `packages/proto` event schema. The order below tracks ease of integration.

## 1. pi (easiest, built first)

- Drive: `pi` RPC mode, JSONL over stdin/stdout, made for non-Node hosts.
- Why first: bidirectional, structured, nearly free.
- Refs: `pi.dev/docs`, `@earendil-works/pi-coding-agent`.
- Local config: `~/.pi/agent/models.json`, sessions under `~/.pi/agent/sessions/`.

## 2. Hermes

- Drive: `hermes-acp`, the ACP adapter ships in-repo, over stdio.
- Refs: `~/.hermes/hermes-agent/acp_adapter/`, `~/.hermes/config.yaml`.

## 3. Claude Code

- Drive: `claude -p "<prompt>" --output-format stream-json --verbose` (add `--include-partial-messages` for token-level deltas).
- Permission host: `--permission-prompt-tool` routes approvals through an MCP tool Truss owns, which becomes permission cards in the UI.
- Subagent tree: `parent_tool_use_id` on messages; `--forward-subagent-text` for nested transcripts.
- Refs: `code.claude.com/docs/en/headless`, Agent SDK.

## 4. DeepSeek Harness

- Drive: DSH can live on another host. Bridge over SSH/HTTP by running the `dsh` CLI or Python SDK on that host, or ship a small dsh plugin that exposes ACP. When Truss and DSH share a host, plain local ACP works and no bridge is needed.
- Refs: `github.com/deepseek-ai/deepseek-harness`.

## Adapter interface (all of them)

```ts
interface HarnessAdapter {
  id: string                      // 'pi' | 'hermes' | 'claude-code' | 'dsh'
  capabilities: { permissions: boolean; subagents: boolean; streaming: boolean }
  spawn(opts: SessionOpts): Promise<Handle>
  send(handle: Handle, text: string): void
  interrupt(handle: Handle): void
  events(handle: Handle): AsyncIterable<ProtoEvent>
}
```

A harness with no structured mode gets a PTY fallback adapter later. The interface already abstracts it.

## As built (2026-09-23)

All four harnesses are connected and verified live through the Truss server:

- **pi** (`adapters/pi.ts`): one `pi --mode rpc` per session, LF-safe framing, turn events become `llm.call.*` with usage, `tool_execution_*` become tool rows, `auto_retry_*` become linked retries.
- **dsh** (`adapters/dsh.ts`): one shared `dsh --profile acp --patch config/truss-dsh-acp.yml` process with sessions multiplexed (`session/new` each). Permission cards come through `session/request_permission`.
- **claude-code** (`adapters/claude.ts`): one long-lived `claude -p --input-format stream-json` per session. The permission host is a Streamable-HTTP MCP endpoint the Truss server hosts (`/mcp/perm/:sessionId`) with `--permission-prompt-tool mcp__truss_perms__approval`.
- **hermes** (`adapters/hermes.ts`): shared-process `hermes-acp`. Per-turn token usage from prompt settlement, model state from `session/new`.

The ACP adapters share `adapters/acp.ts` (stdio JSON-RPC client plus the standard event mapping and turn helpers), so a new ACP harness is about 100 lines.

The interface gained `queueWhileRunning` (pi queues follow-ups, ACP harnesses settle one turn at a time) and an optional `resolve()` for permission hosts. Adapters also attach the per-session management MCP URL (`/mcp/truss/:sessionId`) so tool calls carry caller identity for todo ownership and feed authorship.
