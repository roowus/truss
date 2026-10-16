import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExposure, DEFAULT_BIND_HOST, exposureLine, exposureBanner } from "../src/exposure.js";

/* SPEC-TESTS for issue #214 —
   https://github.com/roowus/truss/issues/214

   TRUSS_HOST defaulted to 0.0.0.0, so a fresh `pnpm -C apps/server start`
   exposed a fully unauthenticated app to every interface, while the README
   documented "bind to loopback or your private network only" and even
   claimed the start line served on 127.0.0.1. The server also never told the
   operator what it actually did: a wide bind printed the same quiet line as
   loopback.

   The contract: the unset default is loopback, a wide bind is the operator's
   explicit opt-in and is announced loudly, and TRUSS_PUBLIC_URL is validated
   through the same check as the bind — rejecting, never coercing. */

/* ── 1. the default bind is loopback ── */

test("unset TRUSS_HOST resolves to loopback, not 0.0.0.0", () => {
  const v = resolveExposure({ port: 4040 });
  assert.equal(v.bind, DEFAULT_BIND_HOST, "the fallback bind is loopback");
  assert.equal(v.bind, "127.0.0.1");
  assert.equal(v.bindKind, "loopback", "and it is classified as loopback");
  assert.equal(v.exposure, "local", "so a fresh start is local-only");
  assert.equal(v.noAuthWarning, false, "a loopback bind never screams");
});

test("an empty/whitespace TRUSS_HOST is treated as unset (loopback), not as a wildcard", () => {
  /* the old code did `process.env.TRUSS_HOST ?? "0.0.0.0"` — an empty string
     is NOT nullish, so TRUSS_HOST="" bound to "" (all interfaces) silently.
     Unset and empty must land in the same safe place. */
  for (const host of ["", "   ", "\t"]) {
    const v = resolveExposure({ port: 4040, host });
    assert.equal(v.bind, "127.0.0.1", `TRUSS_HOST=${JSON.stringify(host)} → loopback`);
    assert.equal(v.exposure, "local");
  }
});

/* ── 2. explicit wide binds still work (the opt-in) ── */

test("explicit TRUSS_HOST=0.0.0.0 still binds wide, and says so", () => {
  const v = resolveExposure({ port: 4040, host: "0.0.0.0" });
  assert.equal(v.bind, "0.0.0.0", "the operator's explicit choice is honored verbatim");
  assert.equal(v.bindKind, "wildcard");
  assert.equal(v.exposure, "network", "and the exposure is reported as network-wide");
  assert.equal(v.noAuthWarning, true, "with no public URL declared, this warns");
});

test("a specific non-loopback bind is honored and classified as network exposure", () => {
  for (const host of ["192.168.1.10", "100.64.0.1"]) {
    const v = resolveExposure({ port: 4040, host });
    assert.equal(v.bind, host);
    assert.equal(v.bindKind, "specific");
    assert.equal(v.exposure, "network");
    assert.equal(v.noAuthWarning, true);
  }
});

test("loopback spellings are all recognized as loopback", () => {
  for (const host of ["127.0.0.1", "::1", "[::1]", "localhost"]) {
    const v = resolveExposure({ port: 4040, host });
    assert.equal(v.bindKind, "loopback", `${host} is loopback`);
    assert.equal(v.exposure, "local", `${host} is local-only`);
    assert.equal(v.noAuthWarning, false, `${host} does not warn`);
  }
});

/* ── 3. TRUSS_PUBLIC_URL validation: reject, never coerce ── */

test("a wildcard public URL is refused (reject, not coerce)", () => {
  for (const url of ["http://0.0.0.0:4040", "http://[::]:4040", "http://0.0.0.0", "https://[::]:8443"]) {
    assert.throws(
      () => resolveExposure({ port: 4040, publicUrl: url }),
      /wildcard|0\.0\.0\.0|::/i,
      `${url} must be refused — a wildcard is not a return address`,
    );
  }
});

test("port 0 in a public URL is refused", () => {
  assert.throws(() => resolveExposure({ port: 4040, publicUrl: "http://truss.example.com:0" }), /port 0|port/i);
});

test("a garbage port is an explicit error, never silently defaulted", () => {
  /* `new URL("http://host:abc")` THROWS, and the tempting repair is to fall
     back to the scheme default. That silent repair is exactly the class of
     bug this issue removes — so it must be a loud error instead. */
  for (const url of ["http://truss.example.com:abc", "http://truss.example.com:80x", "http://truss.example.com:9 9"]) {
    assert.throws(
      () => resolveExposure({ port: 4040, publicUrl: url }),
      /port|invalid|malformed/i,
      `${url} must be refused, not repaired`,
    );
  }
});

