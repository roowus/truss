import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

/**
 * Workspace file browsing for the Files panel (cloned from the dsh-lab
 * dsh-better-sidebar "Files" tab): tree listing, name search, text/image
 * preview, edit-in-place, create file/dir.
 *
 * Every operation is confined to the supplied workspace root (a session's
 * cwd) — paths that resolve outside it are refused.
 */

export interface FileEntry {
  name: string;
  path: string; // relative to root
  kind: "dir" | "file";
  size: number;
  mtime: number;
}

const TEXT_MAX = 512 * 1024; // preview cap
const IMAGE_MAX = 3 * 1024 * 1024; // base64 preview cap
const SEARCH_MAX = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage", "__pycache__", ".cache", ".turbo"]);

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const BINARY_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "woff", "woff2", "ttf", "otf", "eot", "zip", "gz", "tar", "7z", "pdf", "mp3", "mp4", "mov", "webm", "so", "dylib", "exe", "dll", "bin", "wasm", "db", "sqlite", "pyc"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Resolve rel inside root; refuse escapes (incl. symlink-free lexical tricks). */
function confine(root: string, rel: string | undefined): string {
  if (!root) throw new Error("missing workspace root");
  const base = resolve(root);
  const p = resolve(base, rel ?? ".");
  if (p !== base && !p.startsWith(base + sep)) throw new Error("path escapes the workspace root");
  return p;
}

function relOf(root: string, abs: string): string {
  const base = resolve(root);
  return abs === base ? "." : abs.slice(base.length + 1);
}

export function listDir(root: string, rel?: string): FileEntry[] {
  const dir = confine(root, rel);
  const out: FileEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === ".git") continue;
    const abs = resolve(dir, d.name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // broken symlink etc.
    }
    out.push({
      name: d.name,
      path: relOf(root, abs),
      kind: d.isDirectory() ? "dir" : "file",
      size: d.isDirectory() ? 0 : st.size,
      mtime: Math.round(st.mtimeMs),
    });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return out;
}

export interface FileRead {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: "text" | "image" | "binary";
  text?: string;
  truncated?: boolean;
  dataUrl?: string;
}

export function readFile(root: string, rel: string): FileRead {
  const abs = confine(root, rel);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error("is a directory");
  const name = basename(abs);
  const ext = extOf(name);
  const base = { name, path: relOf(root, abs), size: st.size, mtime: Math.round(st.mtimeMs) };
  if (IMAGE_EXT.has(ext)) {
    if (ext === "svg") {
      return { ...base, kind: "text", text: readFileSync(abs, "utf8"), truncated: st.size > TEXT_MAX };
    }
    if (st.size > IMAGE_MAX) return { ...base, kind: "binary" };
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return { ...base, kind: "image", dataUrl: `data:${mime};base64,${readFileSync(abs).toString("base64")}` };
  }
  if (BINARY_EXT.has(ext)) return { ...base, kind: "binary" };
  const buf = readFileSync(abs);
  // cheap binary sniff: NUL byte in the first 8KB
  const sniff = buf.subarray(0, 8192);
  if (sniff.includes(0)) return { ...base, kind: "binary" };
  const truncated = buf.length > TEXT_MAX;
  return { ...base, kind: "text", text: (truncated ? buf.subarray(0, TEXT_MAX) : buf).toString("utf8"), truncated };
}

export function writeFile(root: string, rel: string, content: string): FileRead {
  const abs = confine(root, rel);
  if (!existsSync(abs)) throw new Error("file does not exist (use create)");
  if (statSync(abs).isDirectory()) throw new Error("is a directory");
  writeFileSync(abs, content, "utf8");
  return readFile(root, rel);
}

export function createPath(root: string, rel: string, kind: "file" | "dir"): FileEntry {
  const abs = confine(root, rel);
  if (existsSync(abs)) throw new Error("already exists");
  if (kind === "dir") mkdirSync(abs, { recursive: true });
  else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "", "utf8");
  }
  const st = statSync(abs);
  return { name: basename(abs), path: relOf(root, abs), kind, size: kind === "dir" ? 0 : st.size, mtime: Math.round(st.mtimeMs) };
}

/** Bounded name search across the tree (skips dependency/build dirs). */
export function searchFiles(root: string, q: string): FileEntry[] {
  const base = confine(root, ".");
  const needle = q.toLowerCase();
  const out: FileEntry[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= SEARCH_MAX || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (out.length >= SEARCH_MAX) return;
      const abs = resolve(dir, d.name);
      const isDir = d.isDirectory();
      if (isDir && SKIP_DIRS.has(d.name)) continue;
      if (d.name.toLowerCase().includes(needle)) {
        let size = 0, mtime = 0;
        try {
          const st = statSync(abs);
          size = isDir ? 0 : st.size;
          mtime = Math.round(st.mtimeMs);
        } catch {
          /* ignore */
        }
        out.push({ name: d.name, path: relOf(root, abs), kind: isDir ? "dir" : "file", size, mtime });
      }
      if (isDir) walk(abs, depth + 1);
    }
  };
  walk(base, 0);
  out.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "dir" ? -1 : 1));
  return out;
}
