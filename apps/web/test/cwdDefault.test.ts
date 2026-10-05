import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the default working directory —
   https://github.com/roowus/truss/issues/106
   ("…and have a default directory too"). These FAIL on purpose today.

   A default EXISTS (UiSettings.defaultCwd, prefilled at
   NewSessionDialog.tsx:28) — but the precedence is an inline `||` chain
   with a subtle gap: a per-HOST default (HostPreference.defaultCwd, set
   for remote boxes) never wins. The contract names the order ONCE, in a
   pure src/lib/cwdDefault.ts —

     resolveDefaultCwd({
       preset?,             // explicit preset (task board, "new session here")
       hostDefault?,        // the picked host's preference
       settingsDefault?,    // the global Settings default
       recent?              // most recent session cwd
     }): string

   precedence: preset > hostDefault > settingsDefault > recent > "".
   Blank/whitespace candidates are skipped, never returned as-is. */

interface CwdDefaultModule {
  resolveDefaultCwd(input: {
    preset?: string;
    hostDefault?: string;
    settingsDefault?: string;
    recent?: string;
  }): string;
}

async function load(): Promise<CwdDefaultModule | null> {
  const spec = "../src/lib/cwdDefault"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/cwdDefault.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/cwdDefault.ts must export resolveDefaultCwd — see issue #106");
});

test("precedence: preset > host > settings > recent > empty", async () => {
  const mod = await load();
  assert.ok(mod, "cwdDefault module must exist (see module test)");
  const all = { preset: "/p", hostDefault: "/h", settingsDefault: "/s", recent: "/r" };

  assert.equal(mod.resolveDefaultCwd(all), "/p", "an explicit preset wins everything");
  assert.equal(mod.resolveDefaultCwd({ ...all, preset: undefined }), "/h", "the picked host's default beats the global one");
  assert.equal(mod.resolveDefaultCwd({ ...all, preset: undefined, hostDefault: undefined }), "/s", "then the Settings default");
  assert.equal(mod.resolveDefaultCwd({ ...all, preset: undefined, hostDefault: undefined, settingsDefault: undefined }), "/r", "then the most recent");
  assert.equal(mod.resolveDefaultCwd({}), "", "and nothing → empty (the picker opens at the roots)");
});

test("blank candidates never win", async () => {
  const mod = await load();
  assert.ok(mod, "cwdDefault module must exist (see module test)");
  assert.equal(
    mod.resolveDefaultCwd({ preset: "   ", hostDefault: "", settingsDefault: "/s", recent: "/r" }),
    "/s",
    "whitespace/empty candidates fall through",
  );
});

/* audit round 1 (PR #107, finding B2): pin the host-default LOOKUP, not
   just the precedence — real harness ids are `${adapterId}@${hostId}`, so
   the direct host-pref hit must win, with the registry walk (hostname,
   short hostname) covering hand-keyed suffixes */

interface HostLookupModule extends CwdDefaultModule {
  hostDefaultFor(harnessId: string, prefs: Record<string, { defaultCwd?: string }>, hosts?: { id: string; agent?: { hostname?: string } }[]): string;
}

async function loadLookup(): Promise<HostLookupModule | null> {
  const spec = "../src/lib/cwdDefault";
  return import(spec).catch(() => null);
}

test("hostDefaultFor: the host id suffix hits the host pref directly", async () => {
  const mod = await loadLookup();
  assert.ok(mod, "cwdDefault module must exist (see module test)");
  const prefs = { "box-1": { defaultCwd: "/srv/code" } };
  assert.equal(mod.hostDefaultFor("dsh@box-1", prefs), "/srv/code", "the real id shape resolves without the registry");
  assert.equal(mod.hostDefaultFor("dsh@box-1", prefs, []), "/srv/code", "registry optional for the direct hit");
});

test("hostDefaultFor: hostname and short-hostname suffixes resolve through the registry", async () => {
  const mod = await loadLookup();
  assert.ok(mod, "cwdDefault module must exist (see module test)");
  const prefs = { "box-1": { defaultCwd: "/srv/code" } };
  const hosts = [{ id: "box-1", agent: { hostname: "devbox.lan" } }];
  assert.equal(mod.hostDefaultFor("pi@devbox.lan", prefs, hosts), "/srv/code", "full hostname suffix");
  assert.equal(mod.hostDefaultFor("pi@devbox", prefs, hosts), "/srv/code", "short hostname suffix");
});

