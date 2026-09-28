import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { freshServer } from "./helpers.js";

/* skills.ts — Agent-Skills discovery + management. The module locates skills
   via os.homedir() (which honors $HOME on POSIX, read at call time), so each
   test points HOME at a fixture dir — the real ~/.agents, ~/.claude, ~/.dsh,
   ~/.pi are never touched. skills.ts itself opens no DB; freshServer is still
   used per pattern for the temp dir + cleanup. */

const SK = (frontmatter: string, body = "\n# Body\n") => `---\n${frontmatter}\n---\n${body}`;

function mkSkill(dir: string, content: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
}

/** fresh temp dir + HOME override; returns the dirs and a restore fn */
async function fakeEnv(tag: string) {
  const { dir, cleanup } = await freshServer(tag);
  const home = join(dir, "home");
  const proj = join(dir, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const skills = await import("../src/skills.js");
  return {
    home,
    proj,
    skills,
    done: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      cleanup();
    },
  };
}

test("list: user + project scopes, frontmatter parsed, junk dirs skipped", async () => {
  const { home, proj, skills, done } = await fakeEnv("skills-list");
  try {
    // user scope, two of the spec dirs
    mkSkill(join(home, ".agents", "skills", "alpha"), SK("name: alpha\ndescription: does alpha things"));
    mkSkill(join(home, ".claude", "skills", "gamma"), SK("name: gamma\ndisable-model-invocation: true"));
    // project scope
    mkSkill(join(proj, ".dsh", "skills", "beta"), SK("name: beta\ndescription: proj skill"));
    // malformed / junk entries must degrade gracefully:
    mkdirSync(join(home, ".agents", "skills", "no-skill-file"), { recursive: true }); // no SKILL.md
    writeFileSync(join(home, ".agents", "skills", "a-plain-file.md"), "x"); // not a dir
    mkSkill(join(home, ".agents", "skills", "no-frontmatter"), "# just markdown, no fence\n"); // fm-less
    mkSkill(join(home, ".agents", "skills", ".trash", "buried"), SK("name: buried")); // trash never listed

    const list = skills.listSkills(proj);
    const byName = new Map(list.map((s) => [s.name, s]));

    const alpha = byName.get("alpha")!;
    assert.equal(alpha.scope, "user");
    assert.equal(alpha.description, "does alpha things");
    assert.equal(alpha.disabled, false);
    assert.equal(alpha.source, join(home, ".agents", "skills", "alpha"));

    assert.equal(byName.get("gamma")!.disabled, true, "disable-model-invocation parsed");

    const beta = byName.get("beta")!;
    assert.equal(beta.scope, "project");
    assert.equal(beta.source, join(proj, ".dsh", "skills", "beta"));

    // frontmatter-less SKILL.md still lists, named after its dir
    const nf = byName.get("no-frontmatter")!;
    assert.equal(nf.description, "");
    assert.equal(nf.disabled, false);

    assert.equal(byName.has("buried"), false, ".trash is skipped");
    assert.equal(byName.has("no-skill-file"), false);
    assert.equal(list.length, 4);

    // no cwd -> user scope only
    assert.deepEqual(skills.listSkills().map((s) => s.name).sort(), ["alpha", "gamma", "no-frontmatter"]);
  } finally {
    done();
  }
});

test("setSkillDisabled: toggles the frontmatter flag both ways, persists to disk", async () => {
  const { home, skills, done } = await fakeEnv("skills-toggle");
  try {
    const source = join(home, ".agents", "skills", "alpha");
    mkSkill(source, SK("name: alpha\ndescription: keep me"));

    const off = skills.setSkillDisabled(source, true);
    assert.equal(off.disabled, true);
    assert.equal(off.name, "alpha");
    assert.equal(off.scope, "user", "source under $HOME classifies as user");
    let text = readFileSync(join(source, "SKILL.md"), "utf8");
    assert.match(text, /disable-model-invocation: true/);
    assert.match(text, /description: keep me/, "other frontmatter lines survive");
    assert.match(text, /# Body/, "body survives");
    assert.equal(skills.listSkills().find((s) => s.name === "alpha")!.disabled, true, "re-list sees it");

    const on = skills.setSkillDisabled(source, false);
    assert.equal(on.disabled, false);
    text = readFileSync(join(source, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /disable-model-invocation/);
    assert.match(text, /name: alpha/);

    // errors: no frontmatter, no SKILL.md
    const bare = join(home, ".agents", "skills", "bare");
    mkSkill(bare, "# no fence\n");
    assert.throws(() => skills.setSkillDisabled(bare, true), /no frontmatter/);
    assert.throws(() => skills.setSkillDisabled(join(home, ".agents", "skills", "ghost"), true), /no SKILL.md/);
  } finally {
    done();
  }
});

test("create: slugifies the name, writes SKILL.md, lists afterwards; dup/junk rejected", async () => {
  const { proj, skills, done } = await fakeEnv("skills-create");
  try {
    const s = skills.createSkill(proj, "My Cool Skill!", "does cool things");
    assert.equal(s.name, "my-cool-skill");
    assert.equal(s.scope, "project");
    assert.equal(s.disabled, false);
    assert.equal(s.source, join(proj, ".agents", "skills", "my-cool-skill"));
    const text = readFileSync(join(s.source, "SKILL.md"), "utf8");
    assert.match(text, /name: my-cool-skill/);
    assert.match(text, /description: does cool things/);

    // discoverable through the normal listing
    assert.ok(skills.listSkills(proj).some((x) => x.name === "my-cool-skill" && x.scope === "project"));

    // empty description gets a TODO placeholder in the file
    const bare = skills.createSkill(proj, "plain", "  ");
    assert.match(readFileSync(join(bare.source, "SKILL.md"), "utf8"), /TODO: what this skill does/);

    assert.throws(() => skills.createSkill(proj, "My Cool Skill!", "again"), /already exists/);
    assert.throws(() => skills.createSkill(proj, "!!!", ""), /at least one letter or digit/);
  } finally {
    done();
  }
});

test("trash: moves to .trash recoverably, unlisted, name clash gets a suffix", async () => {
  const { home, skills, done } = await fakeEnv("skills-trash");
  try {
    const root = join(home, ".agents", "skills");
    const source = join(root, "doomed");
    mkSkill(source, SK("name: doomed"));

    const { trashed } = skills.trashSkill(source);
    assert.equal(trashed, join(root, ".trash", "doomed"));
    assert.equal(existsSync(source), false, "source is gone");
    assert.ok(existsSync(join(trashed, "SKILL.md")), "content survives in trash — recoverable");
    assert.equal(skills.listSkills().some((s) => s.name === "doomed"), false, "no longer listed");

    // same basename trashed again -> suffixed, never overwritten
    mkSkill(source, SK("name: doomed"));
    const second = skills.trashSkill(source);
    assert.equal(basename(second.trashed), "doomed-2");
    assert.ok(existsSync(join(root, ".trash", "doomed", "SKILL.md")), "first trash copy intact");

    assert.throws(() => skills.trashSkill(join(root, "ghost")), /no SKILL.md/);
  } finally {
    done();
  }
});
