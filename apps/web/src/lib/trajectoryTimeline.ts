/* Trajectory timeline — a pure projection of the session event log
   (issue #142). The trajectory tab renders this as its primary view: the
   session's story as a chronological ledger grouped by turn (user →
   assistant with the tool calls inline), instead of the raw per-call table
   (#20, which survives as the secondary view).

   Input is the raw event stream (msg.*, tool.*, llm.call.* — both the
   server's proto spellings "tool.call"/toolCallId and the spec's
   "tool.start"/callId are accepted). Output is a list of turns:

   - a turn starts at a user message; its assistant half is the first
     assistant message before the next user message; tools and llm calls in
     that window ride along chronologically;
   - durations come only from real start→done pairs (a harness-reported
     durationMs is accepted for tools whose start we never saw) — unclosed
     spans stay undefined (in flight), never faked;
   - orphan tools (no surrounding messages) get their own turn rather than
     being dropped;
   - replay-stable and junk-safe: same events in → same timeline out, and
     unknown/malformed events are skipped, never thrown on. */

export interface TimelineTool {
  name: string;
  at: number;
  doneAt?: number;
  durationMs?: number;
  ok?: boolean;
}

export interface TimelineTurn {
  at: number;
  user?: { text: string };
  assistant?: { at: number; doneAt?: number; durationMs?: number; model?: string };
  tools: TimelineTool[];
  tokensIn?: number;
  tokensOut?: number;
}

interface RawEvent {
  type: string;
  at?: number | string;
  [k: string]: unknown;
}

interface MsgAcc {
  role: string;
  at: number;
  text: string;
  doneAt?: number;
}
interface ToolAcc {
  name: string;
  at: number;
  doneAt?: number;
  reportedMs?: number;
  ok?: boolean;
}
interface CallAcc {
  model?: string;
  at: number;
  tokensIn?: number;
  tokensOut?: number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function trajectoryTimeline(events: RawEvent[]): TimelineTurn[] {
  if (!Array.isArray(events)) return [];
  const msgs = new Map<string, MsgAcc>();
  const tools = new Map<string, ToolAcc>();
  const calls = new Map<string, CallAcc>();
  let clock = 0; // events without `at` inherit the last known timestamp (as the store's replay does)

  const atOf = (ev: RawEvent): number => {
    const n = num(ev.at);
    if (n !== undefined) clock = n;
    else if (typeof ev.at === "string") {
      const p = Date.parse(ev.at);
      if (!Number.isNaN(p)) clock = p;
    }
    return clock;
  };

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const ev = raw as RawEvent;
    switch (ev.type) {
      case "msg.start": {
        const id = str(ev.messageId);
        if (!id) break;
        const at = atOf(ev);
        const prev = msgs.get(id);
        msgs.set(id, { role: str(ev.role) ?? prev?.role ?? "assistant", at, text: prev?.text ?? "", doneAt: prev?.doneAt });
        break;
      }
      case "msg.chunk": {
        const id = str(ev.messageId);
        const text = str(ev.text);
        if (!id || !text) break;
        const at = atOf(ev);
        if (str(ev.channel) === "thinking") break; // the timeline narrates actions, not reasoning drafts
        const m = msgs.get(id) ?? { role: "assistant", at, text: "" };
        m.text += text;
        msgs.set(id, m);
        break;
      }
      case "msg.done": {
        const id = str(ev.messageId);
        const m = id ? msgs.get(id) : undefined;
        if (!m) break;
        m.doneAt = atOf(ev);
        break;
      }
      case "tool.start":
      case "tool.call": {
        const id = str(ev.callId) ?? str(ev.toolCallId);
        if (!id) break;
        const at = atOf(ev);
        const prev = tools.get(id);
        tools.set(id, {
          name: str(ev.name) ?? prev?.name ?? "tool",
          at,
          doneAt: prev?.doneAt,
          reportedMs: prev?.reportedMs,
          ok: prev?.ok,
        });
        break;
      }
      case "tool.done": {
        const id = str(ev.callId) ?? str(ev.toolCallId);
        if (!id) break;
        const at = atOf(ev);
        const t = tools.get(id);
        const ok = typeof ev.ok === "boolean" ? ev.ok : undefined;
        const reportedMs = num(ev.durationMs);
        if (t) {
          t.doneAt = at;
          if (ok !== undefined) t.ok = ok;
          if (reportedMs !== undefined) t.reportedMs = reportedMs;
        } else {
          // a done without a start still shows: span unknown, outcome real
          tools.set(id, { name: "tool", at, doneAt: at, ok, reportedMs });
        }
        break;
      }
      case "llm.call.start": {
        const id = str(ev.callId);
        if (!id) break;
        const at = atOf(ev);
        const prev = calls.get(id);
        calls.set(id, { model: str(ev.model) ?? prev?.model, at, tokensIn: prev?.tokensIn, tokensOut: prev?.tokensOut });
        break;
      }
      case "llm.call.done": {
        const id = str(ev.callId);
        if (!id) break;
        atOf(ev);
        const c = calls.get(id);
        if (!c) break; // a call we never saw start anchors nothing
        const tin = num(ev.tokensIn);
        const tout = num(ev.tokensOut);
        if (tin !== undefined) c.tokensIn = tin;
        if (tout !== undefined) c.tokensOut = tout;
        break;
      }
      default:
        break; // unknown events are junk, not errors
    }
  }

