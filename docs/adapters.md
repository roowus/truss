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
