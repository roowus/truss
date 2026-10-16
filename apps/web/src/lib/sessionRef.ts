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
}

export function formatSessionRef(meta: SessionRefMeta, hosts: DeviceHost[] = []): string {
  const base = baseHarness(meta.harness);
  const host = meta.harness.includes("@") ? deviceLabel(meta.harness, hosts) : null;
  return `#${meta.id} · ${base}${host ? ` @ ${host}` : ""} · ${shortPath(meta.cwd)}`;
}

/** the session row carries the harness's own uuid too (issue #132) */
export interface SessionRefMetaFull extends SessionRefMeta {
  harness_ref?: string | null;
}

/**
 * The FULL identity block (issue #132): the #13 one-liner stays byte-identical
 * on line 1 — it is the pasteable, tweetable handle — and every id we hold
 * follows, labeled, with the UNSHORTENED cwd:
 *
 *   #aa07c1d9 · pi @ devbox · ~/projects/doubletake
 *   truss: aa07c1d9
 *   pi session: 01a0edfd-6598-727a-99ee-15ab86352a3c
 *   host: 525b9cd4
 *   cwd: /Users/alice/projects/doubletake
 *
 * The host line carries the raw host ID, not the human label: this block is
 * for resolving a session on another machine, and the id is what resolves
 * (the label is already on line 1). Local sessions have no host id at all.
 *
 * Never fabricates: a field we don't hold is absent, never "undefined"/"null".
 * Line 1 keeps parseSessionRef's round trip intact — the label lines can't
 * confuse it, because parsing is slot-shaped off the first "#id".
 */
export function formatSessionRefFull(meta: SessionRefMetaFull, hosts: DeviceHost[] = []): string {
  const base = baseHarness(meta.harness);
  const hostId = hostOf(meta.harness);
  const ref = meta.harness_ref?.trim();
  const cwd = meta.cwd?.trim();

  const lines = [formatSessionRef(meta, hosts), `truss: ${meta.id}`];
  if (ref) lines.push(`${base} session: ${ref}`);
  if (hostId) lines.push(`host: ${hostId}`);
  if (cwd) lines.push(`cwd: ${cwd}`);
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
