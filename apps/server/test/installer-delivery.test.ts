import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for the add-host wizard's missing installer delivery —
   https://github.com/roowus/truss/issues/1 ("Add-host wizard: installer
   command is clipboard-only — no way to send it to the tailnet device").
   These FAIL on purpose today: they pin the contract a fix must satisfy. The wizard already knows WHICH tailnet device the user is
   targeting (step 1's peer picker) and both ends are on the tailnet, yet the
   only way to get the ~160-char one-liner onto the remote is the clipboard.

   The contract, three pieces:

   1. net.ts gains taildropToPeer(peer, files) — push the generated installer
      to the picked tailnet device via Taildrop (`tailscale file cp`). Must
      validate inputs before touching the CLI and must REJECT cleanly (never
      hang, never silently succeed) when the CLI can't be invoked. Tests here
      never perform a real send: the PATH sandbox makes the CLI unfindable on
      any machine, tailscale-equipped or not.

   2. agentbundle.ts gains standaloneInstallScript(hostId, serverUrl, token) —
      same installer but with the token EMBEDDED, so a delivered file runs
      with zero arguments (`sh truss-install-<host>.sh`). The wizard's
      existing $1-arg installScript must keep never embedding the token.

   3. src/pairing.ts (new) — short, typeable, single-use, expiring codes as
      the transport-agnostic fallback: `curl …/i/<code> | sh` instead of a
      160-char command. mintPairing(entry) → { code, expiresAt },
      redeemPairing(code, now?) → entry exactly once. Token lives in memory
      only — hash-at-rest stays the rule (asserted indirectly: the module is
      standalone and never touches the hosts table).

   Safety: no test performs a real taildrop send or flips tailscale state. */

/* ── 1. taildropToPeer: the "Send to <device>" transport ── */

test("net.ts exports taildropToPeer(peer, files) for pushing the installer to a tailnet device", async () => {
  const { cleanup } = await freshServer("deliver-export");
  try {
    const net = await import("../src/net.js");
    assert.equal(
      typeof (net as any).taildropToPeer,
      "function",
      "net.ts must export taildropToPeer(peer: string, files: string[]): Promise<void> — the wizard's \"Send to device\" button needs a server-side transport",
    );
  } finally {
    cleanup();
  }
});

test("taildropToPeer validates inputs before invoking the tailscale CLI", async () => {
  const { cleanup } = await freshServer("deliver-validate");
  try {
    const net = await import("../src/net.js");
    const send = (net as any).taildropToPeer;
    assert.equal(typeof send, "function", "taildropToPeer must exist (see export test)");

    const dir = mkdtempSync(join(tmpdir(), "truss-test-deliver-"));
    const payload = join(dir, "truss-install.sh");
    writeFileSync(payload, "#!/bin/sh\n");
    try {
      await assert.rejects(() => send("", [payload]), /peer|target|device/i, "empty peer must be rejected with a useful message, not a CLI error");
      await assert.rejects(() => send("rinuxfedola.tail208cbf.ts.net", []), /file|path|payload/i, "nothing-to-send must be rejected with a useful message, not a CLI error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("taildropToPeer rejects cleanly when the tailscale CLI cannot be invoked (never hangs, never fakes success)", async () => {
  const { cleanup } = await freshServer("deliver-nocli");
  try {
    const net = await import("../src/net.js");
    const send = (net as any).taildropToPeer;
    assert.equal(typeof send, "function", "taildropToPeer must exist (see export test)");

    /* PATH points at an empty dir: `tailscale` cannot be found on ANY box,
       so this test deterministically exercises the CLI-unavailable path and
       provably never sends a real file. */
    const emptyBin = mkdtempSync(join(tmpdir(), "truss-test-nopath-"));
    const payload = join(emptyBin, "truss-install.sh");
    writeFileSync(payload, "#!/bin/sh\n");
    const realPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      await assert.rejects(
        () => send("rinuxfedola.tail208cbf.ts.net", [payload]),
        /tailscale|ENOENT|not found|spawn/i,
        "rejects with the CLI's own error so the wizard can show it",
      );
    } finally {
      process.env.PATH = realPath;
      rmSync(emptyBin, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

/* ── 2. standaloneInstallScript: a delivered file that runs with no args ── */

test("standaloneInstallScript embeds the token — a taildropped file runs with zero arguments", async () => {
  const { cleanup } = await freshServer("deliver-standalone");
  try {
    const bundle = await import("../src/agentbundle.js");
    const hosts = await import("../src/hosts.js");
    assert.equal(
      typeof (bundle as any).standaloneInstallScript,
      "function",
      "agentbundle.ts must export standaloneInstallScript(hostId, serverUrl, token) — installScript deliberately leaves the token as $1, so today's script is useless as a delivered file",
    );

    await bundle.ensureAgentBundle(); // real esbuild bundle, cached in the fresh data dir
    const { host, token } = hosts.createHost("standalone payload box");
    const serverUrl = "http://rewvis.tail208cbf.ts.net:4040";
    const script = (bundle as any).standaloneInstallScript(host.id, serverUrl, token) as string;

    assert.ok(script.startsWith("#!/bin/sh"), "still a plain sh script");
    assert.ok(script.includes("set -eu"), "fail-fast preserved");
    assert.ok(script.includes(token), "token embedded — nothing left to transcribe");
    assert.ok(script.includes(`agent-${host.id}.env`), "same per-host env file");
    assert.ok(script.includes("chmod 600"), "token file still lands chmod-600");
    assert.ok(script.includes(`TRUSS_SERVER=ws://rewvis.tail208cbf.ts.net:4040`), "dials home over the tailnet");

    /* regression guard: the wizard's $1-arg script must keep the token out —
       delivery must not weaken the copy-command path's secrecy */
    const wizardScript = bundle.installScript(host.id, serverUrl);
    assert.ok(!wizardScript.includes(token), "installScript ($1-arg) still never embeds the token");
  } finally {
    cleanup();
  }
});

/* ── 3. pairing codes: the short, typeable fallback command ── */

async function loadPairing(): Promise<any> {
  const spec = "../src/pairing.js"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

test("src/pairing.ts mints short, unambiguous, expiring codes", async () => {
  const { cleanup } = await freshServer("deliver-pair-mint");
  try {
    const pairing = await loadPairing();
    assert.ok(pairing, "src/pairing.ts must exist — short single-use installer codes, the typeable fallback for the 160-char command (see linked issue)");
    assert.equal(typeof pairing.mintPairing, "function");
    assert.equal(typeof pairing.redeemPairing, "function");

    const a = pairing.mintPairing({ hostId: "h-alice", token: "truss_agent_aaa", serverUrl: "http://rewvis.tail208cbf.ts.net:4040" });
    const b = pairing.mintPairing({ hostId: "h-bob", token: "truss_agent_bbb", serverUrl: "http://rewvis.tail208cbf.ts.net:4040" });
    assert.match(a.code, /^[a-hjkmnp-z2-9]{4,8}$/, "short, lowercase, no ambiguous chars (0/o, 1/i/l) — it must survive manual typing");
    assert.notEqual(a.code, b.code, "codes are unique per mint");
    assert.ok(a.expiresAt > Date.now(), "carries a future expiry");
  } finally {
    cleanup();
  }
});

test("redeemPairing returns the exact entry exactly once (single-use)", async () => {
  const { cleanup } = await freshServer("deliver-pair-redeem");
  try {
    const pairing = await loadPairing();
    assert.ok(pairing, "src/pairing.ts must exist (see mint test)");

    const entry = { hostId: "h-once", token: "truss_agent_once", serverUrl: "http://rewvis.tail208cbf.ts.net:4040" };
    const { code } = pairing.mintPairing(entry);

    const got = pairing.redeemPairing(code);
    assert.deepEqual(got, entry, "redeem hands back exactly what was minted");
    assert.equal(pairing.redeemPairing(code), undefined, "second redeem fails — one code, one install");
  } finally {
    cleanup();
  }
});

test("redeemPairing rejects unknown and expired codes", async () => {
  const { cleanup } = await freshServer("deliver-pair-expiry");
  try {
    const pairing = await loadPairing();
    assert.ok(pairing, "src/pairing.ts must exist (see mint test)");

    assert.equal(pairing.redeemPairing("nosuch"), undefined, "unknown code");

    const { code, expiresAt } = pairing.mintPairing({ hostId: "h-late", token: "truss_agent_late", serverUrl: "http://rewvis.tail208cbf.ts.net:4040" });
    assert.equal(pairing.redeemPairing(code, expiresAt + 1), undefined, "expired code is dead — the token it stands for is a bearer secret");
  } finally {
    cleanup();
  }
});
