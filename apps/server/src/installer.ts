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
 * The pairing command carries a placeholder code (the real code's exact
 * length, so typedChars stays honest) — the wizard mints a fresh single-use
 * code the moment the user picks it and swaps it in. The interactive variant
 * (issue #111) auto-pairs: the served script asks to join and the user
 * approves in the UI, so its command is shorter and nothing is typed at all.
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
    label: "Type one short command; it asks to pair and you approve here",
    command: interactive,
    typedChars: interactive.length, // auto-pair: no code to type at all
  });

  const pair = `curl -fsSL ${caps.serverUrl}/i/${placeholder} | sh`;
  opts.push({ kind: "pairing", label: "Type a short command with a one-time code", command: pair, typedChars: pair.length });

  return opts.sort((a, b) => a.typedChars - b.typedChars);
}

/**
 * The auto-pairing installer (issue #111, review rounds), served at GET /i
 * and safe to taildrop as-is: it carries NO token and no code, so the file
 * is generic and can sit in a Downloads folder without holding a credential.
 * The flow is the WhatsApp shape: the script announces this device at
 * POST /api/pair/request and polls until the user clicks Allow in the Truss
 * UI (or Deny, or the 10-minute request dies). The only embedded value is
 * the URL the client just used to reach this server (validated against the
 * same shell-safe rule as every other script embed point); the approval
 * payload's serverUrl comes from the server, so a moved address self-heals.
 */
