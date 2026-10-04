/**
 * Server-derived environment for the harnesses an agent spawns
 * (issue #100, audit item 16).
 *
 * Adapters default their management endpoints to LOOPBACK — right on the
 * Truss server, dead on a remote host (127.0.0.1 there is the agent itself).
 * The agent knows the one true address (its --server), so it derives the
 * rest. Explicit env always wins over a derivation.
 */

export interface ServerEnv {
  TRUSS_MCP_BASE: string;
  TRUSS_CLAUDE_BASE_URL: string;
}

/** the key-proxy port on the Truss server box (dsh-key-proxy z.ai route) */
const KEY_PROXY_PORT = "45821";

export function deriveServerEnv(server: string): ServerEnv {
  const http = server.replace(/^ws/, "http").replace(/\/$/, "");
  let claudeBase = "http://127.0.0.1:45821/api/anthropic"; // local default
  try {
    const u = new URL(http);
    u.port = KEY_PROXY_PORT;
    u.pathname = "/api/anthropic";
    u.search = "";
    u.hash = "";
    claudeBase = u.toString().replace(/\/$/, "");
  } catch {
    /* unparsable --server: keep the loopback default, the dial loop will
       complain about the server url anyway */
  }
  return { TRUSS_MCP_BASE: http, TRUSS_CLAUDE_BASE_URL: claudeBase };
}

/** fill only the gaps — anything the operator set explicitly survives */
export function applyServerEnv(server: string, env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const derived = deriveServerEnv(server);
  if (!env.TRUSS_MCP_BASE) env.TRUSS_MCP_BASE = derived.TRUSS_MCP_BASE;
  if (!env.TRUSS_CLAUDE_BASE_URL) env.TRUSS_CLAUDE_BASE_URL = derived.TRUSS_CLAUDE_BASE_URL;
  return derived;
}
