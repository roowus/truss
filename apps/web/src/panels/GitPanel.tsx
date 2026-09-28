import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { createPortal } from "react-dom";
import { store, useApp, useNow } from "@/lib/store";
import { ago, shortPath } from "@/lib/format";
// useNow is used by the BranchSwitcher; GitPanel body renders from load()
import { Btn, Empty, Icon, Spinner } from "@/components/ui";
import type { GitBranch, GitChange, GitStatus } from "@/lib/proto";
import { cn } from "@/utils/cn";

type P = { sessionId?: string; cwd?: string };

/**
 * Git — branch switcher + working-tree Changes + commit graph (the dsh-lab
 * git-graph branch selector / graph panel and the better-sidebar Changes tab,
 * merged into one Truss tab). Read-mostly: switching branches is the only
 * mutation; staging and committing stay with the agent.
 */
export function GitPanel({ params }: IDockviewPanelProps<P>) {
  const meta = useApp((s) => (params.sessionId ? s.sessions[params.sessionId] : undefined));
  const backend = useApp((s) => s.backend);
  const cwd = meta?.cwd ?? params.cwd ?? "";
  const [mode, setMode] = useState<"changes" | "graph">("changes");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [graph, setGraph] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [switcher, setSwitcher] = useState(false);
  const [diff, setDiff] = useState<{ path: string; staged: boolean; text: string } | "loading" | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!backend || !cwd) return;
    setLoading(true);
    setErr(null);
    try {
      const st = await backend.gitStatus(cwd);
      setStatus(st);
      if (st.isRepo) {
        backend.gitBranches(cwd).then((b) => setBranches(b.branches)).catch(() => {});
        backend.gitGraph(cwd).then((g) => setGraph(g.graph)).catch(() => setGraph(null));
      }
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [backend, cwd]);

  useEffect(() => {
    setStatus(null);
    setBranches(null);
    setGraph(null);
    setDiff(null);
    void load();
  }, [load]);

  const openDiff = (c: GitChange, staged: boolean) => {
    if (!backend || !cwd) return;
    if (diff !== "loading" && diff?.path === c.path && diff.staged === staged) {
      setDiff(null);
      return;
    }
    setDiff({ path: c.path, staged, text: "" });
    backend.gitDiff(cwd, c.path, staged).then(
      (d) => setDiff({ path: c.path, staged, text: d.diff || "(no textual diff — binary or empty)" }),
      (e) => setDiff({ path: c.path, staged, text: `error: ${e.message ?? e}` }),
    );
  };

  const doSwitch = async (branch: string, create: boolean) => {
    if (!backend) return;
    setSwitcher(false);
    try {
      await backend.gitSwitch(cwd, branch, create);
      store.toast("info", create ? "Branch created" : "Switched branch", branch);
      void load();
    } catch (e: any) {
      store.toast("error", "git switch failed", e.message ?? String(e));
    }
  };

  if (!cwd) {
    return (
      <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
        <Empty icon="tree" title="No working directory">Open Git from a session so the panel knows which repository to show.</Empty>
      </div>
    );
  }

  const staged = status?.changes.filter((c) => c.x !== " " && c.x !== "?") ?? [];
  const unstaged = status?.changes.filter((c) => c.x === " " || c.x === "?") ?? [];

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      {/* header */}
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="tree" size={13} className="text-[var(--t-violet)]" />
        {status?.isRepo ? (
          <button
            ref={chipRef}
            onClick={() => setSwitcher((v) => !v)}
            className="flex items-center gap-1.5 h-6 pl-2 pr-1.5 rounded-full bg-[var(--t-bg0)] border border-[var(--t-line2)] text-[11.5px] font-mono text-[var(--t-fg2)] hover:text-[var(--t-fg)] hover:border-[var(--t-mute)]"
            title="Switch branch"
          >
            <Icon name="tree" size={10} className="text-[var(--t-amber)]" />
            {status.branch ?? "detached"}
            {(status.ahead ?? 0) > 0 && <span className="text-[var(--t-teal)]">↑{status.ahead}</span>}
            {(status.behind ?? 0) > 0 && <span className="text-[var(--t-coral)]">↓{status.behind}</span>}
            <Icon name="down" size={9} className="text-[var(--t-dim)]" />
          </button>
        ) : (
          <span className="font-mono text-[11px] text-[var(--t-mute)] truncate" title={cwd}>{shortPath(cwd)}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {status?.isRepo && (
            <span className="flex items-center rounded bg-[var(--t-bg0)] border border-[var(--t-line)] overflow-hidden text-[10.5px]">
              {(["changes", "graph"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn("px-2 h-6 capitalize", mode === m ? "bg-white/[0.07] text-[var(--t-fg)]" : "text-[var(--t-dim)] hover:text-[var(--t-mute)]")}
                >
                  {m}{m === "changes" && status ? ` (${status.changes.length})` : ""}
                </button>
              ))}
            </span>
          )}
          <Btn size="xs" variant="ghost" icon="retry" title="Refresh" onClick={() => void load()} />
        </span>
      </div>

      {switcher && chipRef.current && branches && (
        <BranchSwitcher anchor={chipRef.current} branches={branches} onPick={doSwitch} onClose={() => setSwitcher(false)} />
      )}

      {/* body */}
      <div className="flex-1 min-h-0 overflow-auto t-scroll">
        {loading ? (
          <div className="h-full grid place-items-center"><Spinner /></div>
        ) : err ? (
          <Empty icon="alert" title="Git failed">{err}</Empty>
        ) : !status?.isRepo ? (
          <Empty icon="tree" title="Not a git repository">
            <span className="font-mono text-[11px]">{shortPath(cwd)}</span>
          </Empty>
        ) : mode === "graph" ? (
          graph === null ? (
            <div className="h-full grid place-items-center"><Spinner /></div>
          ) : graph.trim() === "" ? (
            <Empty icon="tree" title="No commits yet" />
          ) : (
            <pre className="p-3 font-code text-[11.5px] leading-[1.5] whitespace-pre">
              {graph.split("\n").map((ln, i) => <GraphLine key={i} line={ln} />)}
            </pre>
          )
        ) : status.changes.length === 0 ? (
          <Empty icon="check" title="Clean working tree">No changes on <span className="font-mono">{status.branch}</span>.</Empty>
        ) : (
          <div className="py-1">
            {staged.length > 0 && <ChangeGroup label="Staged" list={staged} staged diff={diff} onOpen={openDiff} />}
            {unstaged.length > 0 && <ChangeGroup label="Changes" list={unstaged} staged={false} diff={diff} onOpen={openDiff} />}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- changes ---------- */

const STATUS_STYLE: Record<string, [string, string]> = {
  M: ["modified", "var(--t-amber)"],
  A: ["added", "var(--t-teal)"],
  D: ["deleted", "var(--t-red)"],
  R: ["renamed", "var(--t-sky)"],
  "?": ["untracked", "var(--t-dim)"],
  C: ["copied", "var(--t-sky)"],
  U: ["conflict", "var(--t-red)"],
};

function ChangeGroup({ label, list, staged, diff, onOpen }: {
  label: string;
  list: GitChange[];
  staged: boolean;
  diff: { path: string; staged: boolean; text: string } | "loading" | null;
  onOpen: (c: GitChange, staged: boolean) => void;
}) {
  return (
    <div className="mb-1">
      <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--t-dim)]">{label} · {list.length}</div>
      {list.map((c) => {
        const letter = (staged ? c.x : c.y).trim() || (staged ? c.x : c.y) || "?";
        const [word, color] = STATUS_STYLE[letter] ?? STATUS_STYLE.M;
        const open = diff !== "loading" && diff?.path === c.path && diff.staged === staged;
        return (
          <div key={`${staged}:${c.path}`}>
            <button onClick={() => onOpen(c, staged)} className={cn("w-full flex items-center gap-2 px-3 h-7 text-left hover:bg-white/[0.04]", open && "bg-white/[0.05]")}>
              <span className="w-3 text-center font-mono text-[10.5px] shrink-0" style={{ color }} title={word}>{letter}</span>
              <span className="truncate font-mono text-[12px] text-[var(--t-fg2)]">{c.path}</span>
              {c.orig && <span className="shrink-0 font-mono text-[10px] text-[var(--t-dim)]">← {c.orig}</span>}
              <Icon name="chev" size={10} className={cn("ml-auto shrink-0 text-[var(--t-dim)] transition-transform", open && "rotate-90")} />
            </button>
            {open && (
              <pre className="mx-3 mb-2 max-h-[320px] overflow-auto t-scroll rounded-md border border-[var(--t-line)] bg-[var(--t-bg0)] p-2 font-code text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                {diff.text.split("\n").map((ln, i) => (
                  <span key={i} className={cn("block", ln.startsWith("+") && !ln.startsWith("++") ? "text-[var(--t-teal)]" : ln.startsWith("-") && !ln.startsWith("--") ? "text-[var(--t-red)]" : ln.startsWith("@@") ? "text-[var(--t-violet)]" : "text-[var(--t-mute)]")}>{ln}</span>
                ))}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- graph ---------- */

/** color the leading graph glyphs, the commit hash, and (decorations) */
function GraphLine({ line }: { line: string }) {
  const m = line.match(/^([*|\\/_.\s-]+)\s*(?:([0-9a-f]{7,})\s+)?(.*)$/);
  if (!m) return <span className="text-[var(--t-mute)]">{line}</span>;
  const [, glyphs, hash, rest] = m;
  const deco = rest.match(/^(\([^)]*\))\s*(.*)$/);
  return (
    <>
      <span className="text-[var(--t-sky)]">{glyphs} </span>
      {hash && <span className="text-[var(--t-amber)]">{hash} </span>}
      {deco ? (
        <>
          <span className="text-[var(--t-teal)]">{deco[1]} </span>
          <span className="text-[var(--t-fg2)]">{deco[2]}</span>
        </>
      ) : (
        <span className="text-[var(--t-fg2)]">{rest}</span>
      )}
      {"\n"}
    </>
  );
}

/* ---------- branch switcher ---------- */

function BranchSwitcher({ anchor, branches, onPick, onClose }: {
  anchor: HTMLElement;
  branches: GitBranch[];
  onPick: (branch: string, create: boolean) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const now = useNow(30_000);
  const [pos] = useState(() => {
    const r = anchor.getBoundingClientRect();
    return { left: Math.max(8, Math.min(r.left, window.innerWidth - 280)), top: r.bottom + 6 };
  });
  useEffect(() => {
    input.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const list = branches.filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase()));
  const exact = branches.some((b) => b.name === q.trim());
  return createPortal(
    <>
      <div className="fixed inset-0 z-[170]" onPointerDown={onClose} />
      <div role="dialog" aria-label="Switch branch" className="fixed z-[171] w-[272px] rounded-lg border border-[var(--t-line2)] bg-[var(--t-bg2)] shadow-2xl t-pop overflow-hidden" style={pos}>
        <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
          <Icon name="search" size={12} className="text-[var(--t-dim)]" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const target = q.trim() && !exact ? q.trim() : list[0]?.name;
                if (target) onPick(target, q.trim() !== "" && !exact && !list.length);
              }
            }}
            placeholder="find or create a branch…"
            className="flex-1 bg-transparent outline-none text-[12px] font-mono text-[var(--t-fg)] placeholder:text-[var(--t-dim)]"
          />
        </div>
        <div className="max-h-[260px] overflow-y-auto t-scroll py-1">
          {list.map((b) => (
            <button key={b.name} onClick={() => onPick(b.name, false)} className="w-full flex items-center gap-2 px-3 h-8 text-left hover:bg-white/[0.05]">
              <span className={cn("w-3.5 shrink-0", b.current ? "text-[var(--t-teal)]" : "text-transparent")}><Icon name="check" size={11} /></span>
              <span className="flex-1 min-w-0">
                <span className="block truncate font-mono text-[12px] text-[var(--t-fg2)]">{b.name}</span>
                <span className="block truncate text-[10px] text-[var(--t-dim)]">{b.last} · {ago(b.at, now)}</span>
              </span>
            </button>
          ))}
          {q.trim() && !exact && (
            <button onClick={() => onPick(q.trim(), true)} className="w-full flex items-center gap-2 px-3 h-8 text-left hover:bg-white/[0.05] text-[var(--t-amber)]">
              <Icon name="plus" size={11} className="shrink-0" />
              <span className="truncate text-[12px]">Create and switch to <span className="font-mono">{q.trim()}</span></span>
            </button>
          )}
          {list.length === 0 && !q.trim() && <div className="px-3 py-4 text-center text-[11.5px] text-[var(--t-dim)]">No branches.</div>}
        </div>
      </div>
    </>,
    document.body,
  );
}
