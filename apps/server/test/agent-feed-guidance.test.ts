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

/* issue #222: the automation rule — agents asked for recurring work keep
   reaching for the OS (crontab/systemd timers/launchd) instead of truss's
   own scheduler. The tools exist (#16's schedule_task); nothing told the
   model. Same failure shape as #203. */

test("the guidance forbids OS-level schedulers and names schedule_task", async () => {
  const spec = "../src/deliverables.js";
  const mod: any = await import(spec).catch(() => null);
  assert.ok(mod, "deliverables.ts must exist (see the #203 tests)");

  const g = mod.deliverablesGuidance();
  assert.match(
    g,
    /never[^.]*crontab|not[^.]*crontab|crontab[^.]*never|OS[- ]level/i,
    "the guidance explicitly forbids OS-level cron — today it's silent and agents write crontab entries (issue #222)",
  );
  assert.match(g, /schedule_task/, "and names the truss tool to use instead");
  assert.match(g, /systemd|launchd|timer/i, "naming the other OS schedulers too");
});

/* audit B1 (PR #240): the guidance rides EVERY harness's bootstrap, but
   schedule_task is a truss-MCP tool and pi attaches no MCP server
   (sessions.ts's MCP_ATTACHED; pi's extension registers only
   post_feed/list_feed — piExtension.ts). Telling pi to call a tool it cannot
   call is worse than silence: it hallucinates the call or falls back to the
   OS path the previous test forbids. So the tool name must appear only where
   the tool exists, while the PROHIBITION stays everywhere (that is #222's
   actual ask, and it is true on every harness).

   The pin reads the adapters' real wiring rather than a helper's existence:
   the MCP-attached adapters must carry a paragraph that names schedule_task,
   and pi's bootstrap (adapter + POSTING_GUIDE_PI) must carry one that does
   not — while both keep the OS prohibition. */
test("the guidance names only tools the addressed harness actually exposes", async () => {
  const { cleanup } = await freshServer("guide-harness");
  try {
    const spec = "../src/deliverables.js";
    const mod: any = await import(spec).catch(() => null);
    assert.ok(mod, "deliverables.ts must exist (see the #203 tests)");
    assert.equal(
      typeof mod.deliverablesGuidanceFor,
      "function",
      "deliverables.ts must expose the per-harness selector so a caller cannot send pi the MCP wording",
    );

    /* harnesses that attach the truss MCP get the tool name */
    for (const ok of ["claude-code", "dsh", "hermes"]) {
      const g = mod.deliverablesGuidanceFor(ok);
      assert.match(g, /schedule_task/, `${ok} attaches the truss MCP, so it can call schedule_task — name it`);
      assert.match(g, /crontab/i, `${ok} also carries the prohibition`);
    }

    /* pi cannot: it must get the prohibition WITHOUT the un-callable name,
       and must be pointed at the surface it does have */
    for (const no of ["pi", "pi@node1"]) {
      const g = mod.deliverablesGuidanceFor(no);
      assert.doesNotMatch(
        g,
        /schedule_task/,
        `${no} has no truss MCP (and its extension registers only post_feed/list_feed) — naming schedule_task would instruct it to call a tool that is not registered`,
      );
      assert.match(
        g,
        /crontab/i,
        `${no} still carries the prohibition — #222 asks for it on EVERY harness`,
      );
      assert.match(g, /no scheduling tool|user to schedule/i, `${no} is pointed at a surface it actually has`);
    }

    /* and the wiring actually uses them: each pi surface must carry the
       no-MCP variant, and the MCP adapters must not carry the pi wording.
       Checked per file — concatenating them would let one file's correct
       import mask another file's regression. */
    for (const piFile of ["../src/adapters/pi.ts", "../src/practices.ts"]) {
      const src = readFileSync(new URL(piFile, import.meta.url), "utf8");
      assert.match(
        src,
        /deliverablesGuidanceNoMcp/,
        `${piFile} is a pi bootstrap surface (pi has no schedule_task) — it must use the no-MCP variant`,
      );
      assert.doesNotMatch(
        src,
        /deliverablesGuidance\(\)/,
        `${piFile} must not interpolate the MCP variant: it names schedule_task, which pi cannot call`,
      );
    }
    for (const adapter of ["dsh", "hermes", "claude"]) {
      const src = readFileSync(new URL(`../src/adapters/${adapter}.ts`, import.meta.url), "utf8");
      assert.match(
        src,
        /deliverablesGuidance\(\)/,
        `${adapter} attaches the truss MCP — it must keep the variant that names schedule_task`,
      );
      assert.doesNotMatch(src, /deliverablesGuidanceNoMcp/, `${adapter} CAN call schedule_task; don't send it the pi wording`);
    }
  } finally {
    cleanup();
  }
});

test("schedule_task's own description carries the prohibition (the tool-level nudge)", async () => {
  /* inside freshServer: mcp-truss.ts imports db.ts, which opens truss.db at
     module load from TRUSS_DATA_DIR (db.ts:8-13) — a bare import here would
     hit the real data dir (audit B2, PR #240; it fails outright when that
     dir isn't writable, e.g. under --test-name-pattern). */
  const { cleanup } = await freshServer("guide-tool");
  try {
    const mcp: any = await import("../src/mcp-truss.js").catch(() => null);
    assert.ok(mcp, "mcp-truss.ts loads");
    const tool = (mcp.TOOLS as any[]).find((t) => t.name === "schedule_task");
    assert.ok(tool, "schedule_task exists (#16)");
    assert.match(
      JSON.stringify(tool.description),
      /crontab|systemd|launchd|OS[- ]level/i,
      "the tool description says: recurring automation goes HERE, not into the OS",
    );
  } finally {
    cleanup();
  }
});
