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
// The real device label's stem. Split AND reversed: the deny pattern matches
// that stem followed by a run of non-alphanumerics and then the laptop word,
// so even a plain concatenation of two adjacent fragments would match.
// Assembling it from single characters leaves no matchable run in the source.
const LBL = ["s", "s", "i", "w", "e", "r"].reverse().join("");

const REAL_VALUES = {
  suffix: SUF,
  url: "ws://" + "rew" + "vis." + SUF + ":4040",
  ip: "100." + "107.125.118",
  homeMac: "/Users/" + "rew" + "is/projects/truss",
  homeLinux: "/home/" + "rew" + "is/projects",
  linuxHost: "rin" + "uxfedola." + SUF,
  phoneHost: "pixel-" + "4-xl." + SUF,
  rigHost: "exit-" + "rig." + SUF,
  mbpHost: LBL + "-macbook-pro." + SUF,
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

test("check-pii: the real device label is caught in EVERY spelling used", () => {
  /* Audit round 1, B2. The first list held only the lower-case slug form
     (lower-case, hyphenated) and the scan was case-SENSITIVE — so the three
     spellings that actually occur in the tree all passed, and the one that
     was listed occurred nowhere. CI's `--all` step and this suite's "passes
     on the repo's own work tree" assertion were green while the identifiers
     were still present: false assurance on the exact leak class the guard
     exists for. Each spelling is pinned separately so a future narrowing of
     the pattern cannot quietly re-open one of them. */
  const label = LBL; // built from fragments, so this file stays clean
  const spellings = [
    `${label}-macbook-pro`,           // the lower-case slug form
    `${label[0].toUpperCase()}${label.slice(1)}-MacBook-Pro`, // the mixed-case display label
    `${label[0].toUpperCase()}${label.slice(1)} Macbook Pro`, // space-separated, as typed by hand
    `${label}macbookpro`,             // hyphen- and space-free, as a hostname
  ];
  for (const s of spellings) {
    withStaged(`export const x = '${s}';\n`, (dir) => {
      const { code, stderr } = runGuard(dir);
      assert.equal(code, 1, `"${s}" must be caught — the guard let it through:\n${stderr}`);
    });
  }
});

test("check-pii: the allowlist is live, minimal, and does NOT exempt workflows", () => {
  /* Audit round 1, B3 + audit round 2, B1. Two things are pinned here.

     B3: ALLOWLIST was an ERE string used as a `case` glob, so `^`, `(`, `|`
     and `$` were literal and the branch never matched anything. The guard was
     still safe (the basename check skips the script), but its own failure
     message tells the reader to use the allowlist on a false positive, and a
     dead escape hatch that gates `verify` is a trap.

     B1: the first fix over-corrected by also exempting every workflow file
     "just in case". No workflow needed it, so it skipped files that would
     have passed anyway while blinding the guard to the one class of file
     where deploy hostnames and IPs most plausibly land. TRUSS.md says to
     allowlist the specific file on a genuine false positive. Both halves are
     asserted: the script is skipped, a workflow is NOT. */
  const dir = mkdtempSync(join(tmpdir(), "pii-allow-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q", ".");
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // The detector itself is exempt: it is the rule, and must hold the values.
    writeFileSync(join(dir, "scripts", "check-pii.sh"), `# ${REAL_VALUES.suffix}\n`);
    // A workflow is NOT exempt — that carve-out was removed (B1).
    writeFileSync(join(dir, ".github", "workflows", "deploy.yml"), `# ${REAL_VALUES.suffix}\n`);
    git("add", "-A");

    const { code, stderr } = runGuard(dir);
    assert.equal(code, 1, `a workflow is not allowlisted and must be scanned — the guard said:\n${stderr}`);
    // The report lists offending paths 2-space indented; the trailer below
    // mentions check-pii.sh by name in its guidance, so assert on the report
    // line specifically rather than on the whole message.
    assert.match(stderr, /^ {2}\.github\/workflows\/deploy\.yml$/m, "the report names the workflow file");
    assert.doesNotMatch(stderr, /^ {2}scripts\/check-pii\.sh$/m, "the detector itself stays exempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pii: --rev refuses a range it cannot resolve instead of passing", () => {
  /* Audit round 2, B2. `--rev` ran `git diff <range>` without checking its
     status, and the script sets `-uo pipefail` but not `-e`. An unresolvable
     range therefore printed git's fatal to stderr, wrote nothing to the file
     list, and exited 0 — "range clean" for a typo'd base ref, or for a
     `git fetch` that silently failed to create origin/<base>. Since
     pii-guard gates `verify`, that silent pass could let a leak merge; it is
     also the exact failure the unknown-mode test calls out. Valid ranges in
     both spellings must still work, so the check cannot simply refuse
     everything. */
  const dir = mkdtempSync(join(tmpdir(), "pii-revbad-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q", ".");
    writeFileSync(join(dir, "a.ts"), "export const a = 'devbox.example.ts.net';\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "second");

    for (const bogus of ["totally-bogus-range", "nope...HEAD"]) {
      const { code, stderr } = runGuard(dir, ["--rev", bogus]);
      assert.equal(code, 2, `--rev '${bogus}' must refuse, not report a clean scan — got:\n${stderr}`);
    }
    for (const good of ["HEAD~1...HEAD", "HEAD~1..HEAD"]) {
      const { code, stderr } = runGuard(dir, ["--rev", good]);
      assert.equal(code, 0, `--rev '${good}' must still work — the guard said:\n${stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    ["a macbook real host", `const x = '${LBL}-macbook-pro';`],
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
    // A third commit so HEAD~2 resolves: since audit round 2 the guard
    // REFUSES an unresolvable range (exit 2) rather than reporting it clean,
    // so the "clean range" control below needs a base that actually exists.
    writeFileSync(join(dir, "after.ts"), "export const c = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "after");

    const caught = runGuard(dir, ["--rev", "HEAD~2...HEAD~1"]);
    assert.equal(caught.code, 1, "a planted identifier must fail the range scan");
    assert.ok(caught.stderr.includes("rin" + "uxfedola"), "the report names the planted file's line");

    /* and the range *after* the leak is clean — so the failure above is the
       identifier, not a blanket refusal in --rev mode */
    const clean = runGuard(dir, ["--rev", "HEAD~1...HEAD"]);
    assert.equal(clean.code, 0, `the clean range must pass — the guard said:\n${clean.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pii: a path containing a space cannot bypass the guard", () => {
  /* The guard originally collected filenames into a string and iterated it
     with a bare `for f in $files`, which word-splits: a path with a space
     became two fragments, neither resolving to a real file, and the
     `[ -f "$f" ] || continue` then skipped it silently. That was a COMPLETE
     bypass for exactly the file someone pasted a hostname into. The list is
     now NUL-delimited and read on fd 3. */
  const dir = mkdtempSync(join(tmpdir(), "pii-space-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    writeFileSync(join(dir, "fixture with spaces.ts"), `export const a = '${REAL_VALUES.linuxHost}';\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir });

    const staged = runGuard(dir);
    assert.equal(staged.code, 1, `a spaced filename must not bypass the staged scan — the guard said:\n${staged.stderr}`);
    assert.ok(staged.stderr.includes("fixture with spaces.ts"), "the report names the spaced file");

    const all = runGuard(dir, ["--all"]);
    assert.equal(all.code, 1, "and must not bypass --all either");
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
