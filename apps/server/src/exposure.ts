import { DEFAULT_BIND_HOST } from "./net.js";

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
 * The port text from a URL's raw authority, or "" when there is none.
 *
 * Never last-colon-splitting the authority: in `https://[2001:db8::1]` the
 * colons belong to the IPv6 ADDRESS, so `split(":").pop()` yields `"1]"` and
 * every bracketed IPv6 literal without an explicit port is rejected with a
 * bogus "invalid port" (audit B2). A bracket pair is skipped as a unit, and
 * only a colon AFTER it can introduce the port.
 */
function rawPortText(value: string): string {
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/)[0];
  /* credentials may precede the host; a "@" inside an IPv6 literal cannot,
     because the URL grammar requires brackets around it */
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPart.startsWith("[")) {
    const close = hostPart.indexOf("]");
    if (close === -1) return ""; // malformed bracket — `new URL` already rejected it
    const rest = hostPart.slice(close + 1);
    return rest.startsWith(":") ? rest.slice(1) : "";
  }
  const colon = hostPart.indexOf(":");
  return colon === -1 ? "" : hostPart.slice(colon + 1);
}

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

  const portText = rawPortText(value);
  if (portText && !/^\d+$/.test(portText)) {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" has an invalid port "${portText}" — give a number, or omit the port to use the scheme default`);
  }
  /* numerically, not textually: ":00" and ":000" are the same port 0 the
     literal ":0" is, and they used to slip past a string comparison against
     "0" (audit round 2 edge note) */
  if (portText && Number(portText) === 0) {
    throw new Error(`TRUSS_PUBLIC_URL "${raw}" uses port 0, which is never dialable — give the real port this server answers on (${port})`);
  }

  let u: URL;
  try {
    u = new URL(value);
  } catch {
    /* `new URL` rejects ":abc" outright. The message must still name the
       port, because "invalid URL" sends the operator hunting through the
       whole string for a problem that is four characters long. */
    throw new Error(
      portText && !/^\d+$/.test(portText)
        ? `TRUSS_PUBLIC_URL "${raw}" has an invalid port "${portText}" — give a number, or omit the port to use the scheme default`
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
}): ExposureVerdict {
  const port = input.port;
  const bind = effectiveHost(input.host);
  const bindKind = classifyBind(bind);

  const rawPublic = (input.publicUrl ?? "").trim();
  const publicUrl = rawPublic ? validatedPublicUrl(rawPublic, port) : undefined;

  /* A declared front door is deliberately NOT run through
     assertDialableServerUrl (audit round 1, finding B3). Passing publicUrl
     takes that checker's "the operator declared this URL, trust it" early
     return, so it could only ever re-run its own syntax regex; NOT passing it
     would reject the documented 443-front-door/4040-backend deployment,
     because a declaration names the front door, not the backend it forwards
     to. validatedPublicUrl above therefore enforces the whole of what a
     declaration must satisfy — its SHAPE — and the shared checker keeps
     governing every OTHER return address, unchanged, in the delivery routes.
     That is the contract issue #100 built and net-bind.test.ts pins. */

  /* Q1: the banner fires when the bind is not loopback AND no front door is
     declared. Truss has no auth of its own to inspect, so a declared
     TRUSS_PUBLIC_URL is the operator telling us a proxy exists — that is the
     observable signal, and the banner says so rather than implying the URL
     itself is authentication. */
  const noAuthWarning = bindKind !== "loopback" && !publicUrl;

  const exposure: ExposureKind = publicUrl ? "fronted" : bindKind === "loopback" ? "local" : "network";

  return { port, bind, bindKind, publicUrl, exposure, noAuthWarning };
}

/**
 * A bind address rendered so it inside `host:port` is a dialable URL.
 *
 * A bare IPv6 address is ambiguous without brackets: `http://::1:4040` is not
 * a URL a client can dial, and `TRUSS_HOST=::1` would render differently from
 * `TRUSS_HOST=[::1]` for the very same setting (audit B2). Anything with a
 * colon is bracketed unless it already is — the same normalization `new URL`
 * expects. Exported for tests.
 */
export function formatBindHost(bind: string): string {
  return bind.includes(":") && !(bind.startsWith("[") && bind.endsWith("]")) ? `[${bind}]` : bind;
}

/** the one-line exposure statement, greppable in a service log */
export function exposureLine(v: ExposureVerdict): string {
  const where =
    v.exposure === "local"
      ? "local only"
      : v.exposure === "fronted"
        ? `NO AUTH, fronted by ${v.publicUrl}`
        : "NO AUTH, reachable from your network";
  return `listening on http://${formatBindHost(v.bind)}:${v.port} (${where})`;
}

/** the loud one-time banner, or null when there is nothing to shout about */
export function exposureBanner(v: ExposureVerdict): string | null {
  if (!v.noAuthWarning) return null;
  return [
    "",
    "  ┌─────────────────────────────────────────────────────────────────────┐",
    "  │  WARNING: this Truss has NO AUTHENTICATION and is not on loopback.  │",
    "  └─────────────────────────────────────────────────────────────────────┘",
    `  Bound to ${formatBindHost(v.bind)}:${v.port}, so anyone who can route to this machine can`,
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
