import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Coverage for the picker's "New folder" (issue #233) on the web side.

   The route and its name hygiene are pinned server-side
   (apps/server/test/dirbrowse-mkdir.test.ts is the issue's contract, and
   dirbrowse-mkdir-confine.test.ts holds the security boundary). What can
   rot quietly HERE is the wiring: the picker must call the mkdir route with
   the directory it is SHOWING, enter what came back, and NOT auto-pick it —
   and the demo backend must record the folder it invents, or navigating
   into it shows an empty listing. */

const PICKER = "src/components/NewSessionDialog.tsx";
const DEMO = "src/lib/demo.ts";
const BACKEND = "src/lib/backend.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the picker offers New folder and calls the mkdir route with the shown directory", () => {
  const src = read(PICKER);
  assert.match(src, /New folder/, "the affordance exists");
  assert.match(src, /browseMkdir\(\s*path\s*,/, "it creates in the directory currently shown, not a stale one");
});

test("the picker enters the created folder instead of auto-picking it", () => {
  const src = read(PICKER);
  /* the success path must navigate INTO the returned path and must not call
     onPick — a picked cwd is an explicit user choice (cwdTouched) */
  const create = src.slice(src.indexOf("const createFolder"));
  const body = create.slice(0, create.indexOf("\n  };"));
  assert.match(body, /go\(r\.path, "enter"\)/, "created folder is entered");
  assert.ok(!/onPick\(/.test(body), "and never auto-picked — Choose this folder stays a separate click");
});

test("the New folder row is hidden in the roots view (no parent to create in)", () => {
  const src = read(PICKER);
  /* the JSX guard, not the comment above it: the row block is `{path !== null && (` */
  assert.match(src, /\{path !== null && \(/, "the New folder block renders only with a directory selected");
});

test("a failed create keeps the reason and leaves the row open to correct it", () => {
  const src = read(PICKER);
  const body = src.slice(src.indexOf("const createFolder"));
  const end = body.indexOf("\n  };");
  const fn = body.slice(0, end > -1 ? end : body.length);
  assert.match(fn, /catch[\s\S]*setErr\(/, "the server's reason is surfaced");
  /* the catch must not clear the typed name: only the success path does */
  const catchBlock = fn.slice(fn.indexOf("catch"));
  assert.ok(!/setNewName\(null\)/.test(catchBlock), "a failure keeps the typed name so it can be corrected in place");
});

/* audit round 1 (PR #250, finding B2) */
test("Escape in the New folder input cancels the ROW, not the whole picker", () => {
  const src = read(PICKER);
  /* the dialog's window-level Escape listener closes the whole picker; React's
     onKeyDown is on the same bubble path, so the row must stop propagation */
  assert.match(src, /window\.addEventListener\("keydown"/, "the dialog does close the picker from a window-level Escape");
  const at = src.indexOf('aria-label="New folder name"');
  assert.ok(at > -1, "the input exists");
  /* the attribute block before the label; the comment inside the handler also
     mentions onKeyDown, so anchor on the JSX attribute line itself */
  const handler = src.slice(src.lastIndexOf("onKeyDown={(e) => {", at), at);
  assert.match(handler, /Escape/, "the row handles Escape");
  assert.match(
    handler,
    /stopPropagation\(\)/,
    "and stops it before the dialog's window listener sees it — otherwise cancel discards the browsing position",
  );
});

test("backend + demo expose browseMkdir", () => {
  assert.match(read(BACKEND), /browseMkdir/, "the client method exists");
  assert.match(read(BACKEND), /"\/api\/browse\/mkdir"/, "and hits the real route");
  assert.match(read(DEMO), /browseMkdir/, "the demo mirrors it");
});

test("the demo records the folder it creates, so entering it lists it", async () => {
  const demo = read(DEMO);
  /* a demo that returned a path without recording it would navigate into an
     empty listing — the mutation must touch the shared dirs set */
  const mk = demo.slice(demo.indexOf("async browseMkdir"));
  const body = mk.slice(0, mk.indexOf("\n    },"));
  assert.match(body, /dirs\.add\(/, "the invented folder is recorded in the virtual fs");
  assert.match(body, /dirs\.has\(target\)/, "and duplicates are refused like the route's 409");
});

test("the demo applies the same name rules the route does", () => {
  const demo = read(DEMO);
  const mk = demo.slice(demo.indexOf("async browseMkdir"));
  const body = mk.slice(0, mk.indexOf("\n    },"));
  assert.match(body, /\.trim\(\)/, "trimmed");
  assert.match(body, /===\s*"\.\."/, "never a traversal");
  assert.match(body, /length > 64/, "capped at 64");
  assert.match(body, /\/\[.*\/\\\\\]\//, "no path separators");
});
