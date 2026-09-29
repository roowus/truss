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

/** loose match: is this tailnet device already on the hosts list? */
export function peerAlreadyAdded(hosts: { label: string }[], hostName: string): boolean {
  const want = hostName.trim().toLowerCase();
  return hosts.some((h) => h.label.trim().toLowerCase() === want);
}
