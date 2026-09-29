import { useEffect, useMemo, useRef, useState } from "react";
import { store, useApp } from "@/lib/store";
import { ago } from "@/lib/format";
import type { TailscalePeer } from "@/lib/proto";
import { Btn, Icon, Select, Spinner } from "./ui";
import { cn } from "@/utils/cn";

/**
 * Add-host wizard: name + how the remote reaches this server → a one-line
 * installer command (per-host token embedded, shown once) → live "waiting for
 * the agent" state that flips when it dials in.
 */
export function AddHostWizard({ onClose }: { onClose: () => void }) {
  const be = useApp((s) => s.backend);
  const hosts = useApp((s) => s.hosts);
  const [step, setStep] = useState(1);
  const [label, setLabel] = useState("");
  const [method, setMethod] = useState<"tailscale" | "direct">("tailscale");
  const [net, setNet] = useState<{ port: number; tailscale: { installed: boolean; ip4?: string; dnsName?: string; serveOn?: boolean; serveUrl?: string }; lan: string[] } | null>(null);
  const [peers, setPeers] = useState<{ self?: TailscalePeer; peers: TailscalePeer[] } | null>(null);
  const [pickedPeer, setPickedPeer] = useState<string | null>(null); // dnsName
  const labelTouched = useRef(false);
  const [customAddr, setCustomAddr] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    be?.netInfo().then(setNet).catch(() => setNet(null));
    be?.tailscalePeers().then(setPeers).catch(() => setPeers(null));
  }, [be]);

  /* picking a tailnet device names the host (until the user edits the name
     by hand — after that, clicks stop clobbering it) */
  const pickPeer = (p: TailscalePeer) => {
    setPickedPeer(p.dnsName);
    if (!labelTouched.current) setLabel(p.hostName);
  };

  /* address the remote will use to reach this server */
  const addresses = useMemo(() => {
    if (!net) return [];
    const out: { value: string; label: string }[] = [];
    if (method === "tailscale") {
      if (net.tailscale.serveOn && net.tailscale.serveUrl) out.push({ value: net.tailscale.serveUrl, label: `${net.tailscale.serveUrl} (tailscale serve, https)` });
      if (net.tailscale.dnsName) out.push({ value: `http://${net.tailscale.dnsName}:${net.port}`, label: `${net.tailscale.dnsName} (tailnet name)` });
      if (net.tailscale.ip4) out.push({ value: `http://${net.tailscale.ip4}:${net.port}`, label: `${net.tailscale.ip4} (tailnet ip)` });
    }
    for (const ip of net.lan) {
      if (ip === net.tailscale.ip4) continue; // already offered as the tailnet address
      out.push({ value: `http://${ip}:${net.port}`, label: `${ip} (lan/overlay)` });
    }
    out.push({ value: "custom", label: "custom address…" });
    return out;
  }, [net, method]);

  const [addr, setAddr] = useState("");
  useEffect(() => setAddr(addresses[0]?.value ?? "custom"), [addresses]);
  const serverAddr = addr === "custom" ? customAddr.trim() : addr;

  const create = async () => {
    if (!label.trim() || !be) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await be.createHost(label.trim());
      setCreated({ id: r.host.id, token: r.token });
      setStep(2);
      void store.refreshHosts();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  /* step 3: poll until the agent dials in */
  const online = created ? hosts.find((h) => h.id === created.id)?.online : false;
  useEffect(() => {
    if (step !== 3 || online) return;
    const t = window.setInterval(() => void store.refreshHosts(), 2000);
    return () => window.clearInterval(t);
  }, [step, online]);

  const command = created && serverAddr
    ? `curl -fsSL ${serverAddr}/agent/install.sh?host=${created.id} | sh -s -- ${created.token}`
    : "";

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/50" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Add a remote host" className="w-[520px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-48px)] overflow-y-auto t-scroll rounded-xl border border-[var(--t-line2)] bg-[var(--t-bg1)] shadow-2xl p-5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg border border-[var(--t-line2)] grid place-items-center text-[var(--t-sky)]"><Icon name="host" size={16} /></div>
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--t-fg)] leading-tight">Add a remote host</h2>
            <p className="text-[11.5px] text-[var(--t-dim)]">Run harnesses on another machine; sessions tunnel back over one outbound connection.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="ml-auto text-[var(--t-dim)] hover:text-[var(--t-fg)]"><Icon name="x" size={14} /></button>
        </div>

        {/* step dots */}
        <div className="mt-4 flex items-center gap-1.5 text-[10px] font-mono text-[var(--t-dim)]">
          {["name + network", "run the installer", "connect"].map((s, i) => (
            <span key={s} className={cn("flex items-center gap-1", step === i + 1 && "text-[var(--t-amber)]")}>
              <span className={cn("w-3.5 h-3.5 rounded-full grid place-items-center border", step > i + 1 ? "border-[var(--t-teal)] text-[var(--t-teal)]" : step === i + 1 ? "border-[var(--t-amber)]" : "border-[var(--t-line2)]")}>{step > i + 1 ? "✓" : i + 1}</span>
              {s}{i < 2 && <span className="mx-1 text-[var(--t-line2)]">→</span>}
            </span>
          ))}
        </div>

        {step === 1 && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-[11.5px] text-[var(--t-mute)] mb-1">Name</label>
              <input autoFocus value={label} onChange={(e) => { labelTouched.current = true; setLabel(e.target.value); }} onKeyDown={(e) => e.key === "Enter" && void create()} placeholder="fedora box, mac mini, gpu rig…" className="t-input w-full" />
            </div>
            <div>
              <label className="block text-[11.5px] text-[var(--t-mute)] mb-1">How does the remote reach this server?</label>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setMethod("tailscale")} className={cn("rounded-lg border p-2.5 text-left", method === "tailscale" ? "border-[var(--t-amber)] bg-[var(--t-amber)]/5" : "border-[var(--t-line)] hover:border-[var(--t-line2)]")}>
                  <div className="text-[12px] text-[var(--t-fg)] font-medium">Tailscale</div>
                  <div className="text-[10.5px] text-[var(--t-dim)] leading-snug mt-0.5">
                    {net?.tailscale.installed ? `detected here — ${net.tailscale.dnsName ?? net.tailscale.ip4}` : "not detected on this server"}
                  </div>
                </button>
                <button onClick={() => setMethod("direct")} className={cn("rounded-lg border p-2.5 text-left", method === "direct" ? "border-[var(--t-amber)] bg-[var(--t-amber)]/5" : "border-[var(--t-line)] hover:border-[var(--t-line2)]")}>
                  <div className="text-[12px] text-[var(--t-fg)] font-medium">Direct address</div>
                  <div className="text-[10.5px] text-[var(--t-dim)] leading-snug mt-0.5">LAN IP, NetBird, ZeroTier, WireGuard, or a public IP — anything reachable</div>
                </button>
              </div>
            </div>
            {method === "tailscale" && net?.tailscale.installed && peers && (
              <div>
                <label className="block text-[11.5px] text-[var(--t-mute)] mb-1">Which tailnet device?</label>
                <div className="rounded-lg border border-[var(--t-line)] divide-y divide-[var(--t-line)]/60 max-h-44 overflow-y-auto t-scroll">
                  {/* this server itself, for orientation — not selectable */}
                  {peers.self && (
                    <div className="flex items-center gap-2.5 px-2.5 py-1.5 opacity-55" title="this machine is the Truss server">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-teal)] shrink-0" />
                      <span className="min-w-0 truncate text-[12px] text-[var(--t-fg2)]">{peers.self.hostName}</span>
                      <span className="text-[10px] font-mono text-[var(--t-dim)] shrink-0">{peers.self.ip4}</span>
                      <span className="ml-auto text-[9.5px] font-mono uppercase tracking-wider text-[var(--t-dim)] shrink-0">this server</span>
                    </div>
                  )}
                  {peers.peers.map((p) => {
                    const already = hosts.some((h) => h.label.trim().toLowerCase() === p.hostName.trim().toLowerCase());
                    const sel = pickedPeer === p.dnsName;
                    return (
                      <button
                        key={p.dnsName}
                        type="button"
                        disabled={!p.online}
                        onClick={() => pickPeer(p)}
                        title={`${p.dnsName}${p.online ? "" : ` — offline${p.lastSeen ? `, last seen ${ago(Date.parse(p.lastSeen))} ago` : ""}`}${already ? " · already on your hosts list" : ""}`}
                        className={cn(
                          "w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors",
                          p.online ? "hover:bg-white/[0.04] cursor-pointer" : "opacity-45 cursor-not-allowed",
                          sel && "bg-[var(--t-amber)]/8",
                        )}
                      >
                        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", p.online ? "bg-[var(--t-teal)]" : "bg-[var(--t-line2)]")} />
                        <span className="min-w-0 truncate text-[12px] text-[var(--t-fg)]">{p.hostName}</span>
                        {sel && <Icon name="check" size={11} className="text-[var(--t-amber)] shrink-0" />}
                        <span className="text-[10px] font-mono text-[var(--t-dim)] shrink-0 hidden sm:inline">{p.ip4}</span>
                        <span className="ml-auto flex items-center gap-1.5 shrink-0">
                          {p.exitNodeOption && <span className="text-[9px] font-mono uppercase tracking-wider text-[var(--t-sky)]">exit node</span>}
                          {already && <span className="text-[9px] font-mono uppercase tracking-wider text-[var(--t-teal)]">added</span>}
                          {p.os && <span className="text-[10px] font-mono text-[var(--t-dim)]">{p.os}</span>}
                          {!p.online && p.lastSeen && <span className="text-[10px] font-mono text-[var(--t-dim)]">{ago(Date.parse(p.lastSeen))}</span>}
                        </span>
                      </button>
                    );
                  })}
                  {peers.peers.length === 0 && (
                    <div className="px-2.5 py-2 text-[11px] text-[var(--t-dim)]">No other devices on the tailnet yet — add one with <span className="font-mono text-[var(--t-mute)]">sudo tailscale up</span> on the remote.</div>
                  )}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Select width="100%" className="flex-1" ariaLabel="Server address" value={addr} onChange={setAddr} options={addresses.map((a) => ({ value: a.value, label: a.label }))} />
            </div>
            {addr === "custom" && (
              <input value={customAddr} onChange={(e) => setCustomAddr(e.target.value)} placeholder="http://192.168.1.10:4040" className="t-input w-full font-mono text-[11.5px]" />
            )}
            {method === "tailscale" && net?.tailscale.installed && (
              <p className="text-[10.5px] text-[var(--t-dim)] leading-relaxed">
                The remote needs tailscale too: <span className="font-mono text-[var(--t-mute)]">curl -fsSL https://tailscale.com/install.sh | sh</span> then <span className="font-mono text-[var(--t-mute)]">sudo tailscale up</span>. ZeroTier/NetBird/WireGuard work the same way — use their address under Direct.
              </p>
            )}
            {serverAddr && !/localhost|127\.0\.0\.1|\[::1\]|\.ts\.net(:\d+)?$|^(https?:\/\/)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d)\.)/.test(serverAddr) && (
              <p className="text-[11px] text-[var(--t-coral)] leading-relaxed">Heads up: that address isn't loopback or a known-private range. The agent channel is plaintext ws:// — only use it over a trusted overlay (tailscale/WireGuard encrypt for you), never over the open internet.</p>
            )}
            {err && <p className="text-[11px] text-[var(--t-red)]">{err}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn variant="amber" disabled={!label.trim() || !serverAddr || busy} onClick={() => void create()}>Create host</Btn>
            </div>
          </div>
        )}

        {step === 2 && created && (
          <div className="mt-4 space-y-3">
            <p className="text-[12px] text-[var(--t-mute)] leading-relaxed">
              Run this on <b className="text-[var(--t-fg)]">{label}</b>. It installs the agent into <span className="font-mono">~/.truss/</span> (and a user service when systemd is there). The token is in the command and lands in a chmod-600 env file — <b className="text-[var(--t-fg)]">shown only now</b>; Truss stores just its hash.
            </p>
            <div className="rounded-lg border border-[var(--t-line2)] bg-[var(--t-bg0)] p-3 font-mono text-[11px] leading-relaxed text-[var(--t-fg2)] break-all select-all">{command}</div>
            <div className="flex items-center gap-2">
              <Btn size="xs" variant="outline" icon="copy" onClick={() => { void navigator.clipboard.writeText(command); store.toast("ok", "Copied", "run it on the remote host"); }}>Copy command</Btn>
              <span className="text-[10.5px] text-[var(--t-dim)]">needs node ≥ 20 on the remote + the harness CLIs it should host</span>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Btn variant="ghost" onClick={() => setStep(1)}>Back</Btn>
              <Btn variant="amber" onClick={() => setStep(3)}>It's running →</Btn>
            </div>
          </div>
        )}

        {step === 3 && created && (
          <div className="mt-6 mb-2 text-center">
            {online ? (
              <>
                <div className="inline-grid place-items-center w-10 h-10 rounded-full bg-[var(--t-teal)]/15 text-[var(--t-teal)]"><Icon name="check" size={18} /></div>
                <h3 className="mt-3 text-[14px] font-medium text-[var(--t-fg)]">{label} is online</h3>
                <p className="mt-1 text-[11.5px] text-[var(--t-dim)]">Its harnesses appear in New Session as <span className="font-mono">pi@{created.id}</span>-style ids. Remote sessions show up in the sidebar like any other.</p>
                <div className="mt-4 flex justify-center gap-2">
                  <Btn variant="amber" onClick={onClose}>Done</Btn>
                </div>
              </>
            ) : (
              <>
                <Spinner size={20} />
                <h3 className="mt-3 text-[14px] font-medium text-[var(--t-fg)]">Waiting for {label}…</h3>
                <p className="mt-1 text-[11.5px] text-[var(--t-dim)]">The agent dials out to this server, so no inbound ports or firewall holes are needed. This page flips the moment it connects.</p>
                <div className="mt-4 flex justify-center gap-2">
                  <Btn variant="ghost" onClick={() => setStep(2)}>Back to the command</Btn>
                  <Btn variant="outline" onClick={onClose}>Finish later</Btn>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
