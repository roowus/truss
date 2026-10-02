import { test } from "node:test";
import assert from "node:assert/strict";
import type { IDockviewPanelProps } from "dockview-react";

/* controlSize.test.ts pins the controls.ts numbers. This pins the wiring,
   which is where issue #11 actually broke: the Todos facet dropdowns sit in
   the filter bar but never received size="bar", so they kept Select's 34px
   form height next to the 24px search box — while the constants tests stayed
   green. The panels are rendered server-side (the suite has no DOM); the
   trigger height is the only inline height Select writes, so the markup is
   enough to assert on.

   store.ts touches `window` at module scope, so the shim must exist BEFORE
   the panels are imported — hence the dynamic imports (static ones hoist).
   Same shim store.test.ts needs. */
(globalThis as any).window ??= {};

const { createElement } = await import("react");
const { renderToString } = await import("react-dom/server");
const { Select } = await import("../src/components/ui");
const { store } = await import("../src/lib/store");
const { TodosPanel } = await import("../src/panels/TodosPanel");
const { FeedPanel } = await import("../src/panels/FeedPanel");

const SESSION = {
  id: "s1", harness: "claude-code", title: "session", cwd: "/home/me/proj",
  project: "proj", state: "running" as const, created_at: 0, updated_at: 0, live: true,
};
const TODO = {
  id: "t1", sessionId: "s1", title: "ship it", notes: "", priority: "normal" as const,
  labels: ["api"], subtasks: [], meta: {}, status: "open" as const, createdBy: "agent" as const,
  sharedEditors: [], sharedWith: [], deniedEditors: [], createdAt: 0, updatedAt: 0,
};

/* every `height:` in the rendered markup — in these two panels Select's
   trigger is the only element that writes one. The lookbehind keeps
   min-height / max-height / line-height out of the match. */
const heightsOf = (html: string): number[] =>
  [...html.matchAll(/(?<![-\w])height:\s*([\d.]+)px/g)].map((m) => Number(m[1]));

/* the search box's own height is the h-6 class on its wrapper, not an inline
   style, so heightsOf never sees it — bumping that wrapper to h-7 would
   re-open issue #11 with every heightsOf assertion still green. This reads
   back the class of the div the search input sits in. */
const searchBoxWrapperClass = (html: string): string => {
  const at = html.indexOf('placeholder="search"');
  if (at === -1) return "";
  const open = html.lastIndexOf("<div", at);
  return open === -1 ? "" : (/class="([^"]*)"/.exec(html.slice(open, at))?.[1] ?? "");
};

test("the search box the dropdowns are pinned to is still the h-6 wrapper", () => {
  store.state.todosLoaded = true;
  store.state.sessions = { s1: SESSION };
  store.state.todos = { t1: TODO };
  const html = renderToString(createElement(TodosPanel, {} as IDockviewPanelProps));
  assert.match(searchBoxWrapperClass(html), /\bh-6\b/, "Todos: the search box must stay h-6 — the 24 in heightsOf is only its height while it is");
  store.state.feedLoaded = true;
  const feed = renderToString(createElement(FeedPanel, {} as IDockviewPanelProps));
  assert.match(searchBoxWrapperClass(feed), /\bh-6\b/, "Feed: the search box must stay h-6 — the 24 in heightsOf is only its height while it is");
});

test("every dropdown in the Todos filter bar is as tall as the search box", () => {
  store.state.todosLoaded = true;
  store.state.sessions = { s1: SESSION };
  store.state.todos = { t1: TODO };

  /* the default list view shows "Group by" plus all four facet dropdowns
     (project / agent / folder / label) beside the search box: five triggers */
  const html = renderToString(createElement(TodosPanel, {} as IDockviewPanelProps));
  assert.deepEqual(heightsOf(html), [24, 24, 24, 24, 24], "filter-bar dropdowns must match the search box's h-6 (issue #11)");
});

test("every dropdown in the Feed filter bar is as tall as the search box", () => {
  store.state.feedLoaded = true;

  const html = renderToString(createElement(FeedPanel, {} as IDockviewPanelProps));
  assert.deepEqual(heightsOf(html), [24, 24], "Sort and State must match the search box's h-6 (issue #11)");
});

test("a Select with no size keeps the 34px form height — dialogs are untouched", () => {
  const props = { value: "a", options: [{ value: "a", label: "a" }], onChange: () => {} };
  assert.deepEqual(heightsOf(renderToString(createElement(Select, props))), [34], "the default stays the form size");
  assert.deepEqual(heightsOf(renderToString(createElement(Select, { ...props, size: "bar" as const }))), [24], "the bar size is the compact one");
});
