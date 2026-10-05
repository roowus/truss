import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceTabCloseMode } from "../src/lib/workspaceClose";

/* The workspace tab's close-X visibility (developer feedback on PR #120:
   "I don't see anything"). Chrome's rule, mapped onto the workspace strip:
   the ACTIVE workspace pins its X (always visible, like Chrome's active
   tab), inactive workspaces reveal on hover, and an unclosable workspace
   gets no X at all so a click there can never close anything. */

const SPACES = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("the active workspace pins its X; the others hover-reveal", () => {
  assert.equal(workspaceTabCloseMode(SPACES, "b", "b"), "always", "active: always visible, no hover needed");
  assert.equal(workspaceTabCloseMode(SPACES, "a", "b"), "hover", "inactive: hover-reveal");
  assert.equal(workspaceTabCloseMode(SPACES, "c", "b"), "hover");
});

test("the last workspace standing gets no X, active or not", () => {
  assert.equal(workspaceTabCloseMode([{ id: "solo" }], "solo", "solo"), null);
});

test("ghost ids get no X", () => {
  assert.equal(workspaceTabCloseMode(SPACES, "ghost", "a"), null);
});
