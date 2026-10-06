import { useCallback, useEffect, useState } from "react";
import { detectBackend } from "@/lib/backend";
import { store, useApp } from "@/lib/store";
import { desktops, useDesktops } from "@/lib/desktops";
import { Sidebar } from "@/components/Sidebar";
import { Workspace } from "@/components/Workspace";
import { StatusBar, Toasts, CommandPalette } from "@/components/Chrome";
import { NewSessionDialog, type NewSessionPreset } from "@/components/NewSessionDialog";
import { AddHostWizard } from "./components/AddHostWizard";
import { openPanel } from "@/lib/workspace";
import { canClose, isCloseWindowChord, isReopenClosedChord } from "@/lib/workspaceClose";
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
        await desktops.load(be);
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
  const [newPreset, setNewPreset] = useState<NewSessionPreset | null>(null);
  const [palette, setPalette] = useState(false);
  const [addHost, setAddHost] = useState(false);
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 900);
  const density = useDesktops((s) => s.settings.density);
  const sidebarWidth = density === "compact" ? 246 : 276;
  const openNew = useCallback((preset?: NewSessionPreset) => {
    setPalette(false);
    setNewPreset(preset ?? null);
    setDialog(true);
  }, []);

  useEffect(() => {
    const onNewEv = (e: Event) => openNew((e as CustomEvent<NewSessionPreset>).detail);
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || t.closest(".xterm"));
      /* The legacy Shift+W alias is Chrome's window chord: window-level, it
         fires even mid-typing wherever a setup delivers it. The advertised
         Alt+Shift+W yields while typing, like its Alt+Shift+<letter> strip
         siblings (Alt+Shift+T adds a tab). */
      if (isCloseWindowChord(e, !!typing)) {
        e.preventDefault();
        const live = desktops.state.spaces.filter((s) => !s.archived);
        if (canClose(live, desktops.state.activeId)) desktops.remove(desktops.state.activeId);
        else store.toast("info", "The last workspace stays open", "Truss always keeps at least one workspace.");
        /* Shift+Z is a text-redo chord, so unlike the window chords it must
           yield while typing; Shift+T (browser-reserved, rarely delivered)
           fires window-level wherever it does arrive */
      } else if (isReopenClosedChord(e, !!typing)) {
        e.preventDefault();
        desktops.reopenClosed();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (!typing && e.altKey && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        window.dispatchEvent(new Event("truss:add-tab"));
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openPanel("settings");
      } else if (!typing && !e.ctrlKey && !e.metaKey && e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const space = desktops.state.spaces[Number(e.key) - 1];
        if (space) { e.preventDefault(); desktops.switchTo(space.id); }
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openNew();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setSidebar((s) => !s);
      }
    };
    const onAddHost = () => setAddHost(true);
    window.addEventListener("truss:new", onNewEv);
    window.addEventListener("truss:add-host", onAddHost);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("truss:new", onNewEv);
      window.removeEventListener("truss:add-host", onAddHost);
      window.removeEventListener("keydown", key);
    };
  }, [openNew]);

  // Ambient title: pending permissions beat everything, then running agents.
  const pending = useApp((s) => Object.values(s.views).reduce((n, v) => n + v.pending.length, 0));
  const running = useApp((s) => s.order.reduce((n, id) => n + (s.sessions[id]?.state === "running" ? 1 : 0), 0));
  useEffect(() => {
    document.title = pending ? `⚠ ${pending} permission${pending > 1 ? "s" : ""} · Truss` : running ? `● ${running} running · Truss` : "Truss";
  }, [pending, running]);

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg0)]" data-density={density}>
      <div className="flex-1 min-h-0 flex relative">
        <div className={cn("shrink-0 h-full transition-[width] duration-200 overflow-hidden", "max-[899px]:absolute max-[899px]:z-30 max-[899px]:shadow-2xl")} style={{ width: sidebar ? sidebarWidth : 0 }}>
          <div className="h-full" style={{ width: sidebarWidth }}>
            <Sidebar onNew={() => openNew()} />
          </div>
        </div>
        {sidebar && <div className="min-[900px]:hidden absolute inset-0 z-20 bg-black/40" onClick={() => setSidebar(false)} />}
        <main className="flex-1 min-w-0 h-full">
          <Workspace />
        </main>
      </div>
      <StatusBar onToggleSidebar={() => setSidebar((s) => !s)} />
      <Toasts />
      {dialog && <NewSessionDialog preset={newPreset ?? undefined} onClose={() => { setDialog(false); setNewPreset(null); }} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} onNew={() => openNew()} />}
      {addHost && <AddHostWizard onClose={() => setAddHost(false)} />}
    </div>
  );
}
