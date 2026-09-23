import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import { fmtTokens, useStore, type ChatEntry, type PermCard } from "../store";
import { dockBus } from "../dockBus";

/** agent→user permission card — the bidirectional contract in the UI */
function PermissionCard({ sessionId, perm }: { sessionId: string; perm: PermCard }) {
  const [answering, setAnswering] = useState(false);
  const answer = async (choice: string) => {
    setAnswering(true);
    try {
      await api.resolvePermission(sessionId, perm.requestId, choice);
    } finally {
      setAnswering(false);
    }
  };
  return (
    <div className="permcard">
      <div className="perm-h">
        <Icon name="shield" className="ic sm" />
        <b>{perm.tool}</b>
        <span className="perm-kind">{perm.reason}</span>
      </div>
      <div className="perm-opts">
        {perm.options.map((o) => (
          <button key={o} disabled={answering} onClick={() => void answer(o)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

/** one chat timeline entry */
function Entry({ e, harness }: { e: ChatEntry; harness: string }) {
  const [open, setOpen] = useState(false);

  if (e.kind === "msg") {
    if (e.role === "user") return <div className="msg-u">{e.text}</div>;
    if (e.role === "system") {
      return (
        <div className="think" style={{ borderLeftColor: "var(--red)", opacity: 0.85 }}>
          {e.text}
        </div>
      );
    }
    return (
      <div className={`msg-a ${e.streaming ? "streaming" : ""}`}>
        <div className="who">{harness}</div>
        {e.thinking && <div className="think">{e.thinking}</div>}
        {e.text}
        {e.stopReason?.startsWith("error") && (
          <div className="think" style={{ borderLeftColor: "var(--red)", opacity: 0.85 }}>
            {e.stopReason}
          </div>
        )}
      </div>
    );
  }

  /* tool run — scaffold row, rests at 67% and lifts on hover */
  const target = toolTarget(e.args);
  return (
    <div className="scaf">
      <button className={`tool-h ${open ? "" : "closed"}`} onClick={() => setOpen(!open)}>
        <span className="chev">
          <Icon name="chev-d" className="ic sm" />
        </span>
        <span className="tn">{e.name}</span>
        <span className="tgt">{target}</span>
        <span className={`ok ${e.ok === false ? "err" : ""}`}>
          {e.status === "done" ? (
            <>
              <Icon name={e.ok === false ? "x" : "check"} className="ic sm" />
              {e.durationMs != null ? `${e.durationMs}ms` : ""}
            </>
          ) : (
            "running"
          )}
        </span>
      </button>
      {open && e.output && <div className="tool-b">{e.output}</div>}
    </div>
  );
}

function toolTarget(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const v = a.path ?? a.file ?? a.command ?? a.cmd ?? a.query ?? "";
  return typeof v === "string" ? v : "";
}

/* ── chat panel ── */

export function ChatPanel({ sessionId }: { sessionId: string }) {
  const s = useStore();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sess = s.sessions.get(sessionId);
  const d = s.data.get(sessionId);
  const entries = d?.entries ?? [];
  const perms = d?.perms ?? [];
  const running = sess?.state === "running";
  const harness = s.harnesses.find((h) => h.id === sess?.harness);
  const canQueue = harness?.capabilities.queueWhileRunning ?? true;

  /* hydrate history on first open */
  useEffect(() => {
    void s.hydrate(sessionId);
  }, [sessionId]);

  /* autoscroll while streaming if pinned to bottom */
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, entries[entries.length - 1]?.text, entries[entries.length - 1]?.thinking]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !sess || sess.state === "closed") return;
    setSending(true);
    try {
      await api.prompt(sessionId, text);
      setDraft("");
    } catch {
      /* surfaced via session error events */
    } finally {
      setSending(false);
    }
  };

  if (!sess) {
    return <div className="empty-hint">session not found</div>;
  }

  const userTurns = entries.filter((e) => e.kind === "msg" && e.role === "user");
  const liveTools = entries.filter((e) => e.kind === "tool" && e.status !== "done");

  return (
    <>
      <div className="chatwrap">
        <div className="chat" ref={chatRef}>
          {entries.length === 0 && (
            <div className="empty-hint">
              nothing here yet
              <br />
              send a prompt to wake {sess.harness} up
            </div>
          )}
          {entries.map((e) => (
            <Entry key={e.id} e={e} harness={sess.harness} />
          ))}
          {perms.map((p) => (
            <PermissionCard key={p.requestId} sessionId={sessionId} perm={p} />
          ))}
          <div ref={bottomRef} />
        </div>
        {userTurns.length > 1 && (
          <div className="rail">
            {userTurns.map((t, i) => (
              <button
                key={t.id}
                className={`tick ${i === userTurns.length - 1 ? "on" : ""}`}
                title={t.text?.slice(0, 60)}
              />
            ))}
          </div>
        )}
      </div>

      {/* composer dock: status-stack → input well → context chips */}
      <div className="dock">
        {liveTools.length > 0 && (
          <div className="stack">
            <div className="stack-h">
              <Icon name="agents" className="ic sm" />
              <span className="n">
                {liveTools.length} tool{liveTools.length === 1 ? "" : "s"} running
              </span>
              <span className="chev">
                <Icon name="chev-d" className="ic sm" />
              </span>
            </div>
          </div>
        )}
        <div className="cwell">
          <span className="ps">
            <Icon name="chev-r" />
          </span>
          <input
            value={draft}
            placeholder={
              sess.state === "closed"
                ? "this session is closed"
                : running
                  ? canQueue
                    ? "queue a follow-up…"
                    : "waiting for the turn to settle…"
                  : `prompt ${sess.harness}…`
            }
            disabled={sess.state === "closed" || (running && !canQueue)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {running && (
            <span
              className="attach"
              title="interrupt"
              onClick={() => void api.interrupt(sessionId)}
            >
              <Icon name="x" className="ic sm" />
            </span>
          )}
          <button
            className="send"
            disabled={
              !draft.trim() || sending || sess.state === "closed" || (running && !canQueue)
            }
            onClick={() => void send()}
          >
            <Icon name="send" className="ic sm" />
            {running ? (canQueue ? "Queue" : "Running…") : "Send"}
          </button>
        </div>
        <div className="chips">
          <span className="chipc">
            <span className="cdot" style={{ background: "var(--purple)" }} />
            <b>{sess.harness}</b>
          </span>
          <span className="chipc">
            <Icon name="model" className="ic sm" />
            <b>{sess.model ?? "default"}</b>
          </span>
          <span className="chipc" title={sess.cwd}>
            <Icon name="folder" className="ic sm" />
            <b>{shortenHome(sess.cwd)}</b>
          </span>
          <span
            className="chipc"
            title="open a shell in this session's directory"
            onClick={() => dockBus.openShell(sess.cwd, `${sess.harness} shell`)}
          >
            <Icon name="term" className="ic sm" />
            <b>shell</b>
          </span>
          {d?.ctx && (
            <span className="chipc" style={{ marginLeft: "auto", cursor: "default" }}>
              <Icon name="ctx" className="ic sm" />
              {fmtTokens(d.ctx.used)}/{fmtTokens(d.ctx.total)}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function shortenHome(p: string): string {
  const home = "/home/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const i = rest.indexOf("/");
    if (i !== -1) return "~" + rest.slice(i);
  }
  return p;
}
