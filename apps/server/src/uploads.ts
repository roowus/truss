import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Chat prompt attachments (issue #2): files land INSIDE the session's
 * workspace under .truss-uploads/ so every harness (even text-only ones like
 * pi) can read them by path. The session cwd is the trust boundary, same as
 * files.ts. Binary byte-exact, hostile names neutralized to a basename,
 * collisions deduped (never overwrite), size-capped with no leftovers.
 */

export const UPLOAD_DIR = ".truss-uploads";
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface UploadRef {
  name: string;
  /** workspace-root-relative path */
  path: string;
  size: number;
}

export function saveUpload(root: string, name: string, data: Buffer, opts: { maxBytes?: number } = {}): UploadRef {
  const maxBytes = opts.maxBytes ?? UPLOAD_MAX_BYTES;

  /* neutralize to a basename: strip directories (\ and /), traversal, and
     leading dots — the name is display + filename material, never a path */
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = base.replace(/[^\w.()\- ]+/g, "_").replace(/^\.+/, "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("a file name is required");
  if (data.length > maxBytes) {
    throw new Error(`file too large — ${(data.length / 1048576).toFixed(1)} MB exceeds the ${Math.round(maxBytes / 1048576)} MB cap`);
  }

  const dir = join(root, UPLOAD_DIR);
  mkdirSync(dir, { recursive: true });

  /* dedupe collisions: name.ext → name-1.ext → name-2.ext — an earlier
     upload is evidence, never clobber it */
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let finalName = clean;
  for (let i = 1; existsSync(join(dir, finalName)); i++) {
    finalName = `${stem}-${i}${ext}`;
  }
  writeFileSync(join(dir, finalName), data);
  return { name: finalName, path: `${UPLOAD_DIR}/${finalName}`, size: data.length };
}
