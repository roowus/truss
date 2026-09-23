import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Skill discovery — pi implements the Agent Skills spec: a directory holding
 * SKILL.md with YAML frontmatter (name, description). Scans the pi global dir
 * and, when given, the session's project dir.
 */

export interface SkillInfo {
  name: string;
  description: string;
  source: string; // absolute dir
  scope: "global" | "project";
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  let name: string | undefined;
  let description: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (kv[1] === "name") name = value;
    else if (kv[1] === "description") description = value;
  }
  return { name, description };
}

function scanDir(dir: string, scope: SkillInfo["scope"], out: SkillInfo[]) {
  if (!existsSync(dir)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = join(dir, e.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
      out.push({
        name: fm.name ?? e.name,
        description: fm.description ?? "",
        source: join(dir, e.name),
        scope,
      });
    } catch {
      /* unreadable skill file — skip */
    }
  }
}

export function listSkills(cwd?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  scanDir(join(homedir(), ".pi", "agent", "skills"), "global", out);
  if (cwd) {
    scanDir(join(cwd, ".pi", "skills"), "project", out);
    scanDir(join(cwd, ".claude", "skills"), "project", out); // same spec, shared ecosystem
  }
  return out;
}