export function interactiveInstallScript(serverUrl: string): string {
  assertSafeServerUrl(serverUrl);
  return `#!/bin/sh
# Truss auto-pairing installer — pairs this machine with ${serverUrl}
# Nothing to type: it asks the server to pair, you click Allow in the Truss
# UI, and the install finishes itself.
set -eu

SERVER='${serverUrl}'

HOSTNAME=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._ -' || true)
[ -n "$HOSTNAME" ] || HOSTNAME="unknown device"
OS=$(uname -s 2>/dev/null || echo unknown)
TSIP=$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1 | tr -cd '0-9.' || true)

echo "asking $SERVER to pair this machine ($HOSTNAME)"
RESP=$(curl -fsSL -X POST -H 'content-type: application/json' \\
  -d "{\\"hostname\\":\\"$HOSTNAME\\",\\"os\\":\\"$OS\\",\\"tailscaleIp\\":\\"$TSIP\\"}" \\
  "$SERVER/api/pair/request") && rc=0 || rc=$?
# split the failure honestly: curl 6/7/28 mean the SERVER is unreachable
if [ "$rc" -eq 6 ] || [ "$rc" -eq 7 ] || [ "$rc" -eq 28 ]; then
  echo "cannot reach $SERVER. Check the address (is tailscale up on both ends?), then retry" >&2
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  echo "the server refused the pairing request. Is $SERVER a current Truss server?" >&2
  exit 1
fi
ID=$(printf '%s' "$RESP" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
if [ -z "$ID" ]; then
  echo "unexpected answer from $SERVER. Is this a Truss server?" >&2
  exit 1
fi

echo "waiting for approval: click Allow in the Truss UI (the request lives 10 minutes)"
TOKEN=""
i=0
while [ "$i" -lt 300 ]; do
  BODY=$(curl -sS "$SERVER/api/pair/request/$ID" 2>/dev/null || true)
  case "$BODY" in
    *'"status":"approved"'*)
      TOKEN=$(printf '%s' "$BODY" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')
      HOST_ID=$(printf '%s' "$BODY" | sed -n 's/.*"hostId":"\\([^"]*\\)".*/\\1/p')
      SURL=$(printf '%s' "$BODY" | sed -n 's/.*"serverUrl":"\\([^"]*\\)".*/\\1/p')
      break
      ;;
    *'"status":"denied"'*)
      echo "pairing was declined in the Truss UI" >&2
      exit 1
      ;;
    *'"error"'*)
      echo "the pairing request expired. Run this installer again." >&2
      exit 1
      ;;
  esac
  i=$((i + 1))
  sleep 2
done
if [ -z "$TOKEN" ]; then
  echo "no approval within 10 minutes. Run this installer again when someone is at the Truss UI." >&2
  exit 1
fi
if [ -z "$HOST_ID" ] || [ -z "$SURL" ]; then
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

/**
 * The browser pairing page (issue #111 review rounds), served at GET /p.
 * Minimum work, and no code anywhere: the page LEADS with the one command
 * (`curl -fsSL <origin>/i | sh`, derived from its own origin so no wizard
 * round-trip or embed is needed) — one paste in a terminal, the installer
 * asks to join, the user approves in the Truss UI. The file download is
 * the no-curl fallback; it fetches GET /i under a FRESH random name and
 * shows the run command with that exact name, so a browser that dedupes an
 * earlier download ("t.sh (2)", or Chrome holding an .sh entirely — both
 * found in manual testing) can no longer strand the instruction:
 *
 *   open link / scan QR → paste one command (or Download) → click Allow.
 *
 * The page embeds nothing at all (a fully static string: no interpolation,
 * no injection surface) and no state changes hands here: the download never
 * burns anything and can be repeated freely. Styled to the app's "graphite
 * & signal" tokens with system font stacks, self-contained so a
 * tailnet-only remote needs no internet to render it. The brand svg
 * duplicates the canonical TrussLogo path data from
 * apps/web/src/components/ui.tsx (the server can't import the web tsx) —
 * keep the two in sync when the logo changes.
 */
export function pairingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair this device · Truss</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; background: #0b0c0e; color: #ece7dd;
         font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .card { width: 400px; max-width: calc(100vw - 32px); background: #111316; border: 1px solid #353941; border-radius: 12px;
          padding: 24px; box-shadow: 0 18px 50px rgba(0,0,0,0.45); }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .brand svg { flex: none; }
  .brand h1 { font-size: 16px; font-weight: 600; margin: 0; }
  .sub { color: #9b968c; margin: 0 0 20px; }
  .step { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid #23262c; }
  .n { flex: none; width: 22px; height: 22px; border-radius: 999px; border: 1px solid #f0b35a; color: #f0b35a;
       display: grid; place-items: center; font-size: 11px; font-weight: 600; margin-top: 1px; }
  .step p { margin: 0 0 10px; color: #d0cabe; }
  .hint { color: #66635d; font-size: 11.5px; margin: 8px 0 0; }
  .dl { display: inline-flex; align-items: center; gap: 8px; background: #f0b35a; color: #1a1a1a; font: 600 13px/1 inherit;
        padding: 10px 18px; border-radius: 9px; border: 0; cursor: pointer; text-decoration: none; }
  .dl:hover { filter: brightness(1.08); }
  .dl:disabled { opacity: 0.55; cursor: default; }
  .cmd { display: flex; align-items: center; gap: 8px; background: #0b0c0e; border: 1px solid #23262c; border-radius: 8px; padding: 9px 12px; }
  .cmd code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; font: 13px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; color: #5fc9c0; user-select: all;
              scrollbar-width: thin; scrollbar-color: #353941 transparent; }
  .copy { flex: none; font: inherit; font-size: 11.5px; color: #9b968c; background: none; border: 1px solid #353941;
          border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  .copy:hover { color: #ece7dd; border-color: #66635d; }
  .foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid #23262c; color: #66635d; font-size: 11.5px; }
</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <svg width="32" height="20" viewBox="0 0 32 20" fill="none" stroke="#f0b35a" stroke-width="1.6" stroke-linejoin="round" aria-label="Truss">
      <path d="M1 18h30M3 3h26"/><path d="M1 18L6 3l5 15 5-15 5 15 5-15 5 15"/>
    </svg>
    <h1>Pair this device with Truss</h1>
  </div>
  <p class="sub">One paste in a terminal, one click in Truss. Nothing to type.</p>

  <section class="step">
    <span class="n">1</span>
    <div style="flex:1">
      <p>Paste this in a terminal on this machine.</p>
      <div class="cmd">
        <code id="runcmd">…</code>
        <button class="copy" id="copy" type="button">Copy</button>
      </div>
      <p class="hint">It downloads the installer and runs it in one go, so no file ever lands in Downloads (browsers flag stray .sh files; the pipe skips all that). The installer asks this device to pair and waits.</p>
    </div>
  </section>

  <section class="step">
    <span class="n">2</span>
    <div>
      <p>Click <b>Allow</b> in Truss when it asks.</p>
      <p class="hint">Approving in the Truss UI is the whole handshake: no code, nothing else to type. The agent then installs and starts itself (launchd on a Mac, systemd on Linux) and dials out over your tailnet; no inbound ports, nothing listens.</p>
    </div>
  </section>

  <section class="step">
    <span class="n">&#8226;</span>
    <div style="flex:1">
      <p style="color:#9b968c">No curl on this machine? Download the installer instead.</p>
      <button class="copy" type="button" id="dl">Download installer</button>
      <p class="hint" id="dlhint" hidden></p>
      <p id="err" role="alert" style="color:#ef6b5b;font-size:11.5px;margin:8px 0 0" hidden></p>
    </div>
  </section>
</main>
<script>
var runCmd = document.getElementById("runcmd"),
    copyBtn = document.getElementById("copy"),
    dl = document.getElementById("dl"), dlHint = document.getElementById("dlhint"),
    err = document.getElementById("err");

/* the page is served by the truss server itself, so its origin IS the
   server address — the command needs no wizard round-trip and no embed */
var command = "curl -fsSL " + location.origin + "/i | sh";
runCmd.textContent = command;

copyBtn.addEventListener("click", function () {
  var done = function () { copyBtn.textContent = "Copied"; setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(runCmd.textContent).then(done, function () { copyBtn.textContent = "Select it above"; });
  } else {
    copyBtn.textContent = "Select it above";
  }
});

/* the no-curl fallback: download the installer under a fresh random name
   (a browser that dedupes an earlier download to "t.sh (2)" left a static
   instruction pointing at the wrong file — found in manual test), then
   show the run command with that exact name */
dl.addEventListener("click", function () {
  err.hidden = true;
  dl.disabled = true;
  var name = "truss-pair-" + Math.random().toString(36).slice(2, 6) + ".sh";
  fetch("/i").then(function (r) {
    if (!r.ok) throw new Error("http " + r.status);
    return r.blob();
  }).then(function (blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    /* Safari can abort the download when the blob URL dies in the same tick
       (audit B1) — revoke lazily; one retained blob on a transient page is
       harmless, a missing file is not */
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    dlHint.textContent = "Saved to Downloads. Run it with: sh ~/Downloads/" + name;
    dlHint.hidden = false;
    dl.disabled = false;
  }).catch(function () {
    err.textContent = "Could not download the installer. Check the address, then retry.";
    err.hidden = false;
    dl.disabled = false;
  });
});
</script>
</body>
</html>
`;
}
