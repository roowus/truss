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
