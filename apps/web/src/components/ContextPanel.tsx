import { useEffect } from "react";
import { fmtTokens, useStore } from "../store";

/**
 * Context tracker — the segmented gauge made full-size.
 * Per-category breakdown renders when the harness reports it (pi doesn't yet);
 * the per-call input-token history is always real data from llm.call rows.
 */
export function ContextPanel({ sessionId }: { sessionId: string | null }) {
  const s = useStore();

  useEffect(() => {
    if (sessionId) void s.hydrate(sessionId);
  }, [sessionId]);

  if (!sessionId) {
    return <div className="stub">open a session to track its context</div>;
  }

  const d = s.data.get(sessionId);
  const ctx = d?.ctx;
  const calls = (d?.calls ?? []).filter((c) => c.done && c.tokensIn != null);
  const sess = s.sessions.get(sessionId);

  if (!ctx) {
    return (
      <div className="stub">
        <div>
          <div style={{ color: "var(--com)", fontWeight: 500 }}>no usage reported yet</div>
          <div>the first llm call fills this in</div>
        </div>
      </div>
    );
  }

  const usedPct = ctx.total > 0 ? Math.min(100, (ctx.used / ctx.total) * 100) : 0;
  const cats: { label: string; value?: number; color: string }[] = [
    { label: "system", value: ctx.by?.system, color: "var(--ctx-system)" },
    { label: "tools", value: ctx.by?.tools, color: "var(--ctx-tools)" },
    { label: "rules", value: ctx.by?.rules, color: "var(--ctx-rules)" },
    { label: "memory", value: ctx.by?.memory, color: "var(--ctx-memory)" },
    { label: "conversation", value: ctx.by?.conversation, color: "var(--ctx-conv)" },
  ];
  const hasCats = cats.some((c) => c.value != null);
  const maxIn = Math.max(...calls.map((c) => c.tokensIn ?? 0), 1);

  return (
    <div className="ctxpanel">
      <div className="ctx-big">
        <div className="num">
          {fmtTokens(ctx.used)}
          <span className="of">/ {fmtTokens(ctx.total)}</span>
        </div>
        <div className="sub">
          {sess?.model ?? "model"} · {usedPct.toFixed(1)}% of window
        </div>
        <div className="gauge">
          {hasCats ? (
            <>
              {cats.map(
                (c) =>
                  c.value != null && (
                    <i
                      key={c.label}
                      title={`${c.label} ${fmtTokens(c.value)}`}
                      style={{
                        background: c.color,
                        width: `${(c.value / ctx.total) * 100}%`,
                      }}
                    />
                  ),
              )}
              <i className="free" />
            </>
          ) : (
            <>
              <i
                style={{ background: "var(--ctx-conv)", width: `${usedPct}%` }}
                title="used"
              />
              <i className="free" />
            </>
          )}
        </div>
        {hasCats && (
          <div className="legend">
            {cats
              .filter((c) => c.value != null)
              .map((c) => (
                <span key={c.label}>
                  <i style={{ background: c.color }} />
                  {c.label} {fmtTokens(c.value)}
                </span>
              ))}
          </div>
        )}
        {!hasCats && (
          <div className="legend">
            <span style={{ color: "var(--com-dim)" }}>
              category breakdown lands with harnesses that report it
            </span>
          </div>
        )}
      </div>

      <div className="ctx-hist">
        <div className="hd">input tokens per call</div>
        {calls.length === 0 && <div className="sub">no completed calls</div>}
        {calls.map((c) => (
          <div className="hrow" key={c.callId} title={`${c.callId} — ${c.tokensIn} in`}>
            <span className="hts">{fmtTokens(c.tokensIn)}</span>
            <div className="hbar">
              <i style={{ width: `${((c.tokensIn ?? 0) / maxIn) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
