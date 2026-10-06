import { useEffect, useState } from "react";
import { desktops, useDesktops, type UiSettings } from "@/lib/desktops";
import { useApp } from "@/lib/store";
import { Btn, Icon, Select } from "@/components/ui";
import { cn } from "@/utils/cn";
import type { NetInfo } from "@/lib/proto";

export function SettingsPanel() {
  const settings = useDesktops((s) => s.settings);
  const saveStatus = useDesktops((s) => s.saveStatus);
  const spaces = useDesktops((s) => s.spaces);
  const mode = useApp((s) => s.backend?.mode);
  const [cwd, setCwd] = useState(settings.defaultCwd);
  const [error, setError] = useState("");

  useEffect(() => setCwd(settings.defaultCwd), [settings.defaultCwd]);
  const change = <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => desktops.updateSettings({ [key]: value });

  return (
    <div className="h-full overflow-y-auto t-scroll bg-[var(--t-bg1)]">
      <div className="max-w-[580px] mx-auto px-6 py-7">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg border border-[var(--t-line2)] grid place-items-center text-[var(--t-amber)]">
            <Icon name="settings" size={18} />
          </div>
          <div>
            <h1 className="text-[18px] font-semibold text-[var(--t-fg)] leading-tight">Settings</h1>
            <p className="mt-1 text-[12px] text-[var(--t-dim)]">Your Truss interface. Changes are saved to /api/layout.</p>
          </div>
          <span className={cn("ml-auto text-[11px]", saveStatus === "error" ? "text-[var(--t-red)]" : "text-[var(--t-dim)]")}>
            {saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Save failed" : saveStatus === "saved" ? "Saved" : ""}
          </span>
          {saveStatus === "error" && <Btn variant="outline" size="xs" icon="retry" onClick={() => desktops.retrySave()}>Retry</Btn>}
        </div>

        <section className="mt-9">
          <SectionTitle>Appearance</SectionTitle>
          <Row label="Density" description="How much space navigation and tabs use.">
            <Toggle options={[{ id: "comfortable", name: "Comfortable" }, { id: "compact", name: "Compact" }]} value={settings.density} onChange={(v) => change("density", v as UiSettings["density"])} />
          </Row>
          <Row label="Terminal font size" description="Applies to all shell tabs. Code and terminal keep their monospace font.">
            <Select
              ariaLabel="Terminal font size"
              className="!w-[150px]"
              value={String(settings.terminalFontSize)}
              onChange={(v) => change("terminalFontSize", Number(v))}
              options={[11, 12, 13, 14, 16].map((n) => ({ value: String(n), label: `${n} px` }))}
            />
          </Row>
        </section>

        <section className="mt-8">
          <SectionTitle>Sessions</SectionTitle>
          <Row label="Open sessions" description="What happens when you click a session in the sidebar.">
            <Toggle options={[{ id: "chat", name: "Chat" }, { id: "daily", name: "Full view" }]} value={settings.openMode} onChange={(v) => change("openMode", v as UiSettings["openMode"])} />
          </Row>
          <div className="py-3 border-b border-[var(--t-line)]">
            <div className="text-[12.5px] text-[var(--t-fg)]">Default working directory</div>
            <p className="mt-0.5 mb-2 text-[11.5px] text-[var(--t-dim)]">Prefills new sessions when a host has no specific default.</p>
            <div className="flex gap-2">
              <input aria-label="Default working directory" className="t-input font-code flex-1" value={cwd} onChange={(e) => { setCwd(e.target.value); setError(""); }} placeholder="Use most recent session" />
              <Btn variant="outline" onClick={() => {
                if (cwd.trim() && !cwd.trim().startsWith("/")) { setError("Use an absolute path."); return; }
                change("defaultCwd", cwd.trim());
              }}>Save</Btn>
            </div>
            {error && <div role="alert" className="mt-1 text-[11.5px] text-[var(--t-red)]">{error}</div>}
          </div>
        </section>

        <section className="mt-8">
          <SectionTitle>Workspaces</SectionTitle>
          <p className="text-[12px] text-[var(--t-mute)] leading-relaxed mb-3">
            Think of workspaces as desktops. Each keeps its own tab groups and layout; the same session can appear in several.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-[var(--t-fg2)]">{spaces.length} workspace{spaces.length === 1 ? "" : "s"}</span>
            <Btn variant="outline" icon="plus" className="ml-auto" onClick={() => desktops.create()}>New workspace</Btn>
          </div>
          <p className="mt-2 text-[11.5px] text-[var(--t-dim)]">Switch in the bar above, or with Alt+1–9. Alt+Shift+N creates a workspace, Alt+Shift+W closes the active one, Alt+Shift+Z reopens what you closed. Right-click a tab to copy or move it to another desktop.</p>
          {spaces.some((sp) => sp.archived) && (
            <div className="mt-3">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)] mb-1.5">Archived</div>
              {spaces.filter((sp) => sp.archived).map((sp) => (
                <div key={sp.id} className="flex items-center gap-2 py-1">
                  <Icon name="archive" size={11} className="text-[var(--t-dim)]" />
                  <span className="text-[12px] text-[var(--t-mute)] truncate">{sp.name}</span>
                  <Btn size="xs" variant="ghost" className="ml-auto" onClick={() => desktops.archive(sp.id, false)}>Restore</Btn>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mt-8">
          <SectionTitle>Feed</SectionTitle>
          <p className="text-[12px] text-[var(--t-mute)] leading-relaxed mb-1">
            Which system events post a card to your inbox. Agents can always post explicitly (post_feed) regardless.
          </p>
          {([
            ["permissions", "Decisions", "A session pauses on a permission request"],
            ["workDone", "Work finished", "A running turn settles (one card per turn)"],
            ["taskRuns", "Task-board runs", "A Tasks-board run finishes"],
            ["errors", "Errors", "A harness crashes"],
            ["context", "Context pressure", "A session crosses 85% of its window"],
          ] as const).map(([key, label, desc]) => (
            <Row key={key} label={label} description={desc}>
              <button
                role="switch"
                aria-checked={settings.feedSources[key]}
                onClick={() => change("feedSources", { ...settings.feedSources, [key]: !settings.feedSources[key] })}
                className={cn("w-8 h-4.5 rounded-full relative transition-colors h-[18px]", settings.feedSources[key] ? "bg-[var(--t-teal)]/70" : "bg-[var(--t-line2)]")}
              >
                <span className={cn("absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all", settings.feedSources[key] ? "left-4" : "left-0.5")} />
              </button>
            </Row>
          ))}
        </section>

        <DoubletakeSection />

        <NetworkSection />

        <PracticesSection />

        <div className="mt-9 pt-4 border-t border-[var(--t-line)] text-[11.5px] text-[var(--t-dim)] leading-relaxed">
          {mode === "demo" ? "Demo mode: preferences persist in this browser." : "Preferences and workspace layouts are saved on this Truss server via /api/layout."} Harness and remote node-agent configuration isn't writable through the current API.
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[11px] uppercase tracking-[0.1em] font-medium text-[var(--t-dim)] mb-1">{children}</h2>;
}

/** Integrations — doubletake research cards in the feed. The server polls
    its /api/chats; finished research (answered / failed / capped) posts one
    card per chat that links out to the doubletake chat. */
function DoubletakeSection() {
  const settings = useDesktops((s) => s.settings);
  const dt = settings.doubletake;
  const change = (patch: Partial<typeof dt>) => desktops.updateSettings({ doubletake: { ...dt, ...patch } });
  return (
    <section className="mt-8">
      <SectionTitle>Integrations</SectionTitle>
      <Row label="Doubletake research" description="When a doubletake item finishes (answered, failed, or capped), a card lands in the feed and opens its chat.">
        <button
          role="switch"
          aria-checked={dt.enabled}
          onClick={() => change({ enabled: !dt.enabled })}
          className={cn("w-8 h-4.5 rounded-full relative transition-colors h-[18px]", dt.enabled ? "bg-[var(--t-teal)]/70" : "bg-[var(--t-line2)]")}
        >
          <span className={cn("absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all", dt.enabled ? "left-4" : "left-0.5")} />
        </button>
      </Row>
      {dt.enabled && (
        <>
          <div className="py-3 border-b border-[var(--t-line)]">
            <div className="text-[12.5px] text-[var(--t-fg)]">Base URL</div>
            <p className="mt-0.5 mb-2 text-[11.5px] text-[var(--t-dim)]">Where this box serves doubletake, e.g. https://doubletake.rewis.</p>
            <input
              aria-label="Doubletake base URL"
              className="t-input font-code w-full"
              value={dt.baseUrl}
              onChange={(e) => change({ baseUrl: e.target.value.trim() })}
              placeholder="https://doubletake.rewis"
            />
          </div>
          <div className="py-3 border-b border-[var(--t-line)]">
            <div className="text-[12.5px] text-[var(--t-fg)]">Token</div>
            <p className="mt-0.5 mb-2 text-[11.5px] text-[var(--t-dim)]">Bearer token from doubletake (login or device pairing). Stored in the layout doc on this server.</p>
            <input
              aria-label="Doubletake token"
              type="password"
              className="t-input font-code w-full"
              value={dt.token}
              onChange={(e) => change({ token: e.target.value.trim() })}
              placeholder="leave empty if /api/chats is open"
            />
          </div>
        </>
      )}
    </section>
  );
}

/** Network — how other devices and remote hosts reach this server. */
function NetworkSection() {
  const be = useApp((s) => s.backend);
  const [net, setNet] = useState<NetInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => be?.netInfo().then((n) => { setNet(n); setErr(""); }).catch((e) => setErr(e.message ?? String(e)));
  useEffect(() => { void load(); }, [be]);
  if (!net) return null;
  return (
    <section className="mt-8">
      <SectionTitle>Network</SectionTitle>
      <p className="text-[12px] text-[var(--t-mute)] leading-relaxed mb-2">
        Addresses other devices (and remote node agents) can reach this server on. Everything on the same private network stays in sync.
      </p>
      <div className="rounded-lg border border-[var(--t-line)] overflow-hidden mb-2">
        {net.tailscale.installed && net.tailscale.ip4 && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--t-line)]/50">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-sky)]" />
            <span className="font-mono text-[11.5px] text-[var(--t-fg2)]">{net.tailscale.ip4}</span>
            {net.tailscale.dnsName && <span className="font-mono text-[10.5px] text-[var(--t-dim)] truncate">{net.tailscale.dnsName}</span>}
            <span className="ml-auto text-[9.5px] font-mono uppercase text-[var(--t-sky)]">tailscale</span>
          </div>
        )}
        {net.lan.filter((ip) => ip !== net.tailscale.ip4).map((ip) => (
          <div key={ip} className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--t-line)]/50 last:border-b-0">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-dim)]" />
            <span className="font-mono text-[11.5px] text-[var(--t-fg2)]">{ip}:{net.port}</span>
            <span className="ml-auto text-[9.5px] font-mono uppercase text-[var(--t-dim)]">lan / overlay</span>
          </div>
        ))}
        {!net.tailscale.installed && net.lan.length === 0 && (
          <div className="px-3 py-2 text-[11.5px] text-[var(--t-dim)]">Only loopback. Install tailscale (or any overlay) to reach this server from other machines.</div>
        )}
      </div>
      {net.tailscale.installed && (
        <Row label="Tailscale serve" description={net.tailscale.canServe === false
          ? "This server's user can't write tailscale's serve config — the toggle stays off until then."
          : "Expose Truss on your tailnet with a real https name (tailscale serve). Agents and browsers then reach it at the https name instead of ip:port."}>
          {/* issue #37: grey + guide when the operator isn't set — never a
              bare 400 after the click */}
          {net.tailscale.canServe === false && (
            <span className="text-[10.5px] text-[var(--t-dim)] font-mono">needs: sudo tailscale set --operator=$USER</span>
          )}
          <Btn size="xs" variant={net.tailscale.serveOn ? "outline" : "amber"} disabled={busy || net.tailscale.canServe === false} title={net.tailscale.canServe === false ? "run: sudo tailscale set --operator=$USER (then this works)" : undefined} onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              await be?.tailscaleServe(!net.tailscale.serveOn);
              await load();
            } catch (e: any) {
              setErr(e.message ?? String(e));
            } finally {
              setBusy(false);
            }
          }}>{net.tailscale.serveOn ? "Turn off" : "Turn on"}</Btn>
        </Row>
      )}
      {net.tailscale.serveOn && net.tailscale.serveUrl && (
        <p className="text-[11.5px] text-[var(--t-teal)] font-mono -mt-1 mb-2">serving at {net.tailscale.serveUrl}</p>
      )}
      {err && <p className="text-[11.5px] text-[var(--t-red)]">{err}</p>}
    </section>
  );
}

