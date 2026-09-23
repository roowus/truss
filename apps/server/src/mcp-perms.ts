import type { FastifyInstance } from "fastify";
import { claudePermissionAsk } from "./adapters/claude.js";

/**
 * Permission-host MCP endpoint (Streamable HTTP, JSON responses only).
 * Claude Code connects here per session: /mcp/perm/:sessionId
 * with --permission-prompt-tool mcp__truss_perms__approval.
 *
 * A tools/call holds its HTTP response open until the user answers the
 * permission card in the UI — the round-trip IS the wire wait.
 */

const PROTOCOL_VERSION = "2025-03-26";

const APPROVAL_TOOL = {
  name: "approval",
  description:
    "Ask the user for approval before running a tool. Returns {behavior:'allow'|'deny'}.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      reason: { type: "string" },
    },
    required: ["tool_name"],
  },
};

interface JsonRpc {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export function registerMcpPerms(app: FastifyInstance) {
  app.post("/mcp/perm/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const rpc = req.body as JsonRpc;
    reply.header("Content-Type", "application/json");

    const respond = (result: unknown) => ({ jsonrpc: "2.0", id: rpc.id ?? null, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: { code, message },
    });

    switch (rpc.method) {
      case "initialize":
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "truss-permission-host", version: "0.1.0" },
        });

      case "notifications/initialized":
      case "initialized":
        return reply.code(202).send();

      case "tools/list":
        return respond({ tools: [APPROVAL_TOOL] });

      case "tools/call": {
        const params = rpc.params as { name?: string; arguments?: Record<string, unknown> };
        if (params?.name !== "approval") return fail(-32602, "unknown tool");
        const toolName = String(params.arguments?.tool_name ?? "tool");
        const reason =
          String(
            params.arguments?.reason ??
              JSON.stringify(params.arguments?.input ?? {}).slice(0, 300),
          ) || "needs approval";
        const choice = await claudePermissionAsk(
          sessionId,
          toolName,
          params.arguments?.input,
          reason,
        );
        const verdict =
          choice === "allow"
            ? { behavior: "allow", updatedInput: params.arguments?.input ?? {} }
            : { behavior: "deny", message: "denied by the user via truss" };
        return respond({
          content: [{ type: "text", text: JSON.stringify(verdict) }],
        });
      }

      case "ping":
        return respond({});

      default:
        if (rpc.id == null) return reply.code(202).send(); // stray notification
        return fail(-32601, `method not found: ${rpc.method}`);
    }
  });

  /* Streamable HTTP listen stream — not offered; 405 per spec */
  app.get("/mcp/perm/:sessionId", async (_req, reply) =>
    reply.code(405).header("Allow", "POST").send({ error: "listen stream not supported" }),
  );
}
