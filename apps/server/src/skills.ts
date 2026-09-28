import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Skill discovery + management (Skills panel — a Truss clone of the dsh-lab
 * skill-explorer plugin): every Agent-Skills directory visible to a working
 * directory (user + project, across the pi / claude / dsh / agents spec
 * dirs), with the `disable-model-invocation` frontmatter switch, create, and
 * delete-to-trash (recoverable).
 */

export interface SkillInfo {
  name: string;
  description: string;
  source: string; // absolute dir
  scope: "user" | "project";
  disabled?: boolean;
}

interface Frontmatter {
  name?: string;
  description?: string;
  disabled?: boolean;
  lines: string[]; // raw frontmatter lines (for rewriting)
}

function parseFrontmatter(text: string): Frontmatter | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out: Frontmatter = { lines: m[1].split(/\r?\n/) };
  for (const line of out.lines) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (kv[1] === "name") out.name = value;
    else if (kv[1] === "description") out.description = value;
    else if (kv[1] === "disable-model-invocation") out.disabled = /^(true|yes|1)$/i.test(value);
  }
  return out;
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
    if (!e.isDirectory() || e.name === ".trash") continue;
    const skillFile = join(dir, e.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
      out.push({
        name: fm?.name ?? e.name,
        description: fm?.description ?? "",
        source: join(dir, e.name),
        scope,
        disabled: fm?.disabled ?? false,
      });
    } catch {
      /* unreadable skill file — skip */
    }
  }
}

export function listSkills(cwd?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const home = homedir();
  /* user-level (shared Agent Skills spec dirs across harnesses) */
  scanDir(join(home, ".agents", "skills"), "user", out);
  scanDir(join(home, ".claude", "skills"), "user", out);
  scanDir(join(home, ".dsh", "skills"), "user", out);
  scanDir(join(home, ".pi", "agent", "skills"), "user", out);
  /* project-level */
  if (cwd) {
    scanDir(join(cwd, ".agents", "skills"), "project", out);
    scanDir(join(cwd, ".claude", "skills"), "project", out);
    scanDir(join(cwd, ".dsh", "skills"), "project", out);
    scanDir(join(cwd, ".pi", "skills"), "project", out);
  }
  return out;
}

function skillFileOf(source: string): string {
  const f = join(source, "SKILL.md");
  if (!existsSync(f)) throw new Error(`no SKILL.md at ${source}`);
  return f;
}

/** Flip `disable-model-invocation` in the frontmatter (adds it when missing). */
export function setSkillDisabled(source: string, disabled: boolean): SkillInfo {
  const file = skillFileOf(source);
  const text = readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);
  if (!fm) throw new Error("SKILL.md has no frontmatter");
  const body = text.slice(text.indexOf("---", 3));
  const lines = fm.lines.filter((l) => !/^disable-model-invocation\s*:/.test(l));
  if (disabled) lines.push("disable-model-invocation: true");
  writeFileSync(file, `---\n${lines.join("\n")}\n${body}`, "utf8");
  const after = parseFrontmatter(readFileSync(file, "utf8"))!;
  return {
    name: after.name ?? basename(source),
    description: after.description ?? "",
    source,
    scope: source.startsWith(homedir()) ? "user" : "project",
    disabled: after.disabled ?? false,
  };
}

/** Create a project skill: <cwd>/.agents/skills/<slug>/SKILL.md */
export function createSkill(cwd: string, name: string, description: string): SkillInfo {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("name must contain at least one letter or digit");
  const dir = join(cwd, ".agents", "skills", slug);
  if (existsSync(dir)) throw new Error(`skill already exists: ${slug}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: ${description.trim() || "TODO: what this skill does and when to use it"}\n---\n\n# ${name.trim()}\n\nInstructions for the agent go here.\n`,
    "utf8",
  );
  return { name: slug, description: description.trim(), source: dir, scope: "project", disabled: false };
}

/** Delete to a recoverable trash dir next to the skills root (never unlink). */
export function trashSkill(source: string): { trashed: string } {
  const file = skillFileOf(source); // validates
  void file;
  const trashRoot = join(source, "..", ".trash");
  mkdirSync(trashRoot, { recursive: true });
  let dest = join(trashRoot, basename(source));
  let n = 1;
  while (existsSync(dest)) dest = join(trashRoot, `${basename(source)}-${++n}`);
  renameSync(source, dest);
  return { trashed: dest };
}
