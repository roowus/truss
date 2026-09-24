import { memo, useEffect, useLayoutEffect, useRef, useState, useMemo, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow, capsOf, type Msg, type ToolRun, type Perm, type SessionView } from "@/lib/store";
import { argSummary, fmtMs, harnessStyle, shortPath, baseHarness } from "@/lib/format";
import { openPanel, openAgentShell, renameSessionPanels } from "@/lib/workspace";
import { Btn, Empty, HarnessMark, Icon, IconBtn, Kbd, Spinner, StatePill } from "@/components/ui";
import { Markdown } from "./Markdown";
import { cn } from "@/utils/cn";

type P = { sessionId: string };
const drafts = new Map<string, string>();

export function ChatPanel({ params }: IDockviewPanelProps<P>) {
  const id = params.sessionId;
  const meta = useApp((s) => s.sessions[id]);
  const view = useApp((s) => s.views[id]);
  const sessionsLoaded = useApp((s) => s.sessionsLoaded);

  useEffect(() => {
    if (meta) void store.ensureHydrated(id);
  }, [id, !!meta]);
  useEffect(() => {
    if (meta) renameSessionPanels(id, meta.title);
  }, [id, meta?.title]);

  if (!meta)
    return sessionsLoaded ? (
      <Empty icon="chat" title="Session no longer exists">It may have been deleted from another device. Close this tab.</Empty>
    ) : (
      <div className="h-full grid place-items-center"><Spinner /></div>
    );

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <ChatHeader id={id} />
      {!view || view.hydration === "loading" ? (
        <div className="flex-1 grid place-items-center text-[12px] text-[var(--t-mute)]">
          <span className="inline-flex items-center gap-2"><Spinner /> hydrating history…</span>
        </div>
      ) : view.hydration === "error" ? (
        <div className="flex-1">
          <Empty icon="alert" title="Couldn't load this session's history">
            <span className="font-mono text-[11px] text-[var(--t-red)] break-all">{view.hydrationError}</span>
            <div className="mt-3"><Btn variant="outline" icon="retry" onClick={() => store.ensureHydrated(id)}>Retry</Btn></div>
          </Empty>
        </div>
      ) : (
        <Timeline id={id} view={view} />
      )}
      {view && view.hydration === "ready" && <PermDock id={id} view={view} />}
      <Composer id={id} />
    </div>
  );
}

/* ---------------- header ---------------- */
function ChatHeader({ id }: { id: string }) {
  const meta = useApp((s) => s.sessions[id]);
  const detail = useApp((s) => s.views[id]?.stateDetail);
  const since = useApp((s) => s.stateSince[id]);
  const caps = useApp((s) => capsOf(s, meta.harness));
  const busy = meta.state === "running";
  const now = useNow(1000, busy || meta.state === "spawning");
  const h = harnessStyle(meta.harness);
  return (
    <div className="shrink-0 flex items-center gap-2.5 px-3 h-11 border-b border-[var(--t-line)]">
      <HarnessMark harness={meta.harness} size={22} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[13px] font-medium text-[var(--t-fg)]">{meta.title}</span>
          <StatePill state={meta.state} detail={detail} />
          {(busy || meta.state === "spawning") && since && <span className="font-mono text-[10.5px] text-[var(--t-amber)] tabular-nums">{fmtMs(now - since)}</span>}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--t-dim)] font-mono truncate">
          <span style={{ color: h.color }}>{meta.harness}</span>
          {meta.model && <><span>·</span><span className="truncate">{meta.model}</span></>}
          <span>·</span>
          <span className="truncate" title={meta.cwd}>{shortPath(meta.cwd)}</span>
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <IconBtn icon="wave" label="Trajectory" onClick={() => openPanel("trajectory", { sessionId: id })} />
        <IconBtn icon="gauge" label="Context usage" onClick={() => openPanel("context", { sessionId: id })} />
        {caps?.subagents && <IconBtn icon="tree" label="Subagent team" onClick={() => openPanel("team", { sessionId: id })} />}
        <IconBtn icon="spark" label="Skills" onClick={() => openPanel("skills", { sessionId: id, cwd: meta.cwd })} />
        <IconBtn icon="term" label="Shell in this session's cwd" onClick={() => openAgentShell(id)} />
        {busy && (
          <Btn variant="danger" size="xs" icon="stop" className="ml-1" onClick={() => store.interrupt(id)} title="Interrupt (Esc in composer)">
            Stop
          </Btn>
        )}
      </div>
    </div>
  );
}