  const byAt = <T extends { at: number }>(a: T, b: T) => a.at - b.at;
  const allMsgs = [...msgs.values()];
  const users = allMsgs.filter((m) => m.role === "user").sort(byAt);
  const assistants = allMsgs.filter((m) => m.role === "assistant").sort(byAt);
  const allTools = [...tools.values()].sort(byAt);
  const allCalls = [...calls.values()].sort(byAt);

  const toTool = (t: ToolAcc): TimelineTool => {
    const out: TimelineTool = { name: t.name, at: t.at };
    if (t.doneAt !== undefined) {
      out.doneAt = t.doneAt;
      out.durationMs = t.doneAt - t.at; // the real pair wins…
      if (t.ok !== undefined) out.ok = t.ok;
    } else if (t.reportedMs !== undefined) {
      out.durationMs = t.reportedMs; // …a harness-reported duration is real too
      if (t.ok !== undefined) out.ok = t.ok;
    } else if (t.ok !== undefined) {
      out.ok = t.ok;
    }
    return out;
  };

  // turn windows: [anchor at, next anchor at). Anchors are user messages —
  // plus any assistant message that precedes the first user message (a
  // resumed or harness-initiated session can open with one; it gets its own
  // turn rather than being dropped). With no user messages at all, assistant
  // messages anchor instead, so such a session still gets a story.
  const anchors: { msg: MsgAcc; withUser: boolean }[] =
    users.length > 0
      ? [
          ...assistants.filter((m) => m.at < users[0].at).map((msg) => ({ msg, withUser: false })),
          ...users.map((msg) => ({ msg, withUser: true })),
        ].sort((a, b) => a.msg.at - b.msg.at)
      : assistants.map((msg) => ({ msg, withUser: false }));
  const turns: TimelineTurn[] = [];

  const buildTurn = (anchor: MsgAcc, nextAt: number, withUser: boolean): TimelineTurn => {
    const inWindow = <T extends { at: number }>(x: T) => x.at >= anchor.at && x.at < nextAt;
    const turn: TimelineTurn = { at: anchor.at, tools: [] };
    if (withUser) turn.user = { text: anchor.text };

    const am = assistants.filter((m) => m !== anchor && inWindow(m));
    const first = withUser ? am[0] : anchor;
    if (first) {
      const doneAt = am.reduce<number | undefined>((d, m) => (m.doneAt !== undefined && (d === undefined || m.doneAt > d) ? m.doneAt : d), first.doneAt);
      const a: NonNullable<TimelineTurn["assistant"]> = { at: first.at };
      if (doneAt !== undefined) {
        a.doneAt = doneAt;
        a.durationMs = doneAt - first.at;
      }
      const windowCalls = allCalls.filter(inWindow);
      // the model of the call that produced this message (latest start at or
      // before the message), else the latest call in the window
      const producer = [...windowCalls].reverse().find((c) => c.at <= first.at) ?? windowCalls[windowCalls.length - 1];
      if (producer?.model !== undefined) a.model = producer.model;
      turn.assistant = a;
    } else if (!withUser) {
      turn.assistant = { at: anchor.at };
    }

    turn.tools = allTools.filter(inWindow).map(toTool);

    const windowCalls = allCalls.filter(inWindow);
    let tin = 0, tout = 0, hasIn = false, hasOut = false;
    for (const c of windowCalls) {
      if (c.tokensIn !== undefined) { tin += c.tokensIn; hasIn = true; }
      if (c.tokensOut !== undefined) { tout += c.tokensOut; hasOut = true; }
    }
    if (hasIn) turn.tokensIn = tin;
    if (hasOut) turn.tokensOut = tout;
    return turn;
  };

