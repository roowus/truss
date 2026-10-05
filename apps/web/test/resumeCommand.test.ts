import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for harness-native resume hints — https://github.com/roowus/truss/issues/131
   (User story: ran a pi session on their Mac through truss, then on the Mac
   typed `pi --resume 31752821` → "as if that chat didn't happen". These
   FAIL on purpose today: they pin the contract a fix must satisfy.

   Why it happens (investigated, with live evidence): the visible id is
   TRUSS's (8-hex). pi knows the session by ITS OWN uuid — which truss
   already stores as harness_ref (live proof: truss session 8631a9ae ↔
   harness_ref 01a0edfd-6598-727a-99ee-15ab86352a3c). And `--resume` takes
   no argument at all (it's the picker — vendored pi docs, cli.md:87); the
   direct form is `pi --session <id>` (cli.md:89). So the user's command
   both named the wrong id-space AND used the wrong flag. Nothing in the UI
   surfaces the right one.

   The contract: src/lib/resumeCommand.ts —

     resumeCommand(harness: string, harnessRef: string | null | undefined): string | null

   - pi / pi@<host>        → `pi --session <ref>`      (vendored docs)
   - dsh / dsh@<host>      → `dsh tui --resume <ref>`  (dsh args.ts)
   - hermes / unknown      → null (never fabricate a CLI we haven't verified)
   - missing/blank ref     → null (no fake affordance)
   - the ref is shell-quoted if it carries unsafe chars (refs are harness
     uuids today, but never build an injectable command) */

interface ResumeModule {
  resumeCommand(harness: string, harnessRef: string | null | undefined): string | null;
}

async function load(): Promise<ResumeModule | null> {
  const spec = "../src/lib/resumeCommand"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/resumeCommand.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/resumeCommand.ts must export resumeCommand — see issue #131");
});

test("verified forms per harness; remote variants identical (the command runs ON the host)", async () => {
  const mod = await load();
  assert.ok(mod, "resumeCommand module must exist (see module test)");

  assert.equal(mod.resumeCommand("pi", "01a0edfd-6598-727a-99ee-15ab86352a3c"), "pi --session 01a0edfd-6598-727a-99ee-15ab86352a3c", "pi's direct-resume form (NOT --resume <id> — that's the picker)");
  assert.equal(mod.resumeCommand("pi@3bf6c662", "abc-123"), "pi --session abc-123", "same on a remote host — the user runs it there");

  assert.equal(mod.resumeCommand("dsh", "f1d21a19-b077-427b-b23f-0dd2985793a1"), "dsh tui --resume f1d21a19-b077-427b-b23f-0dd2985793a1", "dsh's resume goes through the tui profile");
  assert.equal(mod.resumeCommand("dsh@box", "session-x"), "dsh tui --resume session-x");
});

test("never fabricate: unknown harnesses and missing refs give no command", async () => {
  const mod = await load();
  assert.ok(mod, "resumeCommand module must exist (see module test)");

  assert.equal(mod.resumeCommand("hermes", "some-ref"), null, "hermes's CLI resume is unverified — no fabrication");
  assert.equal(mod.resumeCommand("mystery-harness", "x"), null);
  assert.equal(mod.resumeCommand("pi", null), null, "no ref, no affordance");
  assert.equal(mod.resumeCommand("pi", undefined), null);
  assert.equal(mod.resumeCommand("pi", "  "), null, "blank ref");
  assert.equal(mod.resumeCommand("", "x"), null);

  /* refs with shell-hostile chars get quoted, never raw-interpolated */
  const q = mod.resumeCommand("pi", "ab'; rm -rf ~; echo '");
  assert.ok(q === null || /^pi --session '[^']*'$/.test(q), "hostile refs are quoted or refused, never raw");
});
