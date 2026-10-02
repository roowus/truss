import type { FastifyInstance } from "fastify";
import { store } from "./db.js";
import {
  closeSession,
  createSession,
  deleteSession,
  interrupt,
  isLive,
  listHarnesses,
  listModels,
  sendPrompt,
  setProjectArchived,
  setSessionArchived,
  purgeSession,
} from "./sessions.js";
import { closeTerminal, createTerminal, listTerminals } from "./terminal.js";
import { listAgents } from "./remote.js";
import { importDshSessions } from "./import-dsh.js";
import { createTask, listTasks, runTask, updateTask } from "./tasks.js";
import { agentUpdateTodo, createTodo, listTodos } from "./todos.js";
import { listFeed, postFeed } from "./feed.js";
import { composePractices, POSTING_GUIDE } from "./practices.js";

/**
 * Truss management MCP server (Streamable HTTP, JSON responses).
 * Agents attached to it get mcp__truss__* tools to run the app itself:
 * session lifecycle, rename/regroup/archive, prompts across sessions,
 * terminals, workspaces + UI settings, cost ledger, imports.
 *
 * Trust model: same as the UI (loopback / tailnet, single user). Attached
 * per-session at spawn by the adapters (claude stream-json --mcp-config,
 * dsh/hermes session/new mcpServers). pi has no MCP surface (yet).
 */

const PROTOCOL_VERSION = "2025-03-26";

/* ── settings live inside the /api/layout v2 document ── */

function readLayoutDoc(): Record<string, any> {
  const raw = store.getKv("dockview-layout");
  if (!raw) return { version: 2, spaces: [], hosts: {}, settings: {} };
  try {
    return JSON.parse(raw);
  } catch {
    /* pre-workspaces dockview blob — settings start empty */
    return { version: 2, spaces: [], hosts: {}, settings: {}, legacyLayout: raw };
  }
}

function writeLayoutDoc(doc: Record<string, any>) {
  store.setKv("dockview-layout", JSON.stringify(doc));
}

/* ── tool definitions ── */

