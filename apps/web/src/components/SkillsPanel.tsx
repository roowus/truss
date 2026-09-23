import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { useStore } from "../store";

interface SkillInfo {
  name: string;
  description: string;
  source: string;
  scope: "global" | "project";
}

/** Skills known to the harness in this session's working directory. */
export function SkillsPanel({ sessionId }: { sessionId: string | null }) {
  const s = useStore();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);

  const cwd = sessionId ? s.sessions.get(sessionId)?.cwd : undefined;

  useEffect(() => {
    setSkills(null);
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/skills${q}`)
      .then((r) => r.json())
      .then((j) => setSkills(j.skills))
      .catch(() => setSkills([]));
  }, [sessionId, cwd]);

  if (!sessionId) return <div className="stub">open a session to see its skills</div>;

  if (skills === null) return <div className="stub">scanning…</div>;

  if (skills.length === 0) {
    return (
      <div className="stub">
        <div>
          <Icon name="zap" className="ic" />
          <div style={{ color: "var(--com)", fontWeight: 500 }}>no skills installed</div>
          <div>
            drop a SKILL.md dir into ~/.pi/agent/skills
            <br />
            or .pi/skills in the project
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="skillpanel">
      {skills.map((sk) => (
        <div className="skillrow" key={sk.source}>
          <div className="stop">
            <span className="sname">{sk.name}</span>
            <span className={`sscope ${sk.scope}`}>{sk.scope}</span>
          </div>
          <div className="sdesc">{sk.description}</div>
          <div className="ssrc">{sk.source}</div>
        </div>
      ))}
    </div>
  );
}
