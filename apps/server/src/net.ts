import { execFile } from "node:child_process";
import { connect } from "node:net";
import { networkInterfaces, userInfo } from "node:os";
import { assertSafeServerUrl } from "./agentbundle.js";

/**
 * Network reachability helper for the add-host wizard: what addresses can a
 * remote agent use to reach this Truss server? Detects tailscale (if the CLI
 * exists) and enumerates private LAN interfaces, and can flip
 * `tailscale serve` for Truss's own port (Settings toggle).
 */

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout: 6000 }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || err.message || "failed").trim().split("\n")[0]));
      else res(stdout);
    });
  });
}

/** sh with a stdin payload (the installer script travels on stdin) */
function shIn(cmd: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((res, rej) => {
    const p = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || err.message || "failed").trim().split("\n")[0]));
      else res(stdout);
    });
    /* the child may exit before reading everything — an EPIPE on stdin is
       the same failure the callback already reports, not a crash */
    p.stdin?.on("error", () => {});
    p.stdin?.end(input);
  });
}

export interface NetInfo {
  port: number;
  /** the address the server listens on (issue #33: the wizard must not offer
     addresses the server can't answer — a loopback bind kills tailnet URLs) */
  bind: string;
  /** operator-declared front door (TRUSS_PUBLIC_URL): a reverse proxy or
     public DNS name that forwards here. Dialability can't discover a proxy
     from the bind, so it trusts exactly this and nothing else (audit B2). */
  publicUrl?: string;
  tailscale: {
    installed: boolean;
    ip4?: string;
    dnsName?: string;
    serveOn?: boolean;
    serveUrl?: string;
    /** can this process write the serve config? (operator/root — issue #37) */
    canServe?: boolean;
    /** what the serve toggle WILL do if clicked now (issue #171): present
       while serve is off and clickable, so the UI can show plan.warning
       BEFORE the click instead of shadowing whoever owns 443 */
    servePlan?: ServePlan;
  };
  lan: string[]; // private IPv4s of this host
}

/* ── tailnet device list (add-host wizard's device picker) ── */

export interface TailscalePeer {
  hostName: string;
  dnsName: string; // magic-dns name, trailing dot stripped
  ip4?: string;
  os?: string; // linux / macOS / windows / android / ios…
  online: boolean;
  lastSeen?: string; // ISO
  exitNode: boolean; // currently routing traffic
  exitNodeOption: boolean; // offers itself as one
  tagged: boolean; // tagged devices have no user owner
}

/** pure: tailscale status --json → clean peer rows (exported for tests) */
export function parseTailscaleStatus(j: unknown): { self?: TailscalePeer; peers: TailscalePeer[] } {
  if (!j || typeof j !== "object") return { peers: [] };
  const root = j as Record<string, unknown>;
  const one = (n: unknown): TailscalePeer | undefined => {
    if (!n || typeof n !== "object") return undefined;
    const p = n as Record<string, unknown>;
    const ips = Array.isArray(p.TailscaleIPs) ? (p.TailscaleIPs as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const hostName = typeof p.HostName === "string" ? p.HostName : "";
    const dnsName = typeof p.DNSName === "string" ? p.DNSName.replace(/\.$/, "") : "";
    if (!hostName && !dnsName) return undefined;
    return {
      hostName,
      dnsName,
      ip4: ips.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)),
      os: typeof p.OS === "string" ? p.OS : undefined,
      online: p.Online === true,
      lastSeen: typeof p.LastSeen === "string" ? p.LastSeen : undefined,
      exitNode: p.ExitNode === true,
      exitNodeOption: p.ExitNodeOption === true,
      tagged: Array.isArray(p.Tags) && p.Tags.length > 0,
    };
  };
  const self = one(root.Self);
  const peersRaw = root.Peer && typeof root.Peer === "object" ? Object.values(root.Peer as Record<string, unknown>) : [];
  const peers = peersRaw
    .map(one)
    .filter((p): p is TailscalePeer => !!p)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName));
  return { self, peers };
}

/** devices on the tailnet; empty when tailscale is absent or the query fails */
export async function tailscalePeers(): Promise<{ self?: TailscalePeer; peers: TailscalePeer[] }> {
  try {
    const st = await sh("tailscale", ["status", "--json"]);
    return parseTailscaleStatus(JSON.parse(st));
  } catch {
    return { peers: [] };
  }
}

