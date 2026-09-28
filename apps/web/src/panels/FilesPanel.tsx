import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp } from "@/lib/store";
import { shortPath } from "@/lib/format";
import { Btn, Empty, Icon, Spinner } from "@/components/ui";
import { Markdown } from "./Markdown";
import type { FileEntry, FileRead } from "@/lib/proto";
import { cn } from "@/utils/cn";

type P = { sessionId?: string; cwd?: string };

/**
 * Files — a workspace file browser tab (the dsh-lab "Files" sidebar tab,
 * cloned for Truss): lazy tree, name search, text/image/markdown preview,
 * edit-in-place, create file/dir. Everything is confined to the session's
 * working directory by the server.
 */
export function FilesPanel({ params }: IDockviewPanelProps<P>) {
  const meta = useApp((s) => (params.sessionId ? s.sessions[params.sessionId] : undefined));
  const backend = useApp((s) => s.backend);
  const root = meta?.cwd ?? params.cwd ?? "";
  const [dirs, setDirs] = useState<Record<string, FileEntry[] | "loading">>({});
  const [open, setOpen] = useState<Record<string, boolean>>({ ".": true });
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<FileRead | "loading" | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FileEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ kind: "file" | "dir"; value: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [renderMd, setRenderMd] = useState(true);
  const [reload, setReload] = useState(0);
  const searchT = useRef<number>(0);

  const loadDir = useCallback(
    (rel: string) => {
      if (!backend || !root) return;
      setDirs((d) => ({ ...d, [rel]: "loading" }));
      backend.listFiles(root, rel).then(
        (r) => setDirs((d) => ({ ...d, [rel]: r.entries })),
        (e) => {
          setDirs((d) => ({ ...d, [rel]: [] }));
          setErr(e.message ?? String(e));
        },
      );
    },
    [backend, root],
  );

  /* root listing (and refresh) */
  useEffect(() => {
    setDirs({});
    setSel(null);
    setFile(null);
    setErr(null);
    if (root) loadDir(".");
  }, [root, loadDir, reload]);

  /* debounced name search */
  useEffect(() => {
    if (!backend || !root) return;
    window.clearTimeout(searchT.current);
    if (!q.trim()) {
      setHits(null);
      return;
    }
    searchT.current = window.setTimeout(() => {
      backend.listFiles(root, undefined, q.trim()).then(
        (r) => setHits(r.entries),
        (e) => setErr(e.message ?? String(e)),
      );
    }, 250);
    return () => window.clearTimeout(searchT.current);
  }, [q, backend, root]);

  /* open a file */
  useEffect(() => {
    if (!backend || !root || !sel) return;
    setFile("loading");
    setEditing(false);
    setDirty(false);
    backend.readFile(root, sel).then(
      (f) => {
        setFile(f);
        setDraft(f.text ?? "");
      },
      (e) => {
        setFile(null);
        setErr(e.message ?? String(e));
      },
    );
  }, [sel, backend, root]);

  const toggle = (rel: string) => {
    setOpen((o) => {
      const next = { ...o, [rel]: !o[rel] };
      if (next[rel] && !dirs[rel]) loadDir(rel);
      return next;
    });
  };

  const save = async () => {
    if (!backend || !root || !sel) return;
    try {
      const f = await backend.writeFile(root, sel, draft);
      setFile(f);
      setDirty(false);
      setEditing(false);
      store.toast("info", "Saved", f.path);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    }
  };

  const create = async () => {
    if (!backend || !root || !creating || !creating.value.trim()) return;
    try {
      await backend.createFile(root, creating.value.trim(), creating.kind);
      setCreating(null);
      setReload((n) => n + 1);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    }
  };

  const rows = useMemo(() => {
    if (hits) {
      return { flat: hits, mode: "search" as const };
    }
    const flat: { e: FileEntry; depth: number }[] = [];
    const walk = (rel: string, depth: number) => {
      const kids = dirs[rel];
      if (!Array.isArray(kids)) return;
      for (const e of kids) {
        flat.push({ e, depth });
        if (e.kind === "dir" && open[e.path]) walk(e.path, depth + 1);
      }
    };
    walk(".", 0);
    return { flat, mode: "tree" as const, loading: dirs["."] === "loading" };
  }, [dirs, open, hits]);

  if (!root) {
    return (
      <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
        <Empty icon="folder" title="No working directory">Open Files from a session so the browser knows which workspace to show.</Empty>
      </div>
    );
  }

  const selEntry = sel;
  const isMd = !!selEntry && /\.(md|mdx)$/i.test(selEntry);

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      {/* header */}
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="folder" size={13} className="text-[var(--t-amber)]" />
        <span className="font-mono text-[11px] text-[var(--t-mute)] truncate" title={root}>{shortPath(root)}</span>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center gap-1.5 h-6 px-2 rounded bg-[var(--t-bg0)] border border-[var(--t-line)]">
            <Icon name="search" size={10} className="text-[var(--t-dim)]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQ("")}
              placeholder="search files"
              className="w-24 bg-transparent text-[11.5px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]"
            />
          </div>
          <Btn size="xs" variant="ghost" icon="plus" title="New file at the root" onClick={() => setCreating({ kind: "file", value: "" })} />
          <Btn size="xs" variant="ghost" icon="folder" title="New folder at the root" onClick={() => setCreating({ kind: "dir", value: "" })} />
          <Btn size="xs" variant="ghost" icon="retry" title="Refresh" onClick={() => setReload((n) => n + 1)} />
        </div>
      </div>

      {creating && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--t-line)] bg-[var(--t-bg2)]">
          <Icon name={creating.kind === "dir" ? "folder" : "edit"} size={12} className="text-[var(--t-dim)]" />
          <input
            autoFocus
            value={creating.value}
            onChange={(e) => setCreating({ ...creating, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
              if (e.key === "Escape") setCreating(null);
            }}
            placeholder={creating.kind === "dir" ? "new/folder (Enter)" : "new/file.ts (Enter)"}
            className="flex-1 bg-transparent outline-none font-mono text-[12px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)]"
          />
          <Btn size="xs" variant="ghost" onClick={() => setCreating(null)}>Cancel</Btn>
        </div>
      )}
      {err && (
        <div className="shrink-0 px-3 py-1.5 border-b border-[var(--t-line)] text-[11px] font-mono text-[var(--t-red)] flex items-center gap-2">
          <span className="flex-1 truncate">{err}</span>
          <button onClick={() => setErr(null)} aria-label="Dismiss"><Icon name="x" size={11} /></button>
        </div>
      )}

      {/* body: tree + preview */}
      <div className="flex-1 min-h-0 flex">
        <div className={cn("h-full overflow-auto t-scroll py-1", sel ? "w-[42%] shrink-0 border-r border-[var(--t-line)]" : "flex-1")}>
          {rows.mode === "search" ? (
            hits!.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-[var(--t-dim)]">No files match “{q}”.</div>
            ) : (
              (rows.flat as FileEntry[]).map((e) => (
                <Row key={e.path} e={e} depth={0} showPath expanded={false} selected={sel === e.path} onToggle={toggle} onSelect={(p) => { setSel(p); setQ(""); }} />
              ))
            )
          ) : dirs["."] === "loading" || dirs["."] === undefined ? (
            <div className="h-full grid place-items-center"><Spinner /></div>
          ) : (rows.flat as { e: FileEntry; depth: number }[]).length === 0 ? (
            <div className="px-3 py-6 text-center text-[11.5px] text-[var(--t-dim)]">Empty directory.</div>
          ) : (
            (rows.flat as { e: FileEntry; depth: number }[]).map(({ e, depth }) => (
              <Row key={e.path} e={e} depth={depth} expanded={!!open[e.path]} selected={sel === e.path} onToggle={toggle} onSelect={setSel} />
            ))
          )}
        </div>

        {sel && (
          <div className="flex-1 min-w-0 h-full flex flex-col">
            <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-[var(--t-line)]">
              <span className="font-mono text-[11px] text-[var(--t-fg2)] truncate" title={sel}>{sel}</span>
              {file !== null && file !== "loading" && (
                <span className="shrink-0 font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{fmtSize(file.size)}{file.truncated ? " · truncated" : ""}</span>
              )}
              <span className="ml-auto shrink-0 flex items-center gap-1">
                {file !== null && file !== "loading" && file.kind === "text" && isMd && !editing && (
                  <Btn size="xs" variant="ghost" onClick={() => setRenderMd((v) => !v)} title="Toggle rendered / raw markdown">{renderMd ? "Raw" : "Rendered"}</Btn>
                )}
                {file !== null && file !== "loading" && file.kind === "text" && !editing && (
                  <Btn size="xs" variant="outline" icon="edit" onClick={() => { setEditing(true); setDraft(file.text ?? ""); }}>Edit</Btn>
                )}
                {editing && (
                  <>
                    <Btn size="xs" variant="ghost" onClick={() => { setEditing(false); setDirty(false); setDraft(typeof file === "object" && file ? file.text ?? "" : ""); }}>Discard</Btn>
                    <Btn size="xs" variant="amber" disabled={!dirty} onClick={() => void save()}>Save ⌘S</Btn>
                  </>
                )}
                <Btn size="xs" variant="ghost" icon="x" title="Close preview" onClick={() => { setSel(null); setFile(null); setEditing(false); }} />
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-auto t-scroll">
              {file === "loading" ? (
                <div className="h-full grid place-items-center"><Spinner /></div>
              ) : !file ? (
                <Empty icon="alert" title="Couldn't read the file" />
              ) : editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                  spellCheck={false}
                  className="w-full h-full resize-none bg-transparent outline-none p-3 font-code text-[12px] leading-relaxed text-[var(--t-fg2)]"
                />
              ) : file.kind === "image" ? (
                <div className="h-full grid place-items-center p-4">
                  <img src={file.dataUrl} alt={file.name} className="max-w-full max-h-full object-contain rounded border border-[var(--t-line)]" />
                </div>
              ) : file.kind === "binary" ? (
                <Empty icon="alert" title="Binary file">{fmtSize(file.size)} — no preview. Open it in a shell instead.</Empty>
              ) : isMd && renderMd ? (
                <div className="p-4 text-[12.5px] t-md"><Markdown text={file.text ?? ""} /></div>
              ) : (
                <pre className="p-3 font-code text-[11.5px] leading-relaxed text-[var(--t-fg2)] whitespace-pre-wrap break-all">{file.text}</pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  e,
  depth,
  expanded,
  selected,
  showPath,
  onToggle,
  onSelect,
}: {
  e: FileEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  showPath?: boolean;
  onToggle: (rel: string) => void;
  onSelect: (rel: string) => void;
}) {
  const hidden = e.name.startsWith(".");
  return (
    <button
      onClick={() => (e.kind === "dir" ? onToggle(e.path) : onSelect(e.path))}
      className={cn(
        "w-full flex items-center gap-1.5 h-7 pr-2 text-left hover:bg-white/[0.04]",
        selected && "bg-white/[0.06]",
        hidden && "opacity-55",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={e.path}
    >
      {e.kind === "dir" ? (
        <Icon name="chev" size={10} className={cn("text-[var(--t-dim)] transition-transform", expanded && "rotate-90")} />
      ) : (
        <span className="w-[10px]" />
      )}
      <Icon name={e.kind === "dir" ? "folder" : "edit"} size={12} className={e.kind === "dir" ? "text-[var(--t-amber)]/80" : "text-[var(--t-dim)]"} />
      <span className={cn("truncate text-[12px]", selected ? "text-[var(--t-fg)]" : "text-[var(--t-fg2)]")}>{e.name}</span>
      {showPath && <span className="truncate text-[10px] font-mono text-[var(--t-dim)]">{e.path}</span>}
      {e.kind === "file" && <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{fmtSize(e.size)}</span>}
    </button>
  );
}

export function fmtSize(n: number): string {
  const r = Math.round(n);
  if (r < 1024) return `${r} B`;
  if (r < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${(n / 1024 ** 4).toFixed(1)} TB`;
}
