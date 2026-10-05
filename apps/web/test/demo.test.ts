import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoBackend } from "../src/lib/demo";

/* Demo mode speaks the live backend's contract, so its metrics fixture has to
   carry every field the Monitor panel reads. The procs rows gained
   user/memPct/threads/ageSec, and the panel renders all four; a row missing
   ageSec renders the literal string "NaNm" in the age column. The fixture
   object is cast at the Backend boundary, so the compiler cannot catch an
   incomplete row — this test pins the shape instead. */

const PROC_FIELDS = ["pid", "cmd", "cpu", "rssMb", "state", "user", "memPct", "threads", "ageSec"] as const;

const num = (row: Record<string, unknown>, f: string): number => {
  const v = row[f];
  assert.equal(typeof v, "number", `${f} should be a number`);
  return v as number;
};
const str = (row: Record<string, unknown>, f: string): string => {
  const v = row[f];
  assert.equal(typeof v, "string", `${f} should be a string`);
  return v as string;
};

const checkRows = (label: string, procs: unknown) => {
  assert.ok(Array.isArray(procs), `${label}: procs is not an array`);
  assert.ok(procs.length > 0, `${label}: expected at least one demo procs row`);
  for (const row of procs) {
    const p = row as Record<string, unknown>;
    for (const f of PROC_FIELDS) {
      assert.ok(f in p, `${label}: procs row is missing "${f}"`);
    }
    assert.ok(num(p, "pid") > 0);
    assert.ok(str(p, "cmd").length > 0);
    assert.ok(num(p, "cpu") >= 0);
    assert.ok(num(p, "rssMb") >= 0);
    assert.ok(str(p, "state").length > 0);
    assert.ok(str(p, "user").length > 0);
    assert.ok(num(p, "memPct") >= 0);
    assert.ok(Number.isInteger(num(p, "threads")) && num(p, "threads") >= 0);
    assert.ok(num(p, "ageSec") >= 0);
  }
};

test("demo metrics: procs rows carry every field the Monitor panel renders", async () => {
  const m = await createDemoBackend().metrics();
  checkRows("local", m.local.metrics.procs);
  for (const [id, entry] of Object.entries(m.agents)) {
    assert.ok(entry, `${id}: demo agent entry is null`);
    checkRows(id, entry.metrics.procs);
  }
});

test("demo backend mirrors the auto-pair contract: pendingPair on hosts(), approve/deny stubs", async () => {
  /* issue #111 review, audit B1: the compiler cannot catch a demo drift
     behind the casts — pin the shape the pairing UI reads */
  const be = createDemoBackend();
  const { pendingPair } = await be.hosts();
  assert.ok(Array.isArray(pendingPair), "hosts() carries the pendingPair list (empty in demo)");
  assert.equal(typeof be.approvePairRequest, "function");
  assert.equal(typeof be.denyPairRequest, "function");
  const opts = await be.deliveryOptions("h1", null, "t", "http://demo:4040");
  const interactive = opts.options.find((o) => o.kind === "interactive");
  assert.ok(interactive, "the demo mirrors the interactive tier");
  assert.equal(interactive.typedChars, interactive.command.length, "auto-pair needs no code — the demo must not invent the +4");
});
