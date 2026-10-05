import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for human-minted host ids — https://github.com/roowus/truss/issues/109
   ("Why do connected sessions say pi@525b9cd4 and not pi@rewissmacbookpro").
   These FAIL on purpose today.

   The display-layer fix (harnessDisplay, web) is the primary; this is the
   deeper option the issue specs: mint the id FROM the label at creation.
   The wizard always has a label at mint time (step 1's name), so
   `rewiss-macbookpro` can BE the id — every raw surface reads right by
   construction, forever immutable (env files on devices keep working).

   The contract (hosts.ts createHost):
   - ids are label-slugged: lowercase, [a-z0-9-], the label's words joined;
   - collisions suffix deterministically-unique (label-2, label-3…);
   - labels with no safe chars fall back to the hex shape (never throw);
   - today's guarantees stand: token minted + verified, prefix hint intact. */

test("createHost mints label-slugged ids; collisions suffix; unsafe labels fall back", async () => {
  const { cleanup } = await freshServer("host-slug");
  try {
    const hosts = await import("../src/hosts.js");
    const { host, token } = hosts.createHost("Rewiss Macbook Pro");
    assert.match(host.id, /^[a-z0-9][a-z0-9-]*$/, "ids are url/env-safe slugs");
    assert.ok(host.id.includes("rewiss"), `the label leads the id — got ${host.id} (today: random hex like 525b9cd4)`);
    assert.ok(host.id.includes("macbook"), "the full slug");

    /* the token flow is untouched */
    assert.ok(token.startsWith("truss_agent_"));
    assert.equal(hosts.verifyAgentToken(host.id, token, ""), true, "slug ids verify exactly like hex ids");

    const dupe = hosts.createHost("Rewiss Macbook Pro");
    assert.ok(dupe.host.id !== host.id, "no id collision");
    assert.ok(dupe.host.id.includes("rewiss"), "the dupe still reads right");
    assert.match(dupe.host.id, /rewiss.*[-2-9a-z]/, "with a uniqueness suffix");

    const weird = hosts.createHost("🚀🚀🚀");
    assert.match(weird.host.id, /^[a-z0-9][a-z0-9-]*$/, "emoji-only labels fall back to a safe id");
  } finally {
    cleanup();
  }
});