const TOOLS = [
  {
    name: "list_sessions",
    description: "List Truss sessions (chats) with id, title, harness, state, cwd, project tag, archived flag.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean", description: "include archived sessions (default false)" },
        project: { type: "string", description: "only this project tag" },
      },
    },
  },
  {
    name: "get_session",
    description: "One session's full metadata by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_session",
    description: "Spawn a new chat session on a harness (pi, dsh, claude-code, hermes, or a remote '<adapter>@<host>').",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string" },
        cwd: { type: "string", description: "working directory on that host" },
        model: { type: "string" },
        provider: { type: "string" },
        title: { type: "string" },
        project: { type: "string" },
      },
      required: ["harness"],
    },
  },
  {
    name: "rename_session",
    description: "Rename a session's title.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" } },
      required: ["id", "title"],
    },
  },
  {
    name: "set_project",
    description: "Move a session to a project tag (empty string = ungrouped).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, project: { type: ["string", "null"] } },
      required: ["id", "project"],
    },
  },
  {
    name: "archive_session",
    description: "Hide a session from the sidebar (history kept, still resumable) or restore it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, archived: { type: "boolean" } },
      required: ["id", "archived"],
    },
  },
  {
    name: "archive_project",
    description: "Archive or restore every session under a project tag.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, archived: { type: "boolean" } },
      required: ["project", "archived"],
    },
  },
  {
    name: "close_session",
    description: "Stop a session's harness process (history kept, resumable later).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_session",
    description: "Move a session to the trash (recoverable for 30 days). hard=true purges it forever, transcript included — that cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, hard: { type: "boolean" } },
      required: ["id"],
    },
  },
  {
    name: "send_prompt",
    description: "Send a prompt to a session (dead sessions resume transparently when the harness supports it).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
  },
  {
    name: "interrupt_session",
    description: "Abort a session's running turn.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_terminals",
    description: "List live shell terminals on the server host.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_terminal",
    description: "Open a shell terminal (pty) on the server host.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, title: { type: "string" } },
    },
  },
  {
    name: "close_terminal",
    description: "Kill a shell terminal by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_harnesses",
    description: "Available harness adapters with capabilities, plus selectable models.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_agents",
    description: "Connected node-agent hosts (remote machines hosting harnesses).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_costs",
    description: "Cost + token ledger: per-session and total LLM calls, tokens in/out, reported cost.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_settings",
    description: "Truss UI settings (density, open mode, terminal font size, default cwd, sidebar group mode) + host preferences.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_settings",
    description: "Patch Truss UI settings, e.g. {density:'compact'} or {groupMode:'folder'}.",
    inputSchema: {
      type: "object",
      properties: { patch: { type: "object", description: "partial settings object to merge" } },
      required: ["patch"],
    },
  },
  {
    name: "list_workspaces",
    description: "List workspaces (desktops) with name, archived flag, and tab/panel ids.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_layout",
    description: "The raw serialized workspace document (all desktops, their Dockview layouts, settings).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "put_layout",
    description: "Replace the whole workspace document (full layout control). Prefer the semantic tools for ordinary moves.",
    inputSchema: {
      type: "object",
      properties: { layout: { type: "object", description: "the full layout document object" } },
      required: ["layout"],
    },
  },
  {
    name: "run_import_dsh",
    description: "Import persisted DeepSeek Harness sessions (transcripts + resumable refs) into Truss.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_tasks",
    description: "List task-board cards (id, title, prompt, cwd, harness, status, linked session).",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["todo", "doing", "done", "archived"], description: "filter by status" } },
    },
  },
  {
    name: "create_task",
    description: "File a card on the Truss task board. Pin the harness + working directory; the prompt is what Run sends.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        prompt: { type: "string", description: "the prompt sent to the agent on Run" },
        cwd: { type: "string", description: "working directory for the run" },
        harness: { type: "string", description: "pi | dsh | claude-code | hermes" },
      },
      required: ["title", "cwd", "harness"],
    },
  },
  {
    name: "update_task",
    description: "Patch a task card: title, prompt, or status (todo|doing|done|archived).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        prompt: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "done", "archived"] },
      },
      required: ["id"],
    },
  },
  {
    name: "run_task",
    description: "Run a task card: spawn its session (pinned harness + cwd) and send the prompt. Returns the new session id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "file_todo",
    description:
      "File a task FOR THE USER (they complete it): things to verify, decisions only they can make, chores with deadlines. " +
      "Owned by your session — you may later update/complete/drop it. Posts a linked card to the user's feed unless postToFeed:false.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        notes: { type: "string", description: "markdown details: what to check, where, why" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        deadline: { type: "number", description: "epoch ms, optional" },
        estimate: { type: "string", description: "your effort guess for the user, e.g. '2m', 'S', 'M'" },
        labels: { type: "array", items: { type: "string" } },
        subtasks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, done: { type: "boolean" } } } },
        meta: { type: "object", description: "free-form fields you deem useful (the user's TRUSS.md may define conventions)" },
        postToFeed: { type: "boolean", description: "default true" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_todos",
    description:
      "List todos. Defaults to YOUR session's todos plus todos shared to your session (view ≠ edit); mine:false lists everything.",
    inputSchema: {
      type: "object",
      properties: {
        mine: { type: "boolean" },
        status: { type: "string", enum: ["open", "done", "dropped"] },
      },
    },
  },
  {
    name: "update_todo",
    description:
      "Edit one of YOUR OWN session's todos (title/notes/priority/deadline/labels/subtasks/meta/status). " +
      "Editing another session's todo asks the user first (per-task approval card) and returns a pending marker.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        notes: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        deadline: { type: "number" },
        estimate: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        subtasks: { type: "array", items: { type: "object" } },
        meta: { type: "object" },
        status: { type: "string", enum: ["open", "done", "dropped"] },
      },
      required: ["id"],
    },
  },
  {
    name: "complete_todo",
    description: "Mark one of YOUR OWN todos done (or status:'dropped' when no longer necessary). Same ownership rules as update_todo.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string", enum: ["done", "dropped"] } },
      required: ["id"],
    },
  },
  {
    name: "post_feed",
    description:
      "Post a card to the user's feed (their inbox). Use type 'report' for finished research/analysis, 'note' for heads-ups. " +
      "Keep titles one line; put the substance in markdown body. Set sharedWith to expose the card to other session ids.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["report", "note"] },
        title: { type: "string" },
        body: { type: "string" },
        importance: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        data: { type: "object" },
        sharedWith: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "list_feed",
    description: "Feed cards shared to YOUR session (the user shared them from their inbox).",
    inputSchema: { type: "object", properties: {} },
  },
];

/* ── handlers ── */

