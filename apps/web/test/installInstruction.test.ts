import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/* SPEC-TESTS for the taildrop run-instruction copy —
   https://github.com/roowus/truss/issues/93
   (User log: the wizard said "…inbox: run sh ~/Downloads/truss-install-…"
   and the user typed it verbatim → `zsh: command not found: run`).
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   The bug: the instruction is PROSE WITH THE COMMAND EMBEDDED
   ("…run sh ~/Downloads/x.sh"). Users paste prose. The fix separates them:
   a LABEL for humans and a COMMAND that's exactly what runs — one click
   copies the command alone.

   The contract: a pure src/lib/installInstruction.ts —

     dropRunCommand(fileName): string
       EXACTLY `sh ~/Downloads/<fileName>` — one line, shell-runnable, no
       prose, no leading verb, no trailing period;
     dropInstructionLabel(fileName): string
       the human sentence shown beside it — must NOT contain the command
       text and must NOT start with an imperative that reads like part of
       the command ("run", "type", "execute"…).

   Verified below against the real sh (syntax check) — the contract is
   "pasteable as-is". */

interface InstallInstructionModule {
  dropRunCommand(fileName: string): string;
  dropInstructionLabel(fileName: string): string;
}

async function load(): Promise<InstallInstructionModule | null> {
  const spec = "../src/lib/installInstruction"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const FILE = "truss-install-dd203a82.sh";

test("src/lib/installInstruction.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/installInstruction.ts must export dropRunCommand/dropInstructionLabel — see issue #93");
});

test("the command is exactly the runnable line — no prose can ride into a paste", async () => {
  const mod = await load();
  assert.ok(mod, "installInstruction module must exist (see module test)");
  const cmd = mod.dropRunCommand(FILE);

  assert.equal(cmd, `sh ~/Downloads/${FILE}`, "exactly `sh <path>` — nothing before, nothing after");
  assert.equal(cmd.trim().split(/\s+/).length, 2, "two words: `sh` and the path");
  assert.ok(!cmd.includes("\n") && cmd === cmd.trim(), "one clean line");
  assert.match(cmd, /^[a-z0-9~\/\s._-]+$/i, "shell-safe characters only");

  /* pasteable as-is: the real shell parses it (file needn't exist for -n) */
  const check = execFileSync("sh", ["-n", "-c", cmd], { encoding: "utf8" });
  assert.equal(check, "", "sh -n: syntactically runnable");
  assert.doesNotThrow(() => execFileSync("sh", ["-n", "-c", cmd]));
});

test("the label never contains the command, and no imperative reads as part of it", async () => {
  const mod = await load();
  assert.ok(mod, "installInstruction module must exist (see module test)");
  const label = mod.dropInstructionLabel(FILE);
  const cmd = mod.dropRunCommand(FILE);

  assert.ok(label.length > 0, "a human sentence exists");
  assert.ok(!label.includes(cmd), "the label never embeds the command");
  assert.ok(!/\b(run|type|execute|paste)\s+sh\b/i.test(label), `no 'run sh …' trap — the user's exact typo; got: ${JSON.stringify(label)}`);
  assert.ok(!/^run\b/i.test(label.trim()), "the label doesn't START with the verb either");
  assert.ok(label.includes("~/Downloads") || /taildrop|inbox/i.test(label), "still tells the human where the file is");
});
