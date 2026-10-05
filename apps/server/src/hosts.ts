import { createHash, randomBytes } from "node:crypto";
import { store } from "./db.js";

/**
 * Registered remote hosts. A host row exists before its agent ever connects
 * (the add-host wizard mints it), shows online state while connected, and
 * stays listed when offline. Per-host agent tokens replace the single shared
 * TRUSS_AGENT_TOKEN: minted at add time, shown once, stored hashed, revocable
 * per host. The shared env token still works as a dev fallback.
 */

export interface HostRow {
  id: string;
  label: string;
  token_hash: string;
  token_prefix: string;
  created_at: number;
  last_seen: number | null;
  revoked: number;
  pinned: number;
  note: string;
}

let ready = false;
function table() {
  if (ready) return;
  store.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      token_hash   TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_seen    INTEGER,
      revoked      INTEGER NOT NULL DEFAULT 0,
      pinned       INTEGER NOT NULL DEFAULT 0,
      note         TEXT NOT NULL DEFAULT ''
    );
  `);
  /* migration: pinned floats the host to the top of the sidebar's hosts
     section (issue #86); pre-pin databases need the column added */
  const cols = store.all<{ name: string }>(`PRAGMA table_info(hosts)`);
  if (!cols.some((c) => c.name === "pinned")) {
    store.exec(`ALTER TABLE hosts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
  ready = true;
}

function camel(r: HostRow) {
  return {
    id: r.id,
    label: r.label,
    tokenPrefix: r.token_prefix,
    createdAt: r.created_at,
    lastSeen: r.last_seen ?? undefined,
    revoked: !!r.revoked,
    pinned: !!r.pinned,
    note: r.note,
  };
}

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * Human-minted ids (issue #109): the add-host wizard always has the label at
 * mint time, so the id IS the slugified label ("Rewiss Macbook Pro" →
 * "rewiss-macbook-pro") — every surface that prints the id raw still reads
 * right. Collisions suffix -2, -3…; a label with no safe characters falls
 * back to the old hex shape. Immutable after mint: env files, tokens, and
 * pairing on the device all key off it. Capped at 48 chars — the id lands
 * in the install command, the on-device env filename, and the systemd unit
 * name, and a pasted paragraph of a label would live there forever.
 */
function mintHostId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  if (!slug) {
    let id = randomBytes(4).toString("hex");
    while (getHost(id)) id = randomBytes(4).toString("hex");
    return id;
  }
  let id = slug;
  for (let n = 2; getHost(id); n++) id = `${slug}-${n}`;
  return id;
}

/** create the row + mint its token; the plaintext returns ONCE (wizard shows it) */
export function createHost(label: string, note = ""): { host: ReturnType<typeof camel>; token: string } {
  table();
  const id = mintHostId(label);
  const token = `truss_agent_${randomBytes(24).toString("hex")}`;
  store.run(
    `INSERT INTO hosts (id, label, token_hash, token_prefix, created_at, note) VALUES (?, ?, ?, ?, ?, ?)` ,
    id, label.trim() || "new host", hashToken(token), `…${token.slice(-6)}`, Date.now(), note,
  );
  return { host: getHost(id)!, token };
}

export function getHost(id: string) {
  table();
  const r = store.get<HostRow>(`SELECT * FROM hosts WHERE id = ?`, id);
  return r ? camel(r) : undefined;
}

export function listHosts() {
  table();
  return store.all<HostRow>(`SELECT * FROM hosts ORDER BY created_at DESC`).map(camel);
}

/* ids deleted this process. The shared-env-token fallback auto-registers an
   unknown id on sight — without a tombstone, a deleted host whose agent
   reconnects (which delete now actively triggers via dropAgent) would
   resurrect itself seconds later (issue #85, audit round 1). In-memory on
   purpose: a restart is the explicit reset, and the add-host wizard always
   mints a fresh id so re-adding a box is never blocked. */
const tombstoned = new Set<string>();

/** tests only: the Set is process-global while freshServer swaps the data
   dir per fixture — clear it when a fixture needs env auto-registration
   for an id some earlier test deleted */
export function resetHostTombstones() {
  tombstoned.clear();
}

/** the connect gate answers 4404 ("host deleted") for these, not a bare
   4403, so the node-agent stops retrying instead of blaming the token */
export function isHostTombstoned(id: string) {
  return tombstoned.has(id);
}

export function deleteHost(id: string) {
  table();
  store.run(`DELETE FROM hosts WHERE id = ?`, id);
  tombstoned.add(id);
}

export function setHostRevoked(id: string, revoked: boolean) {
  table();
  store.run(`UPDATE hosts SET revoked = ? WHERE id = ?`, revoked ? 1 : 0, id);
}

/** pin/unpin (issue #86) — floats the host to the top of the sidebar's hosts
    section. Orthogonal to revoked: a pinned revoked host stays revoked. */
export function setHostPinned(id: string, pinned: boolean) {
  table();
  if (!getHost(id)) throw new Error(`no such host: ${id}`);
  store.run(`UPDATE hosts SET pinned = ? WHERE id = ?`, pinned ? 1 : 0, id);
}

/** rotate: new plaintext once, old token dies. Revocation is separate — a
   revoked host that rotates should stay revoked until explicitly restored. */
export function rotateHostToken(id: string): { token: string } {
  table();
  if (!getHost(id)) throw new Error(`no such host: ${id}`);
  const token = `truss_agent_${randomBytes(24).toString("hex")}`;
  store.run(`UPDATE hosts SET token_hash = ?, token_prefix = ? WHERE id = ?`, hashToken(token), `…${token.slice(-6)}`, id);
  return { token };
}

export function touchHost(id: string) {
  table();
  store.run(`UPDATE hosts SET last_seen = ? WHERE id = ?`, Date.now(), id);
}

/** the /agent/connect gate: per-host token wins; env token is the dev fallback */
export function verifyAgentToken(hostId: string, token: string, envToken: string): boolean {
  table();
  const r = store.get<HostRow>(`SELECT * FROM hosts WHERE id = ?`, hostId);
  /* a revoked host stays dead no matter which token it presents */
  if (r?.revoked) return false;
  if (r && hashToken(token) === r.token_hash) {
    touchHost(hostId);
    return true;
  }
  /* legacy shared token: allowed, and auto-registers the host UNDER ITS OWN
     ID (createHost would mint a random one, orphaning last_seen and adding a
     duplicate row on every reconnect) */
  if (envToken && token === envToken) {
    if (!r) {
      /* a deleted host stays deleted — its agent reconnecting with the
         shared token must not resurrect the row (issue #85) */
      if (tombstoned.has(hostId)) return false;
      store.run(
        `INSERT INTO hosts (id, label, token_hash, token_prefix, created_at, note) VALUES (?, ?, ?, ?, ?, ?)`,
        hostId, hostId, hashToken(token), `…${token.slice(-6)}`, Date.now(), "auto-registered via shared token",
      );
    }
    touchHost(hostId);
    return true;
  }
  return false;
}