export async function netInfo(port: number, bindHost?: string): Promise<NetInfo> {
  const out: NetInfo = { port, bind: bindHost ?? process.env.TRUSS_HOST ?? "0.0.0.0", tailscale: { installed: false }, lan: [] };
  const pub = (process.env.TRUSS_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (pub) out.publicUrl = pub;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (name === "lo") continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.6[4-9]\.|100\.[7-9]\d\.|100\.1[01]\d\.)/.test(a.address)) {
        out.lan.push(a.address);
      }
    }
  }
  try {
    const ip4 = (await sh("tailscale", ["ip", "-4"])).trim();
    out.tailscale.installed = true;
    out.tailscale.ip4 = ip4 || undefined;
    try {
      const st = await sh("tailscale", ["status", "--json"]);
      const j = JSON.parse(st);
      const dns = (j?.CurrentTailnet?.MagicDNSSuffix && j?.Self?.DNSName) ? String(j.Self.DNSName).replace(/\.$/, "") : undefined;
      out.tailscale.dnsName = dns;
      /* serve status: `tailscale serve status --json` — newer CLIs;
         fall back to text parse on older ones */
      try {
        const sv = await sh("tailscale", ["serve", "status", "--json"]);
        const sj = JSON.parse(sv);
        const web = sj?.Web && typeof sj.Web === "object" ? Object.keys(sj.Web) : [];
        const hit = web.find((k) => k.includes(dns ?? "") || k.includes(ip4));
        out.tailscale.serveOn = !!hit;
        if (hit) out.tailscale.serveUrl = `https://${hit}`;
      } catch {
        const sv = await sh("tailscale", ["serve", "status"]);
        const m = sv.match(/https:\/\/[^\s]+/);
        out.tailscale.serveOn = !!m;
        if (m) out.tailscale.serveUrl = m[0];
      }
    } catch {
      /* status parse failed — ip4 is enough */
    }
    /* can we write serve config at all? (issue #37 — the Settings toggle must
       know before the user clicks) */
    try {
      const prefs = await sh("tailscale", ["debug", "prefs"]);
      const operator = parsePrefsOperator(prefs);
      const user = userInfo().username;
      out.tailscale.canServe = canServeWith(operator, user, typeof process.getuid === "function" && process.getuid() === 0);
    } catch {
      /* prefs unreadable — report nothing */
    }
    /* the collision plan (issue #171): while serve is off and clickable,
       probe 443 NOW so the UI can warn about the alternate port before the
       click — never after tailscaled has taken the port over */
    if (!out.tailscale.serveOn && out.tailscale.canServe !== false) {
      out.tailscale.servePlan = planServe({ port, port443Busy: await webServerPresent(443) });
    }
  } catch {
    /* tailscale not installed */
  }
  return out;
}

/* ── serve-config capability (issue #37): tailscaled's LocalAPI refuses
   serve writes from non-root, non-operator users — probe instead of 400ing ── */

/** `tailscale debug prefs` JSON → OperatorUser (null when unset/garbage; never throws) */
export function parsePrefsOperator(prefsJson: string): string | null {
  try {
    const j = JSON.parse(prefsJson);
    const u = j?.OperatorUser;
    return typeof u === "string" && u.trim() ? u.trim() : null;
  } catch {
    return null;
  }
}

/** root always can; the operator can; anyone else can't */
export function canServeWith(operator: string | null, user: string, isRoot: boolean): boolean {
  if (isRoot) return true;
  if (operator && operator === user) return true;
  return false;
}

/** map tailscaled's denial to the one-line remediation, keeping the original text */
export function serveErrorHint(stderr: string, user: string): string {
  if (!/access denied|denied|not permitted|operation not permitted/i.test(stderr)) return stderr;
  return `${stderr} — this server's user (${user}) can't write tailscale's serve config. Run \`sudo tailscale set --operator=${user}\` once (or run Truss as root), then retry Settings → Network.`;
}

/* ── the 443 collision (issue #171) ─────────────────────────────────────
   The serve toggle used to run `tailscale serve --bg --https=443` blind.
   On a machine where another web server owns 443, tailscaled takes TLS on
   443 machine-wide and that server is shadowed (one click took down every
   site a Caddy was fronting, until `tailscale serve reset`). So the toggle
   now PLANS first: probe 443, and when something answers, serve on an
   alternate tailnet port and warn about it in the UI before the click. */

export interface ServePlan {
  httpsPort: number;
  /** null when serving on 443 is safe; otherwise the sentence the UI shows
     BEFORE the toggle is clicked */
  warning: string | null;
}

/** the alternate tailnet https port for when something else owns 443 */
export const SERVE_ALT_PORT = 8443;

/** pure: decide what tailscale serve should claim. A busy 443 is NEVER
   claimed (that was the outage) — the plan moves to the alternate port and
   carries a warning that names the conflict. */
export function planServe(input: { port: number; port443Busy: boolean }): ServePlan {
  if (!input.port443Busy) return { httpsPort: 443, warning: null };
  return {
    httpsPort: SERVE_ALT_PORT,
    warning: `Port 443 is already in use by another server on this machine. Truss will serve on tailnet port ${SERVE_ALT_PORT} instead, so your other sites keep working; Truss lives at :${SERVE_ALT_PORT}.`,
  };
}

