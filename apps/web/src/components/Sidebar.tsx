import { useState } from "react";
import { HarnessLogo, Icon } from "../icons";
import { fmtAge, fmtTokens, useStore } from "../store";

const GROUP_COLORS = ["var(--purple)", "var(--orange)", "var(--cyan)", "var(--pink)"];

function groupColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return GROUP_COLORS[Math.abs(h) % GROUP_COLORS.length];
}

export function Sidebar({
  activeSessionId,
  onOpenSession,
  onOpenPanel,
  onNewSession,
}: {
  activeSessionId: string | null;
  onOpenSession: (id: string) => void;
  onOpenPanel: (id: string) => void;
  onNewSession: () => void;
}) {
  const s = useStore();
  const [closed, setClosed] = useState<Record<string, boolean>>({ ungrouped: true });

  /* group sessions by project, Chrome-style */
  const groups = new Map<string, typeof sessions>();
  const sessions = [...s.sessions.values()].sort((a, b) => b.updated_at - a.updated_at);
  for (const sess of sessions) {
    const g = sess.project?.trim() || "ungrouped";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(sess);
  }
  const groupNames = [...groups.keys()].sort((a, b) =>
    a === "ungrouped" ? 1 : b === "ungrouped" ? -1 : a.localeCompare(b),
  );

  const activeCtx = activeSessionId ? s.data.get(activeSessionId)?.ctx : null;
  const runningCount = sessions.filter((x) => x.state === "running").length;

  return (
    <div className="side">
      <div className="brand">
        <span className="nm">
          truss<i>_</i>
        </span>
        <span className="v">v0.1.0</span>
      </div>
      <button className="newsess bub" onClick={onNewSession}>
        <Icon name="plus" className="ic sm" />
        new session
      </button>

      <div className="sec">Sessions</div>
      {groupNames.length === 0 && (
        <div className="sess" style={{ cursor: "default" }}>
          <span className="nm" style={{ opacity: 0.4 }}>
            no sessions yet
          </span>
        </div>
      )}
      {groupNames.map((g) => {
        const list = groups.get(g)!;
        const isClosed = !!closed[g];
        return (
          <div className={`pgroup ${isClosed ? "closed" : ""}`} key={g}>
            <div
              className="pgroup-h"
              onClick={() => setClosed((c) => ({ ...c, [g]: !c[g] }))}
            >
              <span className="caret">
                <Icon name="chev-d" className="ic sm" />
              </span>
              <span
                className="chip"
                style={{ background: g === "ungrouped" ? "var(--com)" : groupColor(g) }}
              />
              <span
                className="pnm"
                style={
                  g === "ungrouped" ? { color: "var(--com)", fontWeight: 500 } : undefined
                }
              >
                {g}
              </span>
              <span className="cnt">{list.length}</span>
            </div>
            <div className="pgroup-body">
              {list.map((sess) => (
                <div
                  key={sess.id}
                  className={`sess bub ${sess.id === activeSessionId ? "on" : ""} ${
                    sess.state === "closed" ? "dead" : ""
                  }`}
                  onClick={() => onOpenSession(sess.id)}
                >
                  <HarnessLogo harness={sess.harness} name={sess.harness} />
                  <span className="nm">{sess.title}</span>
                  <span
                    className={`meta ${sess.state === "running" ? "livemeta" : ""}`}
                  >
                    {sess.state === "running" ? (
                      <>
                        live <Icon name="dot" className="ic sm fill" />
                      </>
                    ) : (
                      fmtAge(sess.updated_at)
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="sec">Harnesses</div>
      <div className="sess bub" style={{ cursor: "default" }}>
        <HarnessLogo harness="pi" name="pi" />
        <span className="nm">pi</span>
        <span className="meta">rpc</span>
      </div>
      <div className="sess bub" style={{ cursor: "default" }}>
        <HarnessLogo harness="claude-code" name="Claude Code" />
        <span className="nm" style={{ opacity: 0.45 }}>
          Claude Code
        </span>
        <span className="meta">M4</span>
      </div>
      <div className="sess bub" style={{ cursor: "default" }}>
        <HarnessLogo harness="hermes" name="Hermes" />
        <span className="nm" style={{ opacity: 0.45 }}>
          Hermes
        </span>
        <span className="meta">M3</span>
      </div>
      <div className="sess bub" style={{ cursor: "default" }}>
        <HarnessLogo harness="dsh" name="DeepSeek Harness" />
        <span className="nm" style={{ opacity: 0.45 }}>
          DeepSeek Harness
        </span>
        <span className="meta">M6</span>
      </div>

      <div className="sec">Panels</div>
      <div className="sess bub" onClick={() => onOpenPanel("trajectory")}>
        <span className="hlogo none" data-name="Trajectory">
          <Icon name="pulse" />
        </span>
        <span className="nm" style={{ opacity: 0.6 }}>
          trajectory
        </span>
      </div>
      <div className="sess bub" onClick={() => onOpenPanel("context")}>
        <span className="hlogo none" data-name="Context tracker">
          <Icon name="ctx" />
        </span>
        <span className="nm" style={{ opacity: 0.6 }}>
          context tracker
        </span>
      </div>
      <div className="sess bub" onClick={() => onOpenPanel("subagents")}>
        <span className="hlogo none" data-name="Subagents">
          <Icon name="agents" />
        </span>
        <span className="nm" style={{ opacity: 0.6 }}>
          subagents
        </span>
        {runningCount > 0 && <span className="meta livemeta">{runningCount} live</span>}
      </div>
      <div className="sess bub" onClick={() => onOpenPanel("memory")}>
        <span className="hlogo none" data-name="Memory">
          <Icon name="brain" />
        </span>
        <span className="nm" style={{ opacity: 0.6 }}>
          memory
        </span>
      </div>
      <div className="sess bub" onClick={() => onOpenPanel("skills")}>
        <span className="hlogo none" data-name="Skills">
          <Icon name="zap" />
        </span>
        <span className="nm" style={{ opacity: 0.6 }}>
          skills
        </span>
      </div>

      <div className="side-foot">
        <div className="row">
          <span>context</span>
          <b>{activeCtx ? `${fmtTokens(activeCtx.used)}/${fmtTokens(activeCtx.total)}` : "—"}</b>
        </div>
        <div className="ctxseg">
          {activeCtx?.by ? (
            <>
              <i
                style={{
                  background: "var(--ctx-system)",
                  width: `${pct(activeCtx.by.system, activeCtx)}%`,
                }}
              />
              <i
                style={{
                  background: "var(--ctx-tools)",
                  width: `${pct(activeCtx.by.tools, activeCtx)}%`,
                }}
              />
              <i
                style={{
                  background: "var(--ctx-rules)",
                  width: `${pct(activeCtx.by.rules, activeCtx)}%`,
                }}
              />
              <i
                style={{
                  background: "var(--ctx-memory)",
                  width: `${pct(activeCtx.by.memory, activeCtx)}%`,
                }}
              />
              <i
                style={{
                  background: "var(--ctx-conv)",
                  width: `${pct(activeCtx.by.conversation, activeCtx)}%`,
                }}
              />
            </>
          ) : (
            <i
              style={{
                background: "var(--ctx-conv)",
                width:
                  activeCtx && activeCtx.total > 0
                    ? `${Math.min(100, (activeCtx.used / activeCtx.total) * 100)}%`
                    : "0%",
              }}
            />
          )}
          <i style={{ background: "rgba(98,114,164,.18)", flex: 1 }} />
        </div>
      </div>
    </div>
  );
}

function pct(part: number | undefined, ctx: { used: number; total: number }): number {
  if (part == null || !ctx.total) return 0;
  return Math.min(100, Math.max(0, (part / ctx.total) * 100));
}
