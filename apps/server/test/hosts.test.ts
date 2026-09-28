import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freshServer } from "./helpers.js";

/* hosts.ts — the remote-host registry: per-host agent tokens (plaintext shown
   once, sha256 stored), revoke/rotate, last_seen, and the shared-env-token
   dev fallback. All tests share this file's one sqlite handle (db.js opens at
   import time), so hosts get unique labels per test and nothing asserts
   global row counts. */

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

test("createHost mints a token: plaintext returned once, only the HASH stored", async () => {
  const { db, cleanup } = await freshServer("hosts-mint");
  try {
    const hosts = await import("../src/hosts.js");
    const { host, token } = hosts.createHost("  mint box  ", "first host");

    assert.ok(token.startsWith("truss_agent_"), "token has the agent prefix");
    assert.equal(host.label, "mint box", "label is trimmed");
    assert.equal(host.note, "first host");
    assert.equal(host.revoked, false);
    assert.equal(host.lastSeen, undefined, "never seen yet");
    assert.ok(!JSON.stringify(host).includes(token), "camel host never carries the plaintext");

    const raw = db.store.get<{ token_hash: string; token_prefix: string }>(
      `SELECT token_hash, token_prefix FROM hosts WHERE id = ?`,
      host.id,
    )!;
    assert.notEqual(raw.token_hash, token, "plaintext must not be stored");
    assert.match(raw.token_hash, /^[0-9a-f]{64}$/, "stored value looks like a sha256 hex digest");
    assert.equal(raw.token_hash, sha256(token), "stored hash is sha256(plaintext)");
    assert.equal(raw.token_prefix, `…${token.slice(-6)}`, "prefix hint is the token's tail");
    assert.equal(host.tokenPrefix, raw.token_prefix);

    const blank = hosts.createHost("   ");
    assert.equal(blank.host.label, "new host", "blank label falls back to a default");
  } finally {
    cleanup();
  }
});

test("verifyAgentToken accepts the minted token, rejects wrong ones, touches last_seen", async () => {
  const { cleanup } = await freshServer("hosts-verify");
  try {
    const hosts = await import("../src/hosts.js");
    const { host, token } = hosts.createHost("verify box");
    assert.equal(hosts.getHost(host.id)?.lastSeen, undefined);

    const before = Date.now();
    assert.equal(hosts.verifyAgentToken(host.id, token, ""), true, "correct token accepted");
    const seen = hosts.getHost(host.id)?.lastSeen;
    assert.ok(typeof seen === "number" && seen >= before, "success stamps last_seen");

    assert.equal(hosts.verifyAgentToken(host.id, "truss_agent_deadbeef", ""), false, "wrong token rejected");
    assert.equal(hosts.verifyAgentToken("no-such-host", token, ""), false, "unknown host rejected");
    assert.equal(hosts.getHost(host.id)?.lastSeen, seen, "failed verify must not touch last_seen");
  } finally {
    cleanup();
  }
});

test("rotateHostToken kills the old token, mints a working new one", async () => {
  const { db, cleanup } = await freshServer("hosts-rotate");
  try {
    const hosts = await import("../src/hosts.js");
    const { host, token } = hosts.createHost("rotate box");

    const { token: rotated } = hosts.rotateHostToken(host.id);
    assert.notEqual(rotated, token);
    assert.equal(hosts.verifyAgentToken(host.id, token, ""), false, "old token dies");
    assert.equal(hosts.verifyAgentToken(host.id, rotated, ""), true, "new token works");
    assert.equal(hosts.getHost(host.id)?.revoked, false, "never-revoked host stays clear");

    const raw = db.store.get<{ token_hash: string; token_prefix: string }>(
      `SELECT token_hash, token_prefix FROM hosts WHERE id = ?`,
      host.id,
    )!;
    assert.equal(raw.token_hash, sha256(rotated), "hash updated to the new token");
    assert.equal(raw.token_prefix, `…${rotated.slice(-6)}`, "prefix hint updated too");

    assert.throws(() => hosts.rotateHostToken("no-such-host"), /no such host/);
  } finally {
    cleanup();
  }
});

