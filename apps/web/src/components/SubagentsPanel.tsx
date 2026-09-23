import { useEffect } from "react";
import { Icon } from "../icons";
import { useStore, type AgentNode } from "../store";

function AgentRow({ a, depth }: { a: AgentNode; depth: number }) {
  return (
    <div className="agentrow" style={{ paddingLeft: 16 + depth * 16 }}>
      <span className={`adot ${a.done ? (a.ok ? "ok" : "bad") : "run"}`} />
      <span className="albl">{a.label}</span>
      <span className="ameta">{a.done ? (a.ok ? "done" : "failed") : "running"}</span>
    </div>
  );
}

/** Subagent/team tree — real structure from subagent.* events. */
export function SubagentsPanel({ sessionId }: { sessionId: string | null }) {
  const s = useStore();

  useEffect(() => {
    if (sessionId) void s.hydrate(sessionId);
  }, [sessionId]);

  const agents = (sessionId ? s.data.get(sessionId)?.agents : null) ?? [];

  if (!sessionId || agents.length === 0) {
    return (
      <div className="stub">
        <div>
          <Icon name="agents" className="ic" />
          <div style={{ color: "var(--com)", fontWeight: 500 }}>no subagents</div>
          <div>
            pi runs single-agent — the team tree lights up
            <br />
            with hermes (M3) and claude-code (M4)
          </div>
        </div>
      </div>
    );
  }

  const roots = agents.filter((a) => !a.parentAgentId);
  const childrenOf = (id: string) => agents.filter((a) => a.parentAgentId === id);

  const renderTree = (a: AgentNode, depth: number): React.ReactNode => (
    <div key={a.agentId}>
      <AgentRow a={a} depth={depth} />
      {childrenOf(a.agentId).map((c) => renderTree(c, depth + 1))}
    </div>
  );

  return <div className="agentpanel">{roots.map((r) => renderTree(r, 0))}</div>;
}
