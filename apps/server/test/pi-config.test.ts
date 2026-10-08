import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* pi-config.ts binds its paths from homedir() AT IMPORT TIME — HOME is faked
   before the dynamic import (static imports hoist), so the real ~/.pi is
   never touched. Covers syncPiExtension, the installer that puts the truss
   tools into pi's agent dir (issue #203; audit I1). */

const FAKE_HOME = mkdtempSync(join(tmpdir(), "truss-pi-config-"));
process.env.HOME = FAKE_HOME;

const { syncPiExtension } = await import("../src/pi-config.js");

const EXT = join(FAKE_HOME, ".pi", "agent", "extensions", "truss.ts");

after(() => {
  try {
    rmSync(FAKE_HOME, { recursive: true, force: true });
  } catch {
    /* tmp dirs get reaped anyway */
  }
});

test("syncPiExtension: writes the extension, then idempotent, then repairs drift", () => {
  /* first install: file created, and it's the truss bridge */
  const first = syncPiExtension();
  assert.equal(first.wrote, true);
  assert.equal(first.path, EXT);
  assert.ok(existsSync(EXT));
  const src = readFileSync(EXT, "utf8");
  assert.ok(/registerTool/.test(src), "registers pi tools");
  assert.ok(/post_feed/.test(src), "post_feed is among them");
  assert.ok(/if \(!SESSION\) return;/.test(src), "standalone pi (no TRUSS_SESSION_ID) gets no dead tools (audit M1)");

  /* same content → untouched (pi's extension watcher sees no churn) */
  const second = syncPiExtension();
  assert.equal(second.wrote, false);

  /* drift (user edit, older server wrote it) → repaired */
  writeFileSync(EXT, "// stale\n");
  const third = syncPiExtension();
  assert.equal(third.wrote, true);
  assert.ok(/registerTool/.test(readFileSync(EXT, "utf8")), "content restored");
});
