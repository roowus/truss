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

/**
 * The browser pairing page (issue #111 review rounds), served at GET /p.
 * Minimum-work flow: the wizard's link carries the code in the URL fragment
 * (`/p#hbyn` — fragments never leave the browser, so the code never touches
 * access logs), the page pre-fills its box from it, and ONE click on
 * Download turns the code into a same-origin GET /i/<code> — the EXISTING
 * burn-once route — so the saved file is the token-embedded installer and
 * the terminal runs it with nothing else to type:
 *
 *   open link / scan QR → Download → `sh ~/Downloads/t.sh` → done.
 *
 * Error answers stay on the page (410/429 get their own lines; a wrong code
 * burns nothing, since redeemPairing only burns codes that exist). The page
 * embeds nothing itself (a fully static string: no interpolation, no
 * injection surface). Styled to the app's "graphite & signal" tokens with
 * system font stacks, self-contained so a tailnet-only remote needs no
 * internet to render it.
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
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0c0e; color: #ece7dd;
         font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .card { width: 400px; max-width: calc(100vw - 32px); background: #111316; border: 1px solid #353941; border-radius: 12px;
          padding: 24px; box-shadow: 0 18px 50px rgba(0,0,0,0.45); }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .brand h1 { font-size: 16px; font-weight: 600; margin: 0; }
  .sub { color: #9b968c; margin: 0 0 20px; }
  .step { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid #23262c; }
  .n { flex: none; width: 22px; height: 22px; border-radius: 999px; border: 1px solid #f0b35a; color: #f0b35a;
       display: grid; place-items: center; font-size: 11px; font-weight: 600; margin-top: 1px; }
  .step p { margin: 0 0 10px; color: #d0cabe; }
  .hint { color: #66635d; font-size: 11.5px; margin: 8px 0 0; }
  form { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; font: 500 16px/1 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0.25em; padding: 9px 12px; border-radius: 9px; border: 1px solid #353941;
          background: #0b0c0e; color: #f0b35a; }
  input:focus { outline: none; border-color: #f0b35a; }
  #err { color: #ef6b5b; font-size: 11.5px; margin: 8px 0 0; }
  .dl { display: inline-flex; align-items: center; gap: 8px; background: #f0b35a; color: #1a1a1a; font: 600 13px/1 inherit;
        padding: 10px 18px; border-radius: 9px; border: 0; cursor: pointer; text-decoration: none; }
  .dl:hover { filter: brightness(1.08); }
  .dl:disabled { opacity: 0.55; cursor: default; }
  .cmd { display: flex; align-items: center; gap: 8px; background: #0b0c0e; border: 1px solid #23262c; border-radius: 8px; padding: 9px 12px; }
  .cmd code { flex: 1; font: 13px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; color: #5fc9c0; user-select: all; }
  .copy { flex: none; font: inherit; font-size: 11.5px; color: #9b968c; background: none; border: 1px solid #353941;
          border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  .copy:hover { color: #ece7dd; border-color: #66635d; }
  .foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid #23262c; color: #66635d; font-size: 11.5px; }
</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#f0b35a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 20 L12 4 L21 20 Z"/><path d="M7.5 12 L16.5 12"/><path d="M12 4 L12 12"/><path d="M7.5 12 L3 20"/><path d="M16.5 12 L21 20"/>
    </svg>
    <h1>Pair this device with Truss</h1>
  </div>
  <p class="sub">Download, run, done. The installer never asks you anything.</p>

  <section class="step">
    <span class="n">1</span>
    <div style="flex:1">
      <p>Download the installer.</p>
      <form id="f">
        <input id="code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="8" placeholder="code" aria-label="pairing code">
        <button class="dl" type="submit" id="dl">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 v12"/><path d="M6 11 l6 6 6-6"/><path d="M4 21 h16"/></svg>
          Download
        </button>
      </form>
      <p class="hint" id="codehint">The 4-character code from the add-host wizard. It bakes into the downloaded file, so the install runs with zero questions.</p>
      <p id="err" role="alert" hidden></p>
    </div>
  </section>

  <section class="step">
    <span class="n">2</span>
    <div style="flex:1">
      <p>Run it in a terminal on this machine.</p>
      <div class="cmd">
        <code>sh ~/Downloads/t.sh</code>
        <button class="copy" id="copy" type="button">Copy</button>
      </div>
      <p class="hint">That is the whole install. The agent dials out over your tailnet; no inbound ports, nothing listens.</p>
      <p class="hint">The saved file holds a copy of this host's token. Delete it once the agent shows up in Truss.</p>
    </div>
  </section>
</main>
<script>
var f = document.getElementById("f"), c = document.getElementById("code"),
    dl = document.getElementById("dl"), err = document.getElementById("err"),
    hint = document.getElementById("codehint"),
    copyBtn = document.getElementById("copy");

/* the wizard's link carries the code in the fragment (/p#hbyn): fragments
   never leave the browser, so the code skips logs and pre-fills the box */
var fromLink = location.hash.replace(/^#/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
if (fromLink) {
  c.value = fromLink;
  hint.textContent = "Pre-filled from your link. Just hit Download.";
}

f.addEventListener("submit", function (e) {
  e.preventDefault();
  var code = c.value.trim().toLowerCase();
  if (!code) { c.focus(); return; }
  err.hidden = true;
  dl.disabled = true;
  fetch("/i/" + encodeURIComponent(code)).then(function (r) {
    if (!r.ok) {
      err.textContent = r.status === 429
        ? "Too many tries. Wait a minute, then retry."
        : "That code is used up, expired, or mis-typed. Mint a fresh one in the wizard.";
      err.hidden = false;
      dl.disabled = false;
      return null;
    }
    return r.blob();
  }).then(function (blob) {
    if (!blob) return;
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "t.sh";
    a.click();
    /* Safari can abort the download when the blob URL dies in the same tick
       (audit B1) — revoke lazily; one retained blob on a transient page is
       harmless, a missing file is not */
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    dl.disabled = false;
    hint.textContent = "Saved to Downloads. One step left.";
  }).catch(function () {
    err.textContent = "Could not reach the server. Check the address, then retry.";
    err.hidden = false;
    dl.disabled = false;
  });
});

copyBtn.addEventListener("click", function () {
  var done = function () { copyBtn.textContent = "Copied"; setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText("sh ~/Downloads/t.sh").then(done, function () { copyBtn.textContent = "Select it above"; });
  } else {
    copyBtn.textContent = "Select it above";
  }
});
</script>
</body>
</html>
`;
}
