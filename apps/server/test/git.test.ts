import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { freshServer } from "./helpers.js";

/* git.ts — working-tree status / diff / branches / graph, parsed from the real
   git CLI. Tests build throwaway repos in freshServer temp dirs (git init
   -b main for a deterministic default branch; -c user.* on every commit so no
   global config is needed). The truss repo itself is never touched. */

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
function initRepo(dir: string) {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
}
function commit(dir: string, msg: string) {
  git(dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", msg);
}

test("non-git directory: status reports isRepo=false; other calls reject cleanly", async () => {
  const { dir, cleanup } = await freshServer("git-nongit");
  const g = await import("../src/git.js");
  try {
    writeFileSync(join(dir, "plain.txt"), "not a repo");
    const st = await g.gitStatus(dir);
    assert.equal(st.isRepo, false);
    assert.deepEqual(st.changes, []);
    assert.equal(st.branch, undefined);

    // rejected promises, not crashes; note git's wording differs per subcommand
    // ("fatal: not a git repository…" vs diff's "warning: Not a git repository…")
    await assert.rejects(() => g.gitBranches(dir), /not a git repository/i);
    await assert.rejects(() => g.gitGraph(dir), /not a git repository/i);
    await assert.rejects(() => g.gitDiff(dir, "plain.txt", false), /not a git repository/i);
  } finally {
    cleanup();
  }
});

test("status lifecycle: untracked on a no-commit repo (branch quirk), clean + named after commit", async () => {
  const { dir, cleanup } = await freshServer("git-status");
  const g = await import("../src/git.js");
  try {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "hello\n");

    // fresh repo, zero commits: the untracked file is listed
    const fresh = await g.gitStatus(dir);
    assert.equal(fresh.isRepo, true);
    assert.deepEqual(
      fresh.changes.map((c) => [c.path, c.x, c.y]),
      [["a.txt", "?", "?"]],
    );
    // porcelain head "## No commits yet on main" names the real branch
    assert.equal(fresh.branch, "main");

    git(dir, "add", "a.txt");
    commit(dir, "initial commit");
    const committed = await g.gitStatus(dir);
    assert.equal(committed.isRepo, true);
    assert.equal(committed.branch, "main");
    assert.deepEqual(committed.changes, [], "clean tree");
    assert.equal(committed.ahead, undefined);
    assert.equal(committed.behind, undefined);

    const { graph } = await g.gitGraph(dir);
    assert.match(graph, /initial commit/);
  } finally {
    cleanup();
  }
});

test("status codes + diff: modified vs untracked, unstaged/staged diff split", async () => {
  const { dir, cleanup } = await freshServer("git-diff");
  const g = await import("../src/git.js");
  try {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", "a.txt");
    commit(dir, "initial commit");

    appendFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");

    const st = await g.gitStatus(dir);
    const byPath = new Map(st.changes.map((c) => [c.path, c]));
    assert.deepEqual([byPath.get("a.txt")!.x, byPath.get("a.txt")!.y], [" ", "M"], "unstaged modification");
    assert.deepEqual([byPath.get("b.txt")!.x, byPath.get("b.txt")!.y], ["?", "?"], "untracked");

    const unstaged = await g.gitDiff(dir, "a.txt", false);
    assert.ok(unstaged.diff.length > 0, "unstaged diff is non-empty");
    assert.match(unstaged.diff, /\+two/);
    const stagedEmpty = await g.gitDiff(dir, "a.txt", true);
    assert.equal(stagedEmpty.diff, "", "nothing staged yet");

    git(dir, "add", "a.txt");
    const staged = await g.gitStatus(dir);
    const a = staged.changes.find((c) => c.path === "a.txt")!;
    assert.deepEqual([a.x, a.y], ["M", " "], "now staged");
    const stagedDiff = await g.gitDiff(dir, "a.txt", true);
    assert.match(stagedDiff.diff, /\+two/);
    assert.equal((await g.gitDiff(dir, "a.txt", false)).diff, "", "worktree matches the index now");
  } finally {
    cleanup();
  }
});

test("branches: list with current + subject, switch -c, invalid names, detached HEAD", async () => {
  const { dir, cleanup } = await freshServer("git-branch");
  const g = await import("../src/git.js");
  try {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", "a.txt");
    commit(dir, "initial commit");

    const { branches } = await g.gitBranches(dir);
    assert.equal(branches.length, 1);
    assert.equal(branches[0].name, "main");
    assert.equal(branches[0].current, true);
    assert.equal(branches[0].last, "initial commit");
    assert.ok(branches[0].at > 0, "commit time as epoch ms");

    await g.gitSwitch(dir, "feature", true);
    const after = await g.gitBranches(dir);
    assert.equal(after.branches.length, 2);
    assert.equal(after.branches.find((b) => b.name === "feature")!.current, true);
    assert.equal(after.branches.find((b) => b.name === "main")!.current, false);
    assert.equal((await g.gitStatus(dir)).branch, "feature");

    await g.gitSwitch(dir, "main", false);
    assert.equal((await g.gitStatus(dir)).branch, "main");

    // branch name validation happens before git runs
    await assert.rejects(() => g.gitSwitch(dir, "bad name", true), /invalid branch name/);
    await assert.rejects(() => g.gitSwitch(dir, "-x", true), /invalid branch name/);
    // the module's regex is looser than git's own rules — "a..b" sails through
    // it, but git itself still refuses ("fatal: 'a..b' is not a valid branch name")
    await assert.rejects(() => g.gitSwitch(dir, "a..b", true), /not a valid branch name/);
    // switching to a branch that doesn't exist surfaces git's error
    await assert.rejects(() => g.gitSwitch(dir, "ghost", false));

    // detached HEAD: porcelain says "## HEAD (no branch)" -> branch undefined
    git(dir, "checkout", "-q", "--detach", "HEAD");
    const detached = await g.gitStatus(dir);
    assert.equal(detached.isRepo, true);
    assert.equal(detached.branch, undefined);
  } finally {
    cleanup();
  }
});
