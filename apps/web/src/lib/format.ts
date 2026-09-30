export const baseHarness = (h: string) => h.split("@")[0];
export const hostOf = (h: string) => (h.includes("@") ? h.split("@")[1] : undefined);

export const HARNESS: Record<string, { name: string; color: string; glyph: string; blurb: string }> = {
  pi: { name: "pi", color: "#f0b35a", glyph: "π", blurb: "Minimal coding agent · token streaming · queues input mid-run" },
  dsh: { name: "DeepSeek Harness", color: "#5fc9c0", glyph: "◈", blurb: "Plugin-stack harness · ACP · committed chunks · slow first boot" },
  "claude-code": { name: "Claude Code", color: "#ec7f5c", glyph: "✳", blurb: "stream-json · subagent teams via Task · permission prompts" },
  hermes: { name: "Hermes", color: "#a99bf0", glyph: "☤", blurb: "Nous agent · ACP · small streaming chunks" },
};
export const harnessStyle = (h: string) =>
  HARNESS[baseHarness(h)] ?? { name: h, color: "#9aa3ad", glyph: "◇", blurb: "external harness" };

export function fmtMs(ms?: number) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}
export function fmtTokens(n?: number) {
  if (n === undefined || n === null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
export function fmtCost(c?: number) {
  if (c === undefined || c === null) return "—";
  if (c === 0) return "$0";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(c < 1 ? 3 : 2)}`;
}
export function ago(t: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export const TRASH_RETENTION_DAYS = 30;
/** days a trashed chat has left before it is purged (issue #5): the delete
   stamp plus the retention window, never below 0 once the window has passed */
export function daysLeftInTrash(deletedAt: number, now = Date.now(), retentionDays = TRASH_RETENTION_DAYS) {
  return Math.max(0, Math.ceil((deletedAt + retentionDays * 86_400_000 - now) / 86_400_000));
}
export function fmtSize(n: number): string {
  const r = Math.round(n);
  if (r < 1024) return `${r} B`;
  if (r < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${(n / 1024 ** 4).toFixed(1)} TB`;
}
export const shortPath = (p: string) => p.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");

export function argSummary(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const o = args as Record<string, unknown>;
  const key = ["command", "path", "file_path", "pattern", "description", "url", "query"].find((k) => typeof o[k] === "string");
  if (key) return String(o[key]);
  const s = JSON.stringify(args);
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}
