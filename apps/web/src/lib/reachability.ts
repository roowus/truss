/**
 * Which addresses can a remote actually reach this server on (issue #33)?
 * The wizard must never offer a dead address: the bind decides.
 *
 *  - 0.0.0.0 / :: / unset → everything is answerable
 *  - loopback (127.0.0.1, ::1, localhost) → only the tailscale-serve URL
 *    survives (serve proxies tailnet-https to loopback); serve off → nothing
 *  - a specific bind → only its own entries (the tailnet ip ≡ its dns name)
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

  /* serve https is reachable from the tailnet no matter the local bind */
  if (net.tailscale.serveOn && net.tailscale.serveUrl) {
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
 * The tailnet return address the wizard may IMPLY without asking — only when
 * the server can actually answer it (issue #100 closes the #33 hole: gating
 * on "the offer list is non-empty" still implies a dead tailnet URL when the
 * bind is a specific non-loopback ip, e.g. the LAN address).
 */
export function reachableTailscaleReturn(net: (Pick<NetInfo, "port" | "tailscale" | "lan"> & { bind?: string }) | null): string | null {
  if (!net) return null;
  const implied = defaultTailscaleReturn(net);
  if (!implied) return null;
  return reachableAddresses(net).some((a) => a.value === implied) ? implied : null;
}
