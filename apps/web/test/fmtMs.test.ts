import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtMs } from "../src/lib/format.js";

test("fmtMs: small values unchanged; hours and days for large gaps (issue #41)", () => {
  assert.equal(fmtMs(42), "42ms");
  assert.equal(fmtMs(1500), "1.50s");
  assert.equal(fmtMs(12_300), "12.3s");
  assert.equal(fmtMs(65_000), "1m05s");
  /* the bug: 91 hours showed as "+5456m31s" */
  assert.equal(fmtMs(91 * 3_600_000 + 31_000), "3d 19h");
  assert.equal(fmtMs(2 * 86_400_000), "2d");
  assert.equal(fmtMs(3 * 86_400_000 + 19 * 3_600_000), "3d 19h");
  assert.equal(fmtMs(undefined), "—");
});