/* ---------------- timeline ---------------- */
function Timeline({ id, view }: { id: string; view: SessionView }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const meta = useApp((s) => s.sessions[id]);

  const onScroll = () => {
    const el = ref.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = atBottom;
    if (atBottom && showJump) setShowJump(false);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
  }, [view]);

  const lastMsgId = useMemo(() => {
    for (let i = view.items.length - 1; i >= 0; i--) if (view.items[i].kind === "msg") return view.items[i].id;
  }, [view.items]);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={ref} onScroll={onScroll} className="absolute inset-0 overflow-y-auto t-scroll">
        {view.items.length === 0 ? (
          <EmptyChat id={id} />
        ) : (
          <div className="max-w-[860px] mx-auto px-4 py-4 space-y-3">
            {view.items.map((it) =>
              it.kind === "msg" ? (
                <MessageView key={it.id} m={view.msgs[it.id]} harness={meta.harness} live={it.id === lastMsgId && meta.state === "running"} />
              ) : it.kind === "tool" ? (
                <ToolRow key={it.id} t={view.tools[it.id]} callIndex={view.tools[it.id].callId ? view.calls[view.tools[it.id].callId!]?.index : undefined} sessionId={id} />
              ) : (
                <PermInline key={it.id} p={view.perms[it.id]} />
              ),
            )}
          </div>
        )}
      </div>
      {showJump && (
        <button
          onClick={() => {
            stick.current = true;
            ref.current!.scrollTop = ref.current!.scrollHeight;
            setShowJump(false);
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-[var(--t-bg3)] border border-[var(--t-line2)] text-[11.5px] text-[var(--t-fg)] shadow-lg hover:border-[var(--t-amber)]"
        >
          <Icon name="down" size={12} /> new output
        </button>
      )}
    </div>
  );
}

