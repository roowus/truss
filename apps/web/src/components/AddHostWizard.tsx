import { useEffect, useMemo, useRef, useState } from "react";
import { store, useApp } from "@/lib/store";
import { ago, until } from "@/lib/format";
import { peerAlreadyAdded } from "@/lib/device";
import { dropInstructionLabel } from "@/lib/installInstruction";
import { buildInstallCommand, agentRunCommand } from "@/lib/installCommand";
import { reachableAddresses, reachableTailscaleReturn } from "@/lib/reachability";
import type { DeliveryOption, NetInfo, TailscalePeer } from "@/lib/proto";
import QRCode from "qrcode";
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
  const [net, setNet] = useState<NetInfo | null>(null);
  const [peers, setPeers] = useState<{ self?: TailscalePeer; peers: TailscalePeer[] } | null>(null);
  const [pickedPeer, setPickedPeer] = useState<string | null>(null); // dnsName
  const labelTouched = useRef(false);
  const [customAddr, setCustomAddr] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /* installer delivery (issue #1): taildrop to the picked device, or mint a
     short typeable pairing command */
  const [pairCmd, setPairCmd] = useState<{ command: string; code: string; expiresAt: number } | null>(null);
  /* the pairing page's QR (issue #111 review): encodes <serverAddr>/p so a
     phone-class remote (or a phone bridging to one) skips typing the URL */
  const [pairQr, setPairQr] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [dropState, setDropState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [dropErr, setDropErr] = useState<string | null>(null);
  /* the last mile (issue #91): the server's option list for this host/peer,
     ordered by what the user must type; the short drop command comes back
     from the taildrop response itself */
  const [delivery, setDelivery] = useState<DeliveryOption[] | null>(null);
  const [dropCmd, setDropCmd] = useState<string | null>(null);
  const [sshState, setSshState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [sshErr, setSshErr] = useState<string | null>(null);

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

  /* addresses the remote will use to reach this server — filtered to what
     the server can actually ANSWER (issue #33): a loopback bind makes the
     raw tailnet/LAN URLs dead on arrival (curl: (7) connect refused) */
  const reachable = useMemo(() => (net ? reachableAddresses(net) : []), [net]);
  const addresses = useMemo(() => {
    if (!net) return [];
    return [...reachable, { value: "custom", label: "custom address…" }];
  }, [net, reachable]);

  /* nothing reachable at all (loopback bind, serve off) → the wizard says so
     and steers: serve toggle inline, or TRUSS_HOST=0.0.0.0 on restart */
  const unreachable = !!net && reachable.length === 0;
  const [serveBusy, setServeBusy] = useState(false);

  const [addr, setAddr] = useState("");
  const [addrOverride, setAddrOverride] = useState(false);
  useEffect(() => setAddr(addresses[0]?.value ?? "custom"), [addresses]);
  useEffect(() => setAddrOverride(false), [method]); // switching methods resets the override
  /* tailscale: both ends are on the tailnet by construction, so the return
     address is this server's own tailnet identity — no second selection.
     The dropdown only appears as an explicit override (or for Direct).
     Never imply a dead address (issue #100, the #33 hole): a non-empty
     reachable list is not enough — a specific non-loopback bind (say the
     LAN ip) still leaves the tailnet URL dead, so the implied return must
     itself be one of the reachable addresses. */
  const impliedReturn = method === "tailscale" ? reachableTailscaleReturn(net) : null;
  const serverAddr = addrOverride || !impliedReturn ? (addr === "custom" ? customAddr.trim() : addr) : impliedReturn;

  /* the QR encodes the auto-pair page for this exact return address; it is
     rendered once step 2 shows the pairing panel. The custom-address field
     is free text that lands in an href below (audit round 8, B4), so the
     link and the QR only exist for a plain http(s) URL */
  const pairPageUrl = /^https?:\/\//.test(serverAddr) ? `${serverAddr}/p` : null;
  useEffect(() => {
    if (step !== 2 || !pairPageUrl) { setPairQr(null); return; }
    let dead = false;
    QRCode.toDataURL(pairPageUrl, { width: 144, margin: 1 }).then(
      (u) => { if (!dead) setPairQr(u); },
      () => { if (!dead) setPairQr(null); },
    );
    return () => { dead = true; };
  }, [step, pairPageUrl]);

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

  /* once the host exists, ask the server what it can do for the picked peer
     (issue #91): taildrop with a short name, tailscale-ssh zero-typing when
     the probe allows, pairing always. Options arrive sorted by typedChars. */
  useEffect(() => {
    if (!created || !be || !serverAddr) return;
    let dead = false;
    be.deliveryOptions(created.id, pickedPeer, created.token, serverAddr).then(
      (r) => { if (!dead) setDelivery(r.options); },
      () => { if (!dead) setDelivery(null); },
    );
    return () => { dead = true; };
  }, [be, created, pickedPeer, serverAddr]);
  const sshOption = delivery?.find((o) => o.kind === "ssh" && o.typedChars === 0) ?? null;

  /* step 3: poll until the agent dials in */
  const online = created ? hosts.find((h) => h.id === created.id)?.online : false;
  useEffect(() => {
    if (step !== 3 || online) return;
    const t = window.setInterval(() => void store.refreshHosts(), 2000);
    return () => window.clearInterval(t);
  }, [step, online]);

  const pickedPeerLabel = pickedPeer ? peers?.peers.find((p) => p.dnsName === pickedPeer)?.hostName ?? null : null;

  /* shell-quoted (issue #22): a bare ? in the URL trips zsh's glob
     expansion ("no matches found") — the macOS default shell */
  const command = created && serverAddr ? buildInstallCommand(serverAddr, created.id, created.token) : "";

  /* the file taildrop delivered — the authoritative name comes back in the
     taildropHost response (the demo backend names it differently) */
  const [dropFile, setDropFile] = useState("");

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
                    const already = peerAlreadyAdded(hosts, p.hostName);
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
            {unreachable && (
              <div className="rounded-lg border border-[var(--t-amber)]/40 bg-[var(--t-amber)]/6 px-3 py-2 text-[11.5px] leading-relaxed text-[var(--t-amber)]">
                This server only listens on loopback (<span className="font-mono">{net?.bind}</span>) — nothing off-host can connect, so there's no address to offer.{" "}
                {net?.tailscale.installed ? (
                  <>
                    Turn on tailscale serve (https on the tailnet → loopback) or restart with <span className="font-mono">TRUSS_HOST=0.0.0.0</span>.{" "}
                    {net.tailscale.canServe !== false && (
                      <button
                        type="button"
                        disabled={serveBusy}
                        className="underline decoration-dotted hover:brightness-125"
                        onClick={() => {
                          setServeBusy(true);
                          be?.tailscaleServe(true)
                            .then(() => be.netInfo())
                            .then((n) => { setNet(n); setServeBusy(false); })
                            .catch(() => setServeBusy(false));
                        }}
                      >
                        turn on tailscale serve now
                      </button>
                    )}
                    {net.tailscale.canServe === false && (
                      <span className="font-mono">(serve needs: sudo tailscale set --operator=$USER)</span>
                    )}
                  </>
                ) : (
                  <>Restart with <span className="font-mono">TRUSS_HOST=0.0.0.0</span> to listen on the network.</>
                )}
              </div>
            )}
            {method === "tailscale" && impliedReturn && !addrOverride ? (
              <p className="text-[11px] text-[var(--t-dim)] leading-relaxed">
                It calls home at <span className="font-mono text-[var(--t-fg2)] break-all">{impliedReturn}</span>
                {net?.tailscale.serveOn ? " (tailscale serve, https)" : ""} — this server's own tailnet address.{" "}
                <button type="button" onClick={() => setAddrOverride(true)} className="underline decoration-dotted hover:text-[var(--t-fg)]">use a different return address</button>
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Select width="100%" className="flex-1" ariaLabel={method === "tailscale" ? "Return address override" : "Server address"} value={addr} onChange={setAddr} options={addresses.map((a) => ({ value: a.value, label: a.label }))} />
                </div>
                {addr === "custom" && (
                  <input value={customAddr} onChange={(e) => setCustomAddr(e.target.value)} placeholder="http://192.168.1.10:4040" className="t-input w-full font-mono text-[11.5px]" />
                )}
              </>
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
            {/* auto-pairing leads (issue #111 review): the remote downloads
                the installer from /p, runs it, and types nothing — the
                installer asks to join and the user approves right here. No
                code, no mint, no expiry clock. */}
            <div className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)] px-3 py-2 space-y-2">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  {pairPageUrl ? (
                    <a href={pairPageUrl} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-[var(--t-sky)] underline decoration-dotted underline-offset-2 break-all hover:brightness-125">{pairPageUrl}</a>
                  ) : (
                    <span className="font-mono text-[12px] text-[var(--t-fg)] break-all select-all">{serverAddr}/p</span>
                  )}
                  <div className="mt-0.5 text-[10px] text-[var(--t-dim)]">open on the remote (or scan), Download, run the saved file, then click Allow here when it asks. Nothing to type, no code.</div>
                </div>
                {pairQr && <img src={pairQr} width={72} height={72} className="shrink-0 rounded border border-[var(--t-line2)]" alt={`QR code for ${serverAddr}/p`} title={`${serverAddr}/p`} />}
              </div>
              <div>
                <div className="font-mono text-[11px] text-[var(--t-fg2)] break-all select-all">{`curl -fsSL ${serverAddr}/i | sh`}</div>
                <div className="mt-0.5 text-[10px] text-[var(--t-dim)]">the same flow, typed in a terminal: it asks to pair, you approve here</div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Btn size="xs" variant="outline" icon="copy" onClick={() => { void navigator.clipboard.writeText(command); store.toast("ok", "Copied", "run it on the remote host"); }}>Copy command</Btn>
              {sshOption && pickedPeerLabel && created && (
                <Btn
                  size="xs"
                  variant="amber"
                  icon="bolt"
                  disabled={sshState === "running" || sshState === "done"}
                  title={`This server runs the installer on ${pickedPeerLabel} itself: ${sshOption.command}`}
                  onClick={() => {
                    setSshState("running");
                    setSshErr(null);
                    be?.sshInstall(created.id, pickedPeer!, created.token, serverAddr).then(
                      () => { setSshState("done"); setStep(3); },
                      (e) => { setSshState("failed"); setSshErr(e?.message ?? String(e)); },
                    );
                  }}
                >
                  {sshState === "done" ? "Installed ✓" : sshState === "running" ? "Installing…" : "Install it for me"}
                </Btn>
              )}
              {pickedPeerLabel && created && (
                <Btn
                  size="xs"
                  variant="outline"
                  icon="send"
                  disabled={dropState === "sending" || dropState === "sent"}
                  title={`Taildrop the ready-to-run installer to ${pickedPeerLabel} (tailscale file cp) — the token rides inside the file, not the command line`}
                  onClick={() => {
                    setDropState("sending");
                    setDropErr(null);
                    setDropCmd(null);
                    be?.taildropHost(created.id, pickedPeer!, created.token, serverAddr).then(
                      (r) => { setDropFile(r.file); setDropState("sent"); setDropCmd(r.command); },
                      (e) => { setDropState("failed"); setDropErr(e?.message ?? String(e)); },
                    );
                  }}
                >
                  {dropState === "sent" ? `Sent to ${pickedPeerLabel} ✓` : dropState === "sending" ? "Sending…" : `Send to ${pickedPeerLabel}`}
                </Btn>
              )}
              <Btn
                size="xs"
                variant="ghost"
                icon="bolt"
                disabled={pairBusy || !!pairCmd}
                title="Mint a short single-use pairing code (10 min) — the typeable fallback"
                onClick={() => {
                  if (!created) return;
                  setPairBusy(true);
                  be?.pairHost(created.id, created.token, serverAddr).then(
                    (r) => setPairCmd({ command: r.command, code: r.code, expiresAt: r.expiresAt }),
                    (e) => store.toast("error", "Couldn't mint a pairing code", e?.message ?? String(e)),
                  ).finally(() => setPairBusy(false));
                }}
              >
                {pairCmd ? "Code minted" : "Short command"}
              </Btn>
              <span className="text-[10.5px] text-[var(--t-dim)]">needs node ≥ 20 on the remote + the harness CLIs it should host</span>
            </div>
            {sshOption && sshState !== "done" && (
              <p className="text-[11px] text-[var(--t-dim)] leading-relaxed">
                <b className="text-[var(--t-fg)]">Install it for me</b> runs the installer on {pickedPeerLabel} over tailscale ssh right now: this server pipes the script to the peer, you type nothing there. The click is your consent; the command the server runs is in the button's tooltip.
              </p>
            )}
            {sshErr && <p className="text-[11px] text-[var(--t-red)]">Remote install failed: {sshErr} — use the copy command or one of the other options instead.</p>}
            {dropErr && <p className="text-[11px] text-[var(--t-red)]">Taildrop failed: {dropErr} — use the copy command or the short one instead.</p>}
            {dropState === "sent" && dropCmd && (
              <div className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)] px-3 py-2 space-y-1.5">
                <p className="text-[11px] text-[var(--t-teal)]">{dropInstructionLabel(dropFile)}</p>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-[11.5px] text-[var(--t-fg2)] break-all select-all">{dropCmd}</code>
                  <Btn size="xs" variant="outline" icon="copy" onClick={() => { void navigator.clipboard.writeText(dropCmd); store.toast("ok", "Copied", "paste it in a terminal on the device"); }}>Copy</Btn>
                </div>
              </div>
            )}
            {pairCmd && (
              <div className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)] px-3 py-2 space-y-2">
                {/* the pre-authorized one-liner (the code stands in for the
                    Allow click): paste it in the remote's terminal, done */}
                <div className="flex items-center gap-1.5">
                  <div className="font-mono text-[11px] text-[var(--t-fg2)] break-all select-all flex-1">{pairCmd.command}</div>
                  <Btn size="xs" variant="outline" icon="copy" onClick={() => { void navigator.clipboard.writeText(pairCmd.command); store.toast("ok", "Copied", "paste it in the remote's terminal"); }}>Copy</Btn>
                </div>
                <div className="mt-0.5 text-[10px] text-[var(--t-dim)]">paste this one line in the remote's terminal; no approval click needed. code <span className="font-mono text-[var(--t-amber)]">{pairCmd.code}</span> · single-use · expires in {until(pairCmd.expiresAt)}; after it dies, mint another</div>
              </div>
            )}
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
                {/* no systemd on the remote (macOS): the installer only laid
                    the files down — the run command must be HERE, not just in
                    the installer's stdout (issue #100, found in manual test) */}
                <div className="mt-4 rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)] p-3 text-left">
                  <p className="text-[11.5px] text-[var(--t-mute)] leading-relaxed">No systemd on the remote (macOS)? The installer doesn't start anything there — run the agent yourself:</p>
                  <div className="mt-2 font-mono text-[11px] leading-relaxed text-[var(--t-fg2)] break-all select-all">{agentRunCommand(created.id)}</div>
                  <div className="mt-2 flex justify-end">
                    <Btn size="xs" variant="outline" icon="copy" onClick={() => { void navigator.clipboard.writeText(agentRunCommand(created.id)); store.toast("ok", "Copied", "run it on the remote host"); }}>Copy</Btn>
                  </div>
                  <p className="mt-1 text-[10.5px] text-[var(--t-dim)] leading-relaxed">It stays in the foreground on purpose — it <i>is</i> the service. Give it its own terminal tab (or append <span className="font-mono">&amp;</span> to background it); Ctrl+C stops it.</p>
                </div>
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
