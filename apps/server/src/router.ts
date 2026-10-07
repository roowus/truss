import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeAnthropicBaseUrl, modelRouterEnabled } from "./router-resolve.js";

/**
 * Router surface — the 9router model gateway (service control + live model
 * catalog + provider list) and where each harness currently routes its models.
 * 9router's management API is password-gated (its dashboard owns provider
 * keys); everything here is read from its open loopback catalog + config
 * files, or written through systemd.
 */

const ROUTER_PORT = Number(process.env.TRUSS_ROUTER_PORT ?? 20128);
const ROUTER_SERVICE = "9router.service";
const ROUTER_HOME = join(homedir(), ".9router");

async function fetchJson(url: string, timeoutMs = 4000): Promise<unknown | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function serviceActive(name: string): boolean {
  try {
    return execFileSync("systemctl", ["is-active", name], { stdio: "pipe" }).toString().trim() === "active";
  } catch {
    return false;
  }
}

export function controlRouter(action: "start" | "stop" | "restart"): { ok: boolean; detail?: string } {
  try {
    execFileSync("sudo", ["-n", "systemctl", action, ROUTER_SERVICE], { timeout: 20000, stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

interface CatalogModel {
  id: string;
  owned_by?: string;
  capabilities?: Record<string, unknown>;
  context_length?: number;
}

export async function routerStatus(): Promise<{
  service: string;
  active: boolean;
  port: number;
  models: CatalogModel[];
  providers: { id: string; models: number }[];
  catalogSyncedAt?: string;
}> {
  const active = serviceActive(ROUTER_SERVICE);

  /* live model list (open on loopback) when the gateway is up */
  let models: CatalogModel[] = [];
  if (active) {
    const live = (await fetchJson(`http://127.0.0.1:${ROUTER_PORT}/v1/models`)) as { data?: CatalogModel[] } | null;
    if (live?.data) models = live.data;
  }

  /* the synced catalog file carries provider grouping + capabilities */
  const providers: { id: string; models: number }[] = [];
  let catalogSyncedAt: string | undefined;
  const catalogPath = join(ROUTER_HOME, "model-catalog.json");
  if (existsSync(catalogPath)) {
    try {
      const cat = JSON.parse(readFileSync(catalogPath, "utf8"));
      catalogSyncedAt = cat.syncedAt;
      for (const p of cat.providers ?? []) {
        providers.push({ id: p.id ?? p.name ?? "?", models: (p.models ?? []).length });
      }
      if (!models.length && Array.isArray(cat.models)) models = cat.models;
    } catch {
      /* unreadable catalog — live list still served above */
    }
  }
  if (!providers.length && models.length) {
    const counts = new Map<string, number>();
    for (const m of models) {
      const owner = m.owned_by ?? (typeof m.id === "string" && m.id.includes("/") ? m.id.split("/")[0] : "other");
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    for (const [id, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      providers.push({ id, models: count });
    }
  }
  return { service: ROUTER_SERVICE, active, port: ROUTER_PORT, models, providers, catalogSyncedAt };
}

/** where each harness's model config currently points (read-only snapshot) */
export function harnessRouting(): {
  harness: string;
  model?: string;
  provider?: string;
  endpoint?: string;
  source: string;
}[] {
  const out: { harness: string; model?: string; provider?: string; endpoint?: string; source: string }[] = [];

  /* pi: ~/.pi/agent/models.json */
  const piPath = join(homedir(), ".pi", "agent", "models.json");
  if (existsSync(piPath)) {
    try {
      const cfg = JSON.parse(readFileSync(piPath, "utf8"));
      for (const [provider, p] of Object.entries<any>(cfg.providers ?? {})) {
        for (const m of p.models ?? []) {
          out.push({
            harness: "pi",
            model: m.id,
            provider,
            endpoint: p.baseUrl,
            source: "~/.pi/agent/models.json",
          });
        }
      }
    } catch {
      /* partial json — skip */
    }
  }

  /* hermes: ~/.hermes/config.yaml (light parse — top of file only) */
  const hermesPath = join(homedir(), ".hermes", "config.yaml");
  if (existsSync(hermesPath)) {
    try {
      const text = readFileSync(hermesPath, "utf8");
      const defModel = text.match(/default:\s*"([^"]+)"/)?.[1];
      const providerKey = text.match(/provider:\s*"([^"]+)"/)?.[1];
      const baseUrl = text.match(/base_url:\s*"([^"]+)"/)?.[1];
      out.push({
        harness: "hermes",
        model: defModel,
        provider: providerKey,
        endpoint: baseUrl,
        source: "~/.hermes/config.yaml",
      });
    } catch {
      /* skip */
    }
  }

  /* claude-code: env-driven (the adapter's defaults) — the displayed
     endpoint must be the adapter's own precedence (audit B5), so the panel
     can never silently desync from what sessions actually use */
  out.push({
    harness: "claude-code",
    model: process.env.TRUSS_CLAUDE_MODEL ?? "glm-4.7",
    provider: modelRouterEnabled() && !process.env.TRUSS_CLAUDE_BASE_URL ? "model-router" : "zai-local",
    endpoint: claudeAnthropicBaseUrl(),
    source: "truss adapter env",
  });

  /* dsh: the truss patch pins provider+model */
  const patchPath = join(__dirnameFor(), "..", "..", "..", "config", "truss-dsh-acp.yml");
  if (existsSync(patchPath)) {
    try {
      const text = readFileSync(patchPath, "utf8");
      out.push({
        harness: "dsh",
        model: text.match(/model:\s*(\S+)/)?.[1],
        provider: text.match(/provider:\s*(\w+)/)?.[1],
        endpoint: "fireworks via dsh-key-proxy :45820",
        source: "config/truss-dsh-acp.yml",
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

function __dirnameFor(): string {
  return new URL(".", import.meta.url).pathname;
}
