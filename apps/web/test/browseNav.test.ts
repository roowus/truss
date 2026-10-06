import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for directory-picker scroll memory —
   https://github.com/roowus/truss/issues/136
   ("When I'm picking a directory and scroll to the bottom and go into a
   folder, I get sent back to the top and have to scroll all the way down
   again"). These FAIL on purpose today: they pin the contract a fix must
   satisfy.

   Today (NewSessionDialog.tsx DirPicker): every navigation re-renders a
   fresh list and the scroll container resets — returning to a parent you
   were deep inside means scrolling from zero again.

   The contract: a pure nav-state machine, src/lib/browseNav.ts —

     createBrowseNav() → {
       current(): string | null;                    // null = the roots view
       enter(dir: string): void;                    // descend
       climbTo(dir: string | null): void;           // breadcrumb/up-button
       rememberScroll(dir: string | null, top: number): void;
       scrollMemory(dir: string | null): number;
     }

   Semantics (file-manager standard):
   - entering a CHILD starts at 0 (fresh content reads from its top);
   - RETURNING to any previously-visited directory restores its remembered
     scroll — the complaint;
   - memory is per-path and updates on each leave; the roots view
     (null) has its own slot;
   - unknown dirs read 0; garbage never throws. */

interface BrowseNavModule {
  createBrowseNav(): {
    current(): string | null;
    enter(dir: string): void;
    climbTo(dir: string | null): void;
    rememberScroll(dir: string | null, top: number): void;
    scrollMemory(dir: string | null): number;
  };
}

async function load(): Promise<BrowseNavModule | null> {
  const spec = "../src/lib/browseNav"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/browseNav.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/browseNav.ts must export createBrowseNav — see issue #136");
});

test("returning to a directory restores its scroll; entering a child starts fresh", async () => {
  const mod = await load();
  assert.ok(mod, "browseNav module must exist (see module test)");
  const nav = mod.createBrowseNav();

  assert.equal(nav.current(), null, "starts at the roots view");

  /* the user's exact flow: deep in the parent, descend into a child */
  nav.enter("/home/rewis/projects");
  nav.rememberScroll("/home/rewis/projects", 1480); // they scrolled far down
  nav.enter("/home/rewis/projects/truss");
  assert.equal(nav.current(), "/home/rewis/projects/truss");
  assert.equal(nav.scrollMemory("/home/rewis/projects/truss"), 0, "a fresh child reads from its top");

  /* …and climbing back lands exactly where they were */
  nav.climbTo("/home/rewis/projects");
  assert.equal(nav.scrollMemory("/home/rewis/projects"), 1480, "the parent's scroll position is restored — no scrolling down again");

  /* sibling hops keep their own memory */
  nav.enter("/home/rewis/projects/doubletake");
  nav.rememberScroll("/home/rewis/projects/doubletake", 220);
  nav.climbTo("/home/rewis/projects");
  assert.equal(nav.scrollMemory("/home/rewis/projects"), 1480, "parent memory untouched by the sibling visit");
  nav.enter("/home/rewis/projects/doubletake");
  assert.equal(nav.scrollMemory("/home/rewis/projects/doubletake"), 220, "revisiting a child restores ITS place too");
});

test("the roots view remembers too; unknown dirs read 0; garbage never throws", async () => {
  const mod = await load();
  assert.ok(mod, "browseNav module must exist (see module test)");
  const nav = mod.createBrowseNav();

  nav.rememberScroll(null, 640); // scrolled the roots list
  nav.enter("/home/rewis");
  nav.climbTo(null);
  assert.equal(nav.current(), null);
  assert.equal(nav.scrollMemory(null), 640, "the roots view keeps its place");

  assert.equal(nav.scrollMemory("/never/visited"), 0, "unknown → 0");
  assert.doesNotThrow(() => nav.rememberScroll("/x", -5), "weird values never crash");
  assert.doesNotThrow(() => nav.enter(""), "blank dir never crashes");
  assert.doesNotThrow(() => nav.climbTo(null));
});
