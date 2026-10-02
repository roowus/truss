/**
 * The settings registry (issue #30): one declarative source drives the whole
 * Settings page — sections for the TOC, fields with labels + descriptions
 * (no unexplained settings), one control family, uniform auto-save. A
 * setting missing from the registry is a setting missing from the page
 * (groupMode used to live only in the sidebar — that bug class dies here).
 */

export interface SettingSection {
  id: string;
  label: string;
  description?: string;
}

export interface SettingField {
  /** dotted, unique across the registry (e.g. feedSources.workDone) */
  id: string;
  section: string;
  label: string;
  description: string;
  type: "switch" | "select" | "text" | "number";
  options?: { value: string; label: string }[];
  default: unknown;
  keywords?: string[];
  /** number fields only: input + persistence clamp (mirrored in desktops.ts SETTING_BOUNDS) */
  min?: number;
  max?: number;
}

export const SETTINGS_SECTIONS: SettingSection[] = [
  { id: "appearance", label: "Appearance", description: "density and sidebar organization" },
  { id: "workspace", label: "Workspace", description: "defaults for new sessions and opens" },
  { id: "terminal", label: "Terminal", description: "the shell tabs" },
  { id: "feed", label: "Feed & notifications", description: "what lands in your inbox" },
  { id: "monitor", label: "Monitor", description: "device vitals polling" },
  { id: "sessions", label: "Sessions", description: "history, trash, and recovery" },
];

export const SETTINGS_REGISTRY: SettingField[] = [
  {
    id: "density",
    section: "appearance",
    label: "Density",
    description: "Comfortable gives rows room to breathe; compact fits more sessions and panels on screen.",
    type: "select",
    options: [
      { value: "comfortable", label: "comfortable" },
      { value: "compact", label: "compact" },
    ],
    default: "comfortable",
    keywords: ["compact", "spacing", "ui", "size"],
  },
  {
    id: "groupMode",
    section: "appearance",
    label: "Sidebar grouping",
    description: "Group chats by project tag or by working folder. (This used to be reachable only from the sidebar header.)",
    type: "select",
    options: [
      { value: "project", label: "by project" },
      { value: "folder", label: "by folder" },
    ],
    default: "project",
    keywords: ["group", "folder", "project", "sidebar", "sessions"],
  },
  {
    id: "openMode",
    section: "workspace",
    label: "Open sessions in",
    description: "Where a session opens: straight into a chat tab, or onto its daily workspace.",
    type: "select",
    options: [
      { value: "chat", label: "chat tab" },
      { value: "daily", label: "daily workspace" },
    ],
    default: "chat",
    keywords: ["open", "tab", "workspace", "navigation"],
  },
  {
    id: "defaultCwd",
    section: "workspace",
    label: "Default working directory",
    description: "New sessions and free shells start here when nothing else suggests a folder.",
    type: "text",
    default: "~",
    keywords: ["cwd", "directory", "folder", "path", "home"],
  },
  {
    id: "terminalFontSize",
    section: "terminal",
    label: "Terminal font size",
    description: "Pixel size of the monospace text in shell tabs.",
    type: "number",
    default: 13,
    min: 8,
    max: 32,
    keywords: ["font", "size", "terminal", "shell", "text"],
  },
  {
    id: "feedSources.permissions",
    section: "feed",
    label: "Permission requests",
    description: "Post a card when an agent asks for permission, so you can answer it from the inbox.",
    type: "switch",
    default: true,
    keywords: ["permission", "approve", "card", "feed"],
  },
  {
    id: "feedSources.workDone",
    section: "feed",
    label: "Finished work",
    description: "Post a card when a session's turn settles, with an excerpt of what it produced.",
    type: "switch",
    default: true,
    keywords: ["done", "finished", "report", "card", "feed"],
  },
  {
    id: "feedSources.taskRuns",
    section: "feed",
    label: "Task runs",
    description: "Post a card when a task-board run settles, so you can review and move the card.",
    type: "switch",
    default: true,
    keywords: ["task", "board", "run", "card", "feed"],
  },
  {
    id: "feedSources.errors",
    section: "feed",
    label: "Errors and crashes",
    description: "Post a card when a harness process dies into error state mid-session.",
    type: "switch",
    default: true,
    keywords: ["error", "crash", "died", "card", "feed"],
  },
  {
    id: "feedSources.context",
    section: "feed",
    label: "Context pressure",
    description: "Post a card when a session's context window starts filling up.",
    type: "switch",
    default: true,
    keywords: ["context", "window", "tokens", "pressure", "feed"],
  },
  {
    id: "monitorRefreshMs",
    section: "monitor",
    label: "Monitor poll interval (ms)",
    description: "How often the Monitor tab refreshes device vitals. Lower is fresher, higher is gentler on the tunnel.",
    type: "number",
    default: 3000,
    min: 500,
    max: 60000,
    keywords: ["monitor", "poll", "refresh", "vitals", "metrics"],
  },
  {
    id: "trashRetentionDays",
    section: "sessions",
    label: "Keep deleted chats for (days)",
    description: "How long the trash keeps a deleted chat recoverable before it's purged forever.",
    type: "number",
    default: 30,
    min: 1,
    max: 365,
    keywords: ["trash", "delete", "recover", "retention", "days"],
  },
];

/** matches label, description, and keywords — case-insensitive; empty query returns everything */
export function searchSettings(query: string): SettingField[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_REGISTRY;
  const words = q.split(/\s+/);
  return SETTINGS_REGISTRY.filter((f) => {
    const hay = `${f.label} ${f.description} ${(f.keywords ?? []).join(" ")} ${f.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
