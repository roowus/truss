import { useEffect, useMemo, useState } from "react";
import { store, useApp } from "@/lib/store";
import { harnessStyle, hostOf, shortPath } from "@/lib/format";
import { openPanel } from "@/lib/workspace";
import { Btn, HarnessMark, Icon, Kbd, Spinner } from "./ui";
import { cn } from "@/utils/cn";

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const harnesses = useApp((s) => s.harnesses);
  const models = useApp((s) => s.models);
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const recentCwds = useMemo(() => [...new Set(order.map((i) => sessions[i]?.cwd).filter(Boolean))].slice(0, 8), [order, sessions]);
  const projects = useMemo(() => [...new Set(order.map((i) => sessions[i]?.project).filter(Boolean) as string[])], [order, sessions]);

  const [harness, setHarness] = useState<string>(harnesses[0]?.id ?? "");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState(recentCwds[0] ?? "");
  const [project, setProject] = useState(sessions[order[0]]?.project ?? "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!harness && harnesses[0]) setHarness(harnesses[0].id);
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
      openPanel("chat", { sessionId: s.id });
      onClose();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
                          <div className="text-[12.5px] text-[var(--t-fg)] font-medium truncate">{st.name}{host && <span className="text-[var(--t-sky)] font-mono text-[10.5px]"> @{host}</span>}</div>
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
            <select value={model} onChange={(e) => setModel(e.target.value)} className="t-input">
              <option value="">harness default</option>
              {hModels.map((m) => (
                <option key={m.provider + m.model} value={`${m.provider}/${m.model}`}>{m.label} — {m.provider}/{m.model}</option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-[1fr_180px] gap-3">
            <Field label="working directory" error={cwdErr}>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} list="cwd-list" placeholder="/home/you/code/project" className="t-input font-mono" autoFocus />
              <datalist id="cwd-list">{recentCwds.map((c) => <option key={c} value={c}>{shortPath(c)}</option>)}</datalist>
            </Field>
            <Field label="project (optional)">
              <input value={project} onChange={(e) => setProject(e.target.value)} list="proj-list" placeholder="none" className="t-input" />
              <datalist id="proj-list">{projects.map((p) => <option key={p} value={p} />)}</datalist>
            </Field>
          </div>
          {recentCwds.length > 0 && (
            <div className="-mt-3 flex flex-wrap gap-1">
              {recentCwds.slice(0, 5).map((c) => (
                <button key={c} onClick={() => setCwd(c)} className={cn("font-mono text-[10.5px] px-1.5 h-5 rounded border", cwd === c ? "border-[var(--t-line2)] text-[var(--t-fg)] bg-[var(--t-bg2)]" : "border-[var(--t-line)] text-[var(--t-dim)] hover:text-[var(--t-mute)]")}>
                  {shortPath(c)}
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
