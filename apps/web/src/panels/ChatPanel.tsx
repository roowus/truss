import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useMemo, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow, capsOf, type Msg, type ToolRun, type Perm, type SessionView } from "@/lib/store";
import { argSummary, fmtMs, fmtTakeTime, harnessStyle, shortPath, baseHarness, deadSessionHint } from "@/lib/format";
import { deviceLabel, harnessDisplay, hostAliases } from "@/lib/device";
import { useDesktops } from "@/lib/desktops";
import { buildModelOptions, modelSelectOptions, modelValue, splitModelValue } from "@/lib/models";
import { planHeaderFit, HEADER_CLUSTER, HEADER_GAP } from "@/lib/headerFit";
import { CHAT_WIDTH_DEFAULT, chatHandleGeometry, commitChatWidth, dragDisplayWidth, readChatWidthPref, resolveChatWidth, writeChatWidthPref } from "@/lib/chatWidth";
import { filesFromTransfer, isFileDrag } from "@/lib/attach";
import { composerAlign, composerTextareaHeight } from "@/lib/composerFit";
import { composerActions } from "@/lib/composerActions";
import { formatSessionRef } from "@/lib/sessionRef";
import { resumeCommand } from "@/lib/resumeCommand";
import { RAIL_INSET, activeRailIndex, railIndexAtOffset, railMarkTop, railNaturalHeight, turnRailItems } from "@/lib/turnRail";
import { createBrowserVoiceInput, appendTranscript, type BrowserVoiceController } from "@/lib/voice";
import type { VoiceState } from "@/lib/voiceInput";
import { openPanel, openAgentShell, renameSessionPanels } from "@/lib/workspace";
import { Btn, Empty, HarnessMark, Icon, IconBtn, Select, Spinner, StateDot, STATE_META } from "@/components/ui";
import { VoiceVisualizer } from "@/components/VoiceVisualizer";
import { Markdown } from "./Markdown";
import { cn } from "@/utils/cn";

type P = { sessionId: string };
const drafts = new Map<string, string>();

