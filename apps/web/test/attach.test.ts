import { test } from "node:test";
import assert from "node:assert/strict";
import { filesFromTransfer, isFileDrag } from "../src/lib/attach";

/* file-list double: Array.from works on the array-like shape FileList has */
function fakeFiles(names: string[]): FileList {
  const files = names.map((name) => ({ name }) as File);
  return Object.assign(files, { item: (i: number) => files[i] ?? null }) as unknown as FileList;
}

test("filesFromTransfer: files from paste and drop transfers", () => {
  const dt = { files: fakeFiles(["shot.png", "log.txt"]) };
  const out = filesFromTransfer(dt);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.name), ["shot.png", "log.txt"]);
});

test("filesFromTransfer: a text-only paste yields no files (textarea keeps it)", () => {
  assert.deepEqual(filesFromTransfer({ files: fakeFiles([]) }), []);
  assert.deepEqual(filesFromTransfer(null), []);
  assert.deepEqual(filesFromTransfer(undefined), []);
});

test("isFileDrag: only file drags hijack dragover, text drags pass through", () => {
  assert.equal(isFileDrag({ types: ["Files"] } as unknown as DataTransfer), true);
  assert.equal(isFileDrag({ types: ["text/plain"] } as unknown as DataTransfer), false);
  assert.equal(isFileDrag(null), false);
});
