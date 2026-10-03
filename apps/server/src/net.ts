import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";

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
  tailscale: {
    installed: boolean;
    ip4?: string;
    dnsName?: string;
    serveOn?: boolean;
    serveUrl?: string;
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

export async function netInfo(port: number): Promise<NetInfo> {
  const out: NetInfo = { port, tailscale: { installed: false }, lan: [] };
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
  } catch {
    /* tailscale not installed */
  }
  return out;
}

/** expose Truss on the tailnet at https://<machine>.<tailnet>.ts.net */
export async function tailscaleServe(on: boolean, port: number): Promise<NetInfo["tailscale"]> {
  if (on) {
    /* serve https on the tailnet's 443 → local http port (flags vary a bit
       across CLIs; this is the stable modern form) */
    await sh("tailscale", ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
  } else {
    await sh("tailscale", ["serve", "--https=443", "off"]);
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
