import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the new-session dialog's model labels —
   https://github.com/roowus/truss/issues/199
   ("The create-session model dropdown has the same messy unparsed names —
   parse it like the session switcher"). These FAIL on purpose today.

   #169 fixed the picker's display — in the HEADER/composer path only. The
   New Session dialog builds its own options inline (NewSessionDialog.tsx:
   `label: m.label` — the raw catalog label, e.g.
   accounts/fireworks/routers/…/kimi-k3).

   The contract: ONE source of display truth — the dialog's model options
   come from buildModelOptions (models.ts, the #169 parsing included).
   Read-through pins + a same-output pin. */

const DIALOG = () => readFileSync(new URL("../src/components/NewSessionDialog.tsx", import.meta.url), "utf8");

test("the dialog's model options come from buildModelOptions (the parsed path)", () => {
  const src = DIALOG();
  assert.ok(
    /buildModelOptions\(/.test(src),
    "NewSessionDialog must build its model options through buildModelOptions — today it maps raw catalog labels inline (issue #199)",
  );
});

test("the harness-default row stays on top of the dialog's options", () => {
  const src = DIALOG();
  assert.ok(
    /\{ value: "", label: "harness default" \}/.test(src),
    "the dialog must keep its harness-default row ahead of the catalog options (issue #199, audit B1)",
  );
});

test("the dialog never renders a raw router path as a label", async () => {
  const models: any = await import("../src/lib/models.js");
  assert.equal(typeof models.buildModelOptions, "function", "the shared builder exists (#169)");

  /* what the dialog's inline mapper would produce today vs the contract:
     buildModelOptions output for the same catalog entry is parsed */
  const catalog = [{ harness: "dsh", provider: "fireworks", model: "accounts/fireworks/routers/x/kimi-k3", label: "accounts/fireworks/routers/x/kimi-k3" }];
  const opts = models.buildModelOptions(catalog, "dsh");
  assert.equal(opts[0].label, "Kimi K3", "the shared builder parses (green today — the guard)");
  assert.ok(!opts[0].label.includes("/"), "never a path");
});
