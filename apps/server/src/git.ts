import { execFile } from "node:child_process";

/**
 * Git panel backend (cloned from the dsh-lab git-graph + better-sidebar
 * "Changes" tabs): working-tree status + per-file diff, branch list with
 * switch/create, and the commit graph. Read-mostly: the only mutation is
 * `git switch` — staging/committing stays with the agent (terminal/chat).
 */

const TIMEOUT = 10_000;
const MAXBUF = 8 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, timeout: TIMEOUT, maxBuffer: MAXBUF }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || err.message || "git failed").trim().split("\n")[0]));
      else res(stdout);
    });
  });
}

export interface GitChange {
  path: string;
  orig?: string; // rename source
  x: string; // staged status letter
  y: string; // unstaged status letter
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  changes: GitChange[];
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  let out: string;
  try {
    out = await git(cwd, ["status", "--porcelain=v1", "--branch", "--no-renames"]);
  } catch (e: any) {
    if (/not a git repository/i.test(e.message)) return { isRepo: false, changes: [] };
    throw e;
  }
  const lines = out.split("\n");
  const head = lines[0] ?? "";
  /* porcelain head forms: "## main...o/m [ahead 1]" / "## No commits yet on
     main" / "## HEAD (no branch)" — one regex used to read "No" and "HEAD"
     as branch names */
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  if (head.startsWith("## No commits yet on ")) {
    branch = head.slice("## No commits yet on ".length).trim() || undefined;
  } else if (/^## HEAD\b/.test(head)) {
    branch = undefined; // detached
  } else {
    const m = head.match(/^## ([^.\s]+)(?:\.\.\.\S+)?(?: \[ahead (\d+)(?:, behind (\d+))?\])?(?: \[behind (\d+)\])?/);
    branch = m?.[1];
    ahead = m?.[2] ? Number(m[2]) : undefined;
    behind = m?.[3] ? Number(m[3]) : m?.[4] ? Number(m[4]) : undefined;
  }
  const changes: GitChange[] = [];
  for (const ln of lines.slice(1)) {
    if (!ln.trim()) continue;
    const x = ln[0];
    const y = ln[1];
    let path = ln.slice(3);
    let orig: string | undefined;
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) {
      orig = path.slice(0, arrow);
      path = path.slice(arrow + 4);
    }
    changes.push({ path, orig, x, y });
  }
  return { isRepo: true, branch, ahead, behind, changes };
}

export interface GitBranch {
  name: string;
  current: boolean;
  last: string; // last commit subject
  at: number; // last commit epoch ms
}

export async function gitBranches(cwd: string): Promise<{ branches: GitBranch[] }> {
  const out = await git(cwd, [
    "branch", "--sort=-committerdate",
    "--format=%(HEAD)%01%(refname:short)%01%(committerdate:unix)%01%(contents:subject)",
  ]);
  const branches = out.split("\n").filter(Boolean).map((ln) => {
    const [head, name, at, ...rest] = ln.split("\x01");
    return { name, current: head.trim() === "*", at: Number(at) * 1000, last: rest.join("\x01") };
  });
  return { branches };
}

export async function gitGraph(cwd: string, n = 60): Promise<{ graph: string }> {
  const graph = await git(cwd, [
    "log", "--graph", "--oneline", "--decorate=short", "--all", "--color=never", `-n`, String(Math.min(n, 200)),
  ]);
  return { graph };
}

export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<{ diff: string }> {
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (staged) args.push("--cached");
  const diff = await git(cwd, [...args, "--", path]);
  return { diff: diff.slice(0, 512 * 1024) };
}

export async function gitSwitch(cwd: string, branch: string, create: boolean): Promise<{ branch: string }> {
  if (!/^[^\s~^:?*[\]\\]+$/.test(branch) || branch.startsWith("-")) throw new Error("invalid branch name");
  await git(cwd, create ? ["switch", "-c", branch] : ["switch", branch]);
  return { branch };
}
