import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Credentials surface — manages the dsh-key-proxy route config
 * (~/.dsh/bin/dsh-key-proxy.json): the loopback credential broker every
 * Truss harness routes through. Keys are write-only: they arrive at the
 * server, land in the owner-only file, and are never returned by any read.
 *
 * The proxy validates config at startup; every write is followed by a
 * service restart (dsh-key-proxy.service).
 */

const CONFIG_PATH =
  process.env.DSH_KEY_PROXY_CONFIG ?? join(homedir(), ".dsh", "bin", "dsh-key-proxy.json");
const SERVICE = "dsh-key-proxy.service";

/* mirror of the proxy's startup validation invariants */
const UPSTREAM_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const AUTH_STYLES = new Set(["bearer", "x-api-key"]);

export interface RouteView {
  port: number;
  host: string;
  scheme: "https" | "http";
  upstreamPort: number;
  auth: "bearer" | "x-api-key";
  enabled: boolean;
  allowedModels?: string[];
  description?: string;
  hasKey: boolean;
}

interface RouteRaw {
  port: number;
  host: string;
  scheme?: string;
  upstreamPort?: number;
  auth: string;
  enabled?: boolean;
  allowedModels?: string[];
  description?: string;
  key?: string;
}

function readConfig(): { routes: RouteRaw[] } {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${CONFIG_PATH}: ${String(err)}`);
  }
}

function validateRoute(r: Partial<RouteRaw> & { port: number }, existingPorts: Set<number>, replacing: boolean) {
  const name = r.description ?? `route :${r.port}`;
  if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) throw new Error(`${name}: port must be 1-65535`);
  if (!replacing && existingPorts.has(r.port)) throw new Error(`${name}: port ${r.port} already in use`);
  const scheme = r.scheme ?? "https";
  if (scheme !== "https" && scheme !== "http") throw new Error(`${name}: scheme must be https or http`);
  if (typeof r.host !== "string" || !r.host) throw new Error(`${name}: host is required`);
  if (scheme === "https" && !UPSTREAM_HOST_PATTERN.test(r.host))
    throw new Error(`${name}: host must be a bare hostname (no scheme, path, or IP)`);
  if (scheme === "http" && !LOOPBACK_HOSTS.has(r.host))
    throw new Error(`${name}: plaintext http only to loopback hosts`);
  const upstreamPort = r.upstreamPort ?? (scheme === "https" ? 443 : 80);
  if (LOOPBACK_HOSTS.has(r.host) && upstreamPort === r.port)
    throw new Error(`${name}: upstream points back at its own listen port`);
  if (!AUTH_STYLES.has(r.auth ?? "bearer")) throw new Error(`${name}: auth must be bearer or x-api-key`);
  if (r.allowedModels !== undefined) {
    if (!Array.isArray(r.allowedModels) || r.allowedModels.length === 0 || r.allowedModels.some((m) => typeof m !== "string" || !m.length))
      throw new Error(`${name}: allowedModels must be a non-empty string array`);
  }
  const enabled = r.enabled !== false;
  if (enabled && (!r.key || typeof r.key !== "string"))
    throw new Error(`${name}: enabled routes need a key — or set enabled:false`);
}

function writeConfig(cfg: { routes: RouteRaw[] }) {
  /* preserve the owner-only invariant the proxy enforces */
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

function restartService(): { restarted: boolean; detail?: string } {
  try {
    execFileSync("sudo", ["-n", "systemctl", "restart", SERVICE], { timeout: 15000, stdio: "pipe" });
    return { restarted: true };
  } catch (err) {
    return { restarted: false, detail: String(err) };
  }
}

export function listCredentials(): { routes: RouteView[]; service: string; serviceActive: boolean } {
  const cfg = readConfig();
  let serviceActive = false;
  try {
    serviceActive = execFileSync("systemctl", ["is-active", SERVICE], { stdio: "pipe" }).toString().trim() === "active";
  } catch {
    serviceActive = false;
  }
  return {
    service: SERVICE,
    serviceActive,
    routes: cfg.routes.map((r) => ({
      port: r.port,
      host: r.host,
      scheme: (r.scheme as "https" | "http") ?? "https",
      upstreamPort: r.upstreamPort ?? ((r.scheme ?? "https") === "https" ? 443 : 80),
      auth: (r.auth as "bearer" | "x-api-key") ?? "bearer",
      enabled: r.enabled !== false,
      allowedModels: r.allowedModels,
      description: r.description,
      hasKey: typeof r.key === "string" && r.key.length > 0,
    })),
  };
}

export function upsertRoute(input: {
  port: number;
  host: string;
  scheme?: string;
  upstreamPort?: number;
  auth?: string;
  enabled?: boolean;
  allowedModels?: string[];
  description?: string;
  key?: string;
}): { ok: true; restarted: boolean; restartDetail?: string } {
  const cfg = readConfig();
  const idx = cfg.routes.findIndex((r) => r.port === input.port);
  const existing = idx >= 0 ? cfg.routes[idx] : null;
  const existingPorts = new Set(cfg.routes.filter((r) => r !== existing).map((r) => r.port));

  const merged: RouteRaw = {
    ...(existing ?? {}),
    port: input.port,
    host: input.host ?? existing?.host,
    scheme: input.scheme ?? existing?.scheme ?? "https",
    upstreamPort: input.upstreamPort ?? existing?.upstreamPort,
    auth: input.auth ?? existing?.auth ?? "bearer",
    enabled: input.enabled ?? existing?.enabled ?? true,
    allowedModels: input.allowedModels ?? existing?.allowedModels,
    description: input.description ?? existing?.description,
    /* key is write-only: omitted on update = keep the stored one */
    key: input.key ?? existing?.key,
  };

  validateRoute(merged, existingPorts, idx >= 0);
  if (idx >= 0) cfg.routes[idx] = merged;
  else cfg.routes.push(merged);
  cfg.routes.sort((a, b) => a.port - b.port);
  writeConfig(cfg);
  const { restarted, detail } = restartService();
  return { ok: true, restarted, restartDetail: detail };
}

export function deleteRoute(port: number): { ok: true; restarted: boolean; restartDetail?: string } {
  const cfg = readConfig();
  const next = cfg.routes.filter((r) => r.port !== port);
  if (next.length === cfg.routes.length) throw new Error(`no route on port ${port}`);
  if (next.length === 0) throw new Error("the proxy needs at least one route");
  writeConfig({ routes: next });
  const { restarted, detail } = restartService();
  return { ok: true, restarted, restartDetail: detail };
}

export function controlService(action: "start" | "stop" | "restart"): { ok: boolean; detail?: string } {
  try {
    execFileSync("sudo", ["-n", "systemctl", action, SERVICE], { timeout: 15000, stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}