function EmptyChat({ id }: { id: string }) {
  const meta = useApp((s) => s.sessions[id]);
  const h = harnessStyle(meta.harness);
  const ideas = ["Summarize this repository's layout", "Find where the event bus is wired and explain it", "Create a file named truss-check.txt", "The codeword is marmalade"];
  if (baseHarness(meta.harness) === "claude-code") ideas.splice(1, 0, "Audit the server with a team of agents");
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="max-w-[420px] w-full">
        <div className="flex items-center gap-3 mb-3">
          <HarnessMark harness={meta.harness} size={32} />
          <div>
            <div className="text-[14px] text-[var(--t-fg)] font-medium">{h.name}</div>
            <div className="text-[11.5px] text-[var(--t-mute)]">{h.blurb}</div>
          </div>
        </div>
        <div className="grid gap-1.5">
          {ideas.map((t) => (
            <button key={t} onClick={() => window.dispatchEvent(new CustomEvent("truss:draft", { detail: { id, text: t } }))} className="text-left px-3 py-2 rounded-md border border-[var(--t-line)] hover:border-[var(--t-line2)] hover:bg-white/[0.02] text-[12.5px] text-[var(--t-mute)] hover:text-[var(--t-fg)]">
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- messages ---------------- */
const MessageView = memo(function MessageView({ m, harness, live }: { m: Msg; harness: string; live: boolean }) {
  const h = harnessStyle(harness);
  if (m.role === "user") {
    const text = m.segments.map((s) => s.text).join("");
    return (
      <div className="flex gap-3 t-in">
        <div className="w-14 shrink-0 pt-2 text-right font-mono text-[10.5px] uppercase tracking-wider text-[var(--t-dim)]">you</div>
        <div className="flex-1 min-w-0 rounded-lg bg-[var(--t-bg2)] border border-[var(--t-line)] px-3.5 py-2.5 text-[13.5px] text-[var(--t-fg)] whitespace-pre-wrap break-words">{text}</div>
      </div>
    );
  }
  if (m.role === "system") {
    return <div className="text-center text-[11.5px] font-mono text-[var(--t-dim)] py-1">{m.segments.map((s) => s.text).join("")}</div>;
  }
  const streaming = !m.done && live;
  const err = m.stopReason?.startsWith("error");
  const lastIdx = m.segments.length - 1;
  return (
    <div className="flex gap-3 t-in">
      <div className="w-14 shrink-0 pt-1 flex justify-end">
        <span className="font-mono text-[10.5px] uppercase tracking-wider pt-1" style={{ color: h.color }}>{h.glyph} {baseHarness(harness) === "claude-code" ? "claude" : baseHarness(harness)}</span>
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {m.segments.length === 0 && streaming && <div className="h-6 flex items-center"><span className="t-caret" /></div>}
        {m.segments.map((seg, i) =>
          seg.channel === "thinking" ? (
            <Thinking key={i} text={seg.text} active={streaming && i === lastIdx} />
          ) : (
            <div key={i} className="text-[13.5px] leading-[1.65] text-[var(--t-fg2)]">
              <Markdown text={seg.text} />
              {streaming && i === lastIdx && <span className="t-caret" />}
            </div>
          ),
        )}
        {(err || m.stopReason === "interrupted") && (
          <div className={cn("inline-flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded", err ? "text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_10%,transparent)]" : "text-[var(--t-amber)] bg-[color-mix(in_oklab,var(--t-amber)_10%,transparent)]")}>
            <Icon name={err ? "alert" : "stop"} size={11} />
            {err ? m.stopReason : "interrupted by user"}
          </div>
        )}
      </div>
    </div>
  );
});

function Thinking({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? active;
  const words = text.trim().split(/\s+/).length;
  return (
    <div className="t-think">
      <button onClick={() => setOpen(!isOpen)} className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[var(--t-violet)] hover:brightness-125">
        <Icon name="chev" size={11} className={cn("transition-transform", isOpen && "rotate-90")} />
        <Icon name="brain" size={12} />
        {active ? <span className="t-shimmer">reasoning</span> : "reasoning"}
        <span className="normal-case tracking-normal text-[var(--t-dim)]">· {words} words</span>
      </button>
      {isOpen ? (
        <div className="mt-1.5 text-[12.5px] leading-[1.6] italic text-[var(--t-think)] whitespace-pre-wrap">
          {text}
          {active && <span className="t-caret t-caret-v" />}
        </div>
      ) : (
        <div className="mt-0.5 text-[12px] italic text-[var(--t-dim)] truncate">{text.slice(-140)}</div>
      )}
    </div>
  );
}

/* ---------------- tools ---------------- */
const ToolRow = memo(function ToolRow({ t, callIndex, sessionId }: { t: ToolRun; callIndex?: number; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const running = t.status === "running";
  const now = useNow(200, running);
  const dur = running ? now - t.startedAt : t.durationMs;
  const color = running ? "var(--t-amber)" : t.status === "ok" ? "var(--t-teal)" : "var(--t-red)";
  return (
    <div className="flex gap-3 t-in">
      <div className="w-14 shrink-0" />
      <div className={cn("flex-1 min-w-0 rounded-md border bg-[var(--t-bg0)]/60 overflow-hidden", running ? "border-[color-mix(in_oklab,var(--t-amber)_35%,var(--t-line))]" : "border-[var(--t-line)]")}>
        <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-2.5 h-8 text-left hover:bg-white/[0.02]">
          {running ? <Spinner size={12} /> : <Icon name={t.status === "ok" ? "check" : "x"} size={12} className="" />}
          <span className="font-mono text-[12px] font-medium" style={{ color }}>{t.name}</span>
          <span className="flex-1 min-w-0 truncate font-mono text-[11.5px] text-[var(--t-mute)]">{argSummary(t.args)}</span>
          {callIndex !== undefined && (
            <span
              role="link"
              onClick={(e) => {
                e.stopPropagation();
                openPanel("trajectory", { sessionId });
              }}
              className="font-mono text-[10px] text-[var(--t-dim)] hover:text-[var(--t-sky)] px-1 rounded border border-[var(--t-line)]"
              title="LLM call that issued this tool — open trajectory"
            >
              call #{callIndex}
            </span>
          )}
          <span className="font-mono text-[11px] tabular-nums w-14 text-right" style={{ color: running ? color : "var(--t-dim)" }}>{fmtMs(dur)}</span>
          <Icon name="chev" size={11} className={cn("text-[var(--t-dim)] transition-transform", open && "rotate-90")} />
        </button>
        {(open || (running && t.output)) && (
          <div className="border-t border-[var(--t-line)] text-[11.5px] font-mono">
            {open && (
              <div className="px-2.5 py-2 border-b border-[var(--t-line)]">
                <div className="text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1">args</div>
                <pre className="whitespace-pre-wrap break-all text-[var(--t-fg2)]">{JSON.stringify(t.args, null, 2)}</pre>
              </div>
            )}
            <div className="px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1">output{running && " · streaming"}</div>
              <pre className={cn("whitespace-pre-wrap break-all max-h-56 overflow-auto t-scroll", t.status === "fail" ? "text-[var(--t-red)]" : "text-[var(--t-mute)]")}>{t.output ?? (running ? "…" : "(no output)")}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

function PermInline({ p }: { p: Perm }) {
  const pending = p.choice === undefined;
  const denied = p.choice && /deny|reject|cancel/i.test(p.choice);
  return (
    <div className="flex gap-3">
      <div className="w-14 shrink-0" />
      <div className={cn("flex-1 flex items-center gap-2 text-[11.5px] font-mono px-2.5 h-7 rounded-md", pending ? "text-[var(--t-amber)] bg-[color-mix(in_oklab,var(--t-amber)_8%,transparent)] t-pulse-soft" : denied ? "text-[var(--t-red)]" : "text-[var(--t-teal)]")}>
        <Icon name="lock" size={12} />
        {pending ? (
          <>permission · <b>{p.tool}</b> — turn blocked, answer below ↓</>
        ) : (
          <>permission · <b>{p.tool}</b> — answered “{p.choice}”</>
        )}
      </div>
    </div>
  );
}

/* ---------------- permission dock (pinned, prominent) ---------------- */
function PermDock({ id, view }: { id: string; view: SessionView }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!view.pending.length) return null;
  return (
    <div className="shrink-0 px-3 pt-2 space-y-2">
      {view.pending.map((rid) => {
        const p = view.perms[rid];
        if (!p) return null;
        return (
          <div key={rid} className="t-perm rounded-lg p-3">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 shrink-0 rounded-md grid place-items-center bg-[var(--t-amber)] text-[#1b1305]"><Icon name="lock" size={16} /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold text-[var(--t-fg)]">Permission required</span>
                  <span className="font-mono text-[11px] px-1.5 rounded bg-black/30 text-[var(--t-amber)]">{p.tool}</span>
                  <span className="text-[11px] text-[var(--t-mute)]">· the turn is paused until you answer</span>
                </div>
                <div className="mt-1 font-mono text-[12px] text-[var(--t-fg2)] break-all">{p.reason}</div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {p.options.map((o, i) => {
                    const deny = /deny|reject|no/i.test(o);
                    return (
                      <Btn
                        key={o}
                        size="sm"
                        variant={deny ? "danger" : i === 0 ? "amber" : "outline"}
                        disabled={busy === rid}
                        onClick={async () => {
                          setBusy(rid);
                          await store.answer(id, rid, o);
                          setBusy(null);
                        }}
                      >
                        {o}
                        {i < 9 && <span className="opacity-50 font-mono text-[10px]">{i + 1}</span>}
                      </Btn>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- composer ---------------- */
function Composer({ id }: { id: string }) {
  const meta = useApp((s) => s.sessions[id]);
  const caps = useApp((s) => capsOf(s, meta.harness));
  const pending = useApp((s) => s.views[id]?.pending);
  const since = useApp((s) => s.stateSince[id]);
  const [text, setText] = useState(drafts.get(id) ?? "");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const now = useNow(1000, meta.state === "spawning");

  useEffect(() => {
    drafts.set(id, text);
  }, [id, text]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.id === id) {
        setText(d.text);
        ta.current?.focus();
      }
    };
    window.addEventListener("truss:draft", on);
    return () => window.removeEventListener("truss:draft", on);
  }, [id]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(220, el.scrollHeight) + "px";
  }, [text]);

  // Number keys answer the first pending permission when composer is empty
  const hasPending = !!pending?.length;

  const running = meta.state === "running";
  const dead = meta.state === "closed" || meta.state === "error";
  const spawning = meta.state === "spawning";
  const queues = !!caps?.queueWhileRunning;
  const blocked = (running && !queues) || spawning || sending;
  const canSend = !!text.trim() && !blocked;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setErr(null);
    const t = text;
    try {
      await store.prompt(id, t);
      setText("");
    } catch (e: any) {
      if (e.status === 409 && dead) setErr(`This session can't be resumed — the harness has no stored reference for it. Start a new session in ${shortPath(meta.cwd)}.`);
      else setErr(e.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  let hint: ReactNode = null;
  let tone: "amber" | "dim" | "red" = "dim";
  if (dead) {
    tone = meta.state === "error" ? "red" : "dim";
    hint = <><Icon name="power" size={12} /> Process not running. Sending will <b className="text-[var(--t-fg)]">resume {meta.harness}</b> with its stored history.</>;
  } else if (spawning) {
    tone = "amber";
    hint = <><Spinner size={11} /> Booting {meta.harness}… {since ? fmtMs(now - since) : ""}{baseHarness(meta.harness) === "dsh" && " — dsh's plugin stack usually takes 5–10s"}. Your draft is held.</>;
  } else if (running && hasPending) {
    tone = "amber";
    hint = <><Icon name="lock" size={12} /> Waiting on your permission decision above.</>;
  } else if (running && queues) {
    tone = "dim";
    hint = <><Icon name="bolt" size={12} /> {meta.harness} accepts input mid-run — your message queues after the current step.</>;
  } else if (running) {
    tone = "amber";
    hint = <><Icon name="lock" size={12} /> {meta.harness} doesn't accept input mid-run. Draft is held — send when the turn ends, or <button className="underline" onClick={() => store.interrupt(id)}>interrupt</button>.</>;
  }

  return (
    <div className="shrink-0 p-3 pt-2">
      {err && (
        <div className="mb-2 flex items-start gap-2 text-[12px] text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_9%,transparent)] border border-[color-mix(in_oklab,var(--t-red)_25%,transparent)] rounded-md px-2.5 py-1.5">
          <Icon name="alert" size={13} className="mt-0.5" />
          <span className="flex-1 break-words">{err}</span>
          <button onClick={() => setErr(null)} className="opacity-60 hover:opacity-100"><Icon name="x" size={12} /></button>
        </div>
      )}
      <div className={cn("rounded-lg border bg-[var(--t-bg0)] transition-colors focus-within:border-[var(--t-mute)]", dead ? "border-dashed border-[var(--t-line2)]" : "border-[var(--t-line2)]")}>
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            } else if (e.key === "Escape" && running) {
              e.preventDefault();
              void store.interrupt(id);
            } else if (hasPending && !text && /^[1-9]$/.test(e.key)) {
              const v = store.state.views[id];
              const p = v?.perms[v.pending[0]];
              const opt = p?.options[+e.key - 1];
              if (p && opt) {
                e.preventDefault();
                void store.answer(id, p.requestId, opt);
              }
            }
          }}
          rows={1}
          placeholder={dead ? `Message to resume ${meta.harness}…` : `Message ${meta.harness}…`}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13.5px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)] outline-none"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <div className={cn("flex-1 min-w-0 flex items-center gap-1.5 text-[11.5px] leading-tight", tone === "amber" ? "text-[var(--t-amber)]" : tone === "red" ? "text-[var(--t-red)]" : "text-[var(--t-mute)]")}>
            {hint ?? (
              <span className="text-[var(--t-dim)] inline-flex items-center gap-1.5">
                <Kbd>↵</Kbd> send <Kbd>⇧↵</Kbd> newline
              </span>
            )}
          </div>
          {running && (
            <Btn size="sm" variant="danger" icon="stop" onClick={() => store.interrupt(id)} title="Interrupt (Esc)">
              Interrupt
            </Btn>
          )}
          {(!running || queues) && (
            <Btn size="sm" variant={dead ? "outline" : "amber"} icon={dead ? "power" : "send"} disabled={!canSend} onClick={send}>
              {sending ? "Sending…" : dead ? "Resume & send" : running ? "Queue" : "Send"}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
