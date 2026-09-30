import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, useMemo, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow, capsOf, type Msg, type ToolRun, type Perm, type SessionView } from "@/lib/store";
import { argSummary, fmtMs, harnessStyle, shortPath, baseHarness } from "@/lib/format";
import { deviceLabel } from "@/lib/device";
import { buildModelOptions, modelValue, splitModelValue } from "@/lib/models";
import { planHeaderFit } from "@/lib/headerFit";
import { formatSessionRef } from "@/lib/sessionRef";
import { RAIL_INSET, activeRailIndex, railIndexAtOffset, railMarkTop, railNaturalHeight, turnRailItems } from "@/lib/turnRail";
import { CHAT_WIDTH_DEFAULT, dragChatWidth, readChatWidthPref, resolveChatWidth, writeChatWidthPref } from "@/lib/chatWidth";
import { openPanel, openAgentShell, renameSessionPanels } from "@/lib/workspace";
import { Btn, Empty, HarnessMark, Icon, IconBtn, Select, Spinner, StateDot, STATE_META } from "@/components/ui";
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
          <span className="inline-flex items-center gap-2"><Spinner /> loading history…</span>
        </div>
      ) : view.hydration === "error" ? (
        <div className="flex-1">
          <Empty icon="alert" title="Couldn't load this session's history">
            <span className="font-code text-[11px] text-[var(--t-red)] break-all">{view.hydrationError}</span>
            <div className="mt-3"><Btn variant="outline" icon="retry" onClick={() => store.ensureHydrated(id)}>Retry</Btn></div>
          </Empty>
        </div>
      ) : (
        <ChatWidthProvider timeline={<Timeline id={id} view={view} />} composer={<Composer id={id} />} perms={view ? <PermDock id={id} view={view} /> : null} />
      )}
    </div>
  );
}

