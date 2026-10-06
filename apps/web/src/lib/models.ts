import { baseHarness } from "./format";

/** The model picker's option plumbing (chat header). Model ids contain
   slashes themselves (`accounts/fireworks/models/kimi-k3`), so provider and
   model join on the FIRST slash only. */

export interface ModelOption {
  value: string;
  label: string;
  hint?: string;
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

/* Known single-provider scopes get a plain-language reason, not just a name
   (issue #170): claude's picker lists exactly the models the loopback
   key-proxy serves, and a short list with no explanation reads as a bug.
   Keep these user-facing: plain words, no em dashes (TRUSS.md). */
const PROVIDER_SCOPE_NOTES: Record<string, string> = {
  "zai-local": "via zai-local (the local key-proxy)",
};

/* Past this many rows a list no longer reads as sparse, so the note has
   nothing to explain — richness is a ROW count, not a provider count:
   hermes tags its whole 600+ model catalog provider "hermes"
   (apps/server/src/adapters/hermes.ts mapModels), and a provider gate
   alone would pin "via hermes" under exactly the rich lists the issue
   says stay quiet. Sits between claude's 11 key-proxy models and the
   big OpenRouter/dsh catalogs. */
const SCOPE_NOTE_MAX_ROWS = 30;

/**
 * One line under the model picker's list explaining the list's scope, or
 * null when there is nothing to explain (issue #170):
 * - every row from one provider → "via <provider>", with a plain-language
 *   reason for the providers we know are scoped on purpose;
 * - two or three providers → all named;
 * - more providers, or a long list at all → null: the catalog is rich,
 *   and the per-row provider labels (#169) carry the scope instead of a
 *   footnote;
 * - empty → null.
 */
export function catalogScopeNote(models: { provider: string }[]): string | null {
  if (models.length === 0 || models.length > SCOPE_NOTE_MAX_ROWS) return null;
  const providers = [...new Set(models.map((m) => m.provider).filter(Boolean))];
  if (providers.length === 0 || providers.length > 3) return null;
  if (providers.length === 1) return PROVIDER_SCOPE_NOTES[providers[0]] ?? `via ${providers[0]}`;
  return `via ${providers.join(" · ")}`;
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
    .map((m) => ({
      value: modelValue(m.provider, m.model),
      label: m.label,
      hint: modelValue(m.provider, m.model),
    }));
  const current = modelValue(currentProvider, currentModel);
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: currentModel!, hint: "current" });
  }
  return options;
}
