import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for the installer last mile — https://github.com/roowus/truss/issues/91
   (Follow-up to #1: the taildrop works, but the wizard then tells the user
   to TYPE `sh ~/Downloads/truss-install-dd203a82.sh` on the remote — still a
   long command. "Is there a better way?") These FAIL on purpose today.

   The contract: a new src/installer.ts (or the delivery module the fixer
   owns) exports two pure functions —

     installerDropName(hostId): string
       The file name taildropped to the peer. Typeable: ≤ 12 chars, shell-safe
       (/^[a-z0-9.-]+$/), ends in .sh, embeds a SHORT host fragment (first 4
       of the id) so two hosts' drops never silently swap, and the SAME host
       re-drops to the SAME name (overwrite = refresh, not inbox clutter).

     deliveryOptions(caps: { taildropOk: boolean; sshOk: boolean; serverUrl: string }):
       { kind: "ssh" | "taildrop" | "pairing"; label: string; command: string; typedChars: number }[]
       The wizard's option list, ordered by effort: what the user must type.
       - tailscale-ssh available → a zero-typing option leads;
       - taildrop → its command is exactly `sh ~/Downloads/<dropname>`;
       - the pairing `curl …/i/<code> | sh` is ALWAYS present (the floor);
       - sorted ascending by typedChars (ssh = 0). */

interface DeliveryOption {
  kind: "ssh" | "taildrop" | "pairing";
  label: string;
  command: string;
  typedChars: number;
}
interface InstallerModule {
  installerDropName(hostId: string): string;
  deliveryOptions(caps: { taildropOk: boolean; sshOk: boolean; serverUrl: string }): DeliveryOption[];
}

async function load(): Promise<InstallerModule | null> {
  const spec = "../src/installer.js"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const CAPS = { taildropOk: true, sshOk: false, serverUrl: "http://rewvis.tail208cbf.ts.net:4040" };

test("src/installer.ts exists", async () => {
  const { cleanup } = await freshServer("lastmile-mod");
  try {
    const mod = await load();
    assert.ok(mod, "src/installer.ts must export installerDropName + deliveryOptions — see issue #91");
  } finally {
    cleanup();
  }
});

test("installerDropName: short, shell-safe, host-tagged, idempotent per host", async () => {
  const { cleanup } = await freshServer("lastmile-name");
  try {
    const mod = await load();
    assert.ok(mod, "installer module must exist (see module test)");

    const a = mod.installerDropName("dd203a82");
    assert.ok(a.length <= 12, `"${a}" must be typeable (the whole complaint)`);
    assert.match(a, /^[a-z0-9.-]+\.sh$/, "shell-safe + a .sh name");
    assert.ok(a.includes("dd20"), "carries a short host fragment — two hosts' drops never swap silently");
    assert.equal(mod.installerDropName("dd203a82"), a, "same host → same name (a resend overwrites = refreshes)");
    assert.notEqual(mod.installerDropName("9cc3290f"), a, "different hosts differ");
  } finally {
    cleanup();
  }
});

test("deliveryOptions: the least-typing option leads; the taildrop command is the short one; pairing is the floor", async () => {
  const { cleanup } = await freshServer("lastmile-options");
  try {
    const mod = await load();
    assert.ok(mod, "installer module must exist (see module test)");

    const opts = mod.deliveryOptions(CAPS);
    const typed = opts.map((o) => o.typedChars);
    assert.deepEqual(typed, [...typed].sort((a, b) => a - b), "sorted by what the user must type");

    const drop = opts.find((o) => o.kind === "taildrop")!;
    assert.ok(drop, "taildrop offered when available");
    assert.match(drop.command, /^sh ~\/Downloads\/[a-z0-9.-]+\.sh$/, "the remote side types one short path");
    assert.ok(drop.typedChars <= 24, "short enough to actually type");

    const pair = opts.find((o) => o.kind === "pairing")!;
    assert.ok(pair, "the pairing code is always there");
    assert.match(pair.command, /curl .*\/i\/[a-z0-9]+/i, "the short /i/ url form");
    assert.ok(pair.typedChars > 0, "honest about needing typing");
  } finally {
    cleanup();
  }
});

test("tailscale-ssh available → a zero-typing option leads; nothing available → pairing alone", async () => {
  const { cleanup } = await freshServer("lastmile-ssh");
  try {
    const mod = await load();
    assert.ok(mod, "installer module must exist (see module test)");

    const withSsh = mod.deliveryOptions({ ...CAPS, sshOk: true });
    assert.equal(withSsh[0].kind, "ssh", "zero typing beats everything");
    assert.equal(withSsh[0].typedChars, 0, "the user types nothing — the server runs it via tailscale ssh");
    assert.match(withSsh[0].command, /tailscale ssh/, "the command the SERVER would run is shown for transparency");

    const none = mod.deliveryOptions({ taildropOk: false, sshOk: false, serverUrl: CAPS.serverUrl });
    assert.deepEqual(none.map((o) => o.kind), ["pairing"], "the pairing code is the universal floor");
  } finally {
    cleanup();
  }
});
