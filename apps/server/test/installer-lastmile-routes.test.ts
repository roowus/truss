import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { bootServer, type TestServer } from "./server-harness.js";

/* ROUTE-LEVEL tests for the installer last mile (issue #91): the wizard's
   delivery options endpoint, the short taildrop name on the wire, and the
   zero-typing ssh-install path.

   Safety: a FAKE `tailscale` binary shadows the real CLI on PATH (the same
   trick the harness uses for `pi`), so no test ever sends a real file or
   opens a real ssh session — the fake records what it was asked to do. */

let srv: TestServer;
let host: { id: string };
let token: string;
let fakeBin: string;
let fakeLog: string;

const PEER = "fakebox.tail-example.ts.net";

const post = (path: string, body: unknown) =>
  fetch(`${srv.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const fakeCalls = (): { argv: string[] }[] =>
  readFileSync(fakeLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test.before(async () => {
  srv = await bootServer("lastmile-routes");
  const { ensureAgentBundle } = await import("../src/agentbundle.js");
  await ensureAgentBundle(); // the installer script embeds the real bundle

  /* the fake tailscale CLI: answers status with one online peer, runs `true`
     probes happily, captures whatever `ssh <peer> sh -s` receives on stdin,
     and refuses any peer named failbox* (the CLI-failure branch) */
  fakeBin = join(srv.dir, "tsbin");
  mkdirSync(fakeBin, { recursive: true });
  fakeLog = join(srv.dir, "fake-tailscale.log");
  writeFileSync(
    join(fakeBin, "tailscale"),
    `#!/usr/bin/env node
const fs = require("fs");
const log = (rec) => fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(rec) + "\\n");
const args = process.argv.slice(2);
log({ argv: args });
const cmd = args[0];
if (cmd === "status") {
  process.stdout.write(JSON.stringify({
    Self: { HostName: "thisbox", DNSName: "thisbox.tail-example.ts.net.", TailscaleIPs: ["100.64.0.1"], Online: true },
    Peer: { k1: { HostName: "fakebox", DNSName: "${PEER}.", TailscaleIPs: ["100.64.0.2"], Online: true, OS: "linux" } },
  }));
  process.exit(0);
}
if (cmd === "ip") { process.stdout.write("100.64.0.1\\n"); process.exit(0); }
if (cmd === "ssh") {
  const peer = args[1] ?? "";
  if (peer.startsWith("failbox")) { process.stderr.write("tailscale ssh is not enabled on " + peer + "\\n"); process.exit(1); }
  if (args[2] === "sh" && args[3] === "-s") {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => { fs.writeFileSync(${JSON.stringify(fakeLog)} + ".stdin", buf); process.exit(0); });
  } else process.exit(0);
} else if (cmd === "file" && args[1] === "cp") process.exit(0);
else process.exit(0);
`,
  );
  chmodSync(join(fakeBin, "tailscale"), 0o755);
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;

  const created = await post("/api/hosts", { label: "lastmile box" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  host = created.body.host;
  token = created.body.token;
});
test.after(async () => {
  await srv?.close();
});

test("POST /api/hosts/:id/delivery: 400 on a missing body, 403 on a wrong token", async () => {
  const missing = await post(`/api/hosts/${host.id}/delivery`, {});
  assert.equal(missing.status, 400, "token and serverUrl are required");

  const wrong = await post(`/api/hosts/${host.id}/delivery`, { peer: PEER, token: "truss_agent_deadbeef", serverUrl: srv.base });
  assert.equal(wrong.status, 403, "the ssh probe executes on the peer — it stays token-gated");
});

test("delivery options: ssh probe ok → the zero-typing option leads, sorted by typedChars", async () => {
  const r = await post(`/api/hosts/${host.id}/delivery`, { peer: PEER, token, serverUrl: srv.base });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const opts = r.body.options;
  assert.equal(opts[0].kind, "ssh", "zero typing beats everything");
  assert.equal(opts[0].typedChars, 0);
  assert.ok(opts[0].command.includes(`tailscale ssh ${PEER}`), "the command the server runs, shown for consent");

  const typed = opts.map((o: { typedChars: number }) => o.typedChars);
  assert.deepEqual(typed, [...typed].sort((a, b) => a - b), "sorted by what the user must type");

  const drop = opts.find((o: { kind: string }) => o.kind === "taildrop");
  assert.ok(drop, "taildrop offered when the peer is on the tailnet");
  assert.equal(drop.command, `sh ~/Downloads/t-${host.id.slice(0, 4)}.sh`, "the short, host-tagged run command");

  assert.ok(opts.find((o: { kind: string }) => o.kind === "pairing"), "the pairing floor is always present");
});

test("delivery options: peer off the tailnet (or none picked) → pairing alone", async () => {
  const ghost = await post(`/api/hosts/${host.id}/delivery`, { peer: "ghost.tail-example.ts.net", token, serverUrl: srv.base });
  assert.deepEqual(ghost.body.options.map((o: { kind: string }) => o.kind), ["pairing"], "an unknown peer gets no taildrop/ssh offers");

  const none = await post(`/api/hosts/${host.id}/delivery`, { token, serverUrl: srv.base });
  assert.deepEqual(none.body.options.map((o: { kind: string }) => o.kind), ["pairing"], "no peer picked — the floor remains");
});

test("POST /api/hosts/:id/taildrop: the drop lands under the short, typeable name", async () => {
  const r = await post(`/api/hosts/${host.id}/taildrop`, { peer: PEER, token, serverUrl: srv.base });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { installerDropName } = await import("../src/installer.js");
  const name = installerDropName(host.id);
  assert.equal(r.body.file, name, "the wizard's instruction matches the dropped file");
  assert.equal(r.body.command, `sh ~/Downloads/${name}`, "one short path to type");
  assert.equal(r.body.typedChars, r.body.command.length, "honest typing cost");
  assert.ok(name.length <= 12 && /^[a-z0-9.-]+\.sh$/.test(name), "short and shell-safe");

  const cp = fakeCalls().find((c) => c.argv[0] === "file" && c.argv[1] === "cp");
  assert.ok(cp, "the CLI was asked to send");
  assert.ok(cp.argv.some((a) => a.endsWith(`/${name}`)), `the file on the wire is ${name}, not truss-install-<id>.sh`);
});

test("POST /api/hosts/:id/ssh-install: 400 on a missing body, 403 on a wrong token", async () => {
  const missing = await post(`/api/hosts/${host.id}/ssh-install`, {});
  assert.equal(missing.status, 400, "peer, token and serverUrl are required");

  const wrong = await post(`/api/hosts/${host.id}/ssh-install`, { peer: PEER, token: "truss_agent_deadbeef", serverUrl: srv.base });
  assert.equal(wrong.status, 403, "remote execution never happens on a bad token");
});

test("ssh-install: the server runs the standalone installer on the peer (zero typing)", async () => {
  const r = await post(`/api/hosts/${host.id}/ssh-install`, { peer: PEER, token, serverUrl: srv.base });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);

  const ran = readFileSync(`${fakeLog}.stdin`, "utf8");
  assert.ok(ran.startsWith("#!/bin/sh"), "the installer script traveled on stdin");
  assert.ok(ran.includes(`TOKEN="${token}"`), "the standalone variant carries the token — nothing to transcribe");
  assert.ok(ran.includes(`TRUSS_SERVER=ws://127.0.0.1:`), "dials home to the serverUrl the wizard picked");
});

