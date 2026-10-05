import { test } from "node:test";
import assert from "node:assert/strict";

/* Regression tests for issue #100 audit item 16: on a remote host the claude
   adapter pointed its permission MCP (and assumed its key-proxy) at
   LOOPBACK — 127.0.0.1 on the agent is the agent itself. Two halves:
   adapters read env lazily (the claude.ts change), and the agent derives
   both bases from its --server flag (serverEnv.ts, imported here via the
   metrics.test.ts relative-import precedent). */

interface ServerEnvModule {
  deriveServerEnv(server: string): { TRUSS_MCP_BASE: string; TRUSS_CLAUDE_BASE_URL: string };
  applyServerEnv(server: string, env: Record<string, string | undefined>): { TRUSS_MCP_BASE: string };
}

async function load(): Promise<ServerEnvModule> {
  const spec = "../../../packages/node-agent/src/serverEnv.js";
  return import(spec);
}

test("the management + key-proxy bases follow --server, not loopback", async () => {
  const { deriveServerEnv } = await load();
  const d = deriveServerEnv("ws://rewvis.tail208cbf.ts.net:4040");
  assert.equal(d.TRUSS_MCP_BASE, "http://rewvis.tail208cbf.ts.net:4040");
  assert.equal(d.TRUSS_CLAUDE_BASE_URL, "http://rewvis.tail208cbf.ts.net:45821/api/anthropic");

  const tls = deriveServerEnv("wss://rewvis.tail208cbf.ts.net");
  assert.equal(tls.TRUSS_MCP_BASE, "https://rewvis.tail208cbf.ts.net");
  assert.equal(tls.TRUSS_CLAUDE_BASE_URL, "https://rewvis.tail208cbf.ts.net:45821/api/anthropic");
});

test("explicit env wins over the derivation; gaps get filled", async () => {
  const { applyServerEnv } = await load();
  const env: Record<string, string | undefined> = { TRUSS_CLAUDE_BASE_URL: "http://custom:9/x" };
  applyServerEnv("ws://box:4040", env);
  assert.equal(env.TRUSS_MCP_BASE, "http://box:4040", "the gap is filled");
  assert.equal(env.TRUSS_CLAUDE_BASE_URL, "http://custom:9/x", "the operator's setting survives");
});

test("claude.ts has no module-scope env reads left (the ESM-hoisting bug)", async () => {
  /* the lazy-read half: module scope must not touch process.env for these —
     on a remote agent, module evaluation predates applyServerEnv */
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(import.meta.dirname, "../src/adapters/claude.ts"), "utf8");
  const head = src.split(/export const claudeAdapter/)[0]; // module scope only
  /* a direct `const X = process.env.TRUSS_…` freezes the value at import;
     the lazy getters (`() => process.env.…`) never match this */
  assert.ok(!/=\s*process\.env\.(TRUSS_MCP_BASE|TRUSS_CLAUDE_BASE_URL|TRUSS_CLAUDE_MODEL)/.test(head), "env reads must be lazy (behind an arrow), not module-scope constants");
});