/** TRUSS.md — the global practices file (coding + posting). Folder/project
    layers are plain TRUSS.md files, editable in the Files panel. */
function PracticesSection() {
  const be = useApp((s) => s.backend);
  const focus = useApp((s) => (s.focused ? s.sessions[s.focused] : undefined));
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [layers, setLayers] = useState<{ path: string; scope: string }[]>([]);
  const [status, setStatus] = useState<"" | "saved" | "error">("");

  useEffect(() => {
    be?.practices().then((r) => setText(r.text)).catch(() => setText(""));
  }, [be]);
  useEffect(() => {
    if (!be || !focus) return;
    be.composePractices(focus.cwd, focus.project).then((r) => setLayers(r.layers.map((l) => ({ path: l.path, scope: l.scope })))).catch(() => {});
  }, [be, focus?.id]);

  if (text === null) return null;
  return (
    <section className="mt-8">
      <SectionTitle>Practices — TRUSS.md</SectionTitle>
      <p className="text-[12px] text-[var(--t-mute)] leading-relaxed mb-2">
        House rules for every harness Truss hosts — coding practices AND posting practices (when to file todos, post reports, how to prioritize). Layers: <span className="font-mono">~/.truss/TRUSS.md</span> (this file) → <span className="font-mono">~/.truss/projects/&lt;project&gt;.md</span> → any <span className="font-mono">TRUSS.md</span> in the session's folder chain (edit those in a Files tab).
      </p>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true); setStatus(""); }}
        spellCheck={false}
        rows={10}
        className="t-input w-full resize-y font-mono text-[11.5px] leading-relaxed"
        aria-label="Global TRUSS.md"
      />
      <div className="flex items-center gap-2 mt-2">
        <Btn size="xs" variant="amber" disabled={!dirty} onClick={() => {
          void be?.savePractices(text).then(() => { setDirty(false); setStatus("saved"); }).catch(() => setStatus("error"));
        }}>Save practices</Btn>
        {status === "saved" && <span className="text-[11px] text-[var(--t-teal)]">Saved — agents see it on their next tool call.</span>}
        {status === "error" && <span className="text-[11px] text-[var(--t-red)]">Save failed.</span>}
      </div>
      {layers.length > 0 && (
        <p className="mt-2 text-[11px] text-[var(--t-dim)] leading-relaxed">
          Active layers for <span className="font-mono">{focus?.title}</span>: {layers.map((l) => `${l.scope} ${l.path.replace(/^\/home\/[^/]+/, "~")}`).join(" → ")}
        </p>
      )}
    </section>
  );
}

function Row({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 border-b border-[var(--t-line)]">
      <div className="flex-1 min-w-[180px]">
        <div className="text-[12.5px] text-[var(--t-fg)]">{label}</div>
        <p className="mt-0.5 text-[11.5px] text-[var(--t-dim)]">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Toggle({ options, value, onChange }: { options: { id: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-md border border-[var(--t-line2)] p-0.5" role="group">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} aria-pressed={value === o.id} className={cn("h-7 px-2.5 rounded text-[11.5px] transition-colors", value === o.id ? "bg-[var(--t-bg3)] text-[var(--t-fg)]" : "text-[var(--t-dim)] hover:text-[var(--t-fg2)]")}>{o.name}</button>
      ))}
    </div>
  );
}