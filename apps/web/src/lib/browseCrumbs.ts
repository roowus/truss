/**
 * The directory picker's breadcrumb builder, extracted from DirPicker so the
 * symlinked-root case is testable without a DOM (issue #233, audit round 2
 * B1).
 *
 * Why it takes two root lists: `POST /api/browse/mkdir` answers with the
 * CANONICAL path (`join(realParent, clean)`), because that is the string
 * `confine()` actually verified — the security fix for round 1's B3. But
 * `browseRoots()` reports roots under their LEXICAL names, and a browse root
 * may itself be a symlink (`/tmp -> /private/tmp` on macOS is documented in
 * `dirbrowse.ts`; a symlinked home or a `TMPDIR` through a link does it too).
 * Matching only the lexical roots left a canonical path matching NO root: the
 * bar dropped the root crumb and rendered `private / tmp / foo`, and clicking
 * `private` asked the server for `/private`, which is outside the roots — the
 * picker showed its own error for a crumb it had drawn.
 *
 * So a path matches a root when it equals or sits under EITHER the lexical
 * root or its resolved form, and the crumb labelled and navigated to is the
 * matched root itself (enter it and the server accepts it — `confine()`
 * accepts realRoots() too). The ROOT CRUMB'S LABEL prefers the lexical root
 * for display (`~` for home, the plain path otherwise), because that is the
 * name the user recognises and the roots view shows.
 *
 * Pure and defensive: garbage in never throws (this renders inside a dialog).
 */
export interface BrowseCrumb {
  label: string;
  path: string;
}

/** Build the crumb trail for `path`; [] for the roots view (path === null). */
export function browseCrumbs(path: string | null, roots: string[], realRoots: string[] = []): BrowseCrumb[] {
  if (path === null || typeof path !== "string" || !path) return [];
  const lexical = Array.isArray(roots) ? roots.filter((r) => typeof r === "string" && r) : [];
  const real = Array.isArray(realRoots) ? realRoots.filter((r) => typeof r === "string" && r) : [];

  /* the deepest matching root wins, so /home/u/projects beats /home/u */
  const match = (r: string) => path === r || path.startsWith(r + "/");
  const root = [...lexical, ...real].filter(match).sort((a, b) => b.length - a.length)[0];

  /* the label for a RESOLVED root match: show the lexical root it belongs to
     (`~` for home) when it maps back, else the resolved path as-is */
  const lexicalFor = (realRoot: string): string | undefined => {
    const i = real.indexOf(realRoot);
    return i > -1 && i < lexical.length ? lexical[i] : undefined;
  };
  const rootLabel = (): string => {
    if (!root) return "";
    if (lexical.includes(root)) return root === lexical[0] ? "~" : root;
    const lex = lexicalFor(root);
    if (lex === undefined) return root;
    return lex === lexical[0] ? "~" : lex;
  };

  const out: BrowseCrumb[] = [];
  let cur = root ?? "";
  if (root) out.push({ label: rootLabel(), path: root });
  for (const seg of path.slice(cur.length).split("/").filter(Boolean)) {
    cur += "/" + seg;
    out.push({ label: seg, path: cur });
  }
  return out;
}
