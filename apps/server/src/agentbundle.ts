import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./db.js";
import { getHost } from "./hosts.js";

/**
 * The node-agent as a downloadable artifact. Bundled from the monorepo with
 * esbuild at server boot (always version-matched to the server that serves
 * it), cached in the data dir, and wrapped in a self-contained install script
 * at GET /agent/install.sh?host=<id> — the add-host wizard's one-liner.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const bundlePath = () => join(dataDir, "agent-bundle.mjs");

let building: Promise<void> | null = null;
let lastError: string | null = null;
let bundleHash: string | null = null;

/** short hash of the bundle this server currently builds — the version the
   handshake (issue #100) compares an installed agent's self-reported hash
   against, so agent/server skew is detectable instead of silent */
export function agentBundleHash(): string | null {
  return bundleHash;
}

export function ensureAgentBundle(): Promise<void> {
  if (building) return building;
  building = (async () => {
    mkdirSync(dataDir, { recursive: true });
    const { build } = await import("esbuild");
    await build({
      entryPoints: [join(repoRoot, "packages/node-agent/src/index.ts")],
      outfile: bundlePath(),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      /* adapters resolve paths via import.meta.url; ESM output keeps it real
         (CJS output leaves it undefined). CJS deps (ws) require() node builtins
         — createRequire in a banner wires that up for ESM output. */
      banner: {
        js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
      },
      logLevel: "silent",
    });
    bundleHash = createHash("sha256").update(readFileSync(bundlePath())).digest("hex").slice(0, 12);
    lastError = null;
  })().catch((e) => {
    lastError = e?.message ?? String(e);
    building = null;
    throw e;
  });
  return building;
}

export function agentBundleError() {
  return lastError;
}

function b64(s: string | Buffer) {
  return Buffer.from(s).toString("base64");
}

/* serverUrl is request/body-controlled and lands inside a shell script that
   can run unattended on a remote peer (taildrop, ssh-install) — the unquoted
   env heredoc below would honor `$()`/backticks, and a newline would inject
   whole script lines. One choke point, so every delivery route inherits the
   guard: a plain http(s) URL — host (dns/ipv4/ipv6), optional port, optional
   simple path — and nothing the shell can read as syntax. (issue #91 audit) */
const SERVER_URL_RE = /^https?:\/\/[A-Za-z0-9.\-[\]:]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/;
export function assertSafeServerUrl(serverUrl: string): void {
  if (!SERVER_URL_RE.test(serverUrl ?? "")) {
    throw new Error("serverUrl must be a plain http(s) URL — host, optional port and path, no shell characters");
  }
}

/* the label is free text (shown in the UI, unicode welcome) but it is ALSO
   embedded in this shell script — in a comment, where a newline would inject
   a whole line, and in the unquoted systemd-unit heredoc, where $() would
   expand on the peer. The script can run unattended (taildrop, ssh-install),
   so the embed form is stripped to plain display characters. (issue #91
   audit, round 3) */
const scriptSafeLabel = (s: string) => s.replace(/[^A-Za-z0-9 ._-]/g, " ").replace(/\s+/g, " ").trim() || "remote host";

