import { test, mock } from "node:test";
import assert from "node:assert/strict";

/* Regression pin for audit finding B1 on PR #75: openWhenReady's 250ms retry
   interval called openPanel directly, and openPanel toasts "Workspace is
   still opening" on EVERY not-ready call — while store.toast has no dedupe.
   In exactly the scenario #38 targets (a fresh shell while the layout heal is
   in flight after a reload) the user got a churning stack of identical toasts
   at 4/second until the 40-try budget ran out.

   The fix: the interval polls desktops.isReady()/getDockApi() SILENTLY and
   only calls openPanel once it can succeed.

   store.ts touches `window` at module scope, and workspace.ts uses
   window.setInterval at call time — shim window BEFORE the dynamic import.
   The setInterval shim delegates at call time so node:test's mock timers
   (which replace globalThis.setInterval) intercept it. */
(globalThis as any).window ??= {};
const w = (globalThis as any).window;
w.setInterval ??= (fn: () => void, ms: number) => setInterval(fn, ms);
w.clearInterval ??= (t: ReturnType<typeof setInterval>) => clearInterval(t);

const { openFreeShell } = await import("../src/lib/workspace");
const { store } = await import("../src/lib/store");
const { desktops } = await import("../src/lib/desktops");

interface Stubs {
  toasts: string[];
  added: string[];
  ready: boolean;
  restore: () => void;
}

function stubWorld(): Stubs {
  const toasts: string[] = [];
  const added: string[] = [];
  const state: Stubs = {
    toasts,
    added,
    ready: false,
    restore: () => {},
  };
  const orig = {
    toast: store.toast,
    createTerminal: store.createTerminal,
    isReady: desktops.isReady,
    getApi: desktops.getApi,
  };
  (store as any).toast = (_kind: string, title: string) => void toasts.push(title);
  (store as any).createTerminal = async () => ({ id: "t1", title: "shell" });
  (desktops as any).isReady = () => state.ready;
  (desktops as any).getApi = () =>
    state.ready
      ? {
          panels: [] as any[],
          getPanel: () => undefined,
          addPanel: (opts: { id: string }) => {
            added.push(opts.id);
            return { id: opts.id };
          },
        }
      : null;
  state.restore = () => {
    (store as any).toast = orig.toast;
    (store as any).createTerminal = orig.createTerminal;
    (desktops as any).isReady = orig.isReady;
    (desktops as any).getApi = orig.getApi;
  };
  return state;
}

test("not-ready retries are SILENT — no 'Workspace is still opening' toast spam (audit B1)", async () => {
  mock.timers.enable({ apis: ["setInterval"] } /* real clearInterval cancels mocked interval handles */);
  const s = stubWorld();
  try {
    await openFreeShell("/tmp", { spaceId: "desk-1" });
    /* the initial openPanel call may toast once (unchanged behavior) */
    const initialToasts = s.toasts.filter((t) => t === "Workspace is still opening").length;

    mock.timers.tick(250 * 10); /* 10 retries while the workspace heals */
    assert.equal(
      s.toasts.filter((t) => t === "Workspace is still opening").length,
      initialToasts,
      "the retry interval must not toast — old code added one toast per 250ms tick",
    );

    /* when the workspace comes up, the tab opens without further toasts */
    s.ready = true;
    mock.timers.tick(250);
    assert.deepEqual(s.added, ["terminal:t1"], "the queued shell opens once ready");
    assert.equal(
      s.toasts.filter((t) => t === "Workspace is still opening").length,
      initialToasts,
    );
  } finally {
    s.restore();
    mock.timers.reset();
  }
});

test("a workspace that never comes up in the 10s budget yields exactly ONE fallback toast", async () => {
  mock.timers.enable({ apis: ["setInterval"] } /* real clearInterval cancels mocked interval handles */);
  const s = stubWorld();
  try {
    await openFreeShell("/tmp", { spaceId: "desk-1" });
    const initialToasts = s.toasts.filter((t) => t === "Workspace is still opening").length;

    mock.timers.tick(250 * 45); /* exhaust the 40-try budget */
    assert.equal(
      s.toasts.filter((t) => t === "Workspace is still opening").length,
      initialToasts,
      "retries stay silent even when the budget runs out",
    );
    assert.equal(
      s.toasts.filter((t) => t === "Shell is ready").length,
      1,
      "exactly one toast naming the shells list as the fallback",
    );
    assert.equal(s.added.length, 0, "no panel was ever added");

    /* and the interval really stopped — no late toasts after the budget */
    const total = s.toasts.length;
    mock.timers.tick(250 * 5);
    assert.equal(s.toasts.length, total, "the interval cleared itself");
  } finally {
    s.restore();
    mock.timers.reset();
  }
});
