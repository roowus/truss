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

import { PAIRING_CODE_LEN } from "./pairing.js";
import { assertSafeServerUrl } from "./agentbundle.js";

export interface DeliveryCaps {
  taildropOk: boolean; // a tailnet device is picked and tailscale is here
  sshOk: boolean; // the dry probe says `tailscale ssh <peer>` works
  serverUrl: string; // the address the remote uses to reach this server
  hostId?: string; // when known, names and commands carry the host fragment
  peer?: string; // when known, the ssh command names the real device
}

export interface DeliveryOption {
  kind: "ssh" | "taildrop" | "interactive" | "pairing";
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
 * The wizard's delivery options, sorted ascending by typedChars. The pairing
 * options are always present: they need no tailscale on either end, so they
 * are the floor every other option merely beats.
 *
 * The pairing commands carry a placeholder code (the real code's exact
 * length, so typedChars stays honest) — the wizard mints a fresh single-use
 * code the moment the user picks one of these options and swaps it in. The
 * interactive variant (issue #111) types the code at a prompt instead of
 * inline, so its command is shorter and carries nothing secret; its honest
 * count includes the code the user types when asked.
 */
export function deliveryOptions(caps: DeliveryCaps): DeliveryOption[] {
  const opts: DeliveryOption[] = [];
  const drop = installerDropName(caps.hostId ?? "");
  const placeholder = "x".repeat(PAIRING_CODE_LEN);

  if (caps.sshOk) {
    /* zero typing: THIS server runs the installer on the peer, piping the
       script over stdin (tailscaleSshRun) — no drop file is involved. The
       command is shown for transparency and consent; the user types nothing. */
    const command = `tailscale ssh ${caps.peer ?? "<device>"} sh -s`;
    opts.push({ kind: "ssh", label: "Install it for me over tailscale ssh", command, typedChars: 0 });
  }
  if (caps.taildropOk) {
    const command = `sh ~/Downloads/${drop}`;
    opts.push({ kind: "taildrop", label: "Send the installer to the device, then run it", command, typedChars: command.length });
  }

  const interactive = `curl -fsSL ${caps.serverUrl}/i | sh`;
  opts.push({
    kind: "interactive",
    label: "Type a short command, then the one-time code it asks for",
    command: interactive,
    typedChars: interactive.length + PAIRING_CODE_LEN, // the code is typed at the prompt
  });

  const pair = `curl -fsSL ${caps.serverUrl}/i/${placeholder} | sh`;
  opts.push({ kind: "pairing", label: "Type a short command with a one-time code", command: pair, typedChars: pair.length });

  return opts.sort((a, b) => a.typedChars - b.typedChars);
}

/**
 * The interactive installer (issue #111), served at GET /i and safe to
 * taildrop as-is: it carries NO token and no code, so the file is generic
 * and can sit in a Downloads folder without holding a credential. It prompts
 * for the short pairing code, redeems it once at POST /i/redeem for the real
 * credentials, then runs the regular installer with them. The only embedded
 * value is the URL the client just used to reach this server (validated
 * against the same shell-safe rule as every other script embed point).
 */
export function interactiveInstallScript(serverUrl: string): string {
  assertSafeServerUrl(serverUrl);
  return `#!/bin/sh
# Truss interactive installer — pairs this machine with ${serverUrl}
# The add-host wizard shows a short one-time code; this script asks for it,
# trades it once for the real credentials, and installs the agent.
set -eu

SERVER='${serverUrl}'

printf 'pairing code? ' >&2
# when this script arrives via a curl pipe, stdin IS the script (already
# consumed) — the answer must come from the terminal itself
read -r CODE < /dev/tty || read -r CODE || {
  echo "could not read the code: no terminal attached" >&2
  exit 1
}
# typed by hand: forgive case and stray whitespace, keep only code alphabet
CODE=$(printf '%s' "$CODE" | tr 'A-Z' 'a-z' | tr -cd 'abcdefghjkmnpqrstuvwxyz23456789')
if [ -z "$CODE" ]; then
  echo "no code given. Mint one in the Truss add-host wizard (Short command)" >&2
  exit 1
fi

RESP=$(curl -fsSL -X POST -H 'content-type: application/json' \\
  -d "{\\"code\\":\\"$CODE\\"}" \\
  "$SERVER/i/redeem") && rc=0 || rc=$?
# split the failure honestly (audit B3): curl 6/7/28 mean the SERVER is
# unreachable — re-minting a code never fixes that; 22 is the HTTP answer
if [ "$rc" -eq 6 ] || [ "$rc" -eq 7 ] || [ "$rc" -eq 28 ]; then
  echo "cannot reach $SERVER. Check the address (is tailscale up on both ends?), then retry" >&2
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  echo "that code did not work: used up, expired, or mis-typed. Mint a fresh one in the wizard." >&2
  exit 1
fi

TOKEN=$(printf '%s' "$RESP" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')
HOST_ID=$(printf '%s' "$RESP" | sed -n 's/.*"hostId":"\\([^"]*\\)".*/\\1/p')
SURL=$(printf '%s' "$RESP" | sed -n 's/.*"serverUrl":"\\([^"]*\\)".*/\\1/p')
if [ -z "$TOKEN" ] || [ -z "$HOST_ID" ] || [ -z "$SURL" ]; then
  echo "unexpected answer from $SERVER. Is this a Truss server?" >&2
  exit 1
fi

# download first, then run: a failed download must not exit 0 with the agent
# half-announced (a bare curl | sh pipeline hides the curl status)
SCRIPT=$(mktemp "\${TMPDIR:-/tmp}/truss-install.XXXXXX")
trap 'rm -f "$SCRIPT"' EXIT
curl -fsSL "$SURL/agent/install.sh?host=$HOST_ID" -o "$SCRIPT"
sh "$SCRIPT" "$TOKEN"
`;
}
