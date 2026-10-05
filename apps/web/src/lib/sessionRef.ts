import { deviceLabel, type DeviceHost } from "./device";
import { baseHarness, hostOf, shortPath } from "./format";

/**
 * Copyable chat references (issue #13): one line carrying id · harness ·
 * host · directory, parseable back out of pasted prose.
 *
 *   #3f9a1c2e · pi @ fedora box · ~/code/api
 */

export interface SessionRefMeta {
  id: string;
  harness: string; // may be "<base>@<hostId>" for remote sessions
  cwd: string;
  /** the harness's own session uuid (harness_ref) when the harness told us */
  harnessRef?: string | null;
}

export function formatSessionRef(meta: SessionRefMeta, hosts: DeviceHost[] = []): string {
  const base = baseHarness(meta.harness);
  const host = meta.harness.includes("@") ? deviceLabel(meta.harness, hosts) : null;
  return `#${meta.id} · ${base}${host ? ` @ ${host}` : ""} · ${shortPath(meta.cwd)}`;
}

/** issue #132: the one-liner first (byte-identical, so parseSessionRef still
    round-trips a pasted block), then every id we hold, labeled, with the
    full unshortened cwd. Missing fields are simply absent — never
    fabricated, never "undefined"/"null" lines. */
export function formatSessionRefFull(meta: SessionRefMeta, hosts: DeviceHost[] = []): string {
  const lines = [formatSessionRef(meta, hosts), `truss: ${meta.id}`];
  if (meta.harnessRef) lines.push(`${baseHarness(meta.harness)} session: ${meta.harnessRef}`);
  const hostId = hostOf(meta.harness);
  if (hostId) lines.push(`host: ${hostId}`);
  lines.push(`cwd: ${meta.cwd}`);
  return lines.join("\n");
}

export interface ParsedSessionRef {
  sessionId: string;
  harness?: string;
  host?: string;
  cwd?: string;
}

const ID_RE = /#([0-9a-z]{6,})\b/; // no space after #, 6+ chars — "##"/"#xy" junk stays out

/** finds a reference embedded in prose; null (never throws) on anything else */
export function parseSessionRef(text: string): ParsedSessionRef | null {
  if (!text || typeof text !== "string") return null;
  const m = ID_RE.exec(text);
  if (!m) return null;
  const out: ParsedSessionRef = { sessionId: m[1] };

  /* optional trailing segments, slot-shaped so prose after the reference
     doesn't bleed in: " · <harness>[ @ <host>] · <cwd>" */
  const rest = text.slice(m.index! + m[0].length);
  const segs = rest.split(" · ").slice(1);
  const hw = segs[0]?.trim();
  if (hw) {
    const hm = /^([a-z][\w-]*)(?: @ (.+?))?\s*$/i.exec(hw);
    if (hm) {
      out.harness = hm[1];
      /* the host may itself carry trailing prose — hosts are labels, so we
         can't know; formatSessionRef emits it as the full segment, and the
         cwd slot's path shape bounds it from the right when present */
      if (hm[2]) out.host = hm[2].trim();
    }
  }
  const cwdSeg = segs[1]?.trim();
  if (cwdSeg) {
    const cm = /^(~?\/[^\s]*)/.exec(cwdSeg); // path prefix; prose stops at the first space
    if (cm) out.cwd = cm[1];
  }
  return out;
}