test("hostDefaultFor: local harnesses and unknown hosts give no default", async () => {
  const mod = await loadLookup();
  assert.ok(mod, "cwdDefault module must exist (see module test)");
  const prefs = { "box-1": { defaultCwd: "/srv/code" } };
  const hosts = [{ id: "box-1", agent: { hostname: "devbox.lan" } }];
  assert.equal(mod.hostDefaultFor("dsh", prefs, hosts), "", "no @host suffix — a local harness has no host default");
  assert.equal(mod.hostDefaultFor("dsh@nowhere", prefs, hosts), "", "unknown host");
  assert.equal(mod.hostDefaultFor("dsh@box-1", {}, hosts), "", "host known but no pref stored");
});

/* issue #123: the host's OWN suggestion (hello-announced, e.g. ~/projects on
   the remote) slots between the user-set host pref and the global default */

interface CwdDefault117Module extends CwdDefaultModule {
  resolveDefaultCwd(input: {
    preset?: string;
    hostDefault?: string;
    hostSuggested?: string;
    settingsDefault?: string;
    recent?: string;
  }): string;
}

test("precedence with the host's suggestion: preset > host pref > host suggestion > settings > recent", async () => {
  const spec = "../src/lib/cwdDefault";
  const mod = (await import(spec).catch(() => null)) as CwdDefault117Module | null;
  assert.ok(mod, "cwdDefault module must exist (see module test)");
  const all = { preset: "/p", hostDefault: "/h", hostSuggested: "/hs", settingsDefault: "/s", recent: "/r" };

  assert.equal(mod.resolveDefaultCwd(all), "/p", "preset still wins everything");
  assert.equal(mod.resolveDefaultCwd({ ...all, preset: undefined }), "/h", "the user-set host pref beats the suggestion");
  assert.equal(mod.resolveDefaultCwd({ ...all, preset: undefined, hostDefault: undefined }), "/hs", "the remote's own suggestion beats this machine's defaults (the #117 complaint)");
  assert.equal(mod.resolveDefaultCwd({ preset: undefined, hostDefault: undefined, hostSuggested: undefined, settingsDefault: "/s", recent: "/r" }), "/s", "no suggestion → the old chain intact");
  assert.equal(
    mod.resolveDefaultCwd({ hostSuggested: "   ", settingsDefault: "/s", recent: "/r" }),
    "/s",
    "a blank suggestion never wins",
  );
});

/* issue #123, companion to the contract above: hostSuggestedFor resolves the
   picked harness's @host suffix to the host record's agent.suggestedCwd —
   the same registry walk hostDefaultFor uses */

interface CwdSuggestedModule extends CwdDefaultModule {
  hostSuggestedFor(harnessId: string, hosts?: { id: string; agent?: { hostname?: string; suggestedCwd?: string } }[]): string;
}

test("hostSuggestedFor: the host's announced suggestion resolves by id, hostname, or short hostname", async () => {
  const spec = "../src/lib/cwdDefault";
  const mod = (await import(spec).catch(() => null)) as CwdSuggestedModule | null;
  assert.ok(mod, "cwdDefault module must exist (see module test)");
  const hosts = [{ id: "box-1", agent: { hostname: "devbox.lan", suggestedCwd: "/home/dev/projects" } }];

  assert.equal(mod.hostSuggestedFor("pi@box-1", hosts), "/home/dev/projects", "the real id shape (adapterId@hostId)");
  assert.equal(mod.hostSuggestedFor("pi@devbox.lan", hosts), "/home/dev/projects", "full hostname suffix");
  assert.equal(mod.hostSuggestedFor("pi@devbox", hosts), "/home/dev/projects", "short hostname suffix");
});

test("hostSuggestedFor: local harnesses, unknown hosts, and pre-discovery agents suggest nothing", async () => {
  const spec = "../src/lib/cwdDefault";
  const mod = (await import(spec).catch(() => null)) as CwdSuggestedModule | null;
  assert.ok(mod, "cwdDefault module must exist (see module test)");
  const oldAgent = [{ id: "box-2", agent: { hostname: "oldbox" } }];

  assert.equal(mod.hostSuggestedFor("dsh", oldAgent), "", "no @host suffix — a local harness has no suggestion");
  assert.equal(mod.hostSuggestedFor("dsh@nowhere", oldAgent), "", "unknown host");
  assert.equal(mod.hostSuggestedFor("pi@box-2", oldAgent), "", "a pre-discovery agent carries no suggestion (graceful degradation)");
});
