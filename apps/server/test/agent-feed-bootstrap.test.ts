import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Behavioral pins for the deliverables guidance in the ACP adapters (issue
   #203, audit I1/I2): the spec contract's read-through greps prove the
   wiring is REFERENCED; this file proves it FIRES — a fake ACP harness logs
   every session/prompt's text, so the tests assert what the model actually
   receives:
     - first prompt of a spawned session carries the [truss bootstrap] block
     - later prompts go out bare
     - a REJECTED first prompt doesn't burn the one-shot: the retry carries
       the block again (the discipline sessions.ts documents for practices)

   The adapters construct their shared AcpClient at import time from
   TRUSS_DSH_BIN / TRUSS_HERMES_BIN — env must be set before the dynamic
   imports (static imports hoist). One fake binary serves both. */

const DIR = mkdtempSync(join(tmpdir(), "truss-feed-boot-"));
const LOG = join(DIR, "acp.log");

const FAKE = `
setTimeout(() => process.exit(0), 30000); // never outlive the test file
const fs = require("node:fs");
const LOG = ${JSON.stringify(LOG)};
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c; let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.id == null || !r.method) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\\n");
    const fail = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32603, message } }) + "\\n");
    const note = (update) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: r.params?.sessionId, update } }) + "\\n");
    if (r.method === "initialize") reply({ protocolVersion: 1 });
    else if (r.method === "session/new") reply({ sessionId: "fake-acp-1", configOptions: [], models: { availableModels: [{ modelId: "m1" }], currentModelId: "m1" } });
    else if (r.method === "session/prompt") {
      const text = (r.params?.prompt ?? []).map((p) => p.text ?? "").join("\\n");
      fs.appendFileSync(LOG, JSON.stringify({ text }) + "\\n");
      if (text.indexOf("FAILME") !== -1) { fail("harness refused the prompt"); return; }
      /* stream a chunk first so the settle doesn't read as the ghost black
         hole (classifyAcpSettle's instant-empty check) */
      note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      setTimeout(() => reply({ stopReason: "end_turn" }), 40);
    }
    else reply({});
  }
});
`;
const FAKE_BIN = join(DIR, "fake-acp.sh");
writeFileSync(join(DIR, "fake.cjs"), FAKE);
writeFileSync(FAKE_BIN, `#!/bin/sh\nexec ${process.execPath} ${join(DIR, "fake.cjs")}\n`, { mode: 0o755 });
chmodSync(FAKE_BIN, 0o755);
process.env.TRUSS_DSH_BIN = FAKE_BIN;
process.env.TRUSS_HERMES_BIN = FAKE_BIN;
process.env.TRUSS_ACP_TIMEOUT_MS = "4000";

const { freshServer } = await import("./helpers.js");
const { deliverablesGuidance } = await import("../src/deliverables.js");

after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* tmp dirs get reaped anyway */
  }
});

function sentPrompts(): string[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).text as string);
}

async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* one collector per handle (the ACP queue is single-consumer — a second
   for-await would steal events from the first); predicates poll the array */
function collect(adapter: any, handle: any): any[] {
  const events: any[] = [];
  void (async () => {
    for await (const ev of adapter.events(handle)) events.push(ev);
  })();
  return events;
}

for (const [name, specifier, exportName] of [
  ["dsh", "../src/adapters/dsh.js", "dshAdapter"],
  ["hermes", "../src/adapters/hermes.js", "hermesAdapter"],
] as const) {
  test(`${name}: first prompt carries the deliverables guidance, later prompts are bare`, { timeout: 20000 }, async () => {
    const { cleanup } = await freshServer(`feed-boot-${name}`);
    const adapter = (await import(specifier))[exportName] as any;
    try {
      const mark = sentPrompts().length;
      const handle = await adapter.spawn({ sessionId: `t-boot-${name}`, cwd: "/tmp" });
      const events = collect(adapter, handle);

      adapter.send(handle, "write me a report");
      await waitFor(() => events.some((e) => e.type === "llm.call.done"), "first turn settled");
      adapter.send(handle, "thanks");
      await waitFor(() => events.filter((e) => e.type === "llm.call.done").length >= 2, "second turn settled");

      const prompts = sentPrompts().slice(mark);
      assert.equal(prompts.length, 2, "two prompts reached the harness");
      assert.ok(prompts[0].startsWith("write me a report"), "user text leads");
      assert.ok(prompts[0].includes("[truss bootstrap — deliverables guidance]"), "first prompt carries the marked block");
      assert.ok(prompts[0].includes(deliverablesGuidance()), "the block is the canonical paragraph");
      assert.ok(!prompts[1].includes("truss bootstrap"), "second prompt goes out bare");
      assert.equal(prompts[1], "thanks");
      adapter.dispose(handle);
    } finally {
      cleanup();
    }
  });
}

test("hermes: a refused first prompt does not burn the one-shot — the retry carries the guidance", { timeout: 20000 }, async () => {
  const { cleanup } = await freshServer("feed-boot-retry");
  const { hermesAdapter: adapter } = await import("../src/adapters/hermes.js");
  try {
    const mark = sentPrompts().length;
    const handle = await adapter.spawn({ sessionId: "t-boot-retry", cwd: "/tmp" });
    const events = collect(adapter, handle);

    /* the fake answers FAILME prompts with a JSON-RPC error: the turn call
       rejects, nothing was delivered */
    adapter.send(handle, "FAILME first");
    await waitFor(
      () => events.some((e) => e.type === "llm.call.done" && (e as { status?: number }).status === 500),
      "refused turn settled as error",
    );
    adapter.send(handle, "second attempt");
    await waitFor(() => events.filter((e) => e.type === "llm.call.done").length >= 2, "second turn settled");
    adapter.send(handle, "third");
    await waitFor(() => events.filter((e) => e.type === "llm.call.done").length >= 3, "third turn settled");

    const prompts = sentPrompts().slice(mark);
    assert.equal(prompts.length, 3);
    assert.ok(prompts[0].includes("[truss bootstrap"), "attempt 1 carried the block (but was refused)");
    assert.ok(prompts[1].startsWith("second attempt") && prompts[1].includes("[truss bootstrap"), "the retry still carries the briefing");
    assert.equal(prompts[2], "third", "only then do prompts go bare");
    adapter.dispose(handle);
  } finally {
    cleanup();
  }
});