  // orphan tools: before the first anchor there is no turn to carry them,
  // so they get their own instead of being dropped
  const firstAnchor = anchors[0];
  const orphans = firstAnchor ? allTools.filter((t) => t.at < firstAnchor.msg.at) : allTools;
  if (orphans.length > 0) {
    turns.push({ at: orphans[0].at, tools: orphans.map(toTool) });
  }

  for (let i = 0; i < anchors.length; i++) {
    const next = anchors[i + 1]?.msg.at ?? Number.POSITIVE_INFINITY;
    turns.push(buildTurn(anchors[i].msg, next, anchors[i].withUser));
  }

  turns.sort(byAt);
  return turns;
}

/* ---------------- overview strip ----------------

   The Chrome-Network-style overview above the feed, layered like DSH's:
   three lanes — your messages, the model's spans, the tools — each record
   its own span across the session's full time domain. Pure geometry; the
   panel positions spans by percentage. */

/** 0 = your messages, 1 = the model, 2 = tools */
export type OverviewLane = 0 | 1 | 2;

export interface OverviewSpan {
  /** index into the turns array the overview was derived from */
  turnIndex: number;
  lane: OverviewLane;
  start: number;
  end: number;
  /** the record is still open — its end moves with the caller's clock */
  inFlight: boolean;
  /** a tool that reported failure */
  failed: boolean;
}

export interface TimelineOverview {
  /** full session span (end > start always, so fractions never divide by zero) */
  start: number;
  end: number;
  spans: OverviewSpan[];
}

/**
 * Derive the lane-projected overview from the timeline. `now` is the
 * caller's clock, used only as the moving end of in-flight records — pass
 * it explicitly so the function stays replay-stable. Returns null for an
 * empty timeline.
 */
export function timelineOverview(turns: TimelineTurn[], now: number): TimelineOverview | null {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  const spans: OverviewSpan[] = [];
  const push = (turnIndex: number, lane: OverviewLane, at: number, doneAt: number | undefined, failed: boolean) => {
    const inFlight = doneAt === undefined;
    const e = doneAt ?? (inFlight ? now : at);
    spans.push({ turnIndex, lane, start: at, end: Math.max(at, e), inFlight, failed });
    start = Math.min(start, at);
    end = Math.max(end, at, e);
  };
  turns.forEach((t, i) => {
    if (t.user) push(i, 0, t.at, t.at, false); // a prompt is a point, not a span
    if (t.assistant) push(i, 1, t.assistant.at, t.assistant.doneAt, false);
    for (const tool of t.tools) push(i, 2, tool.at, tool.doneAt, tool.ok === false);
  });
  if (spans.length === 0) return null; // turns exist but carried nothing (defensive)
  if (end <= start) end = start + 1;
  return { start, end, spans };
}

/**
 * Case-insensitive turn search across the fields the feed shows: the user's
 * text, the model, and tool names. Returns one flag per turn; an empty
 * query matches everything (the strip undims, the feed unfilters).
 */
export function matchTurns(turns: TimelineTurn[], query: string): boolean[] {
  if (!Array.isArray(turns)) return [];
  const q = query.trim().toLowerCase();
  if (!q) return turns.map(() => true);
  return turns.map(
    (t) =>
      !!t.user?.text.toLowerCase().includes(q) ||
      !!t.assistant?.model?.toLowerCase().includes(q) ||
      t.tools.some((x) => x.name.toLowerCase().includes(q)),
  );
}
