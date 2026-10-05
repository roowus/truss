import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow } from "@/lib/store";
import { desktops, useDesktops, type HostPreference } from "@/lib/desktops";
import { ago, harnessStyle, hostOf, shortPath } from "@/lib/format";
import { harnessDisplay, hostAliases } from "@/lib/device";
import { openPanel, renameHostPanels } from "@/lib/workspace";
import { agentRunCommand } from "@/lib/installCommand";
import { Btn, HarnessMark, Icon, Select, StateDot } from "@/components/ui";
import { cn } from "@/utils/cn";

const blank: HostPreference = { alias: "", defaultCwd: "", defaultProject: "", preferredAdapter: "" };

export function HostPanel({ params }: IDockviewPanelProps<{ hostId: string }>) {
  const hostId = params.hostId;
  const host = useApp((s) => s.hosts.find((h) => h.id === hostId));
  const hosts = useApp((s) => s.hosts);
  const hostPrefs = useDesktops((s) => s.hosts);
  const agent = host?.agent;
  const error = useApp((s) => s.agentsError);
  const harnesses = useApp((s) => s.harnesses);
  const models = useApp((s) => s.models);
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const saved = useDesktops((s) => s.hosts[hostId]);
  const saveStatus = useDesktops((s) => s.saveStatus);
  const [form, setForm] = useState<HostPreference>(() => ({ ...blank, ...saved }));
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const now = useNow(30_000);
  const [expandedAdapter, setExpandedAdapter] = useState<string | null>(null);

  useEffect(() => setForm({ ...blank, ...saved }), [saved]);
  const remoteHarnesses = useMemo(() => harnesses.filter((h) => {
    const suffix = hostOf(h.id);
    if (!suffix) return false; // local harness (no @host) is never "on this host"
    const hn = agent?.hostname;
    return suffix === hostId || (hn !== undefined && (suffix === hn || suffix === hn.split(".")[0]));
  }), [harnesses, hostId, agent?.hostname]);
  const remoteSessions = order.map((id) => sessions[id]).filter((s) => s && (remoteHarnesses.some((h) => h.id === s.harness) || hostOf(s.harness) === hostId));
  const name = saved?.alias?.trim() || agent?.hostname || host?.label || hostId;

  const edit = (patch: Partial<HostPreference>) => {
    setForm((current) => ({ ...current, ...patch }));
    setSubmitted(false);
    setMessage("");
  };

  const save = () => {
    const next = {
      alias: form.alias.trim().slice(0, 40),
      defaultCwd: form.defaultCwd.trim(),
      defaultProject: form.defaultProject.trim(),
      preferredAdapter: form.preferredAdapter,
    };
    if (next.defaultCwd && !next.defaultCwd.startsWith("/")) {
      setMessage("Default directory must be an absolute path.");
      return;
    }
    desktops.updateHost(hostId, next);
    renameHostPanels(hostId, next.alias || agent?.hostname || host?.label || hostId);
    setSubmitted(true);
    setMessage("");
  };

  const newSession = () => {
    const selected = remoteHarnesses.find((h) => h.id === form.preferredAdapter) ?? remoteHarnesses[0];
    if (!selected) return;
    window.dispatchEvent(new CustomEvent("truss:new", {
      detail: { harness: selected.id, cwd: form.defaultCwd, project: form.defaultProject },
    }));
  };

  return (
    <div className="h-full overflow-y-auto t-scroll bg-[var(--t-bg1)]">
      <div className="max-w-[640px] mx-auto px-6 py-6">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg border border-[var(--t-line2)] grid place-items-center text-[var(--t-sky)]">
            <Icon name="host" size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[18px] text-[var(--t-fg)] font-semibold leading-tight truncate">{name}</h1>
            <div className="mt-0.5 text-[12px] text-[var(--t-dim)] truncate flex items-center gap-1.5">
              <span className={cn("inline-block w-1.5 h-1.5 rounded-full", host?.online ? "bg-[var(--t-teal)]" : "bg-[var(--t-line2)]")} />
              {agent?.hostname || host?.label || hostId} · {host?.online ? "online" : host?.lastSeen ? `last seen ${ago(host.lastSeen, now)}` : "never connected"}
            </div>
          </div>
          <Btn variant="ghost" icon="retry" disabled={refreshing} onClick={async () => {
            setRefreshing(true);
            await Promise.all([store.refreshHosts(), store.refreshAgents(), store.refreshHarnesses()]);
            setRefreshing(false);
          }} title="Refresh from /api/agents and /api/harnesses">{refreshing ? "Refreshing" : "Refresh"}</Btn>
        </div>

        {error && (
          <div role="alert" className="mt-5 flex items-start gap-2 text-[12px] text-[var(--t-red)]">
            <Icon name="alert" size={13} className="mt-0.5" /> /api/agents: {error}
          </div>
        )}
        {host && !host.online && !error && (
          /* issue #100: re-running the frozen env recirculates a dead address
             forever, undetected — the banner now names that failure mode */
          <div className="mt-5 rounded-lg border border-[var(--t-line2)] bg-[var(--t-bg0)] px-3 py-2.5 text-[12px] text-[var(--t-mute)] leading-relaxed">
            Offline. On the host: <span className="font-mono text-[var(--t-fg2)]">{agentRunCommand(hostId)}</span>
            {host.revoked && <span className="text-[var(--t-red)]"> — its token is revoked; rotate it below to allow reconnection.</span>}
            {" If the agent's log loops connection refused, the env file's frozen address is one this server can't answer — re-copy a fresh install command from the add-host wizard instead of re-running the old env."}
            {" If it exits instantly with an error instead of looping, the installed bundle itself is stale or broken: re-run the installer from the wizard (re-send the drop or the short command), not just the agent — the run command alone keeps the old bundle on disk."}
          </div>
        )}
        {!host && !error && <div className="mt-5 text-[12px] text-[var(--t-amber)]">This host is not registered. Add it from the sidebar's remote hosts section.</div>}

        <div className="mt-7 flex items-center gap-3">
          <Btn variant="amber" size="md" icon="plus" onClick={newSession} disabled={remoteHarnesses.length === 0}>New session on {name}</Btn>
          {!remoteHarnesses.length && <span className="text-[11.5px] text-[var(--t-dim)]">No remote harness is available in /api/harnesses.</span>}
        </div>

        <section className="mt-9">
          <SectionTitle>Connected adapters</SectionTitle>
          {agent?.adapters?.length ? agent.adapters.map((adapter) => {
            const h = remoteHarnesses.find((x) => x.id.split("@")[0] === adapter);
            const count = h ? models.filter((m) => m.harness === h.id).length : 0;
            const meta = harnessStyle(adapter);
            return (
              <div key={adapter} className="border-b border-[var(--t-line)]">
                <button onClick={() => setExpandedAdapter(expandedAdapter === adapter ? null : adapter)} aria-expanded={expandedAdapter === adapter} className="w-full flex items-center gap-2 py-2 text-left hover:bg-white/[0.02]">
                  <HarnessMark harness={adapter} size={20} />
                  <span className="text-[12.5px] text-[var(--t-fg2)]">{meta.name}</span>
                  <span className="text-[11px] text-[var(--t-dim)]">{h?.id ?? adapter}</span>
                  <span className="ml-auto text-[11px] text-[var(--t-dim)]">{h ? `${count} model${count === 1 ? "" : "s"}` : "not available"}</span>
                  <Icon name="chev" size={11} className={cn("text-[var(--t-dim)] transition-transform", expandedAdapter === adapter && "rotate-90")} />
                </button>
                {expandedAdapter === adapter && (
                  <div className="pb-2 pl-7 text-[11.5px] text-[var(--t-mute)] space-y-1">
                    {h ? (
                      <>
                        <div>Streaming{h.capabilities.streaming ? " on" : " off"} · permissions{h.capabilities.permissions ? " on" : " off"} · subagents{h.capabilities.subagents ? " on" : " off"} · mid-run input{h.capabilities.queueWhileRunning ? " on" : " off"}</div>
                        <div>{models.filter((m) => m.harness === h.id).map((m) => m.label).join(" · ") || "No models reported for this adapter."}</div>
                      </>
                    ) : <div>This adapter is listed by the host but not exposed by /api/harnesses.</div>}
                  </div>
                )}
              </div>
            );
          }) : <p className="text-[12px] text-[var(--t-dim)]">No adapters reported.</p>}
          <p className="mt-2 text-[11.5px] text-[var(--t-dim)]">Listed by /api/agents; this is not a health check of the host process.</p>
        </section>

        <section className="mt-9">
          <SectionTitle>Sessions on this host <span className="text-[var(--t-dim)] font-normal">{remoteSessions.length}</span></SectionTitle>
          {remoteSessions.length ? remoteSessions.map((s) => (
            <button key={s.id} onClick={() => openPanel("chat", { sessionId: s.id })} className="w-full flex items-center gap-2 py-2 border-b border-[var(--t-line)] text-left hover:bg-white/[0.02]">
              <StateDot state={s.state} size={7} />
              <span className="flex-1 truncate text-[12.5px] text-[var(--t-fg2)]">{s.title}</span>
              <span className="text-[11px] text-[var(--t-dim)] truncate max-w-[180px]">{shortPath(s.cwd)}</span>
              <Icon name="chev" size={11} className="text-[var(--t-dim)]" />
            </button>
          )) : <p className="text-[12px] text-[var(--t-dim)]">No sessions yet. Sessions are shared across all workspaces.</p>}
        </section>

        <section className="mt-9">
          <SectionTitle>Connection & token</SectionTitle>
          <p className="text-[12px] text-[var(--t-mute)] leading-relaxed mb-3">
            The agent authenticates with this host's own token (stored as a hash; the plaintext was shown once at setup). Revoke kills the channel for this host only; rotate mints a fresh one (update the env file on the host after rotating).
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-[var(--t-dim)]">token {host?.tokenPrefix ?? "…"}</span>
            <span className={cn("text-[10px] font-mono px-1.5 rounded", host?.revoked ? "bg-[var(--t-red)]/12 text-[var(--t-red)]" : "bg-[var(--t-teal)]/12 text-[var(--t-teal)]")}>{host?.revoked ? "revoked" : "active"}</span>
            <span className="ml-auto" />
            <Btn size="xs" variant="outline" icon="retry" onClick={async () => {
              const r = await store.be?.rotateHostToken(hostId);
              if (r) setNewToken(r.token);
            }}>Rotate</Btn>
            <Btn size="xs" variant={host?.revoked ? "outline" : "ghost"} onClick={() => void store.be?.revokeHost(hostId, !host?.revoked).then(() => store.refreshHosts())}>{host?.revoked ? "Enable" : "Revoke"}</Btn>
            <Btn size="xs" variant="ghost" icon="trash" className="text-[var(--t-red)]" onClick={async () => {
              if (!confirmDelete) { setConfirmDelete(true); return; }
              await store.be?.deleteHost(hostId);
              await store.refreshHosts();
            }}>{confirmDelete ? "Confirm delete" : "Delete host"}</Btn>
          </div>
          {newToken && (
            <div className="mt-2 rounded-lg border border-[var(--t-amber)]/40 bg-[var(--t-amber)]/5 p-3">
              <div className="text-[11px] text-[var(--t-amber)] mb-1">New token — shown once. Put it in the host's env file (~/.truss/agent-{hostId}.env):</div>
              <div className="font-mono text-[11px] text-[var(--t-fg)] break-all select-all">{newToken}</div>
              <Btn size="xs" variant="ghost" className="mt-2" onClick={() => setNewToken(null)}>I've saved it</Btn>
            </div>
          )}
          {/* version handshake (issue #100): installed agents never
              auto-update — the skew must at least be visible */}
          {agent?.bundleHash && (
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--t-dim)]">
              agent bundle <span className="font-mono">{agent.bundleHash}</span>
              {agent.protocol ? ` · protocol ${agent.protocol}` : ""}
              {agent.bundleCurrent === false && (
                <span className="text-[var(--t-amber)]"> — older than this server's build; re-run the installer from the add-host wizard to upgrade</span>
              )}
            </p>
          )}
        </section>

        <section className="mt-9">
          <SectionTitle>Truss defaults for this host</SectionTitle>
          <p className="text-[12px] text-[var(--t-mute)] leading-relaxed mb-4">
            These change how this host appears in Truss and prefill new sessions. They do not change the node-agent's server configuration.
          </p>
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-4">
            <Field label="Display name">
              <input className="t-input" value={form.alias} onChange={(e) => edit({ alias: e.target.value })} placeholder={agent?.hostname || host?.label || hostId} maxLength={40} />
            </Field>
            <Field label="Preferred adapter">
              <Select
                className="w-full"
                value={form.preferredAdapter}
                onChange={(v) => edit({ preferredAdapter: v })}
                ariaLabel="Preferred adapter"
                options={[
                  { value: "", label: "First available" },
                  ...remoteHarnesses.map((h) => ({ value: h.id, label: harnessDisplay(h.id, hosts, hostAliases(hostPrefs)) })),
                ]}
              />
            </Field>
            <Field label="Default working directory">
              <input className="t-input font-code" value={form.defaultCwd} onChange={(e) => edit({ defaultCwd: e.target.value })} placeholder="/home/user/project" />
            </Field>
            <Field label="Default project">
              <input className="t-input" value={form.defaultProject} onChange={(e) => edit({ defaultProject: e.target.value })} placeholder="Optional" />
            </Field>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <Btn variant="outline" icon="check" onClick={save}>Save defaults</Btn>
            {message && <span role="alert" className="text-[11.5px] text-[var(--t-red)]">{message}</span>}
            {!message && submitted && <span className={cn("text-[11.5px]", saveStatus === "error" ? "text-[var(--t-red)]" : saveStatus === "saved" ? "text-[var(--t-teal)]" : "text-[var(--t-dim)]")}>{saveStatus === "error" ? "Not saved" : saveStatus === "saved" ? "Saved" : "Saving…"}</span>}
            {submitted && saveStatus === "error" && <Btn size="xs" variant="outline" icon="retry" onClick={() => desktops.retrySave()}>Retry</Btn>}
          </div>
        </section>

        <div className="mt-9 pt-3 border-t border-[var(--t-line)] text-[11px] text-[var(--t-dim)] leading-relaxed">
          Host ID: <span className="font-code">{hostId}</span>. Node-agent transport, credentials, environment, and adapter installation are not editable because the current API exposes no write endpoint for them.
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-[12px] font-semibold text-[var(--t-fg)] flex items-center gap-1.5">{children}</h2>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block mb-1.5 text-[11px] text-[var(--t-mute)]">{label}</span>{children}</label>;
}