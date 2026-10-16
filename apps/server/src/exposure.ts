import { assertDialableServerUrl, DEFAULT_BIND_HOST, type NetInfo } from "./net.js";

/* re-exported so callers can reach the shared default through this module
   too; net.ts owns it (importing it from here would be a cycle) */
export { DEFAULT_BIND_HOST };

/**
 * The effective exposure of this server (issue #214).
 *
 * TRUSS_HOST used to default to 0.0.0.0, so a fresh `pnpm -C apps/server
 * start` put a fully unauthenticated app on every interface — while the
 * README documented "bind to loopback or your private network only" and even
 * claimed the start line served on 127.0.0.1. The default and the documented
 * security model disagreed, and the safe behavior required knowing an env
 * var. The server also never said what it had actually done: a wide bind
 * printed the same quiet startup line as loopback.
 *
 * This module is the ONE place that answers "what is this server exposed
 * to?". Both the bind and TRUSS_PUBLIC_URL pass through it, so the two can
 * never drift apart — and the startup line and the warning banner are both
 * derived from the same verdict, so neither can describe an exposure the
 * other disagrees with.
 *
 * Validation REJECTS, it never coerces: a garbage port, a wildcard host, a
 * credentialed URL or a protocol-relative form is a loud startup error, not
 * something quietly repaired into a half-working address. Silently repairing
 * a malformed public URL is exactly the class of bug this issue removes.
 */

/** the bind when TRUSS_HOST is unset — loopback, matching the README.
 *  Defined in net.ts and re-exported here (see the import note above). */

export type BindKind = "loopback" | "wildcard" | "specific";

/** how exposed this server ends up, as one word:
 *  - `local`   loopback bind, nothing off-host can reach it
 *  - `network` a non-loopback bind, reachable by whoever can route to it
 *  - `fronted` a declared TRUSS_PUBLIC_URL — a proxy/DNS front door exists */
export type ExposureKind = "local" | "network" | "fronted";

export interface ExposureVerdict {
  /** the port the server answers on */
  port: number;
  /** the effective bind address, normalized — always present, always exact */
  bind: string;
  bindKind: BindKind;
  /** the validated, normalized public URL (trailing slashes stripped) */
  publicUrl?: string;
  exposure: ExposureKind;
  /** should the no-auth warning banner be printed? */
  noAuthWarning: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** `[::1]` and `[::]` arrive bracketed from an env var; URL() strips them */
const unbracket = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);

function classifyBind(bind: string): BindKind {
  const bare = unbracket(bind).toLowerCase();
  if (LOOPBACK_HOSTS.has(bare)) return "loopback";
  if (bare === "0.0.0.0" || bare === "::") return "wildcard";
  return "specific";
}

/**
 * An env var that is set to empty/whitespace is NOT a value — the old code
 * did `process.env.TRUSS_HOST ?? "0.0.0.0"`, and since `""` is not nullish,
 * `TRUSS_HOST=""` bound to "" (every interface) while looking unset. Unset
 * and empty must land in the same safe place.
 */
function effectiveHost(host: string | undefined): string {
  const trimmed = (host ?? "").trim();
  return trimmed || DEFAULT_BIND_HOST;
}

/**
 * Validate a return address and hand back its normalized form.
 *
 * Rejection is the contract here, so every failure mode has its own explicit
 * check BEFORE delegating: `assertDialableServerUrl` treats a URL equal to
 * `net.publicUrl` as dialable by declaration and returns early, so a
 * wildcard or port-0 public URL would sail straight through it.
 */
