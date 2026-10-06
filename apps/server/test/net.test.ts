import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { freshServer } from "./helpers.js";

/* net.ts — reachability probe for the add-host wizard. netInfo() only runs
   READ-ONLY probes (`tailscale ip -4`, `status --json`, `serve status`) and
   swallows every failure, so it is safe to call for real. tailscaleServe()
   FLIPS `tailscale serve` state — a test must never do that to the dev box,
   so we only assert it rejects cleanly when the CLI is unavailable. */

test("netInfo echoes the port, lists private LAN IPv4s, never rejects", async () => {
  const { cleanup } = await freshServer("net-info");
  try {
    const net = await import("../src/net.js");
    const info = await net.netInfo(4321); // resolves even with no tailscale CLI

    assert.equal(info.port, 4321, "port is echoed back");

    assert.ok(Array.isArray(info.lan), "lan is an array");
    for (const ip of info.lan) {
      assert.equal(typeof ip, "string");
      assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/, "dotted-quad IPv4");
      assert.ok(!ip.startsWith("127."), "loopback excluded");
      assert.match(ip, /^(10\.|192\.168\.|172\.|100\.)/, "private/CGNAT ranges only");
    }

    assert.equal(typeof info.tailscale.installed, "boolean");
    if (info.tailscale.installed) {
      // this box has the CLI — probe fields are optional but must have the right shape
      assert.ok(info.tailscale.ip4 === undefined || typeof info.tailscale.ip4 === "string");
      assert.ok(info.tailscale.dnsName === undefined || typeof info.tailscale.dnsName === "string");
      assert.ok(info.tailscale.serveOn === undefined || typeof info.tailscale.serveOn === "boolean");
      assert.ok(info.tailscale.serveUrl === undefined || /^https:\/\//.test(info.tailscale.serveUrl));
    } else {
      assert.equal(info.tailscale.ip4, undefined, "no CLI -> no tailscale fields");
      assert.equal(info.tailscale.serveOn, undefined);
    }
  } finally {
    cleanup();
  }
});

test("tailscaleServe rejects cleanly when tailscale is unavailable (never flips real state)", async () => {
  const { cleanup } = await freshServer("net-serve");
  try {
    const net = await import("../src/net.js");
    const probe = await net.netInfo(4099);
    if (probe.tailscale.installed) {
      /* The CLI works on this machine, so calling tailscaleServe would mutate
         the REAL tailnet serve config — out of bounds for a test. The only
         safe assertion here is that netInfo's read-only probe agreed the CLI
         exists (covered above). Skip the mutation path deliberately. */
      return;
    }
    // no usable tailscale: both directions must reject (Error), not throw sync
    await assert.rejects(() => net.tailscaleServe(true, 4099));
    await assert.rejects(() => net.tailscaleServe(false, 4099));
  } finally {
    cleanup();
  }
});

/* issue #171: the serve toggle plans around a busy 443, and the probe behind
   the plan is webServerPresent — a live listener must read busy, a closed
   port must read free, and the promise must never reject. The plan probes
   EVERY local address (the incident's Caddy owned 443 on the tailnet ip,
   invisible to a loopback-only check), so the multi-host form gets its own
   assertion: a listener on ANY one address reads busy. */

test("webServerPresent: a live listener reads busy, a closed port reads free", async () => {
  const { cleanup } = await freshServer("net-probe");
  try {
    const net = await import("../src/net.js");
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;

    assert.equal(await net.webServerPresent(port, ["127.0.0.1"]), true, "something answers → busy (the plan must move off it)");
    /* the incident shape: the listener sits on ONE address of several — the
       probe must still find it (127.0.0.2 answers nothing on this port) */
    assert.equal(await net.webServerPresent(port, ["127.0.0.2", "127.0.0.1"]), true, "busy on any probed address → busy");

    await new Promise<void>((r) => srv.close(() => r()));
    assert.equal(await net.webServerPresent(port, ["127.0.0.1"]), false, "refused → free (the plan may claim it)");
    assert.equal(await net.webServerPresent(port, ["127.0.0.2", "127.0.0.1"]), false, "refused everywhere → free");
  } finally {
    cleanup();
  }
});

/* audit round 2, B1/B4: the timeout direction is the conservative core of
   the plan — a dropped SYN means "unsure", and an unsure port is never
   claimed. A black-holed port can't be faked without a firewall, so the
   fold is pinned directly. */

