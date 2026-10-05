import { hostOf } from "./format";

/** What the chat header's device chip shows. */
export interface DeviceHost {
  id: string;
  label: string;
}

/**
 * Resolve a session's harness id to a human device name: bare harness ids
 * run on this server; `harness@hostId` runs on that remote host (labeled
 * from the registry, falling back to the raw id when the host is unknown).
 */
export function deviceLabel(harness: string, hosts: DeviceHost[]): string {
  const hostId = hostOf(harness);
  if (!hostId) return "this server";
  return hosts.find((h) => h.id === hostId)?.label ?? hostId;
}

/**
 * What a raw host id reads as to the user (issue #109): the alias they set
 * wins (the sidebar's alias-or-label rule), then the registry label, then
 * the raw id — never a lie, an unknown host stays addressable.
 */
export function hostDisplay(hostId: string, hosts: DeviceHost[], aliases?: Record<string, string>): string {
  const alias = aliases?.[hostId]?.trim();
  if (alias) return alias;
  return hosts.find((h) => h.id === hostId)?.label ?? hostId;
}

/** flatten the desktop host prefs into the alias map harnessDisplay takes */
export function hostAliases(prefs: Record<string, { alias?: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, p] of Object.entries(prefs)) {
    const a = p?.alias?.trim();
    if (a) out[id] = a;
  }
  return out;
}

/**
 * The one resolver for every surface that prints a harness id (issue #109):
 * local harnesses ("pi") pass through untouched; a known remote host reads
 * "pi@<label>" (a set alias wins); an unknown host keeps the raw id. Garbage
 * ("", "pi@", "@x", "pi@a@b", null-ish) never throws and never invents a
 * reading — it comes back as it went in.
 */
export function harnessDisplay(harness: string, hosts: DeviceHost[], aliases?: Record<string, string>): string {
  if (typeof harness !== "string") return "";
  /* a blank id reads as visibly unresolvable ("?") when there are hosts to
     resolve against — silently blank would look like "no harness"; with no
     hosts at all, "" stays "" */
  if (!harness.trim()) return hosts.length ? "?" : "";
  const at = harness.indexOf("@");
  if (at < 0 || at !== harness.lastIndexOf("@")) return harness;
  const base = harness.slice(0, at);
  const hostId = harness.slice(at + 1);
  if (!base || !hostId) return harness;
  return `${base}@${hostDisplay(hostId, hosts, aliases)}`;
}

/** loose match: is this tailnet device already on the hosts list? */
export function peerAlreadyAdded(hosts: { label: string }[], hostName: string): boolean {
  const want = hostName.trim().toLowerCase();
  return hosts.some((h) => h.label.trim().toLowerCase() === want);
}

export interface NetLike {
  port: number;
  tailscale: { installed: boolean; ip4?: string; dnsName?: string; serveOn?: boolean; serveUrl?: string };
}

/**
 * The address a tailnet remote should call home to. Both ends are on the
 * tailnet by construction, so this server's own tailnet identity is the
 * answer: serve https when it's on, then magic dns, then the tailnet ip.
 */
export function defaultTailscaleReturn(net: NetLike | null): string | null {
  if (!net?.tailscale.installed) return null;
  if (net.tailscale.serveOn && net.tailscale.serveUrl) return net.tailscale.serveUrl;
  if (net.tailscale.dnsName) return `http://${net.tailscale.dnsName}:${net.port}`;
  if (net.tailscale.ip4) return `http://${net.tailscale.ip4}:${net.port}`;
  return null;
}
