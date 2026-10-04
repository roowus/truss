import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* SPEC-TESTS for issue #101 — on a fresh server the hermes (and dsh) model
   picker shows only "harness default" until the first session boots, because
   both adapters discover their catalog lazily from session/new responses and
   keep it in module memory only.

   The contract these tests pin:

   - a fresh server answers listModels with an empty hermes/dsh catalog, then
     probes in the BACKGROUND (one throwaway session/new, no MCP servers,
     closed again) and fills the catalog — the picker request itself must not
     hang waiting for a harness boot.
   - a filled catalog is announced with a `models.updated` broadcast so open
     dialogs refetch /api/harnesses and the models appear live.
   - the discovered catalog is persisted (kv), so a server RESTART no longer
     empties the picker: a re-imported adapter hydrates from the store and
     never probes.
   - concurrent empty-catalog fetches share ONE probe per adapter.
   - a full catalog never probes.

   Mechanics: TRUSS_HERMES_BIN / TRUSS_DSH_BIN point at fake ACP servers (the
   model-resume/dsh-resume pattern) that log every request as a JSON line so
   the tests can count session/new probes and session/close cleanups.
   TRUSS_DATA_DIR isolates the kv store. */

const DATA_DIR = mkdtempSync(join(tmpdir(), "truss-test-modelcat-data-"));
process.env.TRUSS_DATA_DIR = DATA_DIR;

const LOG_DIR = mkdtempSync(join(tmpdir(), "truss-test-modelcat-fake-"));
const HERMES_LOG = join(LOG_DIR, "hermes.log");
const DSH_LOG = join(LOG_DIR, "dsh.log");

/* one fake ACP server per adapter: NDJSON over stdio, answers initialize,
   session/new and session/resume with a fixed catalog, logs every request */
