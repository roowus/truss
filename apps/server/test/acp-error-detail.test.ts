import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for the session-create diagnosability fix —
   https://github.com/roowus/truss/issues/235
   ("dsh session creation fails with a generic 500 when any session-store
   entry is root-owned").

   The failure the issue reports: an unreadable session-store entry makes
   dsh's persistence flush throw, dsh-acp wraps it as
   `Error("ACP session persistence flush failed", { cause })`, and the ACP
   SDK serializes ONLY the message — the actionable `EACCES` text and the
   offending path survive nowhere. Truss then rejected with
   `new Error(rec.error.message ?? "acp error")`, so `createSession` sank
   `detail: "Internal error"` on the row and the route returned
   `500 {"error":"Internal error"}`. The user chasing that sees a dead end.

   The contract this pins:

   1. `describeAcpError(rec.error)` folds the JSON-RPC `code`, the
      `message`, and whatever recoverable detail `data` carries into ONE
      plain string, so the rejection carries the real cause:
        - a `data.details` string is preferred verbatim;
        - otherwise `data` is dumped as compact JSON;
        - a `data` that cannot serialize must NOT throw — the chain
          terminates in the plain message (the error path must not be
          able to fail);
        - the dump is length-capped so a pathological `data` cannot bloat
          the 500 body or the session row's `detail`.

   2. The ACP frame's error may carry `code` and `data` (widening the old
      `{ message?: string }`), and the widening is additive: a frame with
      only `message` still describes exactly as before.

   These FAIL on purpose today: `describeAcpError` does not exist and the
   dispatch site rejects with the bare message. */

interface AcpErrorModule {
  describeAcpError: (err: { code?: number; message?: string; data?: unknown } | undefined) => string;
}

let mod: AcpErrorModule;
let srv: TestServer;
let db: Awaited<ReturnType<typeof freshServer>>["db"];
let cleanup: () => void;

before(async () => {
  const fresh = await freshServer("acp-error-detail");
  cleanup = fresh.cleanup;
  db = fresh.db;
  /* one boot per test FILE — the harness contract (server-harness.ts) */
  srv = await bootServer("acp-error-detail");
  mod = (await import("../src/adapters/acp.js")) as unknown as AcpErrorModule;
});

after(async () => {
  await srv?.close();
  cleanup?.();
});

test("describeAcpError prefers a data.details string verbatim", () => {
  const out = mod.describeAcpError({
    code: -32603,
    message: "Internal error",
    data: { details: "ACP session persistence flush failed" },
  });
  assert.match(out, /Internal error/);
  assert.match(out, /ACP session persistence flush failed/);
});

test("describeAcpError falls back to a compact JSON dump when data has no details", () => {
  const out = mod.describeAcpError({
    code: -32603,
    message: "Internal error",
    data: { cause: "EACCES: permission denied, open '/opt/dsh/sessions/x/session.jsonl'" },
  });
  assert.match(out, /Internal error/);
  assert.match(out, /EACCES/);
  assert.match(out, /session\.jsonl/);
});

test("describeAcpError keeps the message when data is absent", () => {
  assert.equal(mod.describeAcpError({ code: -32603, message: "Internal error" }), "Internal error");
});

test("describeAcpError survives data that cannot serialize", () => {
  const cycle: Record<string, unknown> = { name: "boom" };
  cycle.self = cycle;
  const out = mod.describeAcpError({ message: "Internal error", data: cycle });
  assert.match(out, /Internal error/);
  assert.ok(out.length > 0);
});

test("describeAcpError caps a pathological data payload", () => {
  const out = mod.describeAcpError({
    message: "Internal error",
    data: { details: "x".repeat(50_000) },
  });
  assert.ok(out.length < 5_000, `expected a capped string, got ${out.length} chars`);
});

test("describeAcpError names an absent error", () => {
  assert.equal(mod.describeAcpError(undefined), "acp error");
});

/* the wired path: the 500 body carries the real cause, not the wrapper */
test("POST /api/sessions surfaces the spawn failure's detail in the 500 body", async () => {
  /* an unknown harness must still return its real reason — the route's
     catch already stringifies whatever createSession threw, so this pins
     the end the ACP detail has to travel along. */
  const res = await fetch(`${srv.base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "definitely-not-a-harness", cwd: "/tmp" }),
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "the 500 body must carry an error string");
  assert.match(body.error!, /unknown harness/);
});

/* defect 2 (issue #235): the 409 must carry WHY the session died, and must
   never point at the cwd — the directory is irrelevant to a spawn failure */
test("the 409 on a dead session carries the stored failure detail, never the cwd", async () => {
  const CWD = "/tmp/pr-235-workspace";
  /* a row left in `error` with no harness reference — exactly the state a
     failed creation leaves behind. `sendPrompt` refuses it and the route
     turns that refusal into a 409. */
  db.store.createSession({ id: "dead235", harness: "dsh", title: "dead one", cwd: CWD });
  db.store.setSessionState("dead235", "error");
  /* the same row `sink` writes for a failed spawn — this is the detail a
     real creation failure leaves in the event log */
  db.store.appendEvent({
    type: "session.state",
    sessionId: "dead235",
    state: "error",
    detail: "Internal error: ACP session persistence flush failed",
    at: Date.now(),
  } as never);

  const res = await fetch(`${srv.base}/api/sessions/dead235/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error?: string; state?: string; detail?: string };

  /* the reason travels, so no client has to invent one */
  assert.match(body.detail ?? "", /persistence flush failed/);
  assert.match(body.error ?? "", /persistence flush failed/);
  assert.equal(body.state, "error");

  /* and the cwd appears NOWHERE in the refusal — this is the whole defect */
  const wholeBody = JSON.stringify(body);
  assert.ok(!wholeBody.includes(CWD), `the 409 must not name the cwd: ${wholeBody}`);
  assert.ok(!/start a new session in/i.test(wholeBody), "no directory-shaped advice in the 409");
  /* the user-facing string: no class-name prefix, no em dash (TRUSS.md) */
  assert.ok(!(body.error ?? "").includes("NotResumableError"), "no error class name in user copy");
  assert.ok(!(body.error ?? "").includes("—"), "no em dash in user-facing copy");
});

/* an older/quieter row with no stored detail still refuses without guessing */
test("a 409 with no stored detail is still path-free and explicit", async () => {
  const CWD = "/tmp/pr-235-bare-workspace";
  db.store.createSession({ id: "bare235", harness: "dsh", title: "bare one", cwd: CWD });
  db.store.setSessionState("bare235", "closed");

  const res = await fetch(`${srv.base}/api/sessions/bare235/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error?: string; state?: string; detail?: string };
  assert.equal(body.detail, undefined);
  assert.match(body.error ?? "", /closed/);
  assert.ok(!JSON.stringify(body).includes(CWD), "the cwd must never be named");
  assert.ok(!(body.error ?? "").includes("NotResumableError"), "no error class name in user copy");
  assert.ok(!(body.error ?? "").includes("—"), "no em dash in user-facing copy");
});