function validatedPublicUrl(raw: string, port: number): string {
  const value = raw.trim();
  if (!value) throw new Error("TRUSS_PUBLIC_URL is set but empty — unset it or give a full http(s) URL");

  /* protocol-relative ("//host") and bare hostnames have no scheme we can
     trust; refuse rather than guessing http */
  if (value.startsWith("//")) {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" is protocol-relative — give a full absolute URL like https://truss.example.com`);
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" has no scheme — give a full absolute URL like https://truss.example.com`);
  }

  let u: URL;
  try {
    u = new URL(value);
  } catch {
    /* `new URL` rejects ":abc" outright. The message must still name the
       port, because "invalid URL" sends the operator hunting through the
       whole string for a problem that is four characters long. */
    const bad = value.slice(value.indexOf("//") + 2).split(/[/?#]/)[0];
    const tail = bad.includes(":") ? bad.split(":").pop() ?? "" : "";
    throw new Error(
      tail && !/^\d*$/.test(tail)
        ? `TRUSS_PUBLIC_URL "${raw}" has an invalid port "${tail}" — give a number, or omit the port to use the scheme default`
        : `TRUSS_PUBLIC_URL "${raw}" is not a valid URL`,
    );
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" uses scheme "${u.protocol}" — only http and https are accepted`);
  }
  if (u.username || u.password) {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" carries credentials — a return address is not a login; remove the user:password part`);
  }

  const host = u.hostname;
  if (unbracket(host) === "0.0.0.0" || unbracket(host) === "::" || unbracket(host) === "[::]") {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" is a wildcard address — a return address must be a name or ip a client can dial, not ${host}`);
  }
  if (!host) throw new Error(`TRUSS_PUBLIC_URL "${raw}" has no host`);

  /* A port that is present but unparseable must be an ERROR, never a
     silent "no port, use the scheme default". `new URL` throws on ":abc"
     (caught above), but it also ACCEPTS forms that fold away, so the raw
     authority is checked too. */
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/)[0];
  const portPart = authority.slice(authority.lastIndexOf("@") + 1).includes(":")
    ? authority.slice(authority.lastIndexOf("@") + 1).split(":").pop() ?? ""
    : "";
  if (portPart && !/^\d+$/.test(portPart)) {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" has an invalid port "${portPart}" — give a number, or omit the port to use the scheme default`);
  }

  const explicitPort = u.port === "" ? undefined : Number(u.port);
  if (explicitPort === 0 || portPart === "0") {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" uses port 0, which is never dialable — give the real port this server answers on (${port})`);
  }

  const normalized = value.replace(/\/+$/, "");
  return normalized === "" ? value : normalized;
}

/**
 * The one check. Pure: takes the raw env values, returns the verdict, throws
 * with a plain-language reason when a value is unusable.
 */
export function resolveExposure(input: {
  port: number;
  host?: string;
  publicUrl?: string;
  /** reachability facts for the dialability check (bind/port/publicUrl are
   *  taken from this call's own arguments) */
  net?: Pick<NetInfo, "tailscale" | "lan">;
}): ExposureVerdict {
  const port = input.port;
  const bind = effectiveHost(input.host);
  const bindKind = classifyBind(bind);

  const rawPublic = (input.publicUrl ?? "").trim();
  const publicUrl = rawPublic ? validatedPublicUrl(rawPublic, port) : undefined;

  if (publicUrl) {
    /* Reuse the SAME checker the delivery routes use (issue #100) rather
       than restating its bind/port rules — its signature and behavior stay
       untouched for its existing callers.

       BUT it is called with `publicUrl` present in the net object, which
       intentionally takes its "the operator declared this URL, trust it"
       early return. That is not a loophole here, it is the semantics: a
       declared TRUSS_PUBLIC_URL is BY DEFINITION a front door — a reverse
       proxy or DNS name that forwards to this server — so it is expected to
       be an address the local bind cannot itself answer. That is the whole
       reason the escape hatch exists; without it, `TRUSS_PUBLIC_URL` would
       be unusable on the loopback default this issue introduces, and a
       proxied deployment would be rejected at startup.

       What DOES have to hold for a declaration is its own shape (wildcard,
       port 0, scheme, credentials, explicit port matching this server),
       which validatedPublicUrl enforced above, plus the port agreement
       checked below. The bind-match logic keeps governing every OTHER
       address, exactly as before. */
    assertDialableServerUrl(publicUrl, {
      port,
      bind,
      publicUrl,
      tailscale: input.net?.tailscale ?? { installed: false },
      lan: input.net?.lan ?? [],
    });

    /* the front door must still land on the port this server answers: a
       proxy forwards to a port, and a declaration naming a different one
       describes a server that isn't this one */
    const declared = new URL(publicUrl);
    const declaredPort = declared.port ? Number(declared.port) : declared.protocol === "https:" ? 443 : 80;
    if (declaredPort !== port) {
      throw new Error(
        `TRUSS_PUBLIC_URL "${rawPublic}" points at port ${declaredPort}, but this server listens on ${port} — a front door must forward to the port this server actually answers on`,
      );
    }
  }

  /* Q1: the banner fires when the bind is not loopback AND no front door is
     declared. Truss has no auth of its own to inspect, so a declared
     TRUSS_PUBLIC_URL is the operator telling us a proxy exists — that is the
     observable signal, and the banner says so rather than implying the URL
     itself is authentication. */
  const noAuthWarning = bindKind !== "loopback" && !publicUrl;

  const exposure: ExposureKind = publicUrl ? "fronted" : bindKind === "loopback" ? "local" : "network";

  return { port, bind, bindKind, publicUrl, exposure, noAuthWarning };
}

/** the one-line exposure statement, greppable in a service log */
export function exposureLine(v: ExposureVerdict): string {
  const where =
    v.exposure === "local"
      ? "local only"
      : v.exposure === "fronted"
        ? `NO AUTH, fronted by ${v.publicUrl}`
        : "NO AUTH, reachable from your network";
  return `listening on http://${v.bind}:${v.port} (${where})`;
}

/** the loud one-time banner, or null when there is nothing to shout about */
export function exposureBanner(v: ExposureVerdict): string | null {
  if (!v.noAuthWarning) return null;
  return [
    "",
    "  ┌─────────────────────────────────────────────────────────────────────┐",
    "  │  WARNING: this Truss has NO AUTHENTICATION and is not on loopback.  │",
    "  └─────────────────────────────────────────────────────────────────────┘",
    `  Bound to ${v.bind}:${v.port}, so anyone who can route to this machine can`,
    "  open the app and run commands through its agents. Truss is single-user",
    "  and has no login of its own.",
    "",
    "  Bind to loopback instead (TRUSS_HOST=127.0.0.1), or put real auth in",
    "  front of it and declare that front door with TRUSS_PUBLIC_URL. Setting",
    "  TRUSS_PUBLIC_URL is treated as that declaration, which is why it also",
    "  silences this warning.",
    "",
  ].join("\n");
}
