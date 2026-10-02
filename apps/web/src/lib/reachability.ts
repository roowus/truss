/**
 * Which addresses can a remote actually reach this server on (issue #33)?
 * The wizard must never offer a dead address: the bind decides.
 *
 *  - 0.0.0.0 / :: / unset → everything is answerable
 *  - loopback (127.0.0.1, ::1, localhost) → only the tailscale-serve URL
 *    survives (serve proxies tailnet-https to loopback); serve off → nothing
 *  - a specific bind → only its own entries (the tailnet ip ≡ its dns name);
 *    the serve URL is dead here too — serve proxies to 127.0.0.1:<port>
 *    (net.ts tailscaleServe), which a specific non-loopback bind refuses
 */
import type { NetInfo } from "./proto";
import { defaultTailscaleReturn } from "./device";

export interface ReachableAddress {
  value: string;
  label: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function reachableAddresses(net: Pick<NetInfo, "port" | "tailscale" | "lan"> & { bind?: string }): ReachableAddress[] {
  const out: ReachableAddress[] = [];
  const bind = (net.bind ?? "").trim();
  const all = !bind || bind === "0.0.0.0" || bind === "::";
  const loopback = LOOPBACK.has(bind);

  /* serve https answers off-host only when the bind covers loopback — serve
     proxies tailnet-443 to http://127.0.0.1:<port>, which a specific
     non-loopback bind refuses */
  if (net.tailscale.serveOn && net.tailscale.serveUrl && (all || loopback)) {
    out.push({ value: net.tailscale.serveUrl, label: `${net.tailscale.serveUrl} (tailscale serve, https)` });
  }
  if (loopback) return out; // loopback answers nothing else off-host

  const candidates: ReachableAddress[] = [];
  if (net.tailscale.dnsName) candidates.push({ value: `http://${net.tailscale.dnsName}:${net.port}`, label: `${net.tailscale.dnsName} (tailnet name)` });
  if (net.tailscale.ip4) candidates.push({ value: `http://${net.tailscale.ip4}:${net.port}`, label: `${net.tailscale.ip4} (tailnet ip)` });
  for (const ip of net.lan) {
    if (ip === net.tailscale.ip4) continue;
    candidates.push({ value: `http://${ip}:${net.port}`, label: `${ip} (lan/overlay)` });
  }
  if (all) return [...out, ...candidates];

  /* specific bind: keep only entries for that address (tailnet ip ≡ its name) */
  const tailnetAliases = new Set([net.tailscale.ip4, net.tailscale.dnsName].filter(Boolean) as string[]);
  const isTailnetBind = tailnetAliases.has(bind);
  return [
    ...out,
    ...candidates.filter((c) => {
      const host = c.value.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
      return host === bind || (isTailnetBind && tailnetAliases.has(host));
    }),
  ];
}

/**
 * The wizard's implied "it calls home at" address for the tailscale method,
 * gated on answerability (issue #33): only imply an address this module's
 * own filter would offer. `defaultTailscaleReturn` is bind-blind by design
 * (it names this server's tailnet identity); the bind decides whether that
 * identity is answerable — e.g. TRUSS_HOST=192.168.1.10 with serve off must
 * NOT imply the magic-dns URL. Returns null when the implied address is
 * dead, so the wizard falls back to the (filtered) dropdown.
 */
export function impliedTailscaleReturn(net: (Pick<NetInfo, "port" | "tailscale" | "lan"> & { bind?: string }) | null): string | null {
  const implied = defaultTailscaleReturn(net);
  if (!net || !implied) return null;
  return reachableAddresses(net).some((a) => a.value === implied) ? implied : null;
}