test("ssh-install: a CLI failure surfaces as a 502 with the CLI's own message", async () => {
  const r = await post(`/api/hosts/${host.id}/ssh-install`, { peer: "failbox.tail-example.ts.net", token, serverUrl: srv.base });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.error, /ssh is not enabled/, "the peer's own refusal reaches the wizard");
});

/* ── audit round 1 pins: the probe cache, the hostName-only peer match, and
   the drop-name degenerate fallback ── */

test("tailscaleSshOk caches the probe: a second ask within the TTL never touches the CLI", async () => {
  const { tailscaleSshOk } = await import("../src/net.js");
  const peer = "cachebox.tail-example.ts.net"; // unique — the cache is module-level
  const probesBefore = fakeCalls().filter((c) => c.argv[0] === "ssh" && c.argv[1] === peer).length;

  assert.equal(await tailscaleSshOk(peer), true, "first ask probes (fake CLI accepts)");
  assert.equal(await tailscaleSshOk(peer), true, "second ask is the warm cache");
  const probesAfter = fakeCalls().filter((c) => c.argv[0] === "ssh" && c.argv[1] === peer).length;
  assert.equal(probesAfter - probesBefore, 1, "one real probe, not two — the wizard can re-ask on every render");
});

test("delivery options: a peer named by hostName (not dnsName) still matches the tailnet", async () => {
  const r = await post(`/api/hosts/${host.id}/delivery`, { peer: "fakebox", token, serverUrl: srv.base });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.options.find((o: { kind: string }) => o.kind === "taildrop"), "hostName-only reference still offers taildrop");
});

test("installerDropName: degenerate and hostile ids still yield a safe, stable name", async () => {
  const { installerDropName } = await import("../src/installer.js");
  assert.equal(installerDropName(""), "t-host.sh", "empty id falls back, never an empty fragment");
  assert.equal(installerDropName("AB!!cd12"), "t-abcd.sh", "non-alphanumerics stripped, lowercased");
  assert.equal(installerDropName("ab"), "t-ab.sh", "short ids keep what they have");
});
