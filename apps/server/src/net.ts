import { execFile } from "node:child_process";
import { networkInterfaces, userInfo } from "node:os";

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

export interface NetInfo {
  port: number;
  /** the address the server listens on (issue #33: the wizard must not offer
     addresses the server can't answer — a loopback bind kills tailnet URLs) */
  bind: string;
  tailscale: {
    installed: boolean;
    ip4?: string;
    dnsName?: string;
    serveOn?: boolean;
    serveUrl?: string;
    /** can this process write the serve config? (operator/root — issue #37) */
    canServe?: boolean;
    /** the user Truss runs as — the account `tailscale set --operator=` needs */
    user?: string;
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
      out.tailscale.user = user;
      out.tailscale.canServe = canServeWith(operator, user, typeof process.getuid === "function" && process.getuid() === 0);
    } catch {
      /* prefs unreadable — report nothing */
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
  return `${stderr}. This server's user (${user}) can't write tailscale's serve config. Run \`sudo tailscale set --operator=${user}\` once (or run Truss as root), then retry Settings → Network.`;
}

/** expose Truss on the tailnet at https://<machine>.<tailnet>.ts.net */
export async function tailscaleServe(on: boolean, port: number): Promise<NetInfo["tailscale"]> {
  try {
    if (on) {
      /* serve https on the tailnet's 443 → local http port (flags vary a bit
         across CLIs; this is the stable modern form) */
      await sh("tailscale", ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    } else {
      await sh("tailscale", ["serve", "--https=443", "off"]);
    }
  } catch (err) {
    /* denials name the fix (issue #37): the operator one-liner, not a bare 400 */
    throw new Error(serveErrorHint(err instanceof Error ? err.message : String(err), userInfo().username));
  }
  return (await netInfo(port)).tailscale;
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
