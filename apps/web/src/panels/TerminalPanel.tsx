import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { store, useApp } from "@/lib/store";
import { cn } from "@/utils/cn";
import { desktops, useDesktops } from "@/lib/desktops";
import { shortPath } from "@/lib/format";
import { Btn, Icon } from "@/components/ui";
import { openFreeShell, getDockApi } from "@/lib/workspace";

type P = { terminalId: string; sessionId?: string; cwd?: string };

const THEME = {
  background: "#0b0c0e",
  foreground: "#d9d4ca",
  cursor: "#f0b35a",
  cursorAccent: "#0b0c0e",
  selectionBackground: "#f0b35a40",
  black: "#1a1c20", brightBlack: "#5b5f66",
  red: "#ef6b5b", brightRed: "#ff8a7a",
  green: "#8fcf7a", brightGreen: "#a9e394",
  yellow: "#f0b35a", brightYellow: "#ffcb7d",
  blue: "#6fa8e8", brightBlue: "#92c1f5",
  magenta: "#a99bf0", brightMagenta: "#c4b9ff",
  cyan: "#5fc9c0", brightCyan: "#84e0d8",
  white: "#d9d4ca", brightWhite: "#ffffff",
};

export function TerminalPanel({ params, api, containerApi }: IDockviewPanelProps<P>) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ kind: "connecting" | "live" | "exited"; code?: number }>({ kind: "connecting" });
  const meta = useApp((s) => s.terminals.find((t) => t.id === params.terminalId));
  const session = useApp((s) => (params.sessionId ? s.sessions[params.sessionId] : undefined));
  const backend = useApp((s) => s.backend);
  const fontSize = useDesktops((s) => s.settings.terminalFontSize);
  const workspaceActive = useDesktops((s) => desktops.getApi(s.activeId) === containerApi);
  const activeRef = useRef(workspaceActive);
  const refit = useRef<() => void>(() => {});
  activeRef.current = workspaceActive;
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (workspaceActive) requestAnimationFrame(() => refit.current());
  }, [workspaceActive]);

  useEffect(() => {
    const el = host.current;
    if (!el || !backend) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize,
      lineHeight: 1.25,
      cursorBlink: !reduce,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let lastSent = { cols: 0, rows: 0 };
    const conn = backend.connectTerminal(params.terminalId, {
      onHello: (h) => {
        setStatus(h.alive ? { kind: "live" } : { kind: "exited" });
        if (h.title && h.title !== api.title) api.setTitle(h.title);
      },
      onOut: (d) => term.write(d),
      onExit: (code) => {
        setStatus({ kind: "exited", code });
        term.write(`\r\n\x1b[2m[process exited${code !== undefined ? ` · code ${code}` : ""}]\x1b[0m\r\n`);
      },
      onError: (m) => store.toast("error", "Terminal connection problem", m),
    });
    const doFit = () => {
      if (el.clientWidth < 20 || el.clientHeight < 20) return; // xterm fit() throws on zero-size hosts
      try {
        fit.fit();
      } catch {
        return;
      }
      // A terminal can be open in several desktops. Only the visible one owns
      // pty sizing, so hidden copies never fight over the server's dimensions.
      if (activeRef.current && (term.cols !== lastSent.cols || term.rows !== lastSent.rows)) {
        lastSent = { cols: term.cols, rows: term.rows };
        conn.resize(term.cols, term.rows);
      }
    };
    refit.current = doFit;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(doFit);
    });
    ro.observe(el);
    requestAnimationFrame(doFit);
    const sub = term.onData((d) => conn.send(d));
    const vis = api.onDidVisibilityChange?.((e: { isVisible: boolean }) => e.isVisible && requestAnimationFrame(doFit));
    const act = api.onDidActiveChange?.((e: { isActive: boolean }) => e.isActive && term.focus());
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      sub.dispose();
      vis?.dispose();
      act?.dispose();
      conn.close();
      term.dispose();
      refit.current = () => {};
    };
  }, [params.terminalId, backend, nonce, fontSize]);

  const cwd = meta?.cwd ?? session?.cwd ?? params.cwd;
  return (
    <div className="h-full flex flex-col bg-[#0b0c0e]">
      <div className="shrink-0 flex items-center gap-2 px-3 h-6 border-b border-[var(--t-line)] text-[10.5px] text-[var(--t-dim)]" title={`${params.terminalId}${session ? ` · agent shell for “${session.title}”` : ""}`}>
        <span
          className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", status.kind !== "live" && status.kind !== "exited" && "t-pulse")}
          style={{ background: status.kind === "live" ? "var(--t-teal)" : status.kind === "exited" ? "var(--t-red)" : "var(--t-amber)" }}
        />
        <span>{status.kind === "live" ? "attached" : status.kind === "exited" ? `exited${status.code !== undefined ? ` (${status.code})` : ""}` : "attaching…"}</span>
        {cwd && <><span>·</span><span className="truncate">{shortPath(cwd)}</span></>}
      </div>
      <div className="relative flex-1 min-h-0">
        <div ref={host} className="absolute inset-0 pl-2 pt-1" />
        {status.kind === "exited" && (
          <div className="absolute right-3 bottom-3 flex items-center gap-2 rounded-md bg-[var(--t-bg2)] border border-[var(--t-line2)] px-2.5 py-1.5 shadow-xl">
            <Icon name="power" size={12} className="text-[var(--t-red)]" />
            <span className="text-[11.5px] text-[var(--t-mute)]">shell ended</span>
            <Btn size="xs" variant="outline" onClick={() => setNonce((n) => n + 1)}>Reattach</Btn>
            <Btn
              size="xs"
              variant="amber"
              onClick={async () => {
                await desktops.killTerminal(params.terminalId);
                await openFreeShell(cwd);
                getDockApi()?.getPanel(api.id)?.api.close();
              }}
            >
              New shell
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
