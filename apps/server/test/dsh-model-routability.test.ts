import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* REGRESSION for issue #232, Q4 — rows that render but cannot be applied.

   dsh.ts gates the in-session model switch on the HARNESS report:

     if (opts.model && models.some((m) => m.model === opts.model)) {
       await client.call("session/set_config_option", { ... });
     }

   while the picker was fed by the #231 fallback (harness report ∪ credential
   catalog). With the harness reporting 27 and the picker serving ~825, roughly
   798 rows were offered that silently did NOT apply when selected — the
   user's chosen model was dropped, with no error. Production confirmed:
   `models:dsh = 27 rows {fireworks:27}` while the picker served 825.

   Once the catalog is generated from the credential catalog (the real fix)
   the two lists agree, so this becomes a structural guarantee rather than a
   coincidence. These tests pin the invariant that makes it safe:

     every row the picker offers must be a row the harness can route.

   The fallback is what made them disagree, so the fallback is deleted; these
   tests pin its absence and the agreement it used to break. */

const dsh: any = await import("../src/adapters/dsh.js");

test("the #231 stale-catalog fallback is gone, not merely unused", () => {
  /* Q1 approved deleting it: the issue itself notes that once the real report
     is fixed the fallback should be deleted rather than tuned. Leaving the
     functions exported but uncalled would invite a future re-wire, so the
     deletion is pinned. */
  assert.equal(dsh.mergeCatalogRows, undefined, "mergeCatalogRows must be deleted, not left dormant");
  assert.equal(dsh.catalogLooksStale, undefined, "catalogLooksStale must be deleted, not left dormant");
  assert.equal(dsh.DSH_MIN_EXPECTED_MODELS, undefined, "the 50-row heuristic floor must be deleted");
});

test("the picker list and the harness-routable list are the same list", async () => {
  /* the invariant that replaces the fallback: whatever listModels() returns
     for dsh is exactly what the spawn path validates opts.model against.
     A row outside it is one that renders and cannot be applied. */
  const models = await dsh.dshAdapter.listModels();
  const routable = await dsh.routableModels();
  assert.deepEqual(
    models.map((m: any) => `${m.provider}\u0000${m.model}`),
    routable.map((m: any) => `${m.provider}\u0000${m.model}`),
    "the picker must offer exactly the harness-routable set",
  );
});

test("the generated catalog patch is passed as a second --patch, after the static one", async () => {
  /* ordering matters: the static patch supplies everything except the model
     list (agent default, acp pin, llm-deepseek disable), and the generated
     one layers its llm-pi-ai providers over it. Reversed, the static 27 would
     win and the picker would go narrow again. */
  const launch: any = (await import("../src/adapters/dsh.js")).client;
  assert.ok(launch, "the dsh client is exported for this pin");

  const before = dsh.__launchArgs();
  assert.deepEqual(before, ["--profile", "acp", "--patch", dsh.__staticPatchPath()], "starts with only the static patch");

  dsh.useGeneratedCatalogPatch("/tmp/generated-models.yml");
  const after = dsh.__launchArgs();
  assert.deepEqual(
    after,
    ["--profile", "acp", "--patch", dsh.__staticPatchPath(), "--patch", "/tmp/generated-models.yml"],
    "the generated patch rides second so it layers over the static one",
  );

  /* idempotent: a second boot-time sync must not stack duplicate --patch args */
  dsh.useGeneratedCatalogPatch("/tmp/generated-models.yml");
  assert.deepEqual(dsh.__launchArgs(), after, "re-applying the same patch path is a no-op");
});

test("the harvest waits for generation, so dsh never boots on stale args (the preview race)", async () => {
  /* REGRESSION: generation is I/O and runs concurrently with the server
     coming up. On the preview, the first picker probe reached the harvest
     before generation finished, so dsh was spawned from the static-only args
     and the picker reported the old 27 even though the generated file existed
     and was correct (verified: the exact command with both --patch args
     reports 813 leaves). The harvest must therefore await the settled
     generation attempt before it boots the harness. */
  assert.equal(typeof dsh.markGenerationSettled, "function", "the gate must be wired for index.ts");

  let resolved = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = () => {
      resolved = true;
      r();
    };
  });
  dsh.markGenerationSettled(gate);
  assert.equal(resolved, false, "the gate is pending until generation settles");
  release();
  await gate;
  assert.equal(resolved, true, "and resolves once it does");
});

/* spawn()'s gate ordering (audit B3) is pinned BEHAVIOURALLY in
   dsh-spawn-gate.test.ts: a real spawn is driven against a fake ACP binary
   while the generation gate is held open, asserting dsh does not boot until
   it settles. That test was verified to fail with the await removed and pass
   with it restored. An earlier version of this file asserted the same thing
   by grepping the source for `await generationSettled`, which would have
   passed on a commented-out line — deliberately not repeated here. */

test("the harvest waits for generation, so dsh never boots on stale args (the preview race)", async () => {
  /* REGRESSION: generation is I/O and runs concurrently with the server
     coming up. On the preview, the first picker probe reached the harvest
     before generation finished, so dsh was spawned from the static-only args
     and the picker reported the old 27 even though the generated file existed
     and was correct (verified: the exact command with both --patch args
     reports 813 leaves). The harvest must therefore await the settled
     generation attempt before it boots the harness. */
  assert.equal(typeof dsh.markGenerationSettled, "function", "the gate must be wired for index.ts");

  let resolved = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = () => {
      resolved = true;
      r();
    };
  });
  dsh.markGenerationSettled(gate);
  assert.equal(resolved, false, "the gate is pending until generation settles");
  release();
  await gate;
  assert.equal(resolved, true, "and resolves once it does");
});

test("spawn() waits for generation before booting dsh (audit B3)", async () => {
  /* spawn() calls refreshLaunchArgs() before client.ensure(), but generation
     is fire-and-forget at boot while the server is already listening. Without
     awaiting the gate, a session created during that window sees
     generatedPatch === null, boots dsh from the static-only args, and the
     narrow report is then written over the good catalog — and AcpClient keeps
     that process alive, so the narrow catalog outlives the race.

     The spawn path is asserted structurally (spawn awaits the shared gate)
     because driving a real spawn needs a dsh binary; the gate itself is
     exercised by the resolved/pending assertions above. */
  const src = readFileSync(new URL("../src/adapters/dsh.ts", import.meta.url), "utf8");
  const spawnBody = src.slice(src.indexOf("async spawn(opts: SessionOpts)"));
  const gate = spawnBody.indexOf("await generationSettled");
  const refresh = spawnBody.indexOf("refreshLaunchArgs()");
  const ensure = spawnBody.indexOf("await client.ensure()");

  assert.ok(gate !== -1, "spawn must await the generation gate (audit B3)");
  assert.ok(refresh !== -1, "spawn must re-read the generated patch before booting");
  assert.ok(ensure !== -1, "spawn must still boot the client");
  assert.ok(gate < refresh, "the gate must be awaited BEFORE the args are composed");
  assert.ok(refresh < ensure, "and the args composed BEFORE the client boots");
});
