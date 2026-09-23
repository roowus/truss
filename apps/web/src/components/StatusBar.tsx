import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { fmtTokens, useStore } from "../store";

export function StatusBar({ activeSessionId }: { activeSessionId: string | null }) {
  const s = useStore();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const running = [...s.sessions.values()].filter((x) => x.state === "running").length;
  const ctx = activeSessionId ? s.data.get(activeSessionId)?.ctx : null;
  const cost = [...s.data.values()]
    .flatMap((d) => d.calls)
    .reduce((a, c) => a + (c.costUsd ?? 0), 0);

  const clock = new Date(now);
  const hh = String(clock.getHours()).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  const ss = String(clock.getSeconds()).padStart(2, "0");

  return (
    <div className="status">
      <div className="g">
        <span className="dotp">
          <Icon name="dot" className="ic sm fill" />
        </span>
        <b>{running}</b> agents
      </div>
      <div className="right">
        <span className="g">
          ctx <b>{ctx ? `${fmtTokens(ctx.used)}/${fmtTokens(ctx.total)}` : "—"}</b>
        </span>
        <span className="g">
          <b>${cost.toFixed(4)}</b>
        </span>
        <span className="g">ws {s.wsState === "open" ? "connected" : s.wsState}</span>
        <span className="g">
          <Icon name="clock" className="ic sm" />
          {hh}:{mm}:{ss}
        </span>
      </div>
    </div>
  );
}
