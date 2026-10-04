import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* SPEC-TESTS for the install one-liner's shell quoting —
   https://github.com/roowus/truss/issues/22
   (User report, macOS/zsh: `zsh: no matches found: http://…/install.sh?host=…`
   — the command never ran). These FAIL on purpose today: they pin the
   contract a fix must satisfy.

   Root cause: the wizard builds the one-liner with a BARE URL —
   `curl -fsSL ${serverAddr}/agent/install.sh?host=${id} | sh -s -- ${token}`
   (apps/web/src/components/AddHostWizard.tsx:92-94). The `?` is a glob
   metacharacter: zsh (default on macOS) aborts with "no matches found";
   POSIX sh/bash survive only because `//` makes the pattern unmatchable —
   until failglob/nullglob or a hostile custom address changes the picture.

   The contract: the command is composed by a pure
   src/lib/installCommand.ts —

     buildInstallCommand(serverAddr, hostId, token): string

   - the URL is single-quote wrapped; embedded single quotes are escaped
     POSIX-style ('\''); the rest of the line carries NO unquoted shell
     metacharacters (`? * [ ] & ; $ \` ( ) < >` — the one pipe excepted);
   - SHELL ROUND-TRIP: pasted into bash-with-failglob (zsh's NOMATCH
     behavior), dash, and zsh-when-present, curl receives the URL intact and
     `sh -s --` receives the token (proved with a PATH-stubbed curl below);
   - a hostile "custom address…" can't break out of the quotes.

   The matching comment inside the served script (agentbundle.ts:70) is
   acceptance criteria, not pinned here. */

interface InstallCommandModule {
  buildInstallCommand(serverAddr: string, hostId: string, token: string): string;
}

async function load(): Promise<InstallCommandModule | null> {
  const spec = "../src/lib/installCommand"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const ADDR = "http://rewvis.tail208cbf.ts.net:4040";
const HOST = "9cc3290f";
const TOKEN = "truss_agent_21d4681fe39cb592f896bd16132b9650da7e1917e9b36f80";
const URL = `${ADDR}/agent/install.sh?host=${HOST}`;

test("src/lib/installCommand.ts exists and quote-wraps the URL", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/installCommand.ts must export buildInstallCommand — see issue #22");
  const cmd = mod.buildInstallCommand(ADDR, HOST, TOKEN);
  assert.ok(cmd.includes(`'${URL}'`), "the URL is single-quoted");
  assert.ok(cmd.startsWith("curl -fsSL '"), "shape: curl -fsSL '<url>'");
  assert.ok(cmd.endsWith(`' | sh -s -- ${TOKEN}`), "… | sh -s -- <token>");
  assert.ok(!cmd.includes("\n"), "one line");
});

test("no unquoted shell metacharacters anywhere in the line", async () => {
  const mod = await load();
  assert.ok(mod, "installCommand module must exist (see module test)");
  const cmd = mod.buildInstallCommand(ADDR, HOST, TOKEN);
  /* remove single-quoted spans (with POSIX '\'' escapes), then the one pipe;
     nothing dangerous may remain */
  const stripped = cmd.replace(/'([^']|'\\'')*'/g, "").replace(/\| sh -s -- /, "");
  assert.match(stripped, /^[^?*\[\]&;$`()<>#~^]*$/, `unquoted remainder must be metachar-free — got: ${JSON.stringify(stripped)}`);
  assert.equal(cmd.split("|").length - 1, 1, "exactly one pipe");
});

test("a serverAddr containing a single quote is escaped, not injected", async () => {
  const mod = await load();
  assert.ok(mod, "installCommand module must exist (see module test)");
  /* the wizard's "custom address…" is user-typed — a quote in it must not
     break out of the quoting */
  const evil = `http://x:4040/' ; rm -rf ~ ; '`;
  const cmd = mod.buildInstallCommand(evil, HOST, TOKEN);
  const stripped = cmd.replace(/'([^']|'\\'')*'/g, "");
  assert.ok(!/rm -rf/.test(stripped.replace(/\| sh -s -- .*/, "")), "the injected text stays inside quotes");
});

test("SHELL ROUND-TRIP: the pasted line works under failglob (= zsh's default), dash, and zsh when present", async () => {
  const mod = await load();
  assert.ok(mod, "installCommand module must exist (see module test)");
  const cmd = mod.buildInstallCommand(ADDR, HOST, TOKEN);

  /* PATH-stubbed curl records its URL arg (stderr) and hands the pipe a
     script echoing $1 — so both halves of the one-liner are verified */
  const dir = mkdtempSync(join(tmpdir(), "truss-glob-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "curl"), '#!/bin/sh\necho "CURL_URL=$2" >&2\necho \'echo "SH_TOKEN=$1"\'\n');
    chmodSync(join(binDir, "curl"), 0o755);
    const env = { ...process.env, PATH: `${binDir}:/usr/bin:/bin` };

    const shells: [string, string, string][] = [
      ["bash+failglob (zsh's NOMATCH behavior)", "bash", "shopt -s failglob; "],
      ["dash (POSIX sh)", "dash", ""],
    ];
    let hasZsh = false;
    try {
      hasZsh = !!spawnSync("sh", ["-c", "command -v zsh"], { encoding: "utf8" }).stdout.trim();
    } catch {
      hasZsh = false;
    }
    if (hasZsh) shells.push(["zsh (the user's exact shell)", "zsh", ""]);

    for (const [name, exe, pre] of shells) {
      const r = spawnSync(exe, ["-c", pre + cmd], { env, cwd: dir, encoding: "utf8" });
      const all = `${r.stdout}\n${r.stderr}`;
      assert.equal(r.status, 0, `${name}: the pasted line must run (today: 'no matches found' before curl even starts)`);
      assert.ok(all.includes(`CURL_URL=${URL}`), `${name}: curl received the URL intact, query string and all`);
      assert.ok(r.stdout.includes(`SH_TOKEN=${TOKEN}`), `${name}: the token reached sh -s --`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agentRunCommand: the wizard's waiting step and the host panel share one string (issue #100 manual test)", async () => {
  /* the installer prints the run command to the remote's stdout, but a
     systemd-less host (macOS) starts nothing — the wizard must SHOW it */
  const mod = await load();
  assert.ok(mod, "installCommand module must exist (see module test)");
  const run = (mod as unknown as { agentRunCommand(h: string): string }).agentRunCommand("3139d6c3");
  assert.equal(run, "set -a; . ~/.truss/agent-3139d6c3.env; set +a; node ~/.truss/node-agent.mjs");
  assert.ok(!/[?*$`()[\]<>]/.test(run), "no glob/expansion metacharacters — zsh-safe like the install command (the semicolons are the intended separators)");
});
