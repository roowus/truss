import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the project field's default — https://github.com/roowus/truss/issues/202
   ("The New Session dialog often pre-selects a project — the default should
   be NO project; the user picks one if it's supposed to be"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   Today (NewSessionDialog.tsx:40): the project state initializes
   `preset?.project ?? sessions[order[0]]?.project ?? ""` — the MOST RECENT
   session's project silently becomes the new session's. (The recent-project
   chips stay — explicit one-click picks are fine; the sin is the silent
   default.)

   The contract:

   1. cwdDefault.ts (the defaults lib) gains resolveDefaultProject({ preset }):
      an explicit preset wins; otherwise BLANK — recency never fills it;
   2. read-through: the dialog no longer seeds project from the most recent
      session. */

interface DefaultsModule {
  resolveDefaultProject(input: { preset?: string }): string;
}

async function load(): Promise<DefaultsModule | null> {
  const spec = "../src/lib/cwdDefault"; // the defaults module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.resolveDefaultProject === "function" ? mod : null;
}

test("resolveDefaultProject: preset wins; nothing else fills", async () => {
  const mod = await load();
  assert.ok(mod, "cwdDefault.ts must export resolveDefaultProject — see issue #202");

  assert.equal(mod.resolveDefaultProject({ preset: "doubletake" }), "doubletake", "an explicit preset (task board 'new session here') still pre-fills");
  assert.equal(mod.resolveDefaultProject({}), "", "otherwise BLANK — the user picks a project if it IS one");
  assert.equal(mod.resolveDefaultProject({ preset: "  " }), "", "a blank preset is no preset");
});

test("read-through: the dialog never seeds the project from the most recent session", () => {
  const src = readFileSync(new URL("../src/components/NewSessionDialog.tsx", import.meta.url), "utf8");
  assert.ok(/resolveDefaultProject\(/.test(src), "the dialog's project default comes from the contract fn");
  assert.ok(
    !/sessions\[order\[0\]\]\?\.project/.test(src),
    "the recent-session fallback is gone — that's the silent pre-select (issue #202)",
  );
});