test("probeBusy: connect or timeout anywhere → busy; only all-refused/errored is free", async () => {
  const { cleanup } = await freshServer("net-probe-fold");
  try {
    const net = await import("../src/net.js");
    assert.equal(net.probeBusy(["connect"]), true, "an answer is busy");
    assert.equal(net.probeBusy(["refused", "connect"]), true);
    assert.equal(net.probeBusy(["timeout"]), true, "a black hole is UNSURE — never claimed (a false busy costs a warning; a false free costs the outage)");
    assert.equal(net.probeBusy(["refused", "timeout", "error"]), true, "one unsure address among clear ones still reads busy");
    assert.equal(net.probeBusy(["refused", "refused"]), false, "refused everywhere is free");
    assert.equal(net.probeBusy(["error", "refused"]), false, "unreachable/refused is free");
    assert.equal(net.probeBusy([]), false, "nothing probed is free");
  } finally {
    cleanup();
  }
});

test("netInfo surfaces tailscale.servePlan while serve is off and clickable (the pre-click warning)", async () => {
  const { cleanup } = await freshServer("net-plan");
  try {
    const net = await import("../src/net.js");
    const info = await net.netInfo(4040);
    if (!info.tailscale.installed || info.tailscale.serveOn || info.tailscale.canServe === false) return; // nothing to plan on this box
    const plan = info.tailscale.servePlan;
    assert.ok(plan, "serve off + clickable → the plan rides along so the UI warns BEFORE the click");
    assert.ok(Number.isInteger(plan.httpsPort) && plan.httpsPort > 0 && plan.httpsPort <= 65535);
    if (plan.httpsPort === 443) {
      assert.equal(plan.warning, null, "443 free → the standard plan, no noise");
    } else {
      assert.match(plan.warning ?? "", /443/, "the alternate-port plan names the conflict");
    }
  } finally {
    cleanup();
  }
});

test("planServe: both candidate ports busy → the plan refuses, naming both", async () => {
  const { cleanup } = await freshServer("net-plan-both");
  try {
    const net = await import("../src/net.js");
    const plan = net.planServe({ port: 4040, port443Busy: true, altPortBusy: true });
    assert.match(plan.warning ?? "", /443/, "names the standard port");
    assert.match(plan.warning ?? "", /8443/, "names the alternate too");
    assert.match(plan.warning ?? "", /refuse/i, "says the toggle refuses rather than shadowing 8443's owner");
  } finally {
    cleanup();
  }
});

/* audit B1 (PR #178): OFF tears down only a config it can ATTRIBUTE to this
   truss — the status is matched by proxy target, never by name, and an
   unattributable status yields null so the toggle tears nothing down */

test("parseServingHttpsPort: only a config proxying to OUR port is attributed", async () => {
  const { cleanup } = await freshServer("net-serve-attr");
  try {
    const net = await import("../src/net.js");
    const status = JSON.stringify({
      Web: {
        "rewvis.tail208cbf.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
        "rewvis.tail208cbf.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4040" } } },
      },
    });
    assert.equal(net.parseServingHttpsPort(status, 4040), 8443, "ours is the config proxying to our port");
    assert.equal(net.parseServingHttpsPort(status, 5555), null, "a neighbor's config is NOT ours — OFF must target nothing");

    const portlessKey = JSON.stringify({ Web: { "rewvis.tail208cbf.ts.net": { Handlers: { "/": { Proxy: "http://127.0.0.1:4040" } } } } });
    assert.equal(net.parseServingHttpsPort(portlessKey, 4040), 443, "a key without a port suffix is 443");

    for (const junk of ["", "not json", "{}", "[]", "null"]) {
      assert.equal(net.parseServingHttpsPort(junk, 4040), null, `${JSON.stringify(junk)} → null, never a crash`);
    }
  } finally {
    cleanup();
  }
});

/* parseTailscaleStatus is pure — the wizard's device picker lives or dies by
   it, so feed it a canned `tailscale status --json` and check every field */

