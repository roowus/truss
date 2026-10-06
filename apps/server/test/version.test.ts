import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* Direct pin of the /health commit resolver (issue #135, PR #137 audit
   round 1 finding B3): the issue's spec test skips its format assertion
   when /health reports "unknown", so a resolveCommit regression to
   always-"unknown" would ship green. COMMIT is resolved once at module
   import, so each case runs in a subprocess with its own env. */

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url)); // apps/server/

function resolveIn(env: NodeJS.ProcessEnv): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "-e", 'import("./src/version.js").then((m) => console.log(m.COMMIT))'],
    { cwd: SERVER_DIR, env: { ...process.env, ...env }, timeout: 30000 },
  )
    .toString()
    .trim();
}

test("TRUSS_COMMIT override wins (packaged deploys)", () => {
  assert.equal(resolveIn({ TRUSS_COMMIT: "abc1234" }), "abc1234");
});

test("a git checkout resolves the real HEAD sha", () => {
  const env = { ...process.env };
  delete env.TRUSS_COMMIT;
  assert.match(resolveIn(env), /^[0-9a-f]{40}$/);
});

test("no git anywhere falls back to \"unknown\", never throws", () => {
  assert.equal(resolveIn({ TRUSS_COMMIT: "", PATH: "/nonexistent" }), "unknown");
});
