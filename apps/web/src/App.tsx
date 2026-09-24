import { useCallback, useEffect, useState } from "react";
import { detectBackend } from "@/lib/backend";
import { store, useApp } from "@/lib/store";
import { Sidebar } from "@/components/Sidebar";
import { Workspace } from "@/components/Workspace";
import { StatusBar, Toasts, CommandPalette } from "@/components/Chrome";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { TrussLogo, Spinner } from "@/components/ui";
import { cn } from "@/utils/cn";

export default function App() {
  const [phase, setPhase] = useState<"detect" | "ready" | "failed">("detect");
  const [err, setErr] = useState("");

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const be = await detectBackend();
        if (off) return;
        await store.init(be);
        if (!off) setPhase("ready");
      } catch (e: any) {
        setErr(e?.message ?? String(e));
        setPhase("failed");
      }
    })();
    return () => {
      off = true;
    };
  }, []);

  if (phase !== "ready")
    return (
      <div className="h-full grid place-items-center bg-[var(--t-bg0)] t-grid-bg">
        <div className="text-center">
          <div className="inline-block text-[var(--t-amber)] t-pulse"><TrussLogo size={34} /></div>
          {phase === "detect" ? (
            <div className="mt-4 flex items-center justify-center gap-2 text-[12px] text-[var(--t-mute)] font-mono"><Spinner /> probing /health…</div>
          ) : (
            <div className="mt-4 max-w-[420px] text-[12.5px] text-[var(--t-red)]">
              Truss failed to start: <span className="font-mono">{err}</span>
              <div className="mt-3"><button className="underline text-[var(--t-mute)]" onClick={() => location.reload()}>Reload</button></div>
            </div>
          )}
        </div>
      </div>
    );
  return <Shell />;
}

function Shell() {
  const [dialog, setDialog] = useState(false);
  const [palette, setPalette] = useState(false);
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 900);
  const openNew = useCallback(() => {
    setPalette(false);
    setDialog(true);
  }, []);

  useEffect(() => {
    const onNewEv = () => setDialog(true);
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || t.closest(".xterm"));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setDialog(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setSidebar((s) => !s);
      }
    };
    window.addEventListener("truss:new", onNewEv);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("truss:new", onNewEv);
      window.removeEventListener("keydown", key);
    };
  }, []);

  // Ambient title: pending permissions beat everything, then running agents.
  const pending = useApp((s) => Object.values(s.views).reduce((n, v) => n + v.pending.length, 0));
  const running = useApp((s) => s.order.reduce((n, id) => n + (s.sessions[id]?.state === "running" ? 1 : 0), 0));
  useEffect(() => {
    document.title = pending ? `⚠ ${pending} permission${pending > 1 ? "s" : ""} · Truss` : running ? `● ${running} running · Truss` : "Truss";
  }, [pending, running]);

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg0)]">
      <div className="flex-1 min-h-0 flex relative">
        <div className={cn("shrink-0 h-full transition-[width] duration-200 overflow-hidden", sidebar ? "w-[276px]" : "w-0", "max-[899px]:absolute max-[899px]:z-30 max-[899px]:shadow-2xl")}>
          <div className="w-[276px] h-full">
            <Sidebar onNew={openNew} />
          </div>
        </div>
        {sidebar && <div className="min-[900px]:hidden absolute inset-0 z-20 bg-black/40" onClick={() => setSidebar(false)} />}
        <main className="flex-1 min-w-0 h-full p-1.5">
          <Workspace />
        </main>
      </div>
      <StatusBar onToggleSidebar={() => setSidebar((s) => !s)} />
      <Toasts />
      {dialog && <NewSessionDialog onClose={() => setDialog(false)} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} onNew={openNew} />}
    </div>
  );
}
