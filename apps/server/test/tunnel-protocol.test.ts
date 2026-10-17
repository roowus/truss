import { test } from "node:test";
import assert from "node:assert/strict";
import { TUNNEL_CLOSE_REASON_MAX, TUNNEL_PROTOCOL, assessTunnelProtocol, tunnelCloseReason } from "@truss/proto";

/* The pure classifier behind the tunnel protocol floor (issue #217) — all
   five inputs pinned with no boot, no socket, no registry.

   The absent-vs-junk split is the case a later refactor is most likely to
   flatten by accident, so it is spelled out in its own test: an ABSENT
   `protocol` field is a genuine protocol-1 agent and MUST stay accepted,
   while a PRESENT but non-numeric field is refused. Collapsing the two
   would break every installed pre-handshake agent in the wild. */

test("equal protocol: ok, not refused, not marked outdated", () => {
  const a = assessTunnelProtocol(TUNNEL_PROTOCOL);
  assert.equal(a.verdict, "ok");
  assert.equal(a.refuse, false);
  assert.equal(a.agentProtocol, TUNNEL_PROTOCOL);
});

test("older protocol: accepted (never hard-blocked), verdict older", () => {
  for (const older of [1, TUNNEL_PROTOCOL - 1]) {
    const a = assessTunnelProtocol(older);
    assert.equal(a.verdict, "older", `protocol ${older} is older`);
    assert.equal(a.refuse, false, `protocol ${older} must never be refused — old agents keep working`);
    assert.equal(a.agentProtocol, older);
  }
});

test("newer protocol: refused", () => {
  const a = assessTunnelProtocol(TUNNEL_PROTOCOL + 1);
  assert.equal(a.verdict, "newer");
  assert.equal(a.refuse, true);
  assert.equal(a.agentProtocol, TUNNEL_PROTOCOL + 1);
  assert.match(a.detail, new RegExp(String(TUNNEL_PROTOCOL + 1)), "the detail names the agent's level");
});

test("absent protocol is LEGACY, not junk: accepted as protocol 1", () => {
  for (const absent of [undefined]) {
    const a = assessTunnelProtocol(absent);
    assert.equal(a.verdict, "older", "no field at all is a pre-handshake agent");
    assert.equal(a.refuse, false, "a protocol-1 agent currently connects and must keep connecting");
    assert.equal(a.agentProtocol, 1);
  }
});

test("present but non-numeric protocol is junk: refused", () => {
  for (const junk of ["three", null, NaN, Infinity, {}, [], true]) {
    const a = assessTunnelProtocol(junk);
    assert.equal(a.verdict, "junk", `${JSON.stringify(junk) ?? String(junk)} is unreadable`);
    assert.equal(a.refuse, true, "we cannot know what it speaks, so we must not guess");
  }
});

test("the verdict is computed against the passed server level, not a global", () => {
  /* the shared constant is the default, but an explicit level must win —
     this is what makes "agent 2 vs server 3" testable without a second
     process */
  assert.equal(assessTunnelProtocol(3, 3).verdict, "ok");
  assert.equal(assessTunnelProtocol(3, 2).verdict, "newer");
  assert.equal(assessTunnelProtocol(2, 3).verdict, "older");
});

test("a close reason is truncated to a legal frame, byte-aware", () => {
  /* the refusal's human-readable detail is longer than a close frame allows;
     an over-long reason makes ws throw and the socket never closes, so the
     peer hangs instead of learning why. The real "newer" detail is asserted
     against the limit rather than a magic number. */
  const real = assessTunnelProtocol(TUNNEL_PROTOCOL + 1).detail;
  assert.ok(Buffer.byteLength(tunnelCloseReason(real), "utf8") <= TUNNEL_CLOSE_REASON_MAX, "the real refusal fits");
  assert.ok(Buffer.byteLength(real, "utf8") > TUNNEL_CLOSE_REASON_MAX, "…and it genuinely needed truncating");

  const short = "protocol too new";
  assert.equal(tunnelCloseReason(short), short, "a short reason passes through untouched");

  /* multi-byte input must not split a character into an invalid frame */
  const emoji = "é".repeat(200);
  const cut = tunnelCloseReason(emoji);
  assert.ok(Buffer.byteLength(cut, "utf8") <= TUNNEL_CLOSE_REASON_MAX);
  assert.ok(!cut.includes("\uFFFD"), "no half-character left at the cut");
});
