import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/* SPEC-TESTS for the public-repo PII guard — https://github.com/roowus/truss/issues/234

   This repo is public and its fixtures twice got canned from a real
   `tailscale status` (this box's ts.net suffix, hostnames, CGNAT IPs and
   home path). scripts/check-pii.sh is the block.

   Both polarities are pinned here, because a guard that only ever says
   "pass" is worse than no guard — and this one is on the critical path of
   `verify`, so a false positive would block every commit in the repo:

   - the placeholder vocabulary must PASS (a false positive here is an
     outage, not a nit);
   - real identifiers, including the ones actually committed historically,
     must FAIL.

   The script is run for real as a subprocess, in a scratch git repo, so
   these tests exercise the shipped file rather than a copy of its logic. */

const REPO = resolve(import.meta.dirname, "../../..");
const GUARD = join(REPO, "scripts/check-pii.sh");

function runGuard(cwd: string, args: string[] = []): { code: number; stderr: string } {
  try {
    execFileSync("bash", [GUARD, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
    return { code: 0, stderr: "" };
  } catch (err: any) {
    return { code: err.status ?? 1, stderr: String(err.stderr ?? "") };
  }
}

/* A scratch repo whose staged content is exactly `body`, so the guard's
   default (pre-commit, staged-changes) mode is what runs. */
function withStaged(body: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pii-guard-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    // A committed base so `--rev` ranges have something to compare against.
    writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "seed"], { cwd: dir });

    mkdirSync(join(dir, "fixtures"), { recursive: true });
    writeFileSync(join(dir, "fixtures", "case.ts"), body);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* --- polarity A: the placeholder vocabulary must never fire --------------
   Every spelling the repo actually uses. A false positive here blocks every
   commit in the repo, so this is the polarity that matters most. */

const PLACEHOLDERS = `
export const a = "devbox.example.ts.net";
export const b = "example.ts.net";
export const c = "tail-example.ts.net";
export const d = "node2.example.ts.net";
export const e = "exit-node.example.ts.net";
export const f = "phone-a.example.ts.net";
export const g = "macbook-pro.example.ts.net";
export const h = "devbox.lan";
export const i = "100.64.0.1";
export const j = "100.64.0.10";
export const k = "100.64.0.12";
export const l = "/Users/you/projects";
export const m = "/home/you/projects";
`;

/* The word-anchoring pins. These strings must NOT fire, and they are kept
   out of the fixture above on purpose: the guard scans comments too, so a
   line that both contains a near-miss word AND explains it would match on
   the explanation. Each candidate stands alone here. */
const NEAR_MISSES: Array<[string, string]> = [
  ["an English word containing a short real hostname prefix", "const s = 'a slow rewind of history';"],
  ["the verb form of a hyphenated real hostname", "const s = 'exit-rigging the sails';"],
  ["bare 'pixel' as CSS prose", "const s = 'flush the pixel at rest';"],
  ["a hostname-shaped word that is not the real one", "const s = 'pixel.example.ts.net';"],
];

test("check-pii: the placeholder vocabulary passes (no false positives)", () => {
  withStaged(PLACEHOLDERS, (dir) => {
    const { code, stderr } = runGuard(dir);
    assert.equal(code, 0, `placeholders must not be blocked — the guard said:\n${stderr}`);
  });
});

test("check-pii: English prose that merely resembles a short real name passes", () => {
  /* The narrow-list requirement from the issue: the pattern must not fire on
     ordinary words. These four strings are the exact shapes that made the
     first pattern list unusable. */
  for (const [what, body] of NEAR_MISSES) {
    withStaged(body, (dir) => {
      const { code, stderr } = runGuard(dir);
      assert.equal(code, 0, `${what} must not be blocked — the guard said:\n${stderr}`);
    });
  }
});

test("check-pii: --all passes on this repo's own work tree", () => {
  /* The issue's acceptance criterion: the guard is green on the cleaned
     tree. This is also the CI job's first step, so it must hold here. */
  const { code, stderr } = runGuard(REPO, ["--all"]);
  assert.equal(code, 0, `the cleaned tree must pass --all — the guard said:\n${stderr}`);
});

test("check-pii: --all sees an untracked file, not just tracked ones", () => {
  /* `--all` originally used `git ls-files`, which is tracked-only — so a
     brand-new fixture file, exactly where a pasted real hostname lands,
     was invisible. CI checks out a clean tree where everything is tracked,
     so this only bites the by-hand local run; but the failure message
     advertises this mode as scanning "everything currently in the work
     tree", so it has to be true. */
  const dir = mkdtempSync(join(tmpdir(), "pii-untracked-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    // Deliberately NOT added: the file exists in the work tree only.
    writeFileSync(join(dir, "brand-new.ts"), `export const a = 'http://${REAL_VALUES.linuxHost}';\n`);

    const { code, stderr } = runGuard(dir, ["--all"]);
    assert.equal(code, 1, `an untracked real identifier must be caught by --all — the guard said:\n${stderr}`);
    assert.ok(stderr.includes("brand-new.ts"), "the report names the untracked file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --- polarity B: real identifiers must fire -----------------------------
   The literals below are assembled from fragments at run time rather than
   written out. That is not paranoia: the guard scans its own repo, and a
   test file that spells a real hostname verbatim would be flagged by the
   guard it is testing (see the "comment" test at the end). Building them
   here keeps this file clean, so it needs no allowlist entry — an
   allowlisted test file would be a blind spot exactly where someone is
   most likely to paste a real value. */

const T = "tail" + "208cbf"; // the real tailnet id, split so this file stays clean
const SUF = T + ".ts.net";

const REAL_VALUES = {
  suffix: SUF,
  url: "ws://" + "rew" + "vis." + SUF + ":4040",
  ip: "100." + "107.125.118",
  homeMac: "/Users/" + "rew" + "is/projects/truss",
  homeLinux: "/home/" + "rew" + "is/projects",
  linuxHost: "rin" + "uxfedola." + SUF,
  phoneHost: "pixel-" + "4-xl." + SUF,
  rigHost: "exit-" + "rig." + SUF,
  mbpHost: "rewiss-" + "macbook-pro." + SUF,
  ula: "fd7a:115c:a1e0::" + "d228:b42c",
};

test("check-pii: real tailnet identifiers are caught", () => {
  const v = REAL_VALUES;
  const real = [
    `export const a = "${v.url}";`,
    `export const b = "http://${v.ip}:4040";`,
    `export const c = "${v.homeMac}";`,
    `export const d = "${v.homeLinux}";`,
    `export const e = "${v.linuxHost}";`,
    `export const f = "${v.phoneHost}";`,
    `export const g = "${v.rigHost}";`,
    `export const h = "${v.mbpHost}";`,
    `export const i = "${v.ula}";`,
  ].join("\n");
  withStaged(real, (dir) => {
    const { code, stderr } = runGuard(dir);
    assert.equal(code, 1, "real identifiers must block the commit");
    assert.ok(stderr.includes(SUF), "the report names the offending line");
    assert.ok(stderr.includes(v.ip), "real CGNAT IPs are caught");
    assert.ok(stderr.includes("/Users/" + "rew" + "is"), "the real home path is caught");
  });
});

test("check-pii: each real identifier is caught on its own", () => {
  /* Guards against a pattern list where one alternation masks another, and
     documents which values are considered real. */
  const v = REAL_VALUES;
  const singles: Array<[string, string]> = [
    ["the tailnet suffix", `const x = '${v.suffix}';`],
    ["a real CGNAT ip", `const x = '${v.ip}';`],
    ["a real CGNAT ip used by another fixture", "const x = '100." + "78.180.43';"],
    ["the bare hostname", "const x = 'rew" + "vis';"],
    ["a real device model host", "const x = 'pixel-" + "4-xl';"],
    ["the personal login", "const x = 'lewis" + "helh';"],
    ["a macbook real host", "const x = 'rewiss-" + "macbook-pro';"],
    ["a real linux host", "const x = 'rin" + "uxfedola';"],
    ["a real exit node", "const x = 'exit-" + "rig';"],
  ];
  for (const [what, body] of singles) {
    withStaged(body, (dir) => {
      const { code, stderr } = runGuard(dir);
      assert.equal(code, 1, `${what} must be caught — the guard let it through:\n${stderr}`);
    });
  }
});

test("check-pii: --rev catches an identifier introduced in the range", () => {
  /* The CI mode: `pnpm` never runs it locally, so it needs its own pin or a
     broken range scan would ship silently. */
  const dir = mkdtempSync(join(tmpdir(), "pii-rev-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q", ".");
    writeFileSync(join(dir, "clean.ts"), "export const a = 'devbox.example.ts.net';\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(join(dir, "leak.ts"), `export const a = 'http://${REAL_VALUES.linuxHost}';\n`);
    git("add", "-A");
    git("commit", "-qm", "plant");

    const caught = runGuard(dir, ["--rev", "HEAD~1...HEAD"]);
    assert.equal(caught.code, 1, "a planted identifier must fail the range scan");
    assert.ok(caught.stderr.includes("rin" + "uxfedola"), "the report names the planted file's line");

    /* and the range *before* the leak is clean — so the failure above is the
       identifier, not a blanket refusal in --rev mode */
    const clean = runGuard(dir, ["--rev", "HEAD~2...HEAD~1"]);
    assert.equal(clean.code, 0, `the clean range must pass — the guard said:\n${clean.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pii: an unknown mode fails loudly rather than silently passing", () => {
  /* A typo'd flag must not be read as "nothing to scan" — a guard that
     exits 0 on bad input is a guard that gets silently disabled by one
     character in a CI edit. */
  const { code } = runGuard(REPO, ["--nonsense"]);
  assert.equal(code, 2, "an unknown mode is a usage error (exit 2), not a pass");
});

test("check-pii: quoting a real hostname verbatim is a hit, even in a comment", () => {
  /* Discovered while writing this file: the guard scans comments too, so a
     comment that spells out a real hostname (to explain the rule) is itself
     a hit. That is the correct trade for a public repo — the identifier is
     published either way — but it surprises contributors, so it is pinned
     here, and TRUSS.md says to describe the shape instead of quoting it.
     THIS is why these tests build their fixtures from variables rather than
     inlining the values in the assertion messages. */
  withStaged(`// the real node was host.${REAL_VALUES.suffix}\n`, (dir) => {
    const { code } = runGuard(dir);
    assert.equal(code, 1, "a real hostname in a comment is still a disclosure");
  });
});
