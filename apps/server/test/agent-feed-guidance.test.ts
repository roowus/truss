import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for agents using the feed — https://github.com/roowus/truss/issues/203
   (User story: a pi session told to "write a report" never used the feed.
   Investigated: pi sessions get NO truss tools at all — pi doesn't speak
   MCP (vendored pi-mono grep: zero MCP support; its tool model is
   extensions), while dsh/hermes/claude get the truss MCP — and even they
   get no "deliverables go to the feed" guidance, so the tool sits unused).
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   The contract, two halves:

   1. EVERY harness session carries the deliverables guidance — a shared
      src/deliverables.ts:

        deliverablesGuidance(): string
          — one canonical paragraph: finished research/reports/analysis go
            to the user's feed via post_feed (type "report"), heads-ups as
            "note"; never buried in chat only.

      …and every adapter's spawn wiring includes it (read-through pins).

   2. pi gets the tools through an EXTENSION (its tool model — MCP doesn't
      exist there): src/piExtension.ts (or a shipped .pi extension source) —

        piTrussExtensionSource(): string
          — registers post_feed (+ list_feed) tools that call the truss HTTP
            API; the pi adapter/config sync installs + enables it. */

test("deliverablesGuidance exists and says the thing", async () => {
  const { cleanup } = await freshServer("feed-guide");
  try {
    const spec = "../src/deliverables.js"; // variable specifier: typechecks before the module exists
    const mod: any = await import(spec).catch(() => null);
    assert.ok(mod, "src/deliverables.ts must export deliverablesGuidance — see issue #203");
    const g = mod.deliverablesGuidance();
    assert.match(g, /post_feed/, "names the tool");
    assert.match(g, /report/i, "reports → the feed");
    assert.match(g, /feed/i, "the destination is named");
  } finally {
    cleanup();
  }
});

test("every adapter's spawn wiring carries the guidance", () => {
  for (const adapter of ["pi", "dsh", "hermes", "claude"]) {
    const src = readFileSync(new URL(`../src/adapters/${adapter}.ts`, import.meta.url), "utf8");
    assert.ok(/deliverablesGuidance/.test(src), `${adapter}: the session bootstrap must include the deliverables guidance (the report went to chat-only because nothing said otherwise)`);
  }
});

test("pi gets its tools via a shipped extension (its tool model — no MCP exists there)", async () => {
  const { cleanup } = await freshServer("pi-ext");
  try {
    const spec = "../src/piExtension.js"; // variable specifier
    const mod: any = await import(spec).catch(() => null);
    assert.ok(mod, "src/piExtension.ts must export the pi truss extension — pi speaks extensions, not MCP (issue #203)");
    const src = mod.piTrussExtensionSource();
    assert.match(src, /registerTool/, "a pi extension registers tools");
    assert.match(src, /post_feed/, "post_feed is among them");
    assert.match(src, /\/api\/feed|postFeed|\/mcp\//, "and it reaches the truss server");

    /* and the adapter/config actually installs it */
    const piAdapter = readFileSync(new URL("../src/adapters/pi.ts", import.meta.url), "utf8");
    const piConfig = readFileSync(new URL("../src/pi-config.ts", import.meta.url), "utf8");
    assert.ok(/piTrussExtension|piExtension/.test(piAdapter + piConfig), "pi sessions load the extension (install at sync/spawn)");
  } finally {
    cleanup();
  }
});