async function callTool(name: string, a: Record<string, any>, callerId?: string): Promise<unknown> {
  switch (name) {
    case "list_sessions": {
      let rows = store.listSessions();
      if (!a.includeArchived) rows = rows.filter((s) => !s.archived);
      if (a.project) rows = rows.filter((s) => s.project === a.project);
      return rows.map((s) => ({
        id: s.id, title: s.title, harness: s.harness, state: s.state, cwd: s.cwd,
        model: s.model, project: s.project, archived: !!s.archived, live: isLive(s.id),
        updated_at: s.updated_at,
      }));
    }
    case "get_session": {
      const s = store.getSession(String(a.id));
      if (!s) throw new Error(`no such session: ${a.id}`);
      return { ...s, archived: !!s.archived, live: isLive(s.id) };
    }
    case "create_session": {
      if (!a.harness) throw new Error("harness is required");
      const s = await createSession({
        harness: String(a.harness),
        cwd: String(a.cwd ?? process.env.HOME ?? "/"),
        model: a.model ? String(a.model) : undefined,
        provider: a.provider ? String(a.provider) : undefined,
        title: a.title ? String(a.title) : undefined,
        project: a.project ? String(a.project) : undefined,
      });
      return s;
    }
    case "rename_session": {
      const id = String(a.id);
      if (!store.getSession(id)) throw new Error(`no such session: ${id}`);
      const title = String(a.title ?? "").trim();
      if (!title) throw new Error("title must not be empty");
      store.setSessionTitle(id, title);
      return { ok: true, id, title };
    }
    case "set_project": {
      const id = String(a.id);
      if (!store.getSession(id)) throw new Error(`no such session: ${id}`);
      const project = a.project === "" ? null : a.project == null ? null : String(a.project);
      store.setSessionProject(id, project);
      return { ok: true, id, project };
    }
    case "archive_session":
      setSessionArchived(String(a.id), a.archived !== false);
      return { ok: true };
    case "archive_project":
      return { ok: true, sessions: setProjectArchived(String(a.project), a.archived !== false) };
    case "close_session":
      closeSession(String(a.id));
      return { ok: true };
    case "delete_session": {
      /* honor the hard flag (it was ignored — everything hard-deleted) */
      if (a.hard === true) {
        purgeSession(String(a.id));
        return { ok: true, purged: true };
      }
      deleteSession(String(a.id));
      return { ok: true, trashed: true, recoverableForDays: 30 };
    }
    case "send_prompt":
      await sendPrompt(String(a.id), String(a.text ?? ""));
      return { ok: true };
    case "interrupt_session":
      interrupt(String(a.id));
      return { ok: true };
    case "list_terminals":
      return listTerminals();
    case "create_terminal":
      return createTerminal({
        cwd: a.cwd ? String(a.cwd) : undefined,
        title: a.title ? String(a.title) : undefined,
      });
    case "close_terminal":
      closeTerminal(String(a.id));
      return { ok: true };
    case "list_harnesses":
      return { harnesses: listHarnesses(), models: await listModels() };
    case "list_agents":
      return { agents: listAgents() };
    case "get_costs": {
      const sessions = store.costRollup();
      return {
        sessions,
        totals: sessions.reduce(
          (acc, s) => ({
            calls: acc.calls + s.calls,
            tokensIn: acc.tokensIn + s.tokensIn,
            tokensOut: acc.tokensOut + s.tokensOut,
            costUsd: acc.costUsd + (s.costUsd ?? 0),
          }),
          { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
        ),
      };
    }
    case "get_settings": {
      const doc = readLayoutDoc();
      return { settings: doc.settings ?? {}, hosts: doc.hosts ?? {} };
    }
    case "update_settings": {
      const doc = readLayoutDoc();
      doc.settings = { ...(doc.settings ?? {}), ...(a.patch ?? {}) };
      writeLayoutDoc(doc);
      return { ok: true, settings: doc.settings };
    }
    case "list_workspaces": {
      const doc = readLayoutDoc();
      return (doc.spaces ?? []).map((sp: any) => ({
        id: sp.id,
        name: sp.name,
        archived: !!sp.archived,
        panels: Object.keys(sp.layout?.panels ?? {}),
        active: doc.activeId === sp.id,
      }));
    }
    case "get_layout":
      return readLayoutDoc();
    case "put_layout": {
      if (!a.layout || typeof a.layout !== "object") throw new Error("layout object required");
      writeLayoutDoc(a.layout);
      return { ok: true };
    }
    case "run_import_dsh":
      return importDshSessions();
    case "list_tasks": {
      const rows = listTasks();
      return a.status ? rows.filter((t) => t.status === a.status) : rows;
    }
    case "create_task":
      return createTask({
        title: String(a.title ?? ""),
        prompt: String(a.prompt ?? ""),
        cwd: String(a.cwd ?? ""),
        harness: String(a.harness ?? ""),
      });
    case "update_task":
      return updateTask(String(a.id), { title: a.title, prompt: a.prompt, status: a.status });
    case "run_task": {
      const { session } = await runTask(String(a.id));
      return { sessionId: session.id, title: session.title, harness: session.harness, cwd: session.cwd };
    }
    /* ── todos (user-facing tasks; ownership enforced) ── */
    case "file_todo": {
      if (!callerId) throw new Error("unscoped MCP connection — respawn the session");
      const todo = createTodo({
        title: String(a.title ?? ""),
        notes: a.notes ? String(a.notes) : undefined,
        priority: a.priority,
        deadline: a.deadline == null ? null : Number(a.deadline),
        estimate: a.estimate ? String(a.estimate) : null,
        labels: Array.isArray(a.labels) ? a.labels.map(String) : undefined,
        subtasks: Array.isArray(a.subtasks) ? a.subtasks : undefined,
        meta: a.meta && typeof a.meta === "object" ? a.meta : undefined,
        sessionId: callerId,
        createdBy: "agent",
        postToFeed: a.postToFeed !== false,
      });
      return todo;
    }
    case "list_todos": {
      let rows = listTodos();
      /* default view: own todos + todos view-shared to this session (issue
         #26 — view ≠ edit; edits still need the approval card). mine:false
         lists everything. */
      if (a.mine !== false && callerId)
        rows = rows.filter((t) => t.sessionId === callerId || t.sharedWith.includes(callerId));
      if (a.status) rows = rows.filter((t) => t.status === a.status);
      return rows;
    }
    case "update_todo":
    case "complete_todo": {
      if (!callerId) throw new Error("unscoped MCP connection — respawn the session");
      const patch = name === "complete_todo" ? { status: a.status === "dropped" ? "dropped" : "done" } : {
        title: a.title, notes: a.notes, priority: a.priority,
        deadline: a.deadline === undefined ? undefined : a.deadline,
        estimate: a.estimate, labels: a.labels, subtasks: a.subtasks, meta: a.meta,
        status: a.status,
      };
      const r = agentUpdateTodo(callerId, String(a.id), patch as never);
      if (!r.ok) {
        if (r.reason === "not_found") throw new Error(`no such todo: ${a.id}`);
        if (r.reason === "denied") throw new Error("the user denied this session access to that task");
        return { pending: "approval requested — the user got a card; retry after they approve" };
      }
      return r.todo;
    }
    /* ── feed (the user's inbox; agents post reports, read shared posts) ── */
    case "post_feed": {
      if (!callerId) throw new Error("unscoped MCP connection — respawn the session");
      const { item } = postFeed({
        type: (a.type as never) ?? "report",
        title: String(a.title ?? ""),
        body: a.body ? String(a.body) : undefined,
        sessionId: callerId,
        importance: a.importance,
        data: a.data && typeof a.data === "object" ? a.data : undefined,
        sharedWith: Array.isArray(a.sharedWith) ? a.sharedWith.map(String) : undefined,
      });
      return item;
    }
    case "list_feed": {
      if (!callerId) throw new Error("unscoped MCP connection — respawn the session");
      return listFeed({ sharedWith: callerId });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/* ── the JSON-RPC route ── */

export function registerMcpTruss(app: FastifyInstance) {
  const handler = async (req: any, reply: any) => {
    const callerId = (req.params as { sessionId?: string }).sessionId;
    const rpc = req.body as { id?: string | number; method: string; params?: Record<string, any> };
    reply.header("Content-Type", "application/json");

    const respond = (result: unknown) => ({ jsonrpc: "2.0", id: rpc.id ?? null, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: { code, message },
    });

    switch (rpc.method) {
      case "initialize": {
        /* practices ride as MCP server instructions: the caller's global +
           project + folder TRUSS.md layers, plus the posting guide */
        let instructions = POSTING_GUIDE;
        if (callerId) {
          const s = store.getSession(callerId);
          const { composed } = composePractices(s?.cwd, s?.project);
          if (composed.trim()) instructions = `${composed}\n\n---\n\n${POSTING_GUIDE}`;
        }
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "truss", version: "0.1.0" },
          instructions,
        });
      }
      case "notifications/initialized":
      case "initialized":
        return reply.code(202).send();
      case "tools/list":
        return respond({ tools: TOOLS });
      case "tools/call": {
        const p = rpc.params as { name?: string; arguments?: Record<string, any> };
        if (!p?.name) return fail(-32602, "tool name required");
        try {
          const result = await callTool(p.name, p.arguments ?? {}, callerId);
          return respond({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          return respond({
            content: [{ type: "text", text: `error: ${String(err)}` }],
            isError: true,
          });
        }
      }
      case "ping":
        return respond({});
      default:
        if (rpc.id == null) return reply.code(202).send();
        return fail(-32601, `method not found: ${rpc.method}`);
    }
  };

  app.post("/mcp/truss", handler);
  /* per-session URL: callers are identified so todo ownership holds */
  app.post("/mcp/truss/:sessionId", handler);

  app.get("/mcp/truss", async (_req, reply) =>
    reply.code(405).header("Allow", "POST").send({ error: "listen stream not supported" }),
  );
}
