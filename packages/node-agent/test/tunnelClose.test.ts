import { test } from "node:test";
import assert from "node:assert/strict";
import { TUNNEL_CLOSE, TUNNEL_PROTOCOL } from "@truss/proto";
import { planTunnelClose } from "../src/tunnelClose.js";

/* The agent side of the protocol floor (issue #217), pinned as a pure
   decision (tunnelClose.ts) instead of an untested branch inside a socket
   listener. The behavior that matters: a 4406 stops the process with a
   nonzero exit and NEVER schedules a retry — a retry loop would re-run the
   identical refusal forever and bury the one line explaining it. */

const base = { protocol: TUNNEL_PROTOCOL, liveSessions: 0, revokedNoted: false };

test("4406 protocol refusal stops with exit 1 and no retry", () => {
  const plan = planTunnelClose({ ...base, code: TUNNEL_CLOSE.PROTOCOL_TOO_NEW, reason: "protocol too new" });
  assert.equal(plan.action, "stop", "never a retry — the server would refuse identically");
  assert.equal(plan.exitCode, 1, "exits nonzero so a supervisor/installer sees the failure");
  assert.ok(plan.message, "and says why");
});

test("the 4406 message surfaces the server's reason and this agent's level", () => {
  const plan = planTunnelClose({
    ...base,
    code: TUNNEL_CLOSE.PROTOCOL_TOO_NEW,
    reason: "agent speaks protocol 3, newer than this server's 2",
  });
  assert.match(plan.message!, /protocol 3/, "echoes the server's explanation");
  assert.match(plan.message!, new RegExp(`protocol ${TUNNEL_PROTOCOL}`), "names this agent's own level");
  assert.match(plan.message!, /Not retrying/, "is explicit that it will not loop");
});

test("a reasonless 4406 still explains itself (the frame reason is best-effort)", () => {
  const plan = planTunnelClose({ ...base, code: TUNNEL_CLOSE.PROTOCOL_TOO_NEW, reason: "" });
  assert.equal(plan.action, "stop");
  assert.equal(plan.exitCode, 1);
  assert.match(plan.message!, /protocol too new/, "falls back to a plain description");
});

test("4404 host deleted stops without a retry (unchanged from issue #85)", () => {
  const plan = planTunnelClose({ ...base, code: TUNNEL_CLOSE.HOST_DELETED, reason: "host deleted" });
  assert.equal(plan.action, "stop");
  assert.equal(plan.exitCode, undefined, "4404 stops quietly, it does not exit — the pre-#217 behavior");
});

test("4403 keeps the slow watch, explaining once", () => {
  const first = planTunnelClose({ ...base, code: TUNNEL_CLOSE.UNAUTHORIZED, reason: "unauthorized" });
  assert.equal(first.action, "slow-retry");
  assert.match(first.message!, /rotate|revoked/, "tells the user how to fix it");

  const again = planTunnelClose({ ...base, revokedNoted: true, code: TUNNEL_CLOSE.UNAUTHORIZED, reason: "unauthorized" });
  assert.equal(again.action, "slow-retry");
  assert.match(again.message!, /still refused/, "does not repeat the whole explanation every 60s");
});

test("anything else is a blip: backoff-retry, sessions survive", () => {
  const plan = planTunnelClose({ ...base, liveSessions: 3, code: 1006, reason: "abnormal" });
  assert.equal(plan.action, "backoff-retry", "a network blip must never stop the agent");
  assert.equal(plan.exitCode, undefined);
  assert.match(plan.message!, /3 session/, "reassures that the running turns survived");

  const quiet = planTunnelClose({ ...base, liveSessions: 0, code: 1006, reason: "abnormal" });
  assert.equal(quiet.message, null, "with nothing alive there is nothing worth saying");
});