/** pure: the exact CLI lines the toggle runs for a plan. ON and OFF ride
   the SAME planned port, so off tears down what on set up (never a stale
   443). Full command lines (not argv) so the UI can show what will run. */
export function serveCommands(plan: ServePlan, port: number): { on: string[]; off: string[] } {
  return {
    on: [`tailscale serve --bg --https=${plan.httpsPort} http://127.0.0.1:${port}`],
    off: [`tailscale serve --https=${plan.httpsPort} off`],
  };
}

/** does something already answer on this local TCP port? A refused
   connection means free; a connect means busy; a timeout is treated as
   busy — the plan must never claim a port it is unsure about. Never
   rejects. */
export function webServerPresent(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host, port, timeout: timeoutMs });
    const done = (busy: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      res(busy);
    };
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(true));
    sock.on("error", () => done(false));
  });
}

/* run one serveCommands line. The lines are built by serveCommands from
   numbers only, so splitting on spaces is safe — and the plan's text stays
   the single source of truth for what runs. */
async function runServeLine(line: string): Promise<void> {
  const [cmd, ...args] = line.split(" ");
  await sh(cmd, args);
}

/** the https port tailscale is ACTUALLY serving on for this machine (null
   when nothing serves or the status can't be read). OFF targets this, not
   a fresh plan — the plan can change between on and off, the status can't
   lie about what is up. */
async function servingHttpsPort(port: number): Promise<number | null> {
  try {
    const sv = await sh("tailscale", ["serve", "status", "--json"]);
    const sj = JSON.parse(sv);
    const web: string[] = sj?.Web && typeof sj.Web === "object" ? Object.keys(sj.Web) : [];
    if (web.length === 0) return null;
    /* a machine can serve several things — prefer the config that proxies
       to OUR port; off tears down Truss's own, not a neighbor's */
    const ours = web.find((k) => JSON.stringify(sj.Web[k]).includes(`127.0.0.1:${port}`));
    const m = (ours ?? web[0]).match(/:(\d+)$/);
    return m ? Number(m[1]) : 443;
  } catch {
    return null;
  }
}

/** expose Truss on the tailnet at https://<machine>.<tailnet>.ts.net
   (at :8443 instead when something else already owns 443 — issue #171) */
export async function tailscaleServe(on: boolean, port: number): Promise<NetInfo["tailscale"]> {
  try {
    if (on) {
      /* plan FIRST: a busy 443 is never claimed; the UI already warned
         about the alternate port before the click */
      const plan = planServe({ port, port443Busy: await webServerPresent(443) });
      for (const line of serveCommands(plan, port).on) await runServeLine(line);
    } else {
      const httpsPort = (await servingHttpsPort(port)) ?? planServe({ port, port443Busy: await webServerPresent(443) }).httpsPort;
      for (const line of serveCommands({ httpsPort, warning: null }, port).off) await runServeLine(line);
    }
  } catch (err) {
    /* denials name the fix (issue #37): the operator one-liner, not a bare 400 */
    throw new Error(serveErrorHint(err instanceof Error ? err.message : String(err), userInfo().username));
  }
  return (await netInfo(port)).tailscale;
}

/* ── return-address validation (issue #100) ─────────────────────────────
   Syntax was never enough: the user's Mac installed an agent whose env froze
   TRUSS_SERVER=ws://<tailnet-ip>:4040 while the server listened on
   127.0.0.1 only — a syntax-valid address that answers nowhere, minted with
   a 200. The delivery routes run this BEFORE minting anything, so a doomed
   address gets refused with the fix named instead of an install loop.

   A URL is dialable iff THIS server answers it given the bind:
     loopback bind    → loopback hosts only (a loopback server answers
                        nothing off-host)
     wildcard bind    → any address of this machine (loopback, LAN ips,
                        the tailnet ip/name)
     specific ip bind → that ip only (its tailnet magic-dns name aliases it)
   …plus, on any bind: the tailscale-serve URL (serve proxies tailnet https
   into the local port) and the operator-declared TRUSS_PUBLIC_URL (a reverse
   proxy / DNS front door the bind can't reveal). The port must be the
   server's own. */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const isLoopbackBind = (bind: string) => LOOPBACK_HOSTS.has(bind) || bind === "[::1]";
const isWildcardBind = (bind: string) => !bind || bind === "0.0.0.0" || bind === "::" || bind === "[::]";