function writeFake(name: string, log: string, catalogPayload: string): string {
  const src = `
const fs = require("node:fs");
const log = (m) => fs.appendFileSync(${JSON.stringify(log)}, m + "\\n");
const CATALOG = ${catalogPayload};
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c; let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.id == null || !r.method) continue;
    log(JSON.stringify({ method: r.method, params: r.params }));
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\\n");
    if (r.method === "initialize") reply({ protocolVersion: 1 });
    else if (r.method === "session/new") reply({ sessionId: "probe-${name}-1", ...CATALOG });
    else if (r.method === "session/resume") reply({ sessionId: r.params.sessionId, ...CATALOG });
    else if (r.method === "session/close") { reply({}); if (r.params.sessionId === "bye") setTimeout(() => process.exit(0), 100); }
    else reply({});
  }
});
`;
  const bin = join(LOG_DIR, `fake-${name}.cjs`);
  writeFileSync(bin, src);
  const wrapper = join(LOG_DIR, `fake-${name}-bin.sh`);
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${bin} "$@"\n`, { mode: 0o755 });
  return wrapper;
}

const HERMES_CATALOG = JSON.stringify({
  models: {
    availableModels: [
      { modelId: "custom:glm-4.7", name: "Custom endpoint · glm-4.7" },
      { modelId: "custom:kimi-k3", name: "Custom endpoint · kimi-k3" },
    ],
    currentModelId: "custom:glm-4.7",
  },
});
const DSH_CATALOG = JSON.stringify({
  configOptions: [
    {
      id: "model",
      currentValue: '["deepseek","deepseek-chat"]',
      options: [
        { name: "DeepSeek Chat", value: '["deepseek","deepseek-chat"]' },
        { name: "DeepSeek Reasoner", value: '["deepseek","deepseek-reasoner"]' },
      ],
    },
  ],
});

process.env.TRUSS_HERMES_BIN = writeFake("hermes", HERMES_LOG, HERMES_CATALOG);
process.env.TRUSS_DSH_BIN = writeFake("dsh", DSH_LOG, DSH_CATALOG);

const db = await import("../src/db.js");
const hermes: any = await import("../src/adapters/hermes.js");
const dsh: any = await import("../src/adapters/dsh.js");
const sessions = await import("../src/sessions.js");

interface ReqRec {
  method: string;
  params?: { sessionId?: string; mcpServers?: unknown[] };
}
const reqs = (log: string): ReqRec[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const probeNews = (log: string) => reqs(log).filter((r) => r.method === "session/new");

async function waitFor(cond: () => Promise<boolean> | boolean, what: string, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const frames: { seq: number; ev: { type: string; harness?: string } }[] = [];
sessions.setBroadcaster((f) => frames.push(f));

test("fresh server: the picker fetch is empty but a background probe fills both catalogs, announced via models.updated", async () => {
  assert.deepEqual(await hermes.hermesAdapter.listModels(), [], "no hermes catalog before any session boot");
  assert.deepEqual(await dsh.dshAdapter.listModels(), [], "no dsh catalog before any session boot");

  /* the probe is OPT-IN (the dialog's ?probe=1): a plain fetch must never
     spawn harness processes — every api test boots a server with empty
     catalogs, and an ungated probe wedged the suite on a real dsh boot */
  await sessions.listModels();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(probeNews(HERMES_LOG).length, 0, "no probe without probe: true");
  assert.equal(probeNews(DSH_LOG).length, 0, "no probe without probe: true");

  /* concurrent picker fetches share one probe per adapter */
  const [first, second] = await Promise.all([sessions.listModels({ probe: true }), sessions.listModels({ probe: true })]);
  for (const models of [first, second]) {
    assert.ok(!models.some((m) => m.harness === "hermes"), "the fetch itself must not hang on a harness boot");
    assert.ok(!models.some((m) => m.harness === "dsh"), "the fetch itself must not hang on a harness boot");
  }

  await waitFor(async () => (await hermes.hermesAdapter.listModels()).length > 0, "hermes probe to fill the catalog");
  await waitFor(async () => (await dsh.dshAdapter.listModels()).length > 0, "dsh probe to fill the catalog");

  const hermesModels = await hermes.hermesAdapter.listModels();
  assert.ok(hermesModels.some((m: { model: string }) => m.model === "custom:kimi-k3"), `hermes catalog: ${JSON.stringify(hermesModels)}`);
  const dshModels = await dsh.dshAdapter.listModels();
  assert.ok(dshModels.some((m: { model: string }) => m.model === "deepseek-reasoner"), `dsh catalog: ${JSON.stringify(dshModels)}`);

  assert.equal(probeNews(HERMES_LOG).length, 1, "two concurrent fetches, ONE hermes probe");
  assert.equal(probeNews(DSH_LOG).length, 1, "two concurrent fetches, ONE dsh probe");

  /* the probe attaches no tooling and closes its throwaway session again */
  assert.deepEqual(probeNews(HERMES_LOG)[0].params?.mcpServers, [], "probe attaches no MCP servers");
  assert.ok(
    reqs(HERMES_LOG).some((r) => r.method === "session/close" && r.params?.sessionId === "probe-hermes-1"),
    "the hermes probe session is closed again — no harness litter",
  );
  assert.ok(
    reqs(DSH_LOG).some((r) => r.method === "session/close" && r.params?.sessionId === "probe-dsh-1"),
    "the dsh probe session is closed again — no harness litter",
  );

  const announced = frames.filter((f) => f.ev.type === "models.updated").map((f) => f.ev.harness);
  assert.ok(announced.includes("hermes"), `models.updated for hermes — got: ${JSON.stringify(frames.map((f) => f.ev.type))}`);
  assert.ok(announced.includes("dsh"), `models.updated for dsh — got: ${JSON.stringify(frames.map((f) => f.ev.type))}`);
});

test("the discovered catalog persists in kv", () => {
  const h = JSON.parse(db.store.getKv("models:hermes") ?? "[]");
  assert.ok(h.some((m: { model: string }) => m.model === "custom:glm-4.7"), `models:hermes = ${JSON.stringify(h)}`);
  const d = JSON.parse(db.store.getKv("models:dsh") ?? "[]");
  assert.ok(d.some((m: { model: string }) => m.model === "deepseek-chat"), `models:dsh = ${JSON.stringify(d)}`);
});

test("a restarted server hydrates the picker from kv — no probe, no empty window", async () => {
  const hermesBefore = probeNews(HERMES_LOG).length;
  /* query-suffixed import forces re-evaluation: the restart. The db module
     stays cached, so the fresh adapter instance reads the kv the previous
     "boot" wrote. The specifier is computed so tsc doesn't try to resolve
     the query suffix (runtime-only trick, tsx handles it). */
  const restarted: any = await import("../src/adapters/hermes.js" + "?restarted=1");
  const models = await restarted.hermesAdapter.listModels();
  assert.ok(
    models.some((m: { model: string }) => m.model === "custom:kimi-k3"),
    `hydrated from kv immediately: ${JSON.stringify(models)}`,
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(probeNews(HERMES_LOG).length, hermesBefore, "a hydrated catalog never probes");
});

test("a full catalog never probes again, even when asked", async () => {
  const hermesBefore = probeNews(HERMES_LOG).length;
  const dshBefore = probeNews(DSH_LOG).length;
  const models = await sessions.listModels({ probe: true });
  assert.ok(models.some((m) => m.harness === "hermes" && m.model === "custom:glm-4.7"));
  assert.ok(models.some((m) => m.harness === "dsh" && m.model === "deepseek-chat"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(probeNews(HERMES_LOG).length, hermesBefore);
  assert.equal(probeNews(DSH_LOG).length, dshBefore);
});

test("cleanup: close the sentinel sessions so the fake servers exit", async () => {
  const h = await hermes.hermesAdapter.spawn({ sessionId: "t-bye", cwd: "/tmp", resumeRef: "bye" });
  hermes.hermesAdapter.dispose(h);
  const d = await dsh.dshAdapter.spawn({ sessionId: "d-bye", cwd: "/tmp", resumeRef: "bye" });
  dsh.dshAdapter.dispose(d);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(true);
});

test("catalog cache: junk in kv reads as empty, never throws", async () => {
  const cache = await import("../src/adapters/model-catalog-cache.js");
  db.store.setKv("models:junk", "{not json");
  assert.deepEqual(cache.readCatalogCache("models:junk"), []);
  db.store.setKv("models:junk", JSON.stringify([{ model: 42 }, { provider: "p", model: "m", label: "l" }]));
  assert.deepEqual(cache.readCatalogCache("models:junk"), [{ provider: "p", model: "m", label: "l" }]);
  assert.deepEqual(cache.readCatalogCache("models:never-written"), []);
});

after(() => {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(LOG_DIR, { recursive: true, force: true });
  } catch {}
});
