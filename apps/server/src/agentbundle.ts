import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function installScript(hostId: string, serverUrl: string): string {
  const host = getHost(hostId);
  if (!host) throw new Error(`no such host: ${hostId}`);
  /* http(s) for the curl line; the agent dials ws(s) */
  const wsUrl = serverUrl.replace(/^http/, "ws");
  if (!existsSync(bundlePath())) throw new Error("agent bundle isn't built yet — the server builds it at boot, retry in a few seconds");
  const bundle = readFileSync(bundlePath());
  const dshPatch = readFileSync(join(repoRoot, "config", "truss-dsh-acp.yml"), "utf8");
  /* the token is NOT embedded — it arrives as the script's $1, shown once in
     the wizard, and lands chmod 600 in the env file */
  return `#!/bin/sh
# Truss node-agent installer — host "${host.label.replace(/"/g, "")}" (${host.id})
# usage: curl -fsSL ${serverUrl}/agent/install.sh?host=${host.id} | sh -s -- <token-from-the-wizard>
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
echo "run it:        set -a; . \\"$DEST/agent-${host.id}.env\\"; set +a; node $DEST/node-agent.mjs"
if command -v systemctl >/dev/null 2>&1 && systemctl --user >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/truss-agent-${host.id}.service"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$UNIT" <<__UNIT__
[Unit]
Description=Truss node agent (${host.label.replace(/"/g, "")})
After=network-online.target

[Service]
EnvironmentFile=$DEST/agent-${host.id}.env
ExecStart=$(command -v node) $DEST/node-agent.cjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
__UNIT__
  systemctl --user daemon-reload
  systemctl --user enable --now "truss-agent-${host.id}.service"
  echo "service up:   systemctl --user status truss-agent-${host.id}.service"
fi
echo
echo "the agent dials OUT to ${wsUrl} — no inbound ports needed on this host."
`;
}