const STATUS_FIXTURE = {
  MagicDNSSuffix: "tail208cbf.ts.net",
  Self: {
    HostName: "rewvis",
    DNSName: "rewvis.tail208cbf.ts.net.",
    TailscaleIPs: ["100.107.125.118", "fd7a:115c:a1e0::1"],
    OS: "linux",
    Online: true,
    LastSeen: "2026-09-28T22:00:00Z",
  },
  Peer: {
    "node-key-1": {
      HostName: "Rewis's MacBook Pro",
      DNSName: "rewiss-macbook-pro.tail208cbf.ts.net.",
      TailscaleIPs: ["100.78.180.43", "fd7a:115c:a1e0::d228:b42c"],
      OS: "macOS",
      Online: true,
      LastSeen: "2026-09-28T22:50:00.1Z",
      ExitNode: false,
      ExitNodeOption: false,
    },
    "node-key-2": {
      HostName: "Pixel 4 XL",
      DNSName: "pixel-4-xl.tail208cbf.ts.net.",
      TailscaleIPs: ["100.121.74.109"],
      OS: "android",
      Online: false,
      LastSeen: "2026-09-08T07:13:53.1Z",
      ExitNode: false,
      ExitNodeOption: false,
    },
    "node-key-3": {
      HostName: "exit-rig",
      DNSName: "exit-rig.tail208cbf.ts.net.",
      TailscaleIPs: ["100.100.100.100", "fd7a::1"],
      OS: "linux",
      Online: true,
      LastSeen: "2026-09-28T23:00:00Z",
      ExitNode: true,
      ExitNodeOption: true,
      Tags: ["tag:server"],
    },
  },
};

test("parseTailscaleStatus: self + peers with clean fields", async () => {
  const { cleanup } = await freshServer("net-parse");
  try {
    const net = await import("../src/net.js");
    const { self, peers } = net.parseTailscaleStatus(STATUS_FIXTURE);

    assert.equal(self?.hostName, "rewvis");
    assert.equal(self?.dnsName, "rewvis.tail208cbf.ts.net", "trailing dot stripped");
    assert.equal(self?.ip4, "100.107.125.118", "ipv4 picked out of the ip list");
    assert.equal(self?.online, true);

    assert.equal(peers.length, 3);
    const mac = peers.find((p) => p.os === "macOS")!;
    assert.equal(mac.hostName, "Rewis's MacBook Pro");
    assert.equal(mac.ip4, "100.78.180.43");
    assert.equal(mac.exitNode, false);
    assert.equal(mac.tagged, false);

    const rig = peers.find((p) => p.hostName === "exit-rig")!;
    assert.equal(rig.exitNode, true);
    assert.equal(rig.exitNodeOption, true);
    assert.equal(rig.tagged, true, "tagged devices flagged (no user owner)");

    const pixel = peers.find((p) => p.hostName === "Pixel 4 XL")!;
    assert.equal(pixel.online, false);
    assert.equal(pixel.lastSeen, "2026-09-08T07:13:53.1Z");
  } finally {
    cleanup();
  }
});

test("parseTailscaleStatus: online peers sort first, then alphabetical", async () => {
  const { cleanup } = await freshServer("net-sort");
  try {
    const net = await import("../src/net.js");
    const { peers } = net.parseTailscaleStatus(STATUS_FIXTURE);
    const onlineIdx = peers.map((p) => p.online);
    // online entries come before offline ones
    assert.deepEqual(onlineIdx, [...onlineIdx].sort((a, b) => Number(b) - Number(a)));
    const names = peers.map((p) => p.hostName);
    assert.deepEqual(names.slice(0, 2), ["exit-rig", "Rewis's MacBook Pro"].sort((a, b) => a.localeCompare(b)), "alphabetical within online");
    assert.equal(names[2], "Pixel 4 XL", "offline last");
  } finally {
    cleanup();
  }
});

test("parseTailscaleStatus: garbage in, empty out (never throws)", async () => {
  const { cleanup } = await freshServer("net-garbage");
  try {
    const net = await import("../src/net.js");
    for (const junk of [undefined, null, "nope", {}] as const) {
      const r = net.parseTailscaleStatus(junk);
      assert.equal(r.self, undefined);
      assert.deepEqual(r.peers, []);
    }
    // peer with neither name nor dns is dropped; partial peers keep shape
    const r = net.parseTailscaleStatus({ Peer: { a: { Online: true }, b: { HostName: "half" } } });
    assert.equal(r.peers.length, 1);
    assert.equal(r.peers[0].hostName, "half");
    assert.equal(r.peers[0].ip4, undefined);
    assert.equal(r.peers[0].online, false, "missing Online means offline, not truthy garbage");
  } finally {
    cleanup();
  }
});

test("tailscalePeers never rejects (empty list when the CLI is missing or errors)", async () => {
  const { cleanup } = await freshServer("net-peers");
  try {
    const net = await import("../src/net.js");
    const r = await net.tailscalePeers(); // read-only probe, safe for real
    assert.ok(Array.isArray(r.peers));
    for (const p of r.peers) {
      assert.equal(typeof p.hostName, "string");
      assert.equal(typeof p.online, "boolean");
      if (p.ip4) assert.match(p.ip4, /^\d+\.\d+\.\d+\.\d+$/);
    }
  } finally {
    cleanup();
  }
});