export function ChatPanel({ params, api }: IDockviewPanelProps<P>) {
  const id = params.sessionId;
  const meta = useApp((s) => s.sessions[id]);
  const view = useApp((s) => s.views[id]);
  const sessionsLoaded = useApp((s) => s.sessionsLoaded);

  /* dockview keeps inactive panels' React state alive (portals), so a
     composer error banner would otherwise survive tab switches forever */
  const [active, setActive] = useState(api.isActive);
  useEffect(() => {
    const d = api.onDidActiveChange(() => setActive(api.isActive));
    return () => d.dispose();
  }, [api]);

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
        <ChatWidthProvider timeline={<Timeline id={id} view={view} />} composer={<Composer id={id} active={active} />} perms={view ? <PermDock id={id} view={view} /> : null} />
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
  const busy = meta.state === "running";
  const now = useNow(1000, busy || meta.state === "spawning");
  const abnormal = meta.state === "spawning" || meta.state === "error" || meta.state === "closed";
  const [menu, setMenu] = useState(false);
  const hostPrefs = useDesktops((s) => s.hosts);
  const aliases = hostAliases(hostPrefs);
  const harnessName = harnessDisplay(meta.harness, hosts, aliases);
  const tooltip = [harnessName, meta.model, shortPath(meta.cwd), meta.project && `project: ${meta.project}`, detail]
    .filter(Boolean)
    .join("\n");

  /* overflow planning (issue #3): the right cluster must never get clipped
     by the pane edge. The planner (lib/headerFit) collapses rightmost-first
     into the ⋯ menu; the menu trigger never collapses. (Stop planned here
     until issue #179 moved the interrupt into the composer — Send becomes
     Stop while running, so the header no longer carries one.) Measured:
     header width via ResizeObserver, left cluster via a ref (the device chip
     caps at 8rem, so a long remote label cannot inflate the measurement),
     the title gets a 56px reservation (it truncates beyond that). */
  const headerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLSpanElement>(null);
  const [plan, setPlan] = useState<{ visible: string[]; overflow: string[] }>({ visible: ["trajectory", "context", "team", "skills", "shell", "more"], overflow: [] });

  /* which device this session runs on: bare harness id = this server,
     harness@hostId = that remote host (the user's alias wins, then the
     registry label — same rule as every other surface, so the chip never
     disagrees with its own tooltip) */
  const hostId = meta.harness.includes("@") ? meta.harness.split("@")[1] : undefined;
  const device = deviceLabel(meta.harness, hosts, aliases);

  /* the harness-native resume hint (issue #131): the visible id is truss's;
     the harness's own CLI wants its harness_ref — surfaced here, copyable,
     with the host named when the session runs remotely */
  const resumeCmd = resumeCommand(meta.harness, meta.harness_ref);
  const resumeBase = baseHarness(meta.harness);

  /* the model picker left the header in issue #143 — it lives in the
     composer bar now, so nothing here plans or renders for it */
  /* layout effect, not effect: the first measure must land before the first
     paint — the optimistic initial plan names every member visible, so a
     post-paint measure would flash an overflowing row on narrow panels
     (audit round 3, B1) */
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    /* the team shortcut only when the harness runs subagents (issue #145:
       the panel shortcuts are cluster members now) */
    const items = HEADER_CLUSTER.filter((it) => it.id !== "team" || !!caps?.subagents);
    const measure = () => {
      const leftW = leftRef.current?.getBoundingClientRect().width ?? 200;
      const available = el.clientWidth - leftW - 56 /* title reservation */ - 24 /* paddings */;
      /* triggerWidth 0: the ⋯ trigger is priced once, as the essential `more`
         item — it is rendered on every plan, so collapsing adds nothing to
         the row for it to reserve */
      setPlan(planHeaderFit(items, Math.max(0, available), { triggerWidth: 0, gap: HEADER_GAP }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (leftRef.current) ro.observe(leftRef.current);
    measure();
    return () => ro.disconnect();
  }, [busy, device, meta.state, caps?.subagents]);

  return (
    <div ref={headerRef} className="relative shrink-0 flex items-center gap-2 px-3 h-10 border-b border-[var(--t-line)]">
      <span ref={leftRef} className="flex items-center gap-2 shrink-0">
        <HarnessMark harness={meta.harness} size={18} />
        <span
          className="shrink-0 min-w-0 max-w-[8rem] inline-flex items-center gap-1 h-5 px-1.5 rounded border border-[var(--t-line)] text-[10px] font-mono text-[var(--t-mute)]"
          title={`session runs on ${device}`}
        >
          <Icon name="host" size={10} className={hostId ? "text-[var(--t-teal)]" : "text-[var(--t-dim)]"} />
          <span className="min-w-0 truncate">{device}</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0" title={STATE_META[meta.state]?.hint}>
          <StateDot state={meta.state} size={6} />
          {abnormal && <span className="text-[11px] text-[var(--t-mute)]">{STATE_META[meta.state].label}</span>}
          {(busy || meta.state === "spawning") && since && <span className="text-[11px] text-[var(--t-amber)] tabular-nums">{fmtMs(now - since)}</span>}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--t-fg)]" title={tooltip}>{meta.title}</span>
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        {plan.visible.includes("trajectory") && (
          <IconBtn icon="wave" label="Trajectory" onClick={() => openPanel("trajectory", { sessionId: id })} />
        )}
        {/* the panel shortcuts inline (issue #145); whatever the planner
            collapses reappears inside the ⋯ menu below */}
        {plan.visible.includes("context") && (
          <IconBtn icon="gauge" label="Context usage" onClick={() => openPanel("context", { sessionId: id })} />
        )}
        {/* double-gated like the model select was: the initial plan names
            team visible, so without the capability check it would flash for
            one paint on harnesses that never run subagents */}
        {!!caps?.subagents && plan.visible.includes("team") && (
          <IconBtn icon="tree" label="Subagent team" onClick={() => openPanel("team", { sessionId: id })} />
        )}
        {plan.visible.includes("skills") && (
          <IconBtn icon="spark" label="Skills" onClick={() => openPanel("skills", { sessionId: id, cwd: meta.cwd })} />
        )}
        {plan.visible.includes("shell") && (
          <IconBtn icon="term" label="Shell in this cwd" onClick={() => openAgentShell(id)} />
        )}
        {/* the trigger renders unconditionally: its menu always carries the
            utility block (copy reference, resume, the id dump), so it is
            never the empty dead-weight button issue #145 guards against.
            planHeaderFit still reports needsMore — if the utilities ever
            move out, gate this on it. */}
        <IconBtn icon="dots" label="More panels" active={menu} onClick={() => setMenu((m) => !m)} />
      </div>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <div className="absolute right-2 top-[42px] z-50 w-64 rounded-lg bg-[var(--t-bg2)] border border-[var(--t-line2)] shadow-2xl py-1 t-pop">
            {plan.overflow.includes("trajectory") && (
              <button onClick={() => { setMenu(false); openPanel("trajectory", { sessionId: id }); }} className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-[12.5px] text-[var(--t-fg2)] hover:bg-white/[0.05]">
                <Icon name="wave" size={13} className="text-[var(--t-mute)]" />
                Trajectory
              </button>
            )}
            {/* the collapsed shortcuts rejoin their overflowed siblings
                here (issue #145) — each is inline whenever the planner
                keeps it visible */}
            {[
              ...(plan.overflow.includes("context") ? [{ icon: "gauge", label: "Context usage", run: () => openPanel("context", { sessionId: id }) }] : []),
              ...(plan.overflow.includes("team") ? [{ icon: "tree", label: "Subagent team", run: () => openPanel("team", { sessionId: id }) }] : []),
              ...(plan.overflow.includes("skills") ? [{ icon: "spark", label: "Skills", run: () => openPanel("skills", { sessionId: id, cwd: meta.cwd }) }] : []),
              ...(plan.overflow.includes("shell") ? [{ icon: "term", label: "Shell in this cwd", run: () => openAgentShell(id) }] : []),
            ].map((it) => (
              <button key={it.label} onClick={() => { setMenu(false); it.run(); }} className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-[12.5px] text-[var(--t-fg2)] hover:bg-white/[0.05]">
                <Icon name={it.icon} size={13} className="text-[var(--t-mute)]" />
                {it.label}
              </button>
            ))}
            {plan.overflow.length > 0 && <div className="my-1 border-t border-[var(--t-line)]" />}
            {/* the utility block — always present, which is why the ⋯
                trigger renders unconditionally: the menu is never the empty
                button issue #145 calls dead weight (developer call: option
                A on the issue) */}
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
            {resumeCmd && (
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(resumeCmd);
                  store.toast("ok", "Resume command copied", resumeCmd);
                  setMenu(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-[12.5px] text-[var(--t-fg2)] hover:bg-white/[0.05]"
                title={`Copy the command that resumes this session in ${resumeBase}'s own CLI — run it on ${hostId ? device : "this server"}`}
              >
                <Icon name="term" size={13} className="text-[var(--t-mute)]" />
                Resume in {resumeBase}'s CLI{hostId ? ` on ${device}` : ""}
              </button>
            )}
            <div className="px-3 py-1.5 text-[11px] leading-relaxed">
              {/* the all-ids dump, displayed: every id we hold, labeled, full
                  cwd — labels mirror issue #132's PROPOSED dump format; its
                  copyable half ("Copy full details") is #132's own to land */}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 font-mono">
                <dt className="text-[var(--t-dim)]">truss</dt>
                <dd className="text-[var(--t-mute)] break-all">{meta.id}</dd>
                {meta.harness_ref && (
                  <>
                    <dt className="text-[var(--t-dim)]">{resumeBase} session</dt>
                    <dd className="text-[var(--t-mute)] break-all">{meta.harness_ref}</dd>
                  </>
                )}
                {hostId && (
                  <>
                    <dt className="text-[var(--t-dim)]">host</dt>
                    <dd className="text-[var(--t-mute)] break-all">{hostId}</dd>
                  </>
                )}
                <dt className="text-[var(--t-dim)]">cwd</dt>
                <dd className="text-[var(--t-mute)] break-all">{meta.cwd}</dd>
                {resumeCmd && (
                  <>
                    <dt className="text-[var(--t-dim)]">resume</dt>
                    <dd className="text-[var(--t-mute)] break-all">{resumeCmd}</dd>
                  </>
                )}
              </dl>
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

  /* the shared chat column width (issue #6) — hooks stay top-level, never
     inside the JSX ternary below */
  const columnW = useContext(ChatColumnCtx);
  /* the turn rail (issue #7): one mark per user message at the right edge */
  const railItems = useMemo(() => turnRailItems(view.items, view.msgs), [view.items, view.msgs]);
  const [railActive, setRailActive] = useState(-1);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={ref} onScroll={() => { onScroll(); railSpy(ref.current, railItems, setRailActive); }} className="absolute inset-0 overflow-y-auto t-scroll">
        {view.items.length === 0 ? (
          <EmptyChat id={id} />
        ) : (
          <div className="mx-auto px-4 py-5 space-y-4" style={{ maxWidth: columnW }}>
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
function Composer({ id, active }: { id: string; active: boolean }) {
  const meta = useApp((s) => s.sessions[id]);
  const caps = useApp((s) => capsOf(s, meta.harness));
  const hosts = useApp((s) => s.hosts);
  const models = useApp((s) => s.models);
  const hostPrefs = useDesktops((s) => s.hosts);
  const aliases = hostAliases(hostPrefs);
  const harnessName = harnessDisplay(meta.harness, hosts, aliases);
  const pending = useApp((s) => s.views[id]?.pending);
  const since = useApp((s) => s.stateSince[id]);
  const [text, setText] = useState(drafts.get(id) ?? "");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /* an error banner belongs to the attempt that failed: switching away from
     this tab dismisses it (dockview keeps the component's state alive) */
  useEffect(() => {
    if (!active) setErr(null);
  }, [active]);
  const [atts, setAtts] = useState<import("@/lib/proto").PromptAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const now = useNow(1000, meta.state === "spawning");

  /* voice dictation (issue #15): the controller lives across renders and its
     only output is the draft — sending stays the user's click */
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const voiceRef = useRef<BrowserVoiceController | null>(null);
  const voice = () =>
    (voiceRef.current ??= createBrowserVoiceInput({
      onText: (t) => {
        setText((cur) => appendTranscript(cur, t));
        ta.current?.focus();
      },
      onState: setVoiceState,
    }));
  useEffect(() => () => voiceRef.current?.cancel(), []); // drop a live take when the panel unmounts
  /* the take's start wall-time, for the 0:07-style clock in the chip */
  const [voiceStart, setVoiceStart] = useState<number | null>(null);
  useEffect(() => {
    setVoiceStart(voiceState === "recording" ? Date.now() : null);
  }, [voiceState]);
  const voiceNow = useNow(500, voiceStart !== null);
  /* stable getter for the visualizer (issue #112): the stream appears once
     the mic grant lands, so the component polls rather than subscribes */
  const voiceLevelStream = useCallback(() => voiceRef.current?.levelStream() ?? null, []);

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
  /* composer autosize (issue #139): measure collapsed, then apply the total
     height directly — the textarea is border-box (Tailwind preflight), so
     scrollHeight's padding is counted exactly once. The line count drives
     the row alignment: one line → centered (placeholder and buttons share
     the row), more → buttons sink to the bottom. */
  const [taLines, setTaLines] = useState(1);
  const measureTa = useCallback(() => {
    const el = ta.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20.25; // 13.5px * 1.5
    const verticalPadding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = "0px";
    const total = composerTextareaHeight({ scrollHeight: el.scrollHeight, lineHeight, verticalPadding, cap: 220 });
    el.style.height = total + "px";
    setTaLines((n) => {
      const next = Math.max(1, Math.round((total - verticalPadding) / lineHeight));
      return next === n ? n : next;
    });
  }, []);
  useLayoutEffect(measureTa, [text, measureTa]);
  /* a rewrap without a text change (window resize, chat-width drag) must
     re-measure too; the width guard keeps our own height writes from
     re-entering the observer */
  useEffect(() => {
    const el = ta.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      measureTa();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureTa]);
  const taAlignEnd = composerAlign(taLines) === "end";

  /* model picker (issue #143): it lives in the composer bar — the control
     you touch while writing a message. The catalog lists base harnesses;
     remote sessions share the base harness's catalog. It is deliberately
     NOT chained to the input lock below: the lock is about text mid-run,
     and switching the model is not text input. */
  const currentValue = modelValue(meta.provider, meta.model);
  const modelOptions = buildModelOptions(models, meta.harness, meta.model, meta.provider);
  const onModelPick = (v: string) => {
    const { provider, model } = splitModelValue(v);
    if (v && v !== currentValue) void store.switchModel(id, model, provider).catch(() => {});
  };
  const hasModel = modelOptions.length > 0;

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

  const onMic = () => {
    const v = voice();
    if (voiceState === "recording") void v.stop();
    else if (voiceState === "transcribing") v.cancel();
    else v.start();
  };
  const voiceTitle =
    voiceState === "recording" ? "Stop dictation · the transcript lands in the draft · Esc cancels" :
    voiceState === "transcribing" ? "Transcribing… click to cancel" :
    voiceState === "error" ? `Dictation failed: ${voiceRef.current?.error() ?? "unknown error"}` :
    "Dictate into the draft (Esc cancels a take)";

  let hint: ReactNode = null;
  let tone: "amber" | "dim" | "red" = "dim";
  if (dead) {
    tone = meta.state === "error" ? "red" : "dim";
    /* one message, not two: while the error banner carries the actual
       failure, the generic "sending resumes it" hint must not sit under it
       saying the opposite */
    const deadHint = deadSessionHint(dead, !!err, harnessName);
    if (deadHint) hint = <><Icon name="power" size={12} /> {deadHint}</>;
  } else if (spawning) {
    tone = "amber";
    hint = <><Spinner size={11} /> Booting {harnessName}… {since ? fmtMs(now - since) : ""}{baseHarness(meta.harness) === "dsh" && " (dsh takes 5–10s)"}</>;
  } else if (running && hasPending) {
    tone = "amber";
    hint = <><Icon name="lock" size={12} /> Waiting on your permission decision above.</>;
  } else if (running && queues) {
    hint = <><Icon name="bolt" size={12} /> Messages queue after the current step.</>;
  } else if (running) {
    tone = "amber";
    hint = <><Icon name="lock" size={12} /> {harnessName} can't take input mid-run — draft is held, or hit Stop.</>;
  }
  /* an active voice take no longer touches the hint line (review feedback:
     the hint pushed the composer bar up) — the recording state lives
     entirely in the bar: mic button pulses, the overlay carries the clock,
     the waveform, and the Esc affordance */
  if (voiceState === "error") {
    tone = "red";
    hint = <><Icon name="alert" size={12} /> Dictation failed: {voiceRef.current?.error() ?? "unknown error"}</>;
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
      <div
        className={cn("flex items-end gap-1.5 rounded-xl border bg-[var(--t-bg0)] transition-colors focus-within:border-[var(--t-mute)] px-2 py-1.5", !taAlignEnd && "items-center", dead ? "border-dashed border-[var(--t-line2)]" : "border-[var(--t-line2)]")}
        onDragOver={(e) => {
          if (isFileDrag(e.dataTransfer)) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = filesFromTransfer(e.dataTransfer);
          if (files.length) {
            e.preventDefault();
            void attachFiles(files);
          }
        }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Attach files"
          onChange={(e) => { if (e.target.files?.length) void attachFiles(e.target.files); }}
        />
        <IconBtn icon="clip" label={uploading ? "Uploading…" : "Attach files (they land in .truss-uploads/ in the workspace)"} disabled={uploading || sending} onClick={() => fileRef.current?.click()} className={cn("shrink-0", taAlignEnd && "mb-0.5")} />
        <button
          onClick={onMic}
          title={voiceTitle}
          aria-label={voiceTitle}
          className={cn(
            "shrink-0 inline-grid place-items-center w-7 h-7 rounded-md transition-colors",
            taAlignEnd && "mb-0.5",
            voiceState === "idle" && "text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/[0.06]",
            voiceState === "recording" && "text-[var(--t-amber)] bg-[color-mix(in_oklab,var(--t-amber)_12%,transparent)] t-pulse",
            voiceState === "transcribing" && "text-[var(--t-amber)]",
            voiceState === "error" && "text-[var(--t-red)] hover:bg-white/[0.06]",
          )}
        >
          {voiceState === "transcribing" ? <Spinner size={13} /> : <Icon name="mic" />}
        </button>
        <div className="relative flex-1 min-w-0 flex items-end">
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = filesFromTransfer(e.clipboardData);
            if (files.length) {
              e.preventDefault();
              void attachFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            } else if (e.key === "Escape" && (voiceState === "recording" || voiceState === "transcribing")) {
              e.preventDefault();
              voice().cancel();
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
          placeholder={dead ? `Message to resume ${harnessName}…` : "Message…"}
          className="flex-1 min-w-0 resize-none bg-transparent px-1.5 py-1 text-[13.5px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)] outline-none"
        />
        {/* while a take runs, the chat bar IS the recorder (iMessage /
            Voice Memos style): the waveform fills the input's width over
            the draft, with the take clock at its left. The overlay is
            pointer-events-none — purely decorative — so clicks still land
            on the textarea underneath: it stays focused/focusable, Esc
            still cancels the take, Enter still sends, and the draft is one
            stop away. The bars appear once the mic grant lands; if no
            stream can be had, the clock alone shows the take is alive. */}
        {voiceState === "recording" && (
          <div className="pointer-events-none absolute inset-0 flex items-center gap-2 px-1.5 rounded-sm bg-[var(--t-bg0)] text-[var(--t-amber)] overflow-hidden">
            <span className="shrink-0 text-[11.5px] tabular-nums">{fmtTakeTime(voiceNow - (voiceStart ?? voiceNow))}</span>
            <VoiceVisualizer levelStream={voiceLevelStream} className="flex min-w-0 flex-1 items-center gap-[2px] h-5 overflow-hidden" />
            {/* the Esc affordance lives in the bar itself — no hint line
                below, so the composer never shifts when a take starts */}
            <span className="shrink-0 text-[10px] text-[var(--t-dim)]">Esc to cancel</span>
          </div>
        )}
        </div>
        {hasModel && (
          /* right side of the row, next to send — the control you touch
             while writing a message, like the chat apps issue #143 points
             at. w-auto is load-bearing: the .t-input component width is
             100% and would otherwise fill the row. Stays enabled while the
             draft is locked mid-run — model switching is not text input. */
          <Select
            value={currentValue}
            /* name primary, provider as the secondary line, full path on
               hover — the raw routing path never shows (issue #169) */
            options={modelSelectOptions(modelOptions)}
            onChange={onModelPick}
            ariaLabel="Switch model"
            className={cn("!h-7 !px-2 !py-0 !text-[11px] font-mono text-[var(--t-mute)] w-auto max-w-[160px] shrink-0", taAlignEnd && "mb-0.5")}
          />
        )}
        <ComposerButtons running={running} queues={queues} dead={dead} sending={sending} canSend={canSend} alignEnd={taAlignEnd} onSend={() => void send()} onInterrupt={() => store.interrupt(id)} />
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

/* ---------------- the composer's action buttons (issue #179) ---------------- */

/* Stop belongs in the composer: while the session runs, Send becomes Stop;
   queue-capable harnesses keep Queue as the primary with Stop beside it, so
   the interrupt is never stranded; a dead session resumes (wake-and-send).
   The buttons come straight from composerActions — the header carries no
   Stop of its own, and Esc still interrupts from the textarea. */
function ComposerButtons({ running, queues, dead, sending, canSend, alignEnd, onSend, onInterrupt }: {
  running: boolean;
  queues: boolean;
  dead: boolean;
  sending: boolean;
  canSend: boolean;
  alignEnd: boolean;
  onSend: () => void;
  onInterrupt: () => void;
}) {
  const acts = composerActions({ running, queues, dead, sending });
  const stopBtn = (
    <Btn size="sm" variant="danger" icon="stop" onClick={onInterrupt} title="Interrupt (Esc)" className={cn(alignEnd && "mb-0.5")}>Stop</Btn>
  );
  if (acts.primary === "stop") return stopBtn;
  return (
    <>
      {/* Stop sits left of the primary so Send/Queue/Resume never moves
          from the row's end slot */}
      {acts.stop && stopBtn}
      <Btn size="sm" variant={acts.primary === "resume" ? "outline" : "amber"} icon={acts.primary === "resume" ? "power" : "send"} disabled={!canSend} onClick={onSend} className={cn(alignEnd && "mb-0.5")} title={acts.primary === "resume" ? "Resume the harness and send" : acts.primary === "queue" ? "Queue after current step" : "Send (Enter)"}>
        {sending ? "…" : acts.primary === "resume" ? "Resume" : acts.primary === "queue" ? "Queue" : "Send"}
      </Btn>
    </>
  );
}


/* ---------------- draggable chat column width (issue #6) ---------------- */

/* one width state shared by the timeline and the composer (same axis), with
   hover-revealed drag handles riding the chat column's edges */
function ChatWidthProvider({ timeline, composer, perms }: { timeline: ReactNode; composer: ReactNode; perms: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [columnW, setColumnW] = useState(0);
  const [pref, setPref] = useState<number | null>(() => (typeof localStorage !== "undefined" ? readChatWidthPref(localStorage) : null));
  const dragRef = useRef<{ originX: number; base: number; side: "left" | "right"; startPref: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);

  /* layout effect: the initial measure lands before first paint, so a stored
     pref doesn't flash CHAT_WIDTH_MIN for a frame (columnW starts at 0) */
  useLayoutEffect(() => {
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
    /* capture keeps pointerup/cancel flowing even when the pointer leaves the
       window; without it an off-window release sticks the drag and leaks the
       listeners (the buttons===0 self-heal in move is the fallback) */
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    /* drag from the DISPLAYED width — never the stored pref, which the clamp
       can hide (a wide-monitor pref under a narrow window): drags from the
       pref commit with zero visual change and erode the stored value. A drag
       the clamp refuses is a no-op, so the pref still can't be clobbered. */
    dragRef.current = { originX: e.clientX, base: width, side, startPref: pref };
    setDragging(true);
    const finish = (commitX: number | null) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (!d) return;
      if (commitX === null) { // pointercancel: restore the drag-start state, persist nothing
        setPref(d.startPref);
        return;
      }
      const finalW = commitChatWidth(d.base, columnW, d.originX, commitX, d.side);
      if (finalW !== null) {
        setPref(finalW);
        if (typeof localStorage !== "undefined") writeChatWidthPref(localStorage, finalW);
      } else {
        // null = the drag showed nothing (no travel, or the clamp refused it) —
        // persist nothing and put the drag-start state back
        setPref(d.startPref);
      }
    };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (ev.buttons === 0) { finish(ev.clientX); return; } // pointerup missed — released outside the window
      /* null = the clamp refuses the drag here — hold the drag-start state, so
         the column never moves against the drag */
      setPref(dragDisplayWidth(d.base, columnW, d.originX, ev.clientX, d.side) ?? d.startPref);
    };
    const up = (ev: PointerEvent) => finish(ev.clientX);
    const cancel = () => finish(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  /* the handles ride the chat column's edges and move with it (issue #116) —
     pinned to the panel's edges they float ever further from the column as
     the panel widens; hidden entirely when the margin has no room */
  const geo = chatHandleGeometry(columnW, width);
  const handleCls = "absolute top-0 bottom-0 z-20 cursor-col-resize group/edge";
  const handleStyle = (side: "left" | "right"): React.CSSProperties =>
    side === "left"
      ? { left: `calc(50% - ${geo.offset + geo.width}px)`, width: geo.width }
      : { left: `calc(50% + ${geo.offset}px)`, width: geo.width };
  const gripCls = cn(
    "absolute top-1/2 -translate-y-1/2 w-[3px] h-10 rounded-full transition-colors",
    "opacity-0 group-hover/edge:opacity-100",
    "bg-[var(--t-line2)] group-hover/edge:bg-[var(--t-amber)]",
    dragging && "bg-[var(--t-amber)] opacity-100",
  );

  return (
    <div ref={wrapRef} className="relative flex-1 min-h-0 flex flex-col">
      {/* the shared column axis — timeline content and composer align to it */}
      <div className="flex-1 min-h-0 flex flex-col" style={{ ["--t-chatw" as never]: `${width}px` }}>
        <ChatColumnCtx.Provider value={width}>{timeline}{perms}{composer}</ChatColumnCtx.Provider>
      </div>
      {/* edge drag handles — placed from the geometry, hover-only grip */}
      {geo.visible && (["left", "right"] as const).map((side) => (
        <div key={side} className={handleCls} style={{ ...handleStyle(side), touchAction: "none" /* touch: drag resizes instead of scrolling */ }} onPointerDown={onPointerDown(side)} title="Drag to resize the chat column" aria-label={`Resize chat column (${side} edge)`} role="separator" aria-orientation="vertical">
          <span className={cn(gripCls, side === "left" ? "right-0.5" : "left-0.5")} />
        </div>
      ))}
    </div>
  );
}

const ChatColumnCtx = createContext<number>(CHAT_WIDTH_DEFAULT);

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
