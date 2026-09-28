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
