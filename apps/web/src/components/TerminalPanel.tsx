import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/* v11 terminal colors — JetBrains Mono, abyss palette */
const XTERM_THEME = {
  background: "#0c0d12",
  foreground: "#e9e9f4",
  cursor: "#ff79c6",
  cursorAccent: "#0c0d12",
  selectionBackground: "#3a3d4d",
  black: "#15161e",
  red: "#ff5555",
  green: "#8be9fd" /* palette rule: success reads cyan, not green */,
  yellow: "#ffb86c",
  blue: "#6272a4",
  magenta: "#bd93f9",
  cyan: "#8be9fd",
  white: "#e9e9f4",
  brightBlack: "#3f4a78",
  brightRed: "#ff6e6e",
  brightGreen: "#a5f3fc",
  brightYellow: "#ffd39c",
  brightBlue: "#8b9cd9",
  brightMagenta: "#d0aefc",
  brightCyan: "#a5f3fc",
  brightWhite: "#f8f8ff",
};

export function TerminalPanel({ terminalId }: { terminalId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11.5,
      lineHeight: 1.6,
      theme: XTERM_THEME,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/terminal/${terminalId}/ws`);

    /* fit only once the host has real dimensions — dockview mounts panels
       at zero size before layout, and fit() throws on a zero grid */
    const sendResize = () => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {
        /* mid-layout frame — the observer will fire again */
      }
    };
    requestAnimationFrame(sendResize);

    ws.onopen = sendResize;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "out") term.write(msg.data);
        else if (msg.type === "exit") term.write(`\r\n\x1b[38;2;255;85;85m[process exited ${msg.code}]\x1b[0m\r\n`);
      } catch {
        /* malformed frame */
      }
    };

    const sub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "in", data }));
    });

    const ro = new ResizeObserver(sendResize);
    ro.observe(host);

    return () => {
      ro.disconnect();
      sub.dispose();
      ws.close();
      term.dispose();
    };
  }, [terminalId]);

  return <div className="termhost" ref={hostRef} />;
}
