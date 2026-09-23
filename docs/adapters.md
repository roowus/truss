# Truss — Harness Adapters

Each adapter spawns/drives one harness in its structured machine mode and normalizes to the `packages/proto` event schema. Order of implementation tracks ease of integration.

## 1. pi (easiest — build first)

- **Drive**: `pi` RPC mode — JSONL over stdin/stdout, designed for non-Node hosts.
- **Why first**: bidirectional, structured, nearly free.
- **Refs**: `pi.dev/docs`, `@earendil-works/pi-coding-agent`.
- **Local config**: `~/.pi/agent/models.json`, sessions under `~/.pi/agent/sessions/`.

## 2. Hermes

- **Drive**: `hermes-acp` — ACP adapter ships in-repo, stdio.
- **Status**: gateway runs via launchd (`ai.hermes.gateway`); ACP is the clean driving surface.
- **Refs**: `~/.hermes/hermes-agent/acp_adapter/`, `~/.hermes/config.yaml` (LLM via 9router `:20128`).

## 3. Claude Code

- **Drive**: `claude -p "<prompt>" --output-format stream-json --verbose` (plus `--include-partial-messages` for token-level deltas).
- **Permission host**: `--permission-prompt-tool` routes approvals through an MCP tool Truss owns → permission cards in the UI.
- **Subagent tree**: `parent_tool_use_id` on messages; `--forward-subagent-text` for nested transcripts.
- **Refs**: `code.claude.com/docs/en/headless`, Agent SDK.

## 4. DeepSeek Harness (remote)

- **Drive**: DSH lives on rewvis (agent.rewis), not local. Bridge over SSH/HTTP: run `dsh` CLI / Python SDK on the host, or ship a small dsh plugin exposing ACP.
- **Refs**: `github.com/deepseek-ai/deepseek-harness`.

## Adapter interface (all)

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

A harness with no structured mode gets a **PTY fallback adapter** later — the interface already abstracts it.

## As built (rewvis, 2026-09-23)

All four harnesses are connected and verified live through the Truss server:

- **pi** (`adapters/pi.ts`) — `pi --mode rpc` per session; LF-safe framing; turn → `llm.call.*` with usage; `tool_execution_*` → tool rows; `auto_retry_*` → linked retries. Models via `~/.pi/agent/models.json` provider `zai-local` → key-proxy z.ai.
- **dsh** (`adapters/dsh.ts`) — one shared `dsh --profile acp --patch config/truss-dsh-acp.yml` process, sessions multiplexed (`session/new` each); permission cards via `session/request_permission`. Patch routes the profile to fireworks through the key-proxy (`/opt/dsh/.env` supplies `AGENT_PROXY_KEY`).
- **claude-code** (`adapters/claude.ts`) — one long-lived `claude -p --input-format stream-json` per session; permission host is a Streamable-HTTP MCP endpoint the Truss server hosts (`/mcp/perm/:sessionId`) with `--permission-prompt-tool mcp__truss_perms__approval`. Models run via `ANTHROPIC_BASE_URL` → key-proxy z.ai anthropic-compatible route.
- **hermes** (`adapters/hermes.ts`) — shared-process `hermes-acp`; per-turn token usage from prompt settlement; model state from `session/new`. Hermes lives in `~/.hermes/venv` (uv), pinned `agent-client-protocol==0.9.0`, provider `custom:zai` in `~/.hermes/config.yaml`.

The ACP adapters share **`adapters/acp.ts`** (stdio JSON-RPC client + standard event mapping + turn helpers) — new ACP harnesses are ~100 lines.

The interface gained `queueWhileRunning` (pi queues follow-ups; ACP harnesses settle one turn at a time) and optional `resolve()` (permission hosts).