test("revoked host's token is rejected; un-revoke restores it", async () => {
  const { cleanup } = await freshServer("hosts-revoke");
  try {
    const hosts = await import("../src/hosts.js");
    const { host, token } = hosts.createHost("revoke box");
    assert.equal(hosts.verifyAgentToken(host.id, token, ""), true);

    hosts.setHostRevoked(host.id, true);
    assert.equal(hosts.getHost(host.id)?.revoked, true);
    assert.equal(hosts.verifyAgentToken(host.id, token, ""), false, "revoked token rejected");

    hosts.setHostRevoked(host.id, false);
    assert.equal(hosts.getHost(host.id)?.revoked, false);
    assert.equal(hosts.verifyAgentToken(host.id, token, ""), true, "un-revoke path restores access");
  } finally {
    cleanup();
  }
});

test("deleteHost removes the row and its token stops working", async () => {
  const { cleanup } = await freshServer("hosts-delete");
  try {
    const hosts = await import("../src/hosts.js");
    const { host, token } = hosts.createHost("delete box");
    assert.ok(hosts.listHosts().some((h) => h.id === host.id), "listed after create");

    hosts.deleteHost(host.id);
    assert.equal(hosts.getHost(host.id), undefined, "row gone");
    assert.ok(!hosts.listHosts().some((h) => h.id === host.id), "no longer listed");
    assert.equal(hosts.verifyAgentToken(host.id, token, ""), false, "token dead with the row");
  } finally {
    cleanup();
  }
});

test("shared env token fallback auto-registers under the host's OWN id (no duplicates)", async () => {
  const { cleanup } = await freshServer("hosts-env");
  try {
    const hosts = await import("../src/hosts.js");
    const hostId = "ghost-box-env-fallback";

    assert.equal(hosts.verifyAgentToken(hostId, "shared-secret", "shared-secret"), true, "env token accepted");
    const row = hosts.getHost(hostId);
    assert.ok(row, "row registered under the connecting hostId");
    assert.equal(row?.note, "auto-registered via shared token");
    assert.ok(row?.lastSeen, "touchHost lands on the real row");

    /* reconnect: same row, still exactly one */
    assert.equal(hosts.verifyAgentToken(hostId, "shared-secret", "shared-secret"), true);
    assert.equal(hosts.listHosts().filter((h) => h.id === hostId).length, 1, "no duplicate rows on reconnect");

    /* the env token hash became its per-host token: works without the env var too */
    assert.equal(hosts.verifyAgentToken(hostId, "shared-secret", ""), true, "registered token stands alone");

    assert.equal(hosts.verifyAgentToken("other-box", "wrong", "shared-secret"), false, "bad shared token rejected");
    assert.equal(hosts.verifyAgentToken("other-box", "shared-secret", ""), false, "no fallback when env token unset");
  } finally {
    cleanup();
  }
});

test("a revoked host stays dead even with the shared env token", async () => {
  const { cleanup } = await freshServer("hosts-env-revoked");
  try {
    const hosts = await import("../src/hosts.js");
    const hostId = "revoked-env-host";
    assert.equal(hosts.verifyAgentToken(hostId, "shared-secret", "shared-secret"), true);
    hosts.setHostRevoked(hostId, true);
    assert.equal(hosts.verifyAgentToken(hostId, "shared-secret", "shared-secret"), false, "env token cannot resurrect a revoked host");
    assert.equal(hosts.verifyAgentToken(hostId, "anything", ""), false);
  } finally {
    cleanup();
  }
});

test("rotate on a revoked host keeps it revoked", async () => {
  const { cleanup } = await freshServer("hosts-rotate-revoked");
  try {
    const hosts = await import("../src/hosts.js");
    const { host, token } = hosts.createHost("rotate revoked box");
    hosts.setHostRevoked(host.id, true);
    const { token: rotated } = hosts.rotateHostToken(host.id);
    assert.equal(hosts.getHost(host.id)?.revoked, true, "rotation does not un-revoke");
    assert.equal(hosts.verifyAgentToken(host.id, rotated, ""), false, "new token still rejected while revoked");
    assert.equal(hosts.verifyAgentToken(host.id, token, ""), false, "old token dead too");
    hosts.setHostRevoked(host.id, false);
    assert.equal(hosts.verifyAgentToken(host.id, rotated, ""), true, "explicit un-revoke restores the rotated token");
  } finally {
    cleanup();
  }
});
