import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTailscaleReturn, deviceLabel, peerAlreadyAdded } from "../src/lib/device";
import { buildModelOptions, modelValue, splitModelValue } from "../src/lib/models";

/* the chat header's device chip + model picker logic (pure halves) */

test("deviceLabel: bare harness id is this server", () => {
  assert.equal(deviceLabel("pi", []), "this server");
  assert.equal(deviceLabel("claude-code", [{ id: "abc", label: "atlas" }]), "this server");
});

test("deviceLabel: harness@host resolves through the registry label", () => {
  const hosts = [
    { id: "d95b425f", label: "fedora box" },
    { id: "e5010fff", label: "basement pi" },
  ];
  assert.equal(deviceLabel("pi@d95b425f", hosts), "fedora box");
  assert.equal(deviceLabel("hermes@e5010fff", hosts), "basement pi");
});

test("deviceLabel: unknown host falls back to the raw id (never blank)", () => {
  assert.equal(deviceLabel("pi@deadbeef", []), "deadbeef");
  assert.equal(deviceLabel("pi@deadbeef", [{ id: "other", label: "x" }]), "deadbeef");
});

test("peerAlreadyAdded: case/whitespace-insensitive label match", () => {
  const hosts = [{ label: "Fedora Box" }, { label: "  basement pi  " }];
  assert.equal(peerAlreadyAdded(hosts, "fedora box"), true);
  assert.equal(peerAlreadyAdded(hosts, "basement pi"), true);
  assert.equal(peerAlreadyAdded(hosts, "gpu rig"), false);
  assert.equal(peerAlreadyAdded([], "anything"), false);
});

test("modelValue / splitModelValue round-trip (model ids contain slashes)", () => {
  assert.equal(modelValue("truss-fw", "accounts/fireworks/models/kimi-k3"), "truss-fw/accounts/fireworks/models/kimi-k3");
  assert.equal(modelValue(undefined, "glm-4.7"), "glm-4.7");
  assert.equal(modelValue(undefined, undefined), "");

  assert.deepEqual(splitModelValue("truss-fw/accounts/fireworks/models/kimi-k3"), {
    provider: "truss-fw",
    model: "accounts/fireworks/models/kimi-k3",
  });
  assert.deepEqual(splitModelValue("glm-4.7"), { model: "glm-4.7" }); // no provider key at all
  // round trips
  const v = modelValue("a", "b/c/d");
  assert.deepEqual(splitModelValue(v), { provider: "a", model: "b/c/d" });
});

test("buildModelOptions: filters the catalog to the BASE harness (remote shares it)", () => {
  const catalog = [
    { harness: "pi", provider: "zai-local", model: "glm-4.7", label: "GLM 4.7" },
    { harness: "pi", provider: "truss-fw", model: "accounts/fireworks/models/kimi-k3", label: "Kimi K3" },
    { harness: "dsh", provider: "deepseek", model: "deepseek-v3.2", label: "DS 3.2" },
  ];
  const local = buildModelOptions(catalog, "pi", "glm-4.7", "zai-local");
  assert.equal(local.length, 2, "only pi models");
  assert.ok(local.every((o) => o.hint?.startsWith("zai-local/") || o.hint?.startsWith("truss-fw/")));

  const remote = buildModelOptions(catalog, "pi@d95b425f", "glm-4.7", "zai-local");
  assert.equal(remote.length, 2, "remote pi session sees the local pi catalog");
});

test("buildModelOptions: a current model missing from the catalog is synthesized, never blank", () => {
  const catalog = [{ harness: "pi", provider: "zai-local", model: "glm-4.7", label: "GLM 4.7" }];
  const opts = buildModelOptions(catalog, "pi", "old-model", "old-prov");
  assert.equal(opts[0].value, "old-prov/old-model");
  assert.equal(opts[0].label, "old-model");
  assert.equal(opts[0].hint, "current");
  assert.equal(opts.length, 2);
});

test("buildModelOptions: no duplicate when the catalog already has the current model", () => {
  const catalog = [{ harness: "pi", provider: "zai-local", model: "glm-4.7", label: "GLM 4.7" }];
  const opts = buildModelOptions(catalog, "pi", "glm-4.7", "zai-local");
  assert.equal(opts.length, 1);
});

test("buildModelOptions: empty catalog + no model -> no options (picker hides itself)", () => {
  assert.deepEqual(buildModelOptions([], "pi", undefined, undefined), []);
  // ...but a session with a model always shows it, even with an empty catalog
  const opts = buildModelOptions([], "pi", "m", "p");
  assert.equal(opts.length, 1);
  assert.equal(opts[0].value, "p/m");
});

/* the wizard's return address: on tailscale the device pick implies the
   return path — this server's own tailnet identity, no second selection */

const NET = {
  port: 4040,
  tailscale: {
    installed: true,
    ip4: "100.107.125.118",
    dnsName: "rewvis.tail208cbf.ts.net",
    serveOn: false,
  },
};

test("defaultTailscaleReturn: serve https wins when on", () => {
  const net = { ...NET, tailscale: { ...NET.tailscale, serveOn: true, serveUrl: "https://rewvis.tail208cbf.ts.net" } };
  assert.equal(defaultTailscaleReturn(net), "https://rewvis.tail208cbf.ts.net");
});

test("defaultTailscaleReturn: magic dns name next", () => {
  assert.equal(defaultTailscaleReturn(NET), "http://rewvis.tail208cbf.ts.net:4040");
});

test("defaultTailscaleReturn: tailnet ip when no dns", () => {
  const net = { ...NET, tailscale: { installed: true, ip4: "100.107.125.118" } };
  assert.equal(defaultTailscaleReturn(net), "http://100.107.125.118:4040");
});

test("defaultTailscaleReturn: null without tailscale or without any address", () => {
  assert.equal(defaultTailscaleReturn(null), null);
  assert.equal(defaultTailscaleReturn({ port: 4040, tailscale: { installed: false } }), null);
  assert.equal(defaultTailscaleReturn({ port: 4040, tailscale: { installed: true } }), null);
});
