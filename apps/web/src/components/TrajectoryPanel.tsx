import { useEffect } from "react";
import { fmtTokens, useStore, type CallRow } from "../store";

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtClockS(ms: number): string {
  const d = new Date(ms);
  return `${fmtClock(ms)}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function TrajectoryPanel({ sessionId }: { sessionId: string | null }) {
  const s = useStore();

  useEffect(() => {
    if (sessionId) void s.hydrate(sessionId);
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="stub">
        <div>
          <div className="ic" style={{ margin: "0 auto 6px" }}>
            <svg className="ic"><use href="#i-pulse" /></svg>
          </div>
          open a session to see its trajectory
        </div>
      </div>
    );
  }

  const d = s.data.get(sessionId);
  const calls = d?.calls ?? [];

  /* time-axis ruler over the session's call window */
  const t0 = calls.length ? calls[0].at : Date.now();
  const t1 = calls.length ? Math.max(...calls.map((c) => c.at + (c.latencyMs ?? 0)), Date.now()) : Date.now();
  const span = Math.max(t1 - t0, 30_000);
  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => t0 + (span * i) / (tickCount - 1));
  const tickFmt = span < 10 * 60_000 ? fmtClockS : fmtClock;

  const maxLatency = Math.max(...calls.map((c) => c.latencyMs ?? 0), 1000);
  const totalIn = calls.reduce((a, c) => a + (c.tokensIn ?? 0), 0);
  const totalOut = calls.reduce((a, c) => a + (c.tokensOut ?? 0), 0);
  const cost = calls.reduce((a, c) => a + (c.costUsd ?? 0), 0);
  const retries = calls.filter((c) => c.retryOf).length;

  return (
    <>
      <div className="tl">
        <div className="tl-ticks">
          {ticks.map((t, i) => (
            <span key={i}>{calls.length ? tickFmt(t) : "—"}</span>
          ))}
        </div>
        <div className="tl-track">
          {calls.map((c) => (
            <button
              key={c.callId}
              className={`tl-mark ${c.done && c.status !== 200 ? "err" : ""} ${
                c.retryOf ? "sub" : ""
              }`}
              style={{ left: `${Math.min(99, ((c.at - t0) / span) * 100)}%` }}
              title={`${c.callId} — ${c.model}`}
            />
          ))}
          {calls.some((c) => !c.done) && (
            <div className="tl-now" style={{ left: `${Math.min(99, ((Date.now() - t0) / span) * 100)}%` }} />
          )}
        </div>
      </div>

      <div className="traj">
        {calls.length === 0 && (
          <div className="empty-hint" style={{ padding: "24px 0" }}>
            no LLM calls yet
          </div>
        )}
        {calls.map((c) => (
          <Row key={c.callId} c={c} maxLatency={maxLatency} />
        ))}
      </div>

      <div className="pane-f">
        <span>
          calls <b>{calls.length}</b>
        </span>
        <span>
          tokens{" "}
          <b>
            {fmtTokens(totalIn)} → {fmtTokens(totalOut)}
          </b>
        </span>
        <span>
          cost <b>${cost.toFixed(4)}</b>
        </span>
        {retries > 0 && <span style={{ color: "var(--orange)" }}>{retries} retried</span>}
      </div>
    </>
  );
}

function Row({ c, maxLatency }: { c: CallRow; maxLatency: number }) {
  const live = !c.done;
  const bad = c.done && c.status !== 200;
  const width = c.latencyMs != null ? Math.max(4, (c.latencyMs / maxLatency) * 100) : live ? 100 : 4;
  return (
    <div className="trow">
      <span className="ts">{fmtClockS(c.at)}</span>
      <span className="lbl">
        <b>CALL</b> <span className="md">{c.model}</span>{" "}
        {c.retryOf && <span style={{ color: "var(--orange)" }}>retry</span>}
      </span>
      <div className="bar">
        <i className={live ? "live" : bad || c.retryOf ? "retry" : ""} style={{ width: `${width}%` }} />
      </div>
      <span className={`st ${bad ? "bad" : ""}`}>
        {live ? "running" : `${c.status} ${((c.latencyMs ?? 0) / 1000).toFixed(2)}s`}
      </span>
    </div>
  );
}