export function assertDialableServerUrl(
  serverUrl: string,
  net: { port: number; bind?: string; publicUrl?: string; tailscale: NetInfo["tailscale"]; lan: string[] },
): void {
  /* the #91 syntax contract composes — garbage still dies here first */
  assertSafeServerUrl(serverUrl);

  /* bind-independent answers (audit B2): tailscale serve proxies the
     tailnet's planned https port (443, or 8443 on a busy-443 machine —
     issue #171) into the local port; TRUSS_PUBLIC_URL is the operator's
     word that a proxy/DNS name forwards here — without it, proxied
     deployments couldn't pair at all */
  const serve = net.tailscale.serveOn ? net.tailscale.serveUrl?.replace(/\/+$/, "") : undefined;
  if (serve && serverUrl.replace(/\/+$/, "") === serve) return;
  const pub = net.publicUrl?.replace(/\/+$/, "");
  if (pub && serverUrl.replace(/\/+$/, "") === pub) return;

  const u = new URL(serverUrl);
  const host = u.hostname; // URL() strips ipv6 brackets
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const bind = (net.bind ?? "").trim();

  const steer = `turn on tailscale serve on the server (Settings → Network) and use its https URL, or restart the server with TRUSS_HOST=0.0.0.0 so it listens on the network`;

  if (isLoopbackBind(bind)) {
    if (LOOPBACK_HOSTS.has(host)) {
      if (port !== net.port) {
        throw new Error(`${serverUrl} is unreachable: this server listens on port ${net.port}, not ${port}`);
      }
      return;
    }
    throw new Error(
      `${serverUrl} is unreachable: this server is bound to ${bind} (loopback) and answers nothing off-host — ${steer}`,
    );
  }

  if (isWildcardBind(bind)) {
    const local =
      LOOPBACK_HOSTS.has(host) ||
      net.lan.includes(host) ||
      (!!net.tailscale.ip4 && host === net.tailscale.ip4) ||
      (!!net.tailscale.dnsName && host === net.tailscale.dnsName);
    if (!local) {
      throw new Error(
        `${serverUrl} is unreachable: ${host} is not an address this server listens on — check the address, or ${steer}`,
      );
    }
  } else if (host !== bind) {
    /* a specific bind answers on its own address only; the tailnet ip and
       its magic-dns name are the same interface */
    const tailnetAlias = !!net.tailscale.ip4 && bind === net.tailscale.ip4 && host === net.tailscale.dnsName;
    if (!tailnetAlias) {
      throw new Error(
        `${serverUrl} is unreachable: this server is bound to ${bind} and answers only there — use that address, or ${steer}`,
      );
    }
  }

  if (port !== net.port) {
    throw new Error(`${serverUrl} is unreachable: this server listens on port ${net.port}, not ${port} — fix the port, or ${steer}`);
  }
}

/** push files to a tailnet device via Taildrop (`tailscale file cp`).
   Used by the add-host wizard's "Send to device" — both ends are on the
   tailnet, so the installer can travel directly. Validates before touching
   the CLI; CLI failures reject with the CLI's own message (never hangs —
   execFile timeout — and never fakes success). */
export async function taildropToPeer(peer: string, files: string[]): Promise<void> {
  const target = (peer ?? "").trim();
  if (!target) throw new Error("no target device (peer) given");
  if (!Array.isArray(files) || files.length === 0) throw new Error("no files to send");
  await sh("tailscale", ["file", "cp", ...files, `${target}:`]);
}

/* ── tailscale ssh: the zero-typing last mile (issue #91) ── */

const SSH_PROBE_TTL_MS = 2 * 60 * 1000; // a peer's answer is fresh for 2 min
const sshProbes = new Map<string, { ok: boolean; at: number }>();

/** dry probe: can this server drive `tailscale ssh <peer>`? Runs a harmless
   `true` on the peer (ssh is either on for us or the command never runs), so
   detection never changes remote state. Cached briefly so the wizard doesn't
   re-probe on every render. Never throws — any failure just means "no". */
export async function tailscaleSshOk(peer: string): Promise<boolean> {
  const target = (peer ?? "").trim();
  if (!target) return false;
  const hit = sshProbes.get(target);
  if (hit && Date.now() - hit.at < SSH_PROBE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    await sh("tailscale", ["ssh", target, "true"]);
    ok = true;
  } catch {
    ok = false;
  }
  sshProbes.set(target, { ok, at: Date.now() });
  return ok;
}

/** run a script on the peer (`tailscale ssh <peer> sh -s`, script on stdin).
   The zero-typing install path: the server executes, the user consented in
   the wizard. Installs can download and configure a service, so the timeout
   is generous. Validates before touching the CLI; CLI failures reject with
   the CLI's own first error line. */
export async function tailscaleSshRun(peer: string, script: string): Promise<void> {
  const target = (peer ?? "").trim();
  if (!target) throw new Error("no target device (peer) given");
  if (!script) throw new Error("no script to run");
  await shIn("tailscale", ["ssh", target, "sh", "-s"], script, 180000);
}
