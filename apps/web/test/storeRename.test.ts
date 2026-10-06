import { test } from "node:test";
import assert from "node:assert/strict";

/* Store-level pins for the sidebar rename gesture — https://github.com/roowus/truss/issues/147
   (audit round 1, B3: the two new store methods shipped untested).

   store.renameSession / store.renameHost send the raw text (the server
   trims and caps), patch the row in place with the trimmed/capped value on
   success, and toast + leave state alone on failure. Same shim pattern as
   store.test.ts: window at module scope, rAF for notifications. */

(globalThis as any).window ??= {};
(globalThis as any).requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).window.setTimeout ??= globalThis.setTimeout.bind(globalThis);
const { store } = await import("../src/lib/store");

function meta(id: string, title: string) {
  return {
    id, harness: "pi", title, cwd: "/tmp", model: "", provider: "",
    state: "idle", created_at: 0, updated_at: 0, live: true,
  } as never;
}

test("renameSession patches the row in place, trimmed and capped at 64", async () => {
  const calls: Array<[string, string]> = [];
  store.set((s) => ({
    backend: { renameSession: async (id: string, title: string) => { calls.push([id, title]); return { ok: true }; } } as never,
    sessions: { ...s.sessions, "rs-1": meta("rs-1", "old title") },
  }));
  await store.renameSession("rs-1", "  the new name  ");
  assert.deepEqual(calls, [["rs-1", "  the new name  "]], "the raw text goes to the server (it trims/caps)");
  assert.equal(store.state.sessions["rs-1"].title, "the new name", "the local patch mirrors the server's trim");

  await store.renameSession("rs-1", "x".repeat(200));
  assert.equal(store.state.sessions["rs-1"].title.length, 64, "the local patch mirrors the 64 cap");
  delete store.state.sessions["rs-1"];
});

test("renameSession failure toasts and leaves the title alone", async () => {
  store.set((s) => ({
    backend: { renameSession: async () => { throw new Error("404"); } } as never,
    sessions: { ...s.sessions, "rs-2": meta("rs-2", "keep me") },
    toasts: [],
  }));
  await store.renameSession("rs-2", "replacement");
  assert.equal(store.state.sessions["rs-2"].title, "keep me", "a refused rename never patches the row");
  assert.ok(store.state.toasts.some((t) => t.kind === "error" && /rename chat/i.test(t.title)), "the failure is loud");
  delete store.state.sessions["rs-2"];
});

test("renameHost patches the host label in place; the id is untouched", async () => {
  const calls: Array<[string, string]> = [];
  store.set((s) => ({
    backend: { renameHost: async (id: string, label: string) => { calls.push([id, label]); return { ok: true }; } } as never,
    hosts: [{ id: "h-host", label: "old label", online: false } as never, ...(s.hosts ?? []).filter((h) => h.id !== "h-host")],
  }));
  await store.renameHost("h-host", "  the macbook  ");
  assert.deepEqual(calls, [["h-host", "  the macbook  "]]);
  const row = store.state.hosts.find((h) => h.id === "h-host")!;
  assert.equal(row.label, "the macbook", "trimmed locally like the server does");
  assert.equal(row.id, "h-host", "the id is the identity — renames never rekey");
});

test("renameHost failure toasts and leaves the label alone", async () => {
  store.set({
    backend: { renameHost: async () => { throw new Error("404"); } } as never,
    hosts: [{ id: "h-ghost", label: "stay", online: false } as never],
    toasts: [],
  });
  await store.renameHost("h-ghost", "replacement");
  assert.equal(store.state.hosts.find((h) => h.id === "h-ghost")!.label, "stay");
  assert.ok(store.state.toasts.some((t) => t.kind === "error" && /rename host/i.test(t.title)), "the failure is loud");
});
