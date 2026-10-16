# The dsh model picker froze on a stale, narrow catalog

**Status:** quick patch merged (fallback in `apps/server/src/adapters/dsh.ts`).
The root cause is **not** fixed. This document is for the agent doing that.
**Follow-up issue:** #231.
**Related:** #228 and #230 fixed the *pi/hermes* pickers; this is a different
code path and neither of those touched it.

## The symptom

The New Session dialog offered 828 models for pi but only 27 for dsh, and all
27 were Fireworks. The user could not select DeepSeek, z.ai, OpenRouter or
anything else in a dsh session.

## Two different picker architectures (the thing to understand first)

These are not the same code path, which is exactly why pi was fine and dsh was
not:

| | pi | dsh |
|---|---|---|
| Who owns the list | **Truss** | **the harness** |
| Where it comes from | `syncPiModelsJson()` regenerates `~/.pi/agent/models.json` from the key-proxy catalog on boot | the ACP `session/new` response's `configOptions.model` |
| Why 828 rows | 6 providers × the live key-proxy catalog | whatever dsh chooses to report |
| Code | `apps/server/src/pi-config.ts` | `apps/server/src/adapters/dsh.ts` |

So pi's richness is a Truss feature. dsh's is whatever dsh says.

## The root cause

dsh's catalog is discovered once and persisted, and **nothing ever
cross-checks it against reality**:

1. `apps/server/src/adapters/dsh.ts` builds its catalog from
   `session/new` → `parseModelOptions(res.configOptions)`, persisted by
   `lazyCatalog("models:dsh", …)` into the kv store.
2. `apps/server/src/sessions.ts` `listModels()` re-probes **only when the
   catalog is EMPTY**:

   ```ts
   if (opts.probe && models.length === 0 && a.probeModels) { … }
   ```

   A non-empty but *wrong* catalog therefore never gets repaired. Read from the
   production database, the live value was:

   ```
   models:dsh    total=27   {"fireworks":27}
   models:hermes total=631  {"hermes":631}
   ```

3. Meanwhile dsh's own profile, `/opt/dsh/profiles/web/cordis.patch.yml`,
   configures **113 models across 7 providers** (counted from that file):

   ```
   fireworks 12 | deepseek 2 | zai 6 | openrouter 18
   openrouter-router 6 | huggingface 60 | deepinfra 9   = 113
   ```

So the picker was wrong twice over: 6 of 7 providers missing, and the one
provider it did show (27) did not even match its own configured list (12). The
27 is a fossil of an earlier configuration.

### Open question for the real fix

**Why does dsh report 27 rows when its profile configures 113?** That is the
actual defect and this report does not answer it. Candidates worth checking,
in order:

- The dsh process serving ACP may not be loading `cordis.patch.yml` at all, or
  may load a different profile than the one edited at that path. The unit file
  sets `Environment=DSH_HOME=/opt/dsh` for `truss.service`, and the profile
  lives under `/opt/dsh/profiles/web/` — confirm the ACP child inherits that
  and resolves the same file.
- `llm-pi-ai` is the plugin that defines these provider groups. Note that
  `llm-deepseek` is explicitly `disabled: true` in that file (comment: "this
  deployment has no DeepSeek key"), yet a `deepseek:` provider group sits under
  `llm-pi-ai`. If the ACP picker derives its list from the *skill/plugin*
  registry rather than the pi-ai provider block, the 7 groups may never reach
  the picker.
- The label shape may matter: `parseModelOptions` JSON-parses each option's
  `value` as `[provider, model]`. If dsh emits a different shape for some
  groups, those rows are silently skipped (the `catch` swallows it). 27 rows
  getting through and 86 not is consistent with a partial shape mismatch.
- Provider groups may need explicit enablement that only `fireworks` has.

Verifying which of these it is should be the first step: boot dsh with ACP and
dump the raw `configOptions` from `session/new` (the same call
`lazyCatalog`'s discover function makes) and see what it actually contains.
That single observation will discriminate between all four candidates.

## What the quick patch does

`mergeCatalogRows` + `catalogLooksStale` in `apps/server/src/adapters/dsh.ts`.
When the harness report is below a floor (50 rows), the picker is topped up
with the key-proxy catalog — the same source pi uses. Deliberately a
**fallback, not an override**: dsh's own rows win and keep their labels,
because those are the ids its providers are configured to accept. Unconditional
expansion would offer ids dsh cannot route.

Observed effect: the dsh picker goes 27 → 812 rows across 6 providers,
including first-party DeepSeek.

## What the patch does NOT fix

- **The stale cache is still never repaired.** The `models.length === 0` guard
  in `sessions.ts` remains. Any stale non-empty catalog for *any* ACP adapter
  (hermes included — note hermes shows 631 rows, which nobody has verified) is
  still permanent. This is arguably the more general bug.
- **dsh still reports 27.** The picker is now wide, but the underlying report
  is still wrong, so the *session's own* model list (used for request routing
  and for validating `opts.model`) still comes from the narrow report. A model
  the user picks off the widened list may not be selectable in-session.
- **The 50-row floor is a heuristic.** It is not derived from anything. If dsh
  legitimately configures fewer than 50 models one day, the picker will start
  offering every credential row again. The test pins the intent, not a fact.
- **hermes was never audited.** It shows 631 rows from its own report; whether
  that matches its configured providers is unknown. It likely has the same
  class of exposure.

## Suggested shape of the real fix

1. Find out why dsh reports 27 (above). If the profile genuinely configures
   113 and dsh should report them, fixing that makes the fallback unnecessary.
2. Replace the `models.length === 0` re-probe guard with something
   staleness-aware — e.g. re-probe when the catalog is older than N minutes, or
   when a route's credentials changed, not only when it is empty.
3. Cross-check catalogs against the key-proxy routes at boot and surface
   discrepancies (a provider with credentials but zero picker rows is a
   reportable condition, not a silent one). This is the same "make it loud"
   principle as #229.
4. If harness-owned and Truss-owned lists must coexist, reconcile them once at
   the source rather than per-request in `listModels`.

## Evidence used

- `models:dsh` = 27 (all fireworks) read from
  `/home/ubuntu/projects/truss-prod/apps/server/data/truss.db`, kv table.
- `/opt/dsh/profiles/web/cordis.patch.yml` model counts per provider group.
- A live ACP probe through `dshAdapter.probeModels()` → 27 rows, confirming the
  narrow report is current, not a stale read artifact.
- Live production picker: `/api/harnesses/probe` reports pi 828 / dsh 27.