test("credentials in the public URL are refused", () => {
  for (const url of ["http://user:pass@truss.example.com", "http://user@truss.example.com", "https://admin:hunter2@truss.example.com:4040"]) {
    assert.throws(
      () => resolveExposure({ port: 4040, publicUrl: url }),
      /credential|user|password|@/i,
      `${url} carries credentials — refuse it`,
    );
  }
});

test("protocol-relative and non-http(s) forms are refused", () => {
  for (const url of ["//truss.example.com", "truss.example.com", "ftp://truss.example.com", "file:///etc/passwd", "ws://truss.example.com", "javascript:alert(1)"]) {
    assert.throws(
      () => resolveExposure({ port: 4040, publicUrl: url }),
      /scheme|protocol|http|absolute|malformed|invalid/i,
      `${url} is not a plain absolute http(s) URL`,
    );
  }
});

test("a mismatched port on the public URL is refused (it must answer the bound server)", () => {
  assert.throws(
    () => resolveExposure({ port: 4040, publicUrl: "http://127.0.0.1:9999" }),
    /port|listen|unreachable|reach/i,
    "the public URL must point at the port this server actually answers",
  );
});

test("a public URL IS allowed on a loopback bind — that is the front-door case", () => {
  /* Corrected during implementation: the first draft asserted that a
     non-loopback public URL on a loopback bind must be refused. That was
     WRONG. TRUSS_PUBLIC_URL exists precisely to describe a reverse proxy or
     DNS name in front of a loopback server, so requiring the local bind to
     answer it would make the escape hatch unusable on the very default this
     issue introduces (and break the existing net-bind.test.ts contract).
     Shape and port still have to hold — see the cases above. */
  const v = resolveExposure({ port: 4040, host: "127.0.0.1", publicUrl: "http://truss.example.com:4040" });
  assert.equal(v.publicUrl, "http://truss.example.com:4040");
  assert.equal(v.exposure, "fronted");
  assert.equal(v.bind, "127.0.0.1", "the bind is unchanged by the declaration");
});

test("the declared front door must land on this server's port", () => {
  assert.throws(
    () => resolveExposure({ port: 4040, publicUrl: "https://truss.example.com:8443" }),
    /port 8443|port/i,
    "a declaration naming another port describes a different server",
  );
  /* the scheme default counts as a port too: https with no port means 443 */
  assert.throws(
    () => resolveExposure({ port: 4040, publicUrl: "https://truss.example.com" }),
    /port 443|port/i,
    "https with no explicit port means 443, not 4040",
  );
  /* and when the server really is on 443, the same URL is fine */
  const ok = resolveExposure({ port: 443, publicUrl: "https://truss.example.com" });
  assert.equal(ok.publicUrl, "https://truss.example.com");
});

test("a valid public URL is normalized (trailing slash stripped, scheme kept)", () => {
  const v = resolveExposure({ port: 4040, publicUrl: "http://truss.example.com:4040/" });
  assert.equal(v.publicUrl, "http://truss.example.com:4040", "trailing slashes are normalized away");
  assert.equal(v.exposure, "fronted", "a declared front door is its own exposure class");
  assert.equal(v.noAuthWarning, false, "a declared front door silences the banner (Q1)");
});

/* ── 4. the banner gate (Q1) ── */

test("the banner is gated on 'bind is not loopback AND no public URL'", () => {
  /* wide + no front door → warn */
  assert.equal(resolveExposure({ port: 4040, host: "0.0.0.0" }).noAuthWarning, true);
  /* wide + declared front door → quiet (the operator told us a proxy exists) */
  assert.equal(
    resolveExposure({ port: 4040, host: "0.0.0.0", publicUrl: "http://truss.example.com:4040" }).noAuthWarning,
    false,
  );
  /* loopback → always quiet */
  assert.equal(resolveExposure({ port: 4040 }).noAuthWarning, false);
  assert.equal(
    resolveExposure({ port: 4040, publicUrl: "http://truss.example.com:4040" }).noAuthWarning,
    false,
  );
});

