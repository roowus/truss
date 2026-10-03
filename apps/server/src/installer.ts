/**
 * Installer last mile (issue #91). The taildrop from issue #1 landed the
 * installer on the peer, but the wizard then told the user to TYPE
 * `sh ~/Downloads/truss-install-dd203a82.sh` on the remote — 30+ awkward
 * chars on a machine with no clipboard bridge. Two pure functions own the
 * fix:
 *
 *   installerDropName(hostId) — the file name a taildrop lands under:
 *     `t-dd20.sh`. Short enough to type, shell-safe, tagged with the host's
 *     id fragment so two hosts' drops never silently swap, and stable per
 *     host so a resend overwrites (refreshes) instead of piling up in the
 *     taildrop inbox.
 *
 *   deliveryOptions(caps) — the wizard's option list, ordered by what the
 *     user must type on the remote: tailscale-ssh runs the installer from
 *     this server (0 chars), taildrop leaves one short path to type, and
 *     the pairing code is the universal floor that is always offered.
 */

export interface DeliveryCaps {
  taildropOk: boolean; // a tailnet device is picked and tailscale is here
  sshOk: boolean; // the dry probe says `tailscale ssh <peer>` works
  serverUrl: string; // the address the remote uses to reach this server
  hostId?: string; // when known, names and commands carry the host fragment
  peer?: string; // when known, the ssh command names the real device
}

export interface DeliveryOption {
  kind: "ssh" | "taildrop" | "pairing";
  label: string;
  command: string;
  typedChars: number; // what the user must type on the remote — honest count
}

/** the taildrop file name: `t-<first 4 of host id>.sh` — 9 typeable chars */
export function installerDropName(hostId: string): string {
  const frag =
    (hostId ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 4) || "host";
  return `t-${frag}.sh`;
}

/**
 * The wizard's delivery options, sorted ascending by typedChars. Pairing is
 * always present: it needs no tailscale on either end, so it is the floor
 * every other option merely beats.
 *
 * The pairing command carries a placeholder code (`xxxxxx`, the real code's
 * exact length, so typedChars stays honest) — the wizard mints a fresh
 * single-use code the moment the user picks this option and swaps it in.
 */
export function deliveryOptions(caps: DeliveryCaps): DeliveryOption[] {
  const opts: DeliveryOption[] = [];
  const drop = installerDropName(caps.hostId ?? "");

  if (caps.sshOk) {
    /* zero typing: THIS server runs the installer on the peer. The command
       is shown for transparency and consent — it is what the server runs,
       not something the user types. */
    const command = `tailscale ssh ${caps.peer ?? "<device>"} 'sh -s' < ${drop}`;
    opts.push({ kind: "ssh", label: "Install it for me over tailscale ssh", command, typedChars: 0 });
  }
  if (caps.taildropOk) {
    const command = `sh ~/Downloads/${drop}`;
    opts.push({ kind: "taildrop", label: "Send the installer to the device, then run it", command, typedChars: command.length });
  }

  const pair = `curl -fsSL ${caps.serverUrl}/i/xxxxxx | sh`;
  opts.push({ kind: "pairing", label: "Type a short command with a one-time code", command: pair, typedChars: pair.length });

  return opts.sort((a, b) => a.typedChars - b.typedChars);
}
