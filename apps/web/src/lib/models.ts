import { baseHarness } from "./format";

/** The model picker's option plumbing (chat header). Model ids contain
   slashes themselves (`accounts/fireworks/models/kimi-k3`), so provider and
   model join on the FIRST slash only. */

export interface ModelOption {
  value: string;
  label: string;
  hint?: string;
  providerLabel?: string;
  fullPath?: string;
}

export interface CatalogModel {
  harness: string;
  provider: string;
  model: string;
  label: string;
}

export function modelValue(provider: string | undefined, model: string | undefined): string {
  if (!model) return "";
  return provider ? `${provider}/${model}` : model;
}

/** inverse of modelValue — split on the first slash only */
export function splitModelValue(v: string): { provider?: string; model: string } {
  const i = v.indexOf("/");
  if (i === -1) return { model: v };
  return { provider: v.slice(0, i), model: v.slice(i + 1) };
}

/** What a picker row shows for one model (issue #169): the human name
   primary, the provider as the secondary line, and the full routing path
   preserved for the click-through. dsh's catalog labels router-hosted
   models with the raw path (`accounts/fireworks/routers/…/kimi-k3`) — the
   row used to BE that path. */
export interface ModelDisplay {
  name: string;
  providerLabel: string;
  fullPath: string;
}

/** "kimi-k3" -> "Kimi K3"; "gemini-3-pro" -> "Gemini 3 Pro" */
function humanizeId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** The provider named inside a routing path: `accounts/<provider>/…` keeps
   it one segment in; a short `provider/model` id leads with it (the id's
   prefix is the real provider when the session's provider field is an
   aggregator like openrouter). Anything shorter tells us nothing. */
function providerFromPath(p: string): string | undefined {
  const segs = p.split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  return segs[0] === "accounts" ? segs[1] : segs[0];
}

export function modelDisplay(m: { provider: string; model: string; label: string }): ModelDisplay {
  const label = m.label ?? "";
  const provider = m.provider ?? "";
  const model = m.model ?? "";
  // a path masquerading as a label: slashes and no spaces — parse it
  if (label.includes("/") && !label.includes(" ")) {
    const tail = label.split("/").filter(Boolean).pop() ?? "";
    return {
      name: humanizeId(tail) || label,
      providerLabel: humanizeId(providerFromPath(label) ?? provider),
      fullPath: label,
    };
  }
  // a real label is already the name — untouched
  return {
    name: label || humanizeId(model.split("/").filter(Boolean).pop() ?? "") || "Unknown",
    providerLabel: humanizeId(providerFromPath(model) ?? provider),
    fullPath: modelValue(provider, model),
  };
}

/** How many distinct providers still read as a scoped catalog worth
   explaining. Past this, the list is rich enough that the per-row provider
   labels (#169) carry the scope on their own and a note is just noise. */
const SCOPE_NOTE_MAX_PROVIDERS = 3;

/** Past this many rows the list no longer reads as sparse, so the note has
   nothing left to explain. Richness is a ROW count, not a provider count:
   hermes tags its whole 600+ model catalog `provider: "hermes"`
   (apps/server/src/adapters/hermes.ts mapModels — hermes's ACP model state
   carries no provider at all, so that value is a placeholder), and pi does
   the same when `~/.pi/agent/models.json` holds one provider entry with many
   models. A provider gate alone would pin "via hermes" under exactly the
   rich list the issue's acceptance criteria say must stay quiet. Sits
   between claude's 11 key-proxy models and the big OpenRouter/dsh catalogs. */
const SCOPE_NOTE_MAX_ROWS = 30;

/** Why a harness's model list is short (issue #170). claude's picker shows
   ~11 models while pi/hermes show 600+ — reads like a bug, but it is by
   design: different credential routes reach different model universes
   (claude's 11 ARE the loopback key-proxy's real catalog). Returning a note
   for a scoped list is what makes a short list read as intentional.

   Rows are anything carrying the provider — catalog rows (`provider`) or
   already-projected picker options (`providerLabel`), so both call sites can
   hand over what they already hold.

   - a long list → null, however few providers it names (the list is rich,
     not scoped — the #169 per-row labels carry the providers themselves);
   - one provider → names it; the local key-proxy shape also says so;
   - up to SCOPE_NOTE_MAX_PROVIDERS → lists them;
   - more providers, or nothing at all → null. */
export function catalogScopeNote(models: Array<{ provider?: string; providerLabel?: string }>): string | null {
  /* the row gate comes FIRST: a 600-row single-provider catalog is rich, and
     naming its one provider would be a redundant note on a long list */
  if (models.length === 0 || models.length > SCOPE_NOTE_MAX_ROWS) return null;
  const providers: string[] = [];
  for (const m of models) {
    const p = (m?.provider || m?.providerLabel || "").trim();
    if (p && !providers.includes(p)) providers.push(p);
  }
  if (providers.length === 0 || providers.length > SCOPE_NOTE_MAX_PROVIDERS) return null;
  if (providers.length === 1) {
    const only = providers[0];
    /* the loopback key-proxy case (issue #170): the provider id alone
       ("zai-local") doesn't explain WHY the universe is this small, so the
       note names the mechanism too. Matches on the id's own local/proxy
       shape, not on a hardcoded provider list. */
    return /local|proxy/i.test(only)
      ? `via ${only} — the local key-proxy`
      : `via ${only}`;
  }
  return `via ${providers.join(" · ")}`;
}

/** Display projection of picker options for the generic Select: the
   projected row's secondary line becomes the provider and its hover title
   the full path. Source options are untouched — their hint stays the exact
   id (device tests pin it), and the typeahead still matches the raw id via
   `value`. Maps, never mutates. */
export function modelSelectOptions(options: ModelOption[]): Array<ModelOption & { title?: string }> {
  return options.map((o) => ({ ...o, hint: o.providerLabel || o.hint, title: o.fullPath }));
}

/**
 * Options for a session's model picker: the catalog filtered to the base
 * harness (a remote pi session shares the local pi catalog), with the
 * session's current model synthesized in when the catalog doesn't list it
 * (stale config, custom endpoint) so the picker never shows a blank.
 */
export function buildModelOptions(
  catalog: CatalogModel[],
  harness: string,
  currentModel?: string,
  currentProvider?: string,
): ModelOption[] {
  const base = baseHarness(harness);
  const options = catalog
    .filter((m) => m.harness === base)
    .map((m): ModelOption => {
      const d = modelDisplay(m);
      return {
        value: modelValue(m.provider, m.model),
        label: d.name,
        hint: modelValue(m.provider, m.model),
        providerLabel: d.providerLabel,
        fullPath: d.fullPath,
      };
    });
  const current = modelValue(currentProvider, currentModel);
  if (current && !options.some((o) => o.value === current)) {
    /* the synthesized row gets the same parsing — a stale-config path is
       still never the row's face. hint stays "current" (it explains why an
       unlisted model appears) and providerLabel stays unset so the display
       projection keeps it. */
    const d = modelDisplay({ provider: currentProvider ?? "", model: currentModel!, label: currentModel! });
    options.unshift({ value: current, label: d.name, hint: "current", fullPath: d.fullPath });
  }
  return options;
}
