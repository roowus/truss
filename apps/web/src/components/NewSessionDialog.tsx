import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { store, useApp } from "@/lib/store";
import { useDesktops } from "@/lib/desktops";
import { harnessStyle, hostOf, shortPath } from "@/lib/format";
import { hostAliases, hostDisplay } from "@/lib/device";
import { resolveDefaultCwd, hostDefaultFor, hostSuggestedFor } from "@/lib/cwdDefault";
import { createBrowseNav, type BrowseNav } from "@/lib/browseNav";
import { createPortal } from "react-dom";
import type { BrowseDir } from "@/lib/proto";
import { openPanel, openSession } from "@/lib/workspace";
import { Btn, HarnessMark, Icon, Kbd, Select, Spinner } from "./ui";
import { cn } from "@/utils/cn";

export interface NewSessionPreset {
  harness?: string;
  cwd?: string;
  project?: string;
  spaceId?: string;
  groupId?: string;
}

export function NewSessionDialog({ onClose, preset }: { onClose: () => void; preset?: NewSessionPreset }) {
  const harnesses = useApp((s) => s.harnesses);
  const models = useApp((s) => s.models);
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const hosts = useApp((s) => s.hosts);
  const defaultCwd = useDesktops((s) => s.settings.defaultCwd);
  const hostPrefs = useDesktops((s) => s.hosts);
  const aliases = useMemo(() => hostAliases(hostPrefs), [hostPrefs]);
  const recentCwds = useMemo(() => [...new Set(order.map((i) => sessions[i]?.cwd).filter(Boolean))].slice(0, 8), [order, sessions]);
  const projects = useMemo(() => [...new Set(order.map((i) => sessions[i]?.project).filter(Boolean) as string[])], [order, sessions]);

  const [harness, setHarness] = useState<string>(preset?.harness ?? harnesses[0]?.id ?? "");
  const [model, setModel] = useState("");
  const [cwd, setCwdState] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const cwdFieldRef = useRef<HTMLDivElement>(null);
  const [project, setProject] = useState(preset?.project ?? sessions[order[0]]?.project ?? "");

  /* The default working directory follows the named precedence
     (preset > picked host's pref > host's own suggestion > Settings >
     most recent — issue #123 added the remote's hello-announced suggestion
     between the pref and this machine's defaults) and re-resolves as the
     harness pick, host prefs, and settings load — until the user types or
     picks a directory themselves, which marks the field as theirs.

     Recency is SNAPSHOT on open (first non-empty read): the store bumps a
     live session to order[0] on every session.state event, so a live
     `recentCwds` dep would flip the field under the user's eyes whenever
     background sessions change state (audit round 1, B1). */
  const cwdTouched = useRef(false);
  const recentSnapshot = useRef<string | undefined>(undefined);
  if (recentSnapshot.current === undefined && recentCwds[0]) recentSnapshot.current = recentCwds[0];
  const setCwd = (v: string) => {
    cwdTouched.current = true;
    setCwdState(v);
  };
  useEffect(() => {
    if (cwdTouched.current) return;
    const next = resolveDefaultCwd({
      preset: preset?.cwd,
      hostDefault: hostDefaultFor(harness, hostPrefs, hosts),
      hostSuggested: hostSuggestedFor(harness, hosts),
      settingsDefault: defaultCwd,
      recent: recentSnapshot.current,
    });
    setCwdState((cur) => (cur === next ? cur : next));
  }, [harness, preset?.cwd, defaultCwd, hostPrefs, hosts]);

  /* browsing runs on THIS truss server; a remote host's fs is unreachable
     here, so the picker stays local-only and the host default prefill does
     the work for remote picks (issue #106, stretch deferred) */
  const remoteHost = hostOf(harness);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!harness && harnesses[0]) setHarness(harnesses[0].id);
  }, [harnesses]);

  /* fallback for the boot-time probe (store.init probes as soon as the
     harness list lands, so the picker is normally filled before the dialog
     ever opens). A dialog can still see an empty probeable catalog when the
     boot fetch failed or a harness registered later — ask once per open; the
     predicate lives in the store. Repeats stay cheap: the local lazy
     catalogs cool down for 30s (model-catalog-cache), and a remote
     adapter's probe is one bounded tunnel ask (5s timeout, issue #123). */
  const probedRef = useRef(false);
  useEffect(() => {
    if (probedRef.current || !harnesses.length) return;
    probedRef.current = true;
    void store.probeEmptyCatalogs();
  }, [harnesses]);

  const hModels = models.filter((m) => m.harness === harness);
  useEffect(() => setModel(hModels[0] ? `${hModels[0].provider}/${hModels[0].model}` : ""), [harness, models.length]);

  const cwdErr = cwd && !cwd.startsWith("/") && !cwd.startsWith("~") ? "use an absolute path" : null;
  const create = async () => {
    if (!harness || !cwd.trim() || cwdErr) return;
    setBusy(true);
    setErr(null);
    const m = hModels.find((x) => `${x.provider}/${x.model}` === model);
    try {
      const s = await store.createSession({
        harness,
        cwd: (() => {
          const c = cwd.trim();
          const home = recentCwds.map((x) => x.match(/^\/(home|Users)\/[^/]+/)?.[0]).find(Boolean);
          return c.startsWith("~") && home ? home + c.slice(1) : c;
        })(),
        ...(m ? { model: m.model, provider: m.provider } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(project.trim() ? { project: project.trim() } : {}),
      });
      if (preset?.groupId) openPanel("chat", { sessionId: s.id, groupId: preset.groupId, spaceId: preset.spaceId });
      else openSession(s.id);
      onClose();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pickerOpen) setPickerOpen(false);
        else onClose();
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const selCaps = harnesses.find((h) => h.id === harness)?.capabilities;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center p-4 bg-black/60 backdrop-blur-[2px] t-fade" onMouseDown={onClose}>
      <div className="w-full max-w-[620px] max-h-[92vh] overflow-auto t-scroll rounded-xl bg-[var(--t-bg1)] border border-[var(--t-line2)] shadow-2xl t-pop" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="New session">
        <div className="flex items-center gap-2 px-5 h-12 border-b border-[var(--t-line)]">
          <Icon name="plus" size={14} className="text-[var(--t-amber)]" />
          <span className="text-[13.5px] font-medium text-[var(--t-fg)]">New session</span>
          <button onClick={onClose} className="ml-auto text-[var(--t-dim)] hover:text-[var(--t-fg)]"><Icon name="x" size={14} /></button>
        </div>

        <div className="p-5 space-y-5">
          <Field label="harness">
            {harnesses.length === 0 ? (
              <div className="text-[12px] text-[var(--t-red)] flex items-center gap-2">
                <Icon name="alert" size={12} /> No harnesses available — /api/harnesses failed or returned none.
                <button className="underline" onClick={() => store.be.harnesses().then((r) => store.set({ harnesses: r.harnesses, models: r.models })).catch((e) => setErr(e.message))}>retry</button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {harnesses.map((h) => {
                  const st = harnessStyle(h.id);
                  const host = hostOf(h.id);
                  const sel = harness === h.id;
                  return (
                    <button
                      key={h.id}
                      onClick={() => setHarness(h.id)}
                      className={cn("text-left rounded-lg border px-3 py-2.5 transition-colors", sel ? "bg-[var(--t-bg2)]" : "border-[var(--t-line)] hover:border-[var(--t-line2)]")}
                      style={sel ? { borderColor: st.color, boxShadow: `0 0 0 3px color-mix(in oklab, ${st.color} 14%, transparent)` } : undefined}
                    >
                      <div className="flex items-center gap-2">
                        <HarnessMark harness={h.id} size={22} />
                        <div className="min-w-0">
                          <div className="text-[12.5px] text-[var(--t-fg)] font-medium truncate">{st.name}{host && <span className="text-[var(--t-sky)] font-mono text-[10.5px]"> @{hostDisplay(host, hosts, aliases)}</span>}</div>
                          <div className="font-mono text-[10.5px] text-[var(--t-dim)]">{h.id}</div>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Cap on={h.capabilities.permissions}>permissions</Cap>
                        <Cap on={h.capabilities.subagents}>subagents</Cap>
                        <Cap on={h.capabilities.queueWhileRunning}>mid-run input</Cap>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
          {selCaps && harness.startsWith("dsh") && (
            <div className="-mt-3 text-[11px] text-[var(--t-amber)] flex items-center gap-1.5"><Icon name="alert" size={11} /> First dsh boot takes 5–10s while its plugin stack loads.</div>
          )}

          <Field label="model">
            <Select
              value={model}
              onChange={setModel}
              ariaLabel="Model"
              className="w-full"
              options={[
                { value: "", label: "harness default" },
                ...hModels.map((m) => ({
                  value: `${m.provider}/${m.model}`,
                  label: m.label,
                  hint: `${m.provider}/${m.model}`,
                })),
              ]}
            />
          </Field>

          <div className="grid grid-cols-[1fr_180px] gap-3">
            <Field label="working directory" error={cwdErr}>
              <div ref={cwdFieldRef}>
                <div className="flex gap-1.5">
                  <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/you/code/project" className="t-input font-mono flex-1" autoFocus />
                  <button
                    type="button"
                    onClick={() => setPickerOpen((o) => !o)}
                    disabled={!!remoteHost}
                    title={remoteHost ? "Browsing runs on this server; a remote host's default directory is prefilled instead" : "Browse directories"}
                    aria-label="Browse directories"
                    className={cn(
                      "shrink-0 w-8 rounded-md border grid place-items-center transition-colors",
                      pickerOpen ? "border-[var(--t-amber)]/60 text-[var(--t-amber)] bg-[color-mix(in_oklab,var(--t-amber)_10%,transparent)]" : "border-[var(--t-line)] text-[var(--t-dim)] hover:text-[var(--t-fg)] hover:border-[var(--t-line2)]",
                      remoteHost && "opacity-40 cursor-not-allowed",
                    )}
                  >
                    <Icon name="folder" size={14} />
                  </button>
                </div>
                {pickerOpen && !remoteHost && (
                  <DirPicker
                    anchorRef={cwdFieldRef}
                    onPick={(p) => {
                      setCwd(p);
                      setPickerOpen(false);
                    }}
                    onClose={() => setPickerOpen(false)}
                  />
                )}
              </div>
            </Field>
            <Field label="project (optional)">
              <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="none" className="t-input" />
            </Field>
          </div>
          {remoteHost && (
            <div className="-mt-3 text-[11px] text-[var(--t-dim)] flex items-center gap-1.5">
              <Icon name="host" size={11} /> Directory browsing runs on this server. For @{remoteHost}, the host's own suggested directory is prefilled above (a Hosts panel default, when set, still wins).
            </div>
          )}
          {recentCwds.length > 0 && (
            <div className="-mt-3 flex flex-wrap gap-1">
              {recentCwds.slice(0, 5).map((c) => (
                <button key={c} onClick={() => setCwd(c)} className={cn("font-mono text-[10.5px] px-1.5 h-5 rounded border", cwd === c ? "border-[var(--t-line2)] text-[var(--t-fg)] bg-[var(--t-bg2)]" : "border-[var(--t-line)] text-[var(--t-dim)] hover:text-[var(--t-mute)]")}>
                  {shortPath(c)}
                </button>
              ))}
            </div>
          )}
          {projects.length > 0 && (
            <div className="-mt-3 flex flex-wrap gap-1 items-center">
              <span className="text-[10px] text-[var(--t-dim)] uppercase tracking-wider mr-0.5">projects:</span>
              {projects.map((p) => (
                <button key={p} onClick={() => setProject(project === p ? "" : p)} className={cn("font-mono text-[10.5px] px-1.5 h-5 rounded border", project === p ? "border-[var(--t-amber)]/50 text-[var(--t-amber)] bg-[color-mix(in_oklab,var(--t-amber)_10%,transparent)]" : "border-[var(--t-line)] text-[var(--t-dim)] hover:text-[var(--t-mute)]")}>
                  {p}
                </button>
              ))}
            </div>
          )}

          <Field label="title (optional)">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="auto-named from your first prompt" className="t-input" />
          </Field>

          {err && (
            <div className="flex items-start gap-2 text-[12px] text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_9%,transparent)] border border-[color-mix(in_oklab,var(--t-red)_25%,transparent)] rounded-md px-3 py-2">
              <Icon name="alert" size={13} className="mt-0.5" /><span className="break-words">{err}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 h-14 border-t border-[var(--t-line)]">
          <span className="text-[11px] text-[var(--t-dim)] flex items-center gap-1"><Kbd>⌘</Kbd><Kbd>↵</Kbd> create · <Kbd>Esc</Kbd> cancel</span>
          <Btn variant="ghost" className="ml-auto" onClick={onClose}>Cancel</Btn>
          <Btn variant="amber" size="md" disabled={busy || !harness || !cwd.trim() || !!cwdErr} onClick={create}>
            {busy ? <><Spinner size={12} color="#1b1305" /> Spawning…</> : <>Spawn {harness || "session"}</>}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-center mb-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)]">
        {label}
        {error && <span className="ml-auto normal-case tracking-normal text-[var(--t-red)]">{error}</span>}
      </div>
      {children}
    </label>
  );
}

function Cap({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("font-mono text-[9.5px] px-1.5 h-4 inline-flex items-center rounded", on ? "text-[var(--t-teal)] bg-[color-mix(in_oklab,var(--t-teal)_12%,transparent)]" : "text-[var(--t-dim)] line-through decoration-[var(--t-line2)]")}>
      {children}
    </span>
  );
}

/** The cwd picker's directory browser (issue #106): click to navigate, a
   breadcrumb and up-button to climb, a hidden-dirs toggle, and "choose this
   folder" to take the current directory. The server lists directory NAMES
   only, confined to its browse roots. `path` null means the roots view.

   The dropdown portals to <body> and anchors itself under the cwd field:
   rendered inside the dialog it was clipped by the dialog's 92vh scroll
   box, and every listing swap (rows → spinner → rows) changed the dialog's
   scrollable extent and yanked the user's view back to the top (developer
   feedback on PR #138). As an overlay it neither scrolls with nor resizes
   the dialog. */
function DirPicker({ anchorRef, onPick, onClose }: { anchorRef: { current: HTMLDivElement | null }; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [dirs, setDirs] = useState<BrowseDir[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* Scroll memory (issue #136): before this, every navigation re-rendered a
     fresh listing and the scroll container reset — climbing back out of a
     subfolder landed at the TOP of the parent. The nav machine remembers
     each visited directory's scrollTop; `go` records the outgoing
     directory's position before switching, and the effect below restores
     the incoming one's once its rows have rendered. One instance per picker
     mount: reopening the picker may start fresh (the issue allows it). */
  const navRef = useRef<BrowseNav | null>(null);
  if (!navRef.current) navRef.current = createBrowseNav();
  const nav = navRef.current;
  const listRef = useRef<HTMLDivElement>(null);
  /* the directory whose remembered scroll is waiting to be applied —
     undefined means "nothing to restore" (a hidden-toggle refetch must not
     yank the list back to a stale position). `loadedFor` records which
     directory the current rows belong to: the fetch is async, so a
     restore may only fire once the listing for the target has actually
     committed — applying it on the navigation commit itself would hit the
     PREVIOUS directory's rows and then be wiped when the spinner collapses
     the container (audit round 1, B1) */
  const pendingRestore = useRef<string | null | undefined>(undefined);
  const loadedFor = useRef<string | null | undefined>(undefined);
  const go = (next: string | null, via: "enter" | "climb") => {
    if (next === path) return; // re-clicking the current crumb stays put
    nav.rememberScroll(path, listRef.current?.scrollTop ?? 0);
    pendingRestore.current = next;
    if (via === "enter" && next !== null) nav.enter(next);
    else nav.climbTo(next);
    setPath(next);
  };

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr(null);
    store.be
      .browse(path ?? undefined, hidden)
      .then((r) => {
        if (!alive) return;
        if (r.roots) setRoots(r.roots);
        setDirs(r.dirs ?? []);
        setParent(r.parent ?? null);
        loadedFor.current = path;
      })
      .catch((e: any) => {
        if (alive) setErr(e?.message ?? String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [path, hidden]);

  /* the listing is either the root list or the current path's subdirs */
  const rows: BrowseDir[] = path === null ? roots.map((r) => ({ name: r, path: r })) : dirs;

  /* Apply the pending scroll restore only once the rows on screen ARE the
     destination's (loadedFor === target), in a layout effect so the list
     never paints at the top first. Runs after every commit; the guard makes
     it a no-op unless a navigation is waiting AND its listing has landed. */
  useLayoutEffect(() => {
    if (pendingRestore.current === undefined || busy || err) return;
    if (loadedFor.current !== pendingRestore.current) return;
    const target = pendingRestore.current;
    pendingRestore.current = undefined;
    if (listRef.current) listRef.current.scrollTop = nav.scrollMemory(target);
  });

  const crumbs = useMemo(() => {
    if (path === null) return [];
    const root = [...roots].filter((r) => path === r || path.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0];
    const home = roots[0];
    const out: { label: string; path: string }[] = [];
    let cur = root ?? "";
    if (root) out.push({ label: root === home ? "~" : root, path: root });
    for (const seg of path.slice(cur.length).split("/").filter(Boolean)) {
      cur += "/" + seg;
      out.push({ label: seg, path: cur });
    }
    return out;
  }, [path, roots]);

  /* anchor the overlay under the cwd field; follow any scroll (the dialog
     itself can scroll on short viewports — capture phase, scroll doesn't
     bubble) or resize. Flip above the field when the window has no room
     below: the dropdown is ~300px at its tallest (header 36 + list 224 +
     footer 40). */
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r || r.width === 0) return;
      const base = { left: r.left, width: r.width };
      setAnchor(
        window.innerHeight - r.bottom >= 304
          ? { ...base, top: r.bottom + 4 }
          : /* flip above; clamp so the dropdown never dips past the
               viewport's bottom edge when the field itself is scrolled
               out of view */
            { ...base, bottom: Math.max(4, window.innerHeight - r.top + 4) },
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  if (!anchor) return null;
  return createPortal(
    <div
      className="fixed z-[110] rounded-lg border border-[var(--t-line2)] bg-[var(--t-bg1)] shadow-xl t-pop"
      style={{ left: anchor.left, width: anchor.width, ...(anchor.top !== undefined ? { top: anchor.top } : { bottom: anchor.bottom }) }}
      /* portal events bubble through the REACT tree: without this the
         dialog's backdrop onMouseDown would treat clicks inside the
         dropdown as outside clicks and close the whole dialog */
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 px-2 h-9 border-b border-[var(--t-line)]">
        <button
          type="button"
          onClick={() => go(parent, "climb")}
          disabled={parent === null}
          title="Up"
          aria-label="Up one directory"
          className="w-6 h-6 grid place-items-center rounded text-[var(--t-dim)] hover:text-[var(--t-fg)] disabled:opacity-30 disabled:hover:text-[var(--t-dim)]"
        >
          <Icon name="chev" size={12} className="-rotate-90" />
        </button>
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto t-scroll whitespace-nowrap font-mono text-[11px] text-[var(--t-dim)]">
          <button type="button" onClick={() => go(null, "climb")} className={cn("hover:text-[var(--t-fg)]", path === null && "text-[var(--t-fg)]")}>
            roots
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              <Icon name="chev" size={9} className="opacity-50" />
              <button type="button" onClick={() => go(c.path, "climb")} className={cn("hover:text-[var(--t-fg)]", i === crumbs.length - 1 && "text-[var(--t-fg)]")}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setHidden((h) => !h)}
          title="Show hidden directories"
          className={cn("font-mono text-[10px] px-1.5 h-5 rounded border shrink-0", hidden ? "border-[var(--t-line2)] text-[var(--t-fg)] bg-[var(--t-bg2)]" : "border-[var(--t-line)] text-[var(--t-dim)] hover:text-[var(--t-mute)]")}
        >
          .*
        </button>
        <button type="button" onClick={onClose} aria-label="Close browser" className="w-6 h-6 grid place-items-center rounded text-[var(--t-dim)] hover:text-[var(--t-fg)] shrink-0">
          <Icon name="x" size={12} />
        </button>
      </div>

      <div ref={listRef} className="max-h-56 overflow-auto t-scroll py-1">
        {busy ? (
          <div className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-[var(--t-dim)]">
            <Spinner size={11} /> Listing…
          </div>
        ) : err ? (
          <div className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-[var(--t-red)]">
            <Icon name="alert" size={12} /> {err}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-2 text-[11.5px] text-[var(--t-dim)]">No subdirectories here.</div>
        ) : (
          rows.map((d) => (
            <button
              key={d.path}
              type="button"
              onClick={() => go(d.path, "enter")}
              className="w-full flex items-center gap-2 px-3 h-7 text-left font-mono text-[11.5px] text-[var(--t-fg)] hover:bg-[var(--t-bg2)]"
            >
              <Icon name="folder" size={12} className="text-[var(--t-dim)]" />
              <span className="truncate">{d.name}</span>
            </button>
          ))
        )}
      </div>

      <div className="flex items-center gap-2 px-2 h-10 border-t border-[var(--t-line)]">
        <span className="flex-1 font-mono text-[10.5px] text-[var(--t-dim)] truncate">{path ?? "pick a folder, then choose it"}</span>
        <Btn variant="amber" size="sm" disabled={path === null} onClick={() => path !== null && onPick(path)}>
          Choose this folder
        </Btn>
      </div>
    </div>,
    document.body,
  );
}