export function installScript(hostId: string, serverUrl: string): string {
  const host = getHost(hostId);
  if (!host) throw new Error(`no such host: ${hostId}`);
  assertSafeServerUrl(serverUrl);
  const label = scriptSafeLabel(host.label);
  /* http(s) for the curl line; the agent dials ws(s) */
  const wsUrl = serverUrl.replace(/^http/, "ws");
  if (!existsSync(bundlePath())) throw new Error("agent bundle isn't built yet — the server builds it at boot, retry in a few seconds");
  const bundle = readFileSync(bundlePath());
  const dshPatch = readFileSync(join(repoRoot, "config", "truss-dsh-acp.yml"), "utf8");
  /* the token is NOT embedded — it arrives as the script's $1, shown once in
     the wizard, and lands chmod 600 in the env file */
  return `#!/bin/sh
# Truss node-agent installer — host "${label}" (${host.id})
# usage: curl -fsSL '${serverUrl}/agent/install.sh?host=${host.id}' | sh -s -- <token-from-the-wizard>
set -eu

TOKEN="\${1:-}"
if [ -z "$TOKEN" ]; then
  echo "missing the host token (arg 1) — copy the full command from the Truss add-host wizard" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node.js >= 20 is required on this host — https://nodejs.org/en/download" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "node >= 20 required (found $(node -v))" >&2
  exit 1
fi

DEST="$HOME/.truss"
mkdir -p "$DEST"
chmod 700 "$DEST"

base64 -d > "$DEST/node-agent.mjs" <<'__BUNDLE__'
${b64(bundle)}
__BUNDLE__

base64 -d > "$DEST/truss-dsh-acp.yml" <<'__PATCH__'
${b64(dshPatch)}
__PATCH__

cat > "$DEST/agent-${host.id}.env" <<__ENV__
TRUSS_SERVER=${wsUrl}
TRUSS_HOST_ID=${host.id}
TRUSS_AGENT_TOKEN=$TOKEN
TRUSS_DSH_PATCH=$DEST/truss-dsh-acp.yml
__ENV__
chmod 600 "$DEST/agent-${host.id}.env"

echo
echo "installed: $DEST/node-agent.mjs"
echo
# the installer STARTS the agent wherever the platform allows (issue #111
# review: "it just tells me another command to run" — a manual run line is
# the fallback, never the happy path). macOS gets a launchd LaunchAgent
# (no sudo, starts at login); the plist execs through the chmod-600 env
# file so the token stays out of the 0644 plist.
if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  PLIST="$HOME/Library/LaunchAgents/com.truss.agent-${host.id}.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<__PLIST__
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.truss.agent-${host.id}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>set -a; . "$DEST/agent-${host.id}.env"; set +a; exec $(command -v node) "$DEST/node-agent.mjs"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$DEST/agent-${host.id}.log</string>
  <key>StandardErrorPath</key>
  <string>$DEST/agent-${host.id}.log</string>
</dict>
</plist>
__PLIST__
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
  launchctl kickstart "gui/$(id -u)/com.truss.agent-${host.id}" 2>/dev/null || true
  if launchctl print "gui/$(id -u)/com.truss.agent-${host.id}" >/dev/null 2>&1; then
    echo "service up:   launchd agent com.truss.agent-${host.id} (running now, starts at login)"
    echo "logs:         $DEST/agent-${host.id}.log"
  else
    echo "could not auto-start the agent (no console session?). Run it:"
    echo "  set -a; . \\"$DEST/agent-${host.id}.env\\"; set +a; node $DEST/node-agent.mjs"
  fi
elif command -v systemctl >/dev/null 2>&1 && systemctl --user >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/truss-agent-${host.id}.service"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$UNIT" <<__UNIT__
[Unit]
Description=Truss node agent (${label})
After=network-online.target

[Service]
EnvironmentFile=$DEST/agent-${host.id}.env
ExecStart=$(command -v node) $DEST/node-agent.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
__UNIT__
  systemctl --user daemon-reload
  systemctl --user enable --now "truss-agent-${host.id}.service"
  echo "service up:   systemctl --user status truss-agent-${host.id}.service"
else
  echo "no launchd or systemd here. Run the agent yourself:"
  echo "  set -a; . \\"$DEST/agent-${host.id}.env\\"; set +a; node $DEST/node-agent.mjs"
fi
echo
echo "the agent dials OUT to ${wsUrl} — no inbound ports needed on this host."
`;
}

/**
 * The DELIVERED-file variant (issue #1): same installer with the token baked
 * in, so `sh truss-install-<host>.sh` runs with zero arguments after a
 * taildrop. installScript (the wizard's copy command) keeps the token as $1
 * — the copy path must never embed it in the command line, the delivered
 * file must never lack it.
 */
export function standaloneInstallScript(hostId: string, serverUrl: string, token: string): string {
  if (!/^truss_agent_[a-f0-9]+$/.test(token)) throw new Error("unexpected token shape — refusing to embed");
  const script = installScript(hostId, serverUrl);
  const needle = 'TOKEN="${1:-}"';
  const i = script.indexOf(needle);
  if (i === -1) throw new Error("install script shape changed — embed point missing");
  return script.slice(0, i) + `TOKEN="${token}"` + script.slice(i + needle.length);
}
