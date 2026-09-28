import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Practices — TRUSS.md, Truss's take on CLAUDE.md: markdown files where the
 * user dictates coding practices AND posting practices (what to file as
 * todos, what to post to the feed, priorities/deadlines conventions).
 *
 * Layers, root → leaf (later layers win by appending):
 *   1. global   ~/.truss/TRUSS.md
 *   2. project  ~/.truss/projects/<project>.md
 *   3. folders  every TRUSS.md from $HOME down to the session cwd
 *
 * The composed document rides to MCP-capable harnesses as the truss MCP
 * server's `instructions`, and gets prepended to pi's first prompt (pi has
 * no MCP surface).
 */

const GLOBAL_DIR = join(homedir(), ".truss");
const GLOBAL_FILE = join(GLOBAL_DIR, "TRUSS.md");

const DEFAULT_GLOBAL = `# Truss practices

## Posting
- File a todo (file_todo) when you hand work to the user: things to verify,
  decisions only they can make, chores with deadlines. Set priority honestly;
  add a deadline only when time truly matters.
- Post a report (post_feed, type "report") when you finish substantial
  research or analysis — one tight summary, link the session.
- You may only edit your own session's todos; ask via the approval card
  otherwise. Keep todos current: complete or drop what no longer applies.

## Coding
- (Add your house rules here — they reach every harness Truss hosts.)
`;

export interface PracticeLayer {
  path: string;
  scope: "global" | "project" | "folder";
  text: string;
}

function readIfExists(path: string): string | null {
  try {
    if (existsSync(path)) return readFileSync(path, "utf8");
  } catch {
    /* unreadable */
  }
  return null;
}

export function composePractices(cwd?: string, project?: string | null): { layers: PracticeLayer[]; composed: string } {
  const layers: PracticeLayer[] = [];
  const g = readIfExists(GLOBAL_FILE);
  if (g) layers.push({ path: GLOBAL_FILE, scope: "global", text: g });
  if (project) {
    const pf = join(GLOBAL_DIR, "projects", `${project.replace(/[^\w.-]+/g, "_")}.md`);
    const p = readIfExists(pf);
    if (p) layers.push({ path: pf, scope: "project", text: p });
  }
  if (cwd) {
    /* walk $HOME → cwd collecting TRUSS.md (never above $HOME). The $HOME
       root itself is deliberately skipped: home-wide rules belong in the
       global layer (~/.truss/TRUSS.md), not a loose file in your home dir */

    const home = homedir();
    const abs = resolve(cwd);
    if (abs === home || abs.startsWith(home + sep)) {
      const chain: string[] = [];
      let cur = abs;
      while (cur !== home && cur.startsWith(home + sep)) {
        chain.unshift(cur);
        cur = dirname(cur);
      }
      for (const dir of chain) {
        const f = join(dir, "TRUSS.md");
        const t = readIfExists(f);
        if (t) layers.push({ path: f, scope: "folder", text: t });
      }
    }
  }
  const composed = layers.map((l) => `<!-- ${l.scope}: ${l.path} -->\n${l.text.trim()}`).join("\n\n---\n\n");
  return { layers, composed };
}

export function getGlobalPractices(): string {
  const g = readIfExists(GLOBAL_FILE);
  if (g !== null) return g;
  return DEFAULT_GLOBAL;
}

export function saveGlobalPractices(text: string) {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(GLOBAL_FILE, text, "utf8");
}

/** The posting guide always appended to MCP instructions (practices or not). */
export const POSTING_GUIDE = `Truss tools you have: file_todo / list_todos / update_todo / complete_todo (user-facing tasks with priority, deadline, labels, subtasks — you may only edit your OWN session's todos; a foreign edit asks the user first), post_feed / list_feed (the user's inbox — post reports and heads-ups there; read posts shared to you), plus the task-board and session tools. Follow the user's TRUSS.md practices when provided.`;