test("the banner names the bind address and says there is no authentication", () => {
  const v = resolveExposure({ port: 4040, host: "0.0.0.0" });
  const text = exposureBanner(v);
  assert.ok(text, "a wide bind with no front door produces a banner");
  assert.match(text!, /0\.0\.0\.0/, "the banner names the exact bind address");
  assert.match(text!, /no auth/i, "and states the app has no authentication");
  /* Q1 refinement: honest about the conditional — a declared TRUSS_PUBLIC_URL
     is TREATED as a front door, and that is what silences this */
  assert.match(text!, /TRUSS_PUBLIC_URL/, "the banner says what would silence it");

  /* loopback produces no banner at all */
  assert.equal(exposureBanner(resolveExposure({ port: 4040 })), null, "loopback is silent");
});

/* ── 5. the startup line reflects the bind (and always carries it) ── */

test("the startup line distinguishes loopback from wide exposure", () => {
  const local = exposureLine(resolveExposure({ port: 4040 }));
  assert.match(local, /listening on http:\/\/127\.0\.0\.1:4040/);
  assert.match(local, /local only/i, "a loopback bind reads as local only");

  const wide = exposureLine(resolveExposure({ port: 4040, host: "0.0.0.0" }));
  assert.match(wide, /listening on http:\/\/0\.0\.0\.0:4040/, "the effective bind is always printed");
  assert.match(wide, /NO AUTH/i, "and a wide bind is unmistakable");
  assert.match(wide, /network/i, "naming where it is reachable from");
});

test("the startup line always names the bind address, even loopback (Q1 refinement)", () => {
  for (const [host, expect] of [["127.0.0.1", "127.0.0.1"], ["0.0.0.0", "0.0.0.0"], ["192.168.1.10", "192.168.1.10"]] as const) {
    const line = exposureLine(resolveExposure({ port: 4040, host }));
    assert.match(line, new RegExp(expect.replace(/\./g, "\\.")), `the bind ${expect} appears in the line`);
  }
});

/* ── 6. the real server: the bind it actually listens on ── */

function startServer(env: Record<string, string>): Promise<{ line: string; error: string; port: number }> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "truss-exposure-"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts"],
      {
        cwd: join(here, ".."),
        env: {
          ...process.env,
          TRUSS_TEST: "1",
          TRUSS_DATA_DIR: join(dir, "data"),
          TRUSS_PORT: "0",
          TRUSS_EXPOSURE_PROBE: "1",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    const done = (fn: () => void) => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      rmSync(dir, { recursive: true, force: true });
      fn();
    };
    const scan = () => {
      /* the probe line below is printed by index.ts once the server is up
         with its real bound port, so the test can assert the effective bind
         without guessing a port */
      const m = out.match(/TRUSS_EXPOSURE_PROBE port=(\d+)/);
      if (m) done(() => resolve({ line: out, error: err, port: Number(m[1]) }));
    };
    child.stdout.on("data", (b) => {
      out += String(b);
      scan();
    });
    child.stderr.on("data", (b) => {
      out += String(b);
      err += String(b);
      scan();
    });
    child.on("exit", (code) => {
      if (!/TRUSS_EXPOSURE_PROBE port=/.test(out)) {
        done(() => reject(new Error(`server exited (code ${code}) without starting.\nstdout:\n${out}\nstderr:\n${err}`)));
      }
    });
    setTimeout(() => done(() => reject(new Error(`timeout.\nstdout:\n${out}\nstderr:\n${err}`))), 30000).unref();
  });
}

test("a real start with TRUSS_HOST unset listens on loopback and prints the local-only line", async () => {
  const { line } = await startServer({ TRUSS_HOST: "" });
  assert.match(line, /listening on http:\/\/127\.0\.0\.1:\d+ \(local only\)/, "the effective exposure is stated");
  assert.doesNotMatch(line, /NO AUTH/, "an unset bind is not a screaming start");
});

test("a real start with TRUSS_HOST=0.0.0.0 binds wide and prints the loud line and banner", async () => {
  const { line } = await startServer({ TRUSS_HOST: "0.0.0.0" });
  assert.match(line, /listening on http:\/\/0\.0\.0\.0:\d+ \(NO AUTH, reachable from your network\)/, "wide bind is announced");
  assert.match(line, /no auth/i, "and the banner fires");
  assert.match(line, /0\.0\.0\.0/, "the banner names the bind");
});

test("the startup line appears exactly once per start", async () => {
  const { line } = await startServer({ TRUSS_HOST: "0.0.0.0" });
  const hits = line.match(/listening on http:\/\//g) ?? [];
  /* fastify logs its own line too; OURS must be exactly one */
  const ours = line.match(/\(NO AUTH, reachable from your network\)/g) ?? [];
  assert.equal(ours.length, 1, `exactly one exposure line, saw ${ours.length}.\n${line}`);
  assert.ok(hits.length >= 1);
});