/* ---------------- header ---------------- */
function ChatHeader({ id }: { id: string }) {
  const meta = useApp((s) => s.sessions[id]);
  const detail = useApp((s) => s.views[id]?.stateDetail);
  const since = useApp((s) => s.stateSince[id]);
  const caps = useApp((s) => capsOf(s, meta.harness));
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.models);
  const busy = meta.state === "running";
  const now = useNow(1000, busy || meta.state === "spawning");
  const abnormal = meta.state === "spawning" || meta.state === "error" || meta.state === "closed";
  const [menu, setMenu] = useState(false);
  const tooltip = [meta.harness, meta.model, shortPath(meta.cwd), meta.project && `project: ${meta.project}`, detail]
    .filter(Boolean)
    .join("\n");

  /* overflow planning (issue #3): the right cluster must never get clipped
     by the pane edge. The planner (lib/headerFit) collapses rightmost-first
     into the ⋯ menu; Stop and the menu trigger never collapse. Measured:
     header width via ResizeObserver, left cluster via a ref, the title gets
     a 56px reservation (it truncates beyond that). */
  const headerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLSpanElement>(null);
  const [plan, setPlan] = useState<{ visible: string[]; overflow: string[] }>({ visible: ["model", "stop", "trajectory", "more"], overflow: [] });

  /* which device this session runs on: bare harness id = this server,
     harness@hostId = that remote host (labeled from the registry) */
  const hostId = meta.harness.includes("@") ? meta.harness.split("@")[1] : undefined;
  const device = deviceLabel(meta.harness, hosts);

  /* model picker: the catalog lists base harnesses; remote sessions share
     the base harness's catalog */
  const currentValue = modelValue(meta.provider, meta.model);
  const modelOptions = buildModelOptions(models, meta.harness, meta.model, meta.provider);
  const onModelPick = (v: string) => {
    const { provider, model } = splitModelValue(v);
    if (v && v !== currentValue) void store.switchModel(id, model, provider).catch(() => {});
  };

  const hasModel = modelOptions.length > 0;
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const items = [
      ...(hasModel ? [{ id: "model", width: 170 }] : []),
      ...(busy ? [{ id: "stop", width: 58, essential: true }] : []),
      { id: "trajectory", width: 28 },
      { id: "more", width: 28, essential: true },
    ];
    const measure = () => {
      const leftW = leftRef.current?.getBoundingClientRect().width ?? 200;
      const available = el.clientWidth - leftW - 56 /* title reservation */ - 24 /* paddings */;
      setPlan(planHeaderFit(items, Math.max(0, available), { triggerWidth: 28, gap: 6 }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (leftRef.current) ro.observe(leftRef.current);
    measure();
    return () => ro.disconnect();
  }, [hasModel, busy, device, meta.state]);

  return (
    <div ref={headerRef} className="relative shrink-0 flex items-center gap-2 px-3 h-10 border-b border-[var(--t-line)]">
      <span ref={leftRef} className="flex items-center gap-2 shrink-0">
        <HarnessMark harness={meta.harness} size={18} />
        <span
          className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded border border-[var(--t-line)] text-[10px] font-mono text-[var(--t-mute)]"
          title={`session runs on ${device}`}
        >
          <Icon name="host" size={10} className={hostId ? "text-[var(--t-teal)]" : "text-[var(--t-dim)]"} />
          {device}
        </span>
        <span className="flex items-center gap-1.5 shrink-0" title={STATE_META[meta.state]?.hint}>
          <StateDot state={meta.state} size={6} />
          {abnormal && <span className="text-[11px] text-[var(--t-mute)]">{STATE_META[meta.state].label}</span>}
          {(busy || meta.state === "spawning") && since && <span className="text-[11px] text-[var(--t-amber)] tabular-nums">{fmtMs(now - since)}</span>}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--t-fg)]" title={tooltip}>{meta.title}</span>
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        {hasModel && plan.visible.includes("model") && (
          <Select
            value={currentValue}
            options={modelOptions}
            onChange={onModelPick}
            ariaLabel="Switch model"
            className="!h-6 !px-2 !py-0 !text-[11px] font-mono text-[var(--t-mute)] w-[170px] shrink-0"
          />
        )}
        {busy && (
          <Btn variant="danger" size="xs" icon="stop" onClick={() => store.interrupt(id)} title="Interrupt (Esc in composer)">Stop</Btn>
        )}
        {plan.visible.includes("trajectory") && (
          <IconBtn icon="wave" label="Trajectory" onClick={() => openPanel("trajectory", { sessionId: id })} />
        )}
        <IconBtn icon="dots" label="More panels" active={menu} onClick={() => setMenu((m) => !m)} />
      </div>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <div className="absolute right-2 top-[42px] z-50 w-52 rounded-lg bg-[var(--t-bg2)] border border-[var(--t-line2)] shadow-2xl py-1 t-pop">
            {plan.overflow.includes("model") && (
              <div className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                <Select
                  value={currentValue}
                  options={modelOptions}
                  onChange={(v) => { onModelPick(v); }}
                  ariaLabel="Switch model"
                  className="w-full !h-7 !text-[11.5px] font-mono"
                />
              </div>
            )}
            {plan.overflow.includes("trajectory") && (
              <button onClick={() => { setMenu(false); openPanel("trajectory", { sessionId: id }); }} className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-[12.5px] text-[var(--t-fg2)] hover:bg-white/[0.05]">
                <Icon name="wave" size={13} className="text-[var(--t-mute)]" />
                Trajectory
              </button>
            )}
            {plan.overflow.length > 0 && <div className="my-1 border-t border-[var(--t-line)]" />}
            {[
              { icon: "gauge", label: "Context usage", run: () => openPanel("context", { sessionId: id }) },
              ...(caps?.subagents ? [{ icon: "tree", label: "Subagent team", run: () => openPanel("team", { sessionId: id }) }] : []),
              { icon: "spark", label: "Skills", run: () => openPanel("skills", { sessionId: id, cwd: meta.cwd }) },
              { icon: "term", label: "Shell in this cwd", run: () => openAgentShell(id) },
            ].map((it) => (
              <button key={it.label} onClick={() => { setMenu(false); it.run(); }} className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-[12.5px] text-[var(--t-fg2)] hover:bg-white/[0.05]">
                <Icon name={it.icon} size={13} className="text-[var(--t-mute)]" />
                {it.label}
              </button>
            ))}
            <div className="my-1 border-t border-[var(--t-line)]" />
            <button
              onClick={() => {
                const refText = formatSessionRef(meta, hosts);
                void navigator.clipboard.writeText(refText);
                store.toast("ok", "Reference copied", refText);
                setMenu(false);
              }}
              className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-[12.5px] text-[var(--t-fg2)] hover:bg-white/[0.05]"
              title="Copy a one-line reference (id · harness · host · directory) to paste into another chat"
            >
              <Icon name="clip" size={13} className="text-[var(--t-mute)]" />
              Copy reference
            </button>
            <div className="px-3 py-1.5 text-[11px] text-[var(--t-dim)] leading-relaxed break-all">
              <span className="font-mono text-[var(--t-mute)]">{formatSessionRef(meta, hosts)}</span><br />
              {meta.harness}{meta.model && ` · ${meta.model}`}<br />{shortPath(meta.cwd)}
            </div>
          </div>
        </>
      )}
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

  /* the turn rail (issue #7): one mark per user message at the right edge */
  const railItems = useMemo(() => turnRailItems(view.items, view.msgs), [view.items, view.msgs]);
  const [railActive, setRailActive] = useState(-1);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={ref} onScroll={() => { onScroll(); railSpy(ref.current, railItems, setRailActive); }} className="absolute inset-0 overflow-y-auto t-scroll">
        {view.items.length === 0 ? (
          <EmptyChat id={id} />
        ) : (
          <div className="mx-auto px-4 py-5 space-y-4" style={{ maxWidth: useContext(ChatColumnCtx) }}>
            {view.items.map((it) => (
              <div key={it.id} data-iid={it.id}>
                {it.kind === "msg" ? (
                  <MessageView m={view.msgs[it.id]} harness={meta.harness} live={it.id === lastMsgId && meta.state === "running"} />
                ) : it.kind === "tool" ? (
                  <ToolRow t={view.tools[it.id]} callIndex={view.tools[it.id].callId ? view.calls[view.tools[it.id].callId!]?.index : undefined} sessionId={id} />
                ) : (
                  <PermInline p={view.perms[it.id]} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <TurnRail items={railItems} active={railActive} scroller={ref} />
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
  const ideas = ["Summarize this repository's layout", "Create a file named truss-check.txt", "The codeword is marmalade"];
  if (baseHarness(meta.harness) === "claude-code") ideas.splice(1, 0, "Audit the server with a team of agents");
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="max-w-[380px] w-full text-center">
        <HarnessMark harness={meta.harness} size={30} className="mx-auto" />
        <div className="mt-2 text-[13px] text-[var(--t-fg)]">{h.name}</div>
        <div className="mt-4 grid gap-1.5">
          {ideas.map((t) => (
            <button key={t} onClick={() => window.dispatchEvent(new CustomEvent("truss:draft", { detail: { id, text: t } }))} className="px-3 py-1.5 rounded-md text-[12.5px] text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/[0.03]">
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- messages (texting layout: role above content) ---------------- */
const MessageView = memo(function MessageView({ m, harness, live }: { m: Msg; harness: string; live: boolean }) {
  const h = harnessStyle(harness);
  if (m.role === "user") {
    const text = m.segments.map((s) => s.text).join("");
    return (
      <div className="t-in flex flex-col items-end">
        <div className="mb-1 mr-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)]">you</div>
        {/* attachment chips survive reload (msg.start carries the refs) */}
        {!!m.attachments?.length && (
          <div className="mb-1 flex flex-wrap justify-end gap-1 max-w-[85%]">
            {m.attachments.map((a) => (
              <span key={a.path} className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md bg-[var(--t-bg2)] border border-[var(--t-line2)] text-[10px] font-mono text-[var(--t-mute)]" title={`${a.path} · ${a.size} B`}>
                <Icon name="clip" size={9} />
                {a.name}
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[85%] rounded-xl rounded-br-[4px] bg-[var(--t-bg3)] px-3.5 py-2 text-[13.5px] leading-relaxed text-[var(--t-fg)] whitespace-pre-wrap break-words">{text}</div>
      </div>
    );
  }
  if (m.role === "system") {
    return <div className="text-center text-[11.5px] text-[var(--t-dim)] py-1">{m.segments.map((s) => s.text).join("")}</div>;
  }
  const streaming = !m.done && live;
  const err = m.stopReason?.startsWith("error");
  const lastIdx = m.segments.length - 1;
  const name = baseHarness(harness) === "claude-code" ? "claude" : baseHarness(harness);
  return (
    <div className="t-in">
      <div className="mb-1 ml-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: h.color }}>
        <span>{h.glyph}</span>
        <span>{name}</span>
      </div>
      <div className="space-y-2">
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
          <div className={cn("inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded", err ? "text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_10%,transparent)]" : "text-[var(--t-amber)] bg-[color-mix(in_oklab,var(--t-amber)_10%,transparent)]")}>
            <Icon name={err ? "alert" : "stop"} size={11} />
            {err ? m.stopReason : "interrupted"}
          </div>
        )}
      </div>
    </div>
  );
});

function Thinking({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? active;
  return (
    <div className="t-think">
      <button onClick={() => setOpen(!isOpen)} className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-violet)] hover:brightness-125">
        <Icon name="chev" size={10} className={cn("transition-transform", isOpen && "rotate-90")} />
        {active ? <span className="t-shimmer">reasoning</span> : "reasoning"}
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

/* ---------------- tools: quiet single lines, expandable ---------------- */
const ToolRow = memo(function ToolRow({ t, callIndex, sessionId }: { t: ToolRun; callIndex?: number; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const running = t.status === "running";
  const now = useNow(200, running);
  const dur = running ? now - t.startedAt : t.durationMs;
  const color = running ? "var(--t-amber)" : t.status === "ok" ? "var(--t-teal)" : "var(--t-red)";
  return (
    <div className="t-in -my-2">
      <button onClick={() => setOpen(!open)} className="group w-full flex items-center gap-2 h-7 px-1.5 rounded-md text-left hover:bg-white/[0.03]">
        {running ? <Spinner size={11} /> : <Icon name={t.status === "ok" ? "check" : "x"} size={11} className={t.status === "ok" ? "text-[var(--t-dim)]" : "text-[var(--t-red)]"} />}
        <span className="text-[12px] font-code shrink-0" style={{ color: running || t.status === "fail" ? color : "var(--t-mute)" }}>{t.name}</span>
        <span className="min-w-0 truncate text-[11.5px] font-code text-[var(--t-dim)]">{argSummary(t.args)}</span>
        <span className="ml-auto shrink-0 text-[10.5px] tabular-nums" style={{ color: running ? color : "var(--t-dim)" }}>{fmtMs(dur)}</span>
        <Icon name="chev" size={10} className={cn("shrink-0 text-[var(--t-dim)] opacity-0 group-hover:opacity-100 transition-transform", open && "rotate-90 opacity-100")} />
      </button>
      {(open || (running && t.output)) && (
        <div className="mt-1 mb-2 ml-5 rounded-md border border-[var(--t-line)] bg-[var(--t-bg0)]/60 text-[11.5px] font-code overflow-hidden">
          {open && (
            <div className="px-2.5 py-2 border-b border-[var(--t-line)]">
              <div className="flex items-center text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1 font-sans">
                args
                {callIndex !== undefined && (
                  <button
                    onClick={() => openPanel("trajectory", { sessionId })}
                    className="ml-auto normal-case tracking-normal hover:text-[var(--t-sky)]"
                    title="LLM call that issued this tool — open trajectory"
                  >
                    from call #{callIndex} →
                  </button>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-all text-[var(--t-fg2)]">{JSON.stringify(t.args, null, 2)}</pre>
            </div>
          )}
          <div className="px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1 font-sans">output{running && " · streaming"}</div>
            <pre className={cn("whitespace-pre-wrap break-all max-h-56 overflow-auto t-scroll", t.status === "fail" ? "text-[var(--t-red)]" : "text-[var(--t-mute)]")}>{t.output ?? (running ? "…" : "(no output)")}</pre>
          </div>
        </div>
      )}
    </div>
  );
});

function PermInline({ p }: { p: Perm }) {
  const pending = p.choice === undefined;
  const denied = p.choice && /deny|reject|cancel/i.test(p.choice);
  return (
    <div className={cn("-my-2 flex items-center gap-2 text-[11.5px] px-1.5 h-7", pending ? "text-[var(--t-amber)]" : denied ? "text-[var(--t-red)]" : "text-[var(--t-dim)]")}>
      <Icon name="lock" size={11} />
      {pending ? <>permission · <b>{p.tool}</b> — waiting, answer below</> : <>permission · {p.tool} — “{p.choice}”</>}
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
              <div className="w-7 h-7 shrink-0 rounded-md grid place-items-center bg-[var(--t-amber)] text-[#1b1305]"><Icon name="lock" size={14} /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold text-[var(--t-fg)]">Permission required</span>
                  <span className="font-code text-[11px] px-1.5 rounded bg-black/30 text-[var(--t-amber)]">{p.tool}</span>
                </div>
                <div className="mt-1 font-code text-[12px] text-[var(--t-fg2)] break-all">{p.reason}</div>
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
                        {i < 9 && <span className="opacity-50 text-[10px]">{i + 1}</span>}
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
  const [atts, setAtts] = useState<import("@/lib/proto").PromptAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const hasPending = !!pending?.length;
  const running = meta.state === "running";
  const dead = meta.state === "closed" || meta.state === "error";
  const spawning = meta.state === "spawning";
  const queues = !!caps?.queueWhileRunning;
  const blocked = (running && !queues) || spawning || sending || uploading;
  const canSend = (!!text.trim() || atts.length > 0) && !blocked;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setErr(null);
    try {
      await store.prompt(id, text, atts.length ? atts : undefined);
      setText("");
      setAtts([]);
    } catch (e: any) {
      if (e.status === 409 && dead) setErr(`This session can't be resumed — the harness has no stored reference for it. Start a new session in ${shortPath(meta.cwd)}.`);
      else setErr(e.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  const attachFiles = async (files: FileList | File[]) => {
    setErr(null);
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const up = await store.upload(id, f);
        setAtts((a) => [...a, { ...up, mime: f.type || undefined }]);
      }
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  let hint: ReactNode = null;
  let tone: "amber" | "dim" | "red" = "dim";
  if (dead) {
    tone = meta.state === "error" ? "red" : "dim";
    hint = <><Icon name="power" size={12} /> Not running — sending resumes {meta.harness} with its history.</>;
  } else if (spawning) {
    tone = "amber";
    hint = <><Spinner size={11} /> Booting {meta.harness}… {since ? fmtMs(now - since) : ""}{baseHarness(meta.harness) === "dsh" && " (dsh takes 5–10s)"}</>;
  } else if (running && hasPending) {
    tone = "amber";
    hint = <><Icon name="lock" size={12} /> Waiting on your permission decision above.</>;
  } else if (running && queues) {
    hint = <><Icon name="bolt" size={12} /> Messages queue after the current step.</>;
  } else if (running) {
    tone = "amber";
    hint = <><Icon name="lock" size={12} /> {meta.harness} can't take input mid-run — draft is held, or <button className="underline" onClick={() => store.interrupt(id)}>interrupt</button>.</>;
  }

  const columnW = useContext(ChatColumnCtx);
  return (
    <div className="shrink-0 p-3 pt-2">
      <div className="mx-auto" style={{ maxWidth: columnW }}>
      {err && (
        <div className="mb-2 flex items-start gap-2 text-[12px] text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_9%,transparent)] border border-[color-mix(in_oklab,var(--t-red)_25%,transparent)] rounded-md px-2.5 py-1.5">
          <Icon name="alert" size={13} className="mt-0.5" />
          <span className="flex-1 break-words">{err}</span>
          <button onClick={() => setErr(null)} className="opacity-60 hover:opacity-100"><Icon name="x" size={12} /></button>
        </div>
      )}
      {/* attachment chips (uploaded into the workspace, referenced by path) */}
      {atts.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1 px-0.5">
          {atts.map((a) => (
            <span key={a.path} className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md bg-[var(--t-bg2)] border border-[var(--t-line2)] text-[10.5px] font-mono text-[var(--t-fg2)]" title={`${a.path} (${a.size} B)`}>
              <Icon name="clip" size={10} className="text-[var(--t-dim)]" />
              {a.name}
              <button onClick={() => setAtts((x) => x.filter((y) => y.path !== a.path))} className="text-[var(--t-dim)] hover:text-[var(--t-red)]" aria-label={`Remove ${a.name}`}>
                <Icon name="x" size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={cn("flex items-end gap-1.5 rounded-xl border bg-[var(--t-bg0)] transition-colors focus-within:border-[var(--t-mute)] px-2 py-1.5", dead ? "border-dashed border-[var(--t-line2)]" : "border-[var(--t-line2)]")}>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Attach files"
          onChange={(e) => { if (e.target.files?.length) void attachFiles(e.target.files); }}
        />
        <IconBtn icon="clip" label={uploading ? "Uploading…" : "Attach files (they land in .truss-uploads/ in the workspace)"} disabled={uploading || sending} onClick={() => fileRef.current?.click()} className="mb-0.5 shrink-0" />
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
          placeholder={dead ? `Message to resume ${meta.harness}…` : "Message…"}
          className="flex-1 min-w-0 resize-none bg-transparent px-1.5 py-1 text-[13.5px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)] outline-none"
        />
        {running && !queues ? (
          <Btn size="sm" variant="danger" icon="stop" onClick={() => store.interrupt(id)} title="Interrupt (Esc)" className="mb-0.5">Stop</Btn>
        ) : (
          <Btn size="sm" variant={dead ? "outline" : "amber"} icon={dead ? "power" : "send"} disabled={!canSend} onClick={send} className="mb-0.5" title={dead ? "Resume the harness and send" : running ? "Queue after current step" : "Send (Enter)"}>
            {sending ? "…" : dead ? "Resume" : running ? "Queue" : "Send"}
          </Btn>
        )}
      </div>
      {hint && (
        <div className={cn("mt-1.5 px-1 flex items-center gap-1.5 text-[11.5px] leading-tight", tone === "amber" ? "text-[var(--t-amber)]" : tone === "red" ? "text-[var(--t-red)]" : "text-[var(--t-mute)]")}>
          {hint}
        </div>
      )}
      </div>
    </div>
  );
}


/* ---------------- the turn rail (issue #7) ---------------- */

/* scroll-spy: active mark = last user-row top at/above the read line (30%
   down the viewport reads naturally) */
function railSpy(scroller: HTMLDivElement | null, items: { id: string }[], set: (i: number) => void) {
  if (!scroller) return;
  const tops = items.map((it) => {
    const el = scroller.querySelector(`[data-iid="${it.id}"]`);
    return el ? (el as HTMLElement).offsetTop - scroller.clientHeight * 0.3 : 0;
  });
  set(activeRailIndex(tops, scroller.scrollTop));
}

function TurnRail({ items, active, scroller }: { items: { id: string; index: number; preview: string }[]; active: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  if (items.length < 2) return null; // a rail for one turn is noise
  const jumpTo = (i: number) => {
    const el = scroller.current?.querySelector(`[data-iid="${items[i].id}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <div
      className="absolute right-1 top-0 bottom-0 w-4 z-10 select-none"
      style={{ height: "100%" }}
      aria-label="Turn rail"
    >
      <div
        className="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col"
        style={{ height: railNaturalHeight(items.length), maxHeight: "80%" }}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const i = railIndexAtOffset(e.clientY - r.top, items.length);
          if (i >= 0) jumpTo(i);
        }}
      >
        {items.map((it) => (
          <button
            key={it.id}
            onClick={(e) => { e.stopPropagation(); jumpTo(it.index); }}
            title={it.preview || "(empty prompt)"}
            aria-label={`Jump to turn ${it.index + 1}: ${it.preview.slice(0, 40)}`}
            className="group/rail relative block"
            style={{ position: "absolute", top: railMarkTop(it.index) - 3, right: 0, width: 12, height: RAIL_INSET, padding: 0 }}
          >
            <span
              className={cn(
                "block w-1.5 h-1.5 rounded-full transition-colors",
                it.index === active ? "bg-[var(--t-amber)] scale-125" : "bg-[var(--t-line2)] group-hover/rail:bg-[var(--t-mute)]",
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}


/* ---------------- draggable chat column width (issue #6) ---------------- */

/* one width state shared by the timeline and the composer (same axis), with
   hover-revealed drag handles at the panel's side edges */
function ChatWidthProvider({ timeline, composer, perms }: { timeline: ReactNode; composer: ReactNode; perms: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [columnW, setColumnW] = useState(0);
  const [pref, setPref] = useState<number | null>(() => (typeof localStorage !== "undefined" ? readChatWidthPref(localStorage) : null));
  const dragRef = useRef<{ originX: number; base: number; side: "left" | "right" } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setColumnW(el.clientWidth));
    ro.observe(el);
    setColumnW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const width = pref === null ? CHAT_WIDTH_DEFAULT : resolveChatWidth(columnW, pref);

  const onPointerDown = (side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { originX: e.clientX, base: width, side };
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPref(Math.round(dragChatWidth(d.base, d.originX, ev.clientX, d.side)));
    };
    const up = (ev: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (d) {
        const finalW = Math.round(dragChatWidth(d.base, d.originX, ev.clientX, d.side));
        setPref(finalW);
        if (typeof localStorage !== "undefined") writeChatWidthPref(localStorage, finalW);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handleCls = (side: "left" | "right") =>
    cn(
      "absolute top-0 bottom-0 w-2 z-20 cursor-col-resize group/edge",
      side === "left" ? "left-0" : "right-0",
    );
  const gripCls = cn(
    "absolute top-1/2 -translate-y-1/2 w-[3px] h-10 rounded-full transition-colors",
    "bg-[var(--t-line2)] group-hover/edge:bg-[var(--t-amber)]",
    dragging && "bg-[var(--t-amber)]",
  );

  return (
    <div ref={wrapRef} className="relative flex-1 min-h-0 flex flex-col">
      {/* the shared column axis — timeline content and composer align to it */}
      <div className="flex-1 min-h-0 flex flex-col" style={{ ["--t-chatw" as never]: `${width}px` }}>
        <ChatColumnCtx.Provider value={width}>{timeline}{perms}{composer}</ChatColumnCtx.Provider>
      </div>
      {/* edge drag handles */}
      {(["left", "right"] as const).map((side) => (
        <div key={side} className={handleCls(side)} onPointerDown={onPointerDown(side)} title="Drag to resize the chat column" aria-label={`Resize chat column (${side} edge)`} role="separator" aria-orientation="vertical">
          <span className={cn(gripCls, side === "left" ? "left-0.5" : "right-0.5")} />
        </div>
      ))}
    </div>
  );
}

const ChatColumnCtx = createContext<number>(CHAT_WIDTH_DEFAULT);
