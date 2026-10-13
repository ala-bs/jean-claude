# Model Profiles & Project Policy — Design

Replaces the current "default backend + per-backend default model + per-model thinking"
triple-layer with **Roles × Profiles × Project Policy**.

## 1. Problem

Every consumer of a model stores its own independent `(backend, model, thinkingEffort)`:

```
backends.defaultBackend        ─ main agent backend
backendDefaultModels[backend]  ─ main agent model
thinkingSettings[be][model]    ─ main agent thinking
summaryModels                  ─ summaries
prReviewAgent                  ─ PR review
agentMemory.extraction*        ─ memory extraction
aiSkillSlots[]                 ─ AI skill slots
taskNameGeneration             ─ task naming
rateLimitSwap[]                ─ swap chain
```

Consequences:

1. **No single default.** `resolveBackendModelSelection` reconciles four sources
   (defaultBackend → per-backend default model → per-(backend,model) effort → maybe a
   matching preset).
2. **Switching backend loses the model.** `resolveBackendModelSelection` clamps to
   `'default'`; `resolveRunModelSettings` drops model *and* effort to `undefined` on a
   cross-backend swap. There is no cross-backend model mapping and ids are opaque
   (`sonnet` vs `anthropic/claude-sonnet-4-5` vs `gpt-5`).
3. **Rate-limit fallback is an 8-setting manual edit.** "Claude quota is out, move
   everything to Codex for an hour" requires editing every row above, then editing back.
4. **Project override is a suggestion, not a constraint.** `project.defaultAgentModelPreference`
   only applies when `project.defaultAgentBackend` happens to match, and nothing validates
   it at session creation. An org policy ("this repo may only use backend X") cannot be
   expressed.

## 2. Concepts

### Preset — the atom

`(backend, model, thinkingEffort)` + name. Already exists as `BackendModelPreset`; it keeps
its shape and becomes a building block rather than a secondary convenience.

### Role — the semantic slot

A fixed, app-defined enum of every place that needs a model:

```ts
type ModelRole =
  // core
  | 'agent'               // main coding agent
  | 'summary'             // step/task summaries
  | 'pr-review'           // PR review agent
  | 'memory'              // agent memory extraction
  | 'completion'          // Mistral FIM autocomplete
  // AI-generation features (each backed by an AI skill slot)
  | 'task-name'
  | 'pr-description'
  | 'commit-message'
  | 'project-summary'
  | 'work-item-summary'
  | 'project-logo'
  // catch-all
  | 'ai-generation';      // fallback for any skill slot without its own role
```

`ai-generation` is the fallback for skill slots that are not one of the six named roles, and
for `completion-context-generation-service` (which today hardcodes `model: 'haiku'` and
ignores every preference — see §7).

A role binds to `presetId | 'inherit' | 'off'`:

- `'inherit'` — follow the `agent` role.
- `'off'` — the feature is disabled under this profile. Only meaningful for optional
  features; `agent` may never be `'off'`. This exists because autocomplete should be
  switchable off per profile (a "cheap" or "rate-limited" profile shouldn't burn quota on
  FIM completions).

### Skill slots and roles

`electron/services/ai-skill-slot-resolver.ts` currently falls back to
`backends.defaultBackend` + `backendDefaultModels`, both of which this design deletes. The
slot resolver therefore has to be re-pointed at the profile:

```
resolveAiSkillSlot(slot, project)
  project.aiSkillSlots[slot]                  ← explicit per-project, still wins
  └─ global aiSkillSlots[slot]                ← explicit per-slot, still wins
     └─ profile.roles[roleForSlot(slot)]      ← NEW: the six named roles
        └─ profile.roles['ai-generation']     ← NEW: catch-all for other slots
           └─ profile.roles['agent']          ← via `inherit`
```

The six slots that have a named role (`task-name`, `pr-description`, `commit-message`,
`project-summary`, `work-item-summary`, `project-logo`) are individually bindable in a
profile. Any *other* slot — including ones added later — resolves through `ai-generation`,
so the unbounded set never forces profiles to grow. A slot's own explicit config always beats
the profile; the profile only supplies the fallback that `backendDefaultModels` used to.

### Profile — the switch

A named binding of every role to a preset. `inherit` means "follow `agent`", so a profile is
normally 1–2 explicit lines.

```
            ┌── Profile: "Anthropic" (active) ──┐   ┌── Profile: "Codex fallback" ──┐
   agent    │  claude-code / sonnet / high      │   │  codex / gpt-5 / high         │
   summary  │  claude-code / haiku / default    │   │  codex / gpt-5-mini / low     │
   pr-review│  claude-code / opus / high        │   │  inherit                      │
   memory   │  inherit                          │   │  inherit                      │
   skill:*  │  vibe / codestral / none          │   │  vibe / codestral / none      │
            └───────────────────────────────────┘   └───────────────────────────────┘
                              ▲
                  one switch (⌘. / palette) moves every row
```

Profile *definitions* are global. The *active* profile is global too — it models "my current
subscription situation", which is machine-wide, not repo-scoped. A project can still **pin**
a different profile for itself (§4); it does not get its own private profile list.

Cross-backend model translation disappears as a problem: you never map `sonnet → gpt-5`, you
activate a profile that already names the right model for each backend.

### Project policy — the constraint

```ts
type ProjectModelPolicy = {
  mode: 'inherit' | 'prefer' | 'enforce';
  allowedBackends?: AgentBackendType[];
  allowedPresetIds?: string[];
  pinnedProfileId?: string;
};
```

- `inherit` — today's behavior, global profile applies.
- `prefer` — pins a profile but the user can still pick anything.
- `enforce` — disallowed options are **hidden** in pickers **and rejected at session
  creation** with a visible error.

Hard enforcement matters because a global profile switch (or a stale step row written before
the policy existed) would otherwise leak a disallowed backend into a restricted repo. The
runtime check in `agent-service.createSession` is the real boundary; the UI filter is only
ergonomics.

**Source of truth:** repo file if present, else project settings in the DB.

```
<repo>/.jean-claude/model-policy.json   ← committed, applies to the whole team
        ↓ absent
projects.modelPolicy (DB)               ← per-machine project settings UI
```

The repo file wins wholesale (not merged), so a committed policy is unambiguous. When it is
present the project settings UI shows the policy read-only with a "defined in
`.jean-claude/model-policy.json`" note.

## 3. Resolution

One chain replaces four sources:

```
role
 │
 ├─► project policy ──── enforce? ──► clamp / pin / reject
 │                                        │
 ├─► active profile (or pinned) ──────────┤
 │                                        │
 ├─► preset ──────────────────────────────┤
 │                                        ▼
 └─► step override (only if policy allows) ──► (backend, model, thinkingEffort)
```

Shared resolver, used by both renderer (to render pickers) and main (to build
`AgentBackendConfig`):

```ts
resolveModelForRole({ role, project, policy, activeProfile, profiles, presets, override })
  : { backend, model, thinkingEffort, source: 'override'|'profile'|'policy'|'fallback',
      blocked?: { reason, allowed } }
```

Steps keep storing the **resolved triple** (`agentBackend`, `modelPreference`,
`thinkingEffort`) so history stays accurate, plus a new `profileId` / `presetId` for display
and for "was this a profile switch or an explicit override" reasoning.

## 4. Rate-limit fallback

`rateLimitSwap` stops being a per-entry model chain and becomes an ordered list of **profiles**:

```
on rate limit (backend of the active profile's `agent` role)
   ↓
activate next profile in the fallback order
   ↓
banner: "Claude limit reached — switched to Codex fallback · revert"
   ↓
auto-revert when the quota resets (or on manual revert)
```

Because the profile binds every role, the swap moves AI-generation features along with the
main agent — which is the use case that motivated this design.

**Running steps keep their model.** Only new steps pick up the new profile. This is a change
from today's `resolveRunModelSettings`, which restarts a run on the swapped backend and drops
model/effort to `undefined`. Restarting mid-run loses context and surprises the user; the
quota error surfaces on the *next* run instead.

## 5. Switching UX

```
┌─ header / composer ───────────────────────────┐
│  [ Anthropic ▾ ]  sonnet · high               │
└───────────────────────────────────────────────┘
        │ click / ⌘.
        ▼
┌───────────────────────────────────────────────┐
│  PROFILES                                     │
│  ● Anthropic            sonnet · high    ⌘1   │
│  ○ Codex fallback       gpt-5 · high     ⌘2   │
│  ○ Cheap                haiku · none     ⌘3   │
│  ─────────────────────────────────────────    │
│  Override this step only…                  ▸  │
│  Edit profiles…                               │
└───────────────────────────────────────────────┘
```

- `⌘.` cycles profiles, `⌘⌥1..9` jumps directly, all registered through `useCommands` so they
  appear in the command palette (`Use profile: Codex fallback`). *Shipped with `⌘⌥1..9`, not
  `⌘1..9`: plain `cmd+1..9` is already bound to feed-list navigation.*
- The raw backend / model / thinking pickers move **behind "Override this step only…"**. They
  stay available but stop being the primary control.
- Under `enforce`, non-permitted profiles render disabled with the policy reason, and
  "Override this step only…" is hidden entirely.

## 6. Data model changes

New settings keys (`SETTINGS_DEFINITIONS`):

| key | shape |
| --- | --- |
| `modelProfiles` | `ModelProfile[]` — `{ id, name, roles: Partial<Record<ModelRole, string /*presetId*/ \| 'inherit'>> }` |
| `activeModelProfileId` | `string \| null` |
| `modelFallbackOrder` | `string[]` — profile ids, replaces `rateLimitSwap` |

Kept: `backendModelPresets` (now the atom), `backends.enabledBackends`.

Deprecated → migrated → removed: `backends.defaultBackend`, `backendDefaultModels`,
`thinkingSettings`, `summaryModels`, `prReviewAgent`, `agentMemory.extraction*`,
`rateLimitSwap`, `projects.defaultAgentBackend`, `projects.defaultAgentModelPreference`.

Migration (mechanical, no user input):

1. Synthesize a preset per existing `(backend, model, effort)` triple found across all old
   keys, deduped.
2. Build one profile `"Default"` binding each role to the preset derived from its old key.
3. Build one profile per additional enabled backend from `backendDefaultModels` +
   `thinkingSettings`, roles all `inherit`.
4. `activeModelProfileId` = the profile whose `agent` preset matches old `defaultBackend`.
5. `modelFallbackOrder` = profiles derived from old `rateLimitSwap` entries, in order.
6. Projects start clean: every project migrates to `modelPolicy = { mode: 'inherit' }` and the
   old `defaultAgentBackend` / `defaultAgentModelPreference` columns are dropped. Today's
   per-project override is half-broken (the model only applied when the backend happened to
   match), so carrying it forward would carry the bug forward. Policy is opt-in, set
   deliberately per project.

   **As shipped this is two migrations, not one.** `092_model_profiles_and_project_policy`
   only *adds* `projects.modelPolicy`; `093_drop_project_default_backend` drops
   `defaultAgentBackend` / `defaultAgentModelPreference` afterwards, once every writer had
   stopped referencing them. Dropping the columns in 092 broke project save at runtime with
   `no such column`, because repository inserts/updates still named them.

## 7. Cleanup this unlocks

The scan found the backend list spelled out in 4 places (`AgentBackendType`,
`SETTINGS_DEFINITIONS` literals, `settings.ts` normalizers, `AVAILABLE_BACKENDS`) and the
Claude model list in 3 (`backend-models-service.ts`, `ui-backend-selector`,
`ui-model-selector` — the last holding a stale `claude-opus-4-5`). Collapsing every
per-backend `Record<AgentBackendType, …>` setting into profiles removes most of the hand-written
enumerations; the remaining ones should derive from a single `BACKENDS` registry.

## 8. Open risks

- **Unknown roles.** Profiles must tolerate role ids they don't recognise (treat as
  `inherit`) so adding a role in a later version doesn't invalidate stored profiles.
- **Repo policy trust.** A committed `model-policy.json` can only *restrict*, never grant a
  backend the user hasn't enabled or authenticated. Intersect with `enabledBackends`.
- **Enforce + fallback conflict — decided.** If a project is in `enforce` mode and its only
  permitted backend is rate-limited, the fallback **must not** engage. Surface a blocking
  error on the project ("Claude limit reached — this project only permits claude-code") and
  leave the profile untouched. Silently falling back to a banned backend is worse than not
  running. Projects in `inherit` / `prefer` mode are unaffected and fall back normally, so a
  global rate limit never blocks unrestricted projects.

## 9. Decisions log — **shipped**

Everything below is implemented and green. Deviations from the original decision are called
out in the Decision column.

| Question | Decision | Status |
| --- | --- | --- |
| First PR scope | Profiles **and** project policy together | Shipped |
| Existing `defaultAgentBackend` | Migrate to `mode: 'inherit'`, drop the columns, start clean. **Split into two migrations:** `092` adds `projects.modelPolicy`, `093` drops `defaultAgentBackend` / `defaultAgentModelPreference` — dropping them in 092 caused a runtime `no such column` on project save | Shipped (amended) |
| Enforce vs rate limit | Blocking error, never violate the policy | Shipped |
| Roles in a profile | **12 roles**, not six: `agent`, `summary`, `pr-review`, `memory`, `completion`, `task-name`, `pr-description`, `commit-message`, `project-summary`, `work-item-summary`, `project-logo`, `ai-generation` | Shipped (expanded) |
| Role binding values | `presetId \| 'inherit' \| 'off'`; unknown role ids are treated as `inherit` | Shipped |
| AI skill slots | Six get named roles; the rest resolve via the `ai-generation` catch-all. Explicit per-slot config always wins | Shipped |
| `completion-context-generation-service` hardcoded `haiku` | Routed through the `ai-generation` role | Shipped |
| `completion` per profile | Can be set to `'off'`, hence the `'off'` binding value | Shipped |
| Profile scope | Definitions and active selection are global; projects *pin*, never own | Shipped |
| Running steps on switch | Keep their model; only new steps pick up the new profile | Shipped |
| Profile shortcuts | `⌘.` cycles, `⌘⌥1..9` jumps — **not** `⌘1..9`, which feed-list navigation already owns | Shipped (amended) |
| Legacy settings keys | `backends.defaultBackend`, `backendDefaultModels`, `thinkingSettings`, `summaryModels`, `prReviewAgent`, `rateLimitSwap`, `agentMemory.extraction*` deleted outright; `migrateLegacyModelSettingsToProfiles` upgrades existing installs at startup | Shipped |

---

# Revision 1 — roles hold their own triple; presets move inside profiles

Shipped waves 0–6 made a role point at a **global** preset by id. Using it revealed
three problems:

1. **A profile isn't bound to a backend — each row is.** Pointing at a shared preset made
   the profile a bag of references to something outside itself, so you could not read a
   profile and know what it does.
2. **Dangling references.** Deleting a global preset left every role that referenced it
   pointing at nothing, silently falling through to `agent` with no warning.
3. **The quick switcher never merged.** `modelQuickSwitcher` + `showInQuickSwitcher`
   survived as a second, global, profile-blind switching concept — exactly the duplication
   this design set out to remove. With "Codex fallback" active it still offered pinned
   Claude presets, and picking one silently contradicted the profile.

## New shape

```ts
type ModelTriple = {
  backend: AgentBackendType;
  model: ModelPreference;
  thinkingEffort: ThinkingEffort;
};

type RoleBinding = ModelTriple | 'inherit' | 'off';

type ProfilePreset = { id: string; name: string } & ModelTriple;

type ModelProfile = {
  id: string;
  name: string;
  /** Named shortcuts owned by THIS profile; applying one fills a role's triple. */
  presets: ProfilePreset[];
  /** Presets offered as one-tap chips in the composer, for this profile. */
  quickPresetIds: string[];
  roles: Partial<Record<ModelRole, RoleBinding>>;
};
```

A role now stores a concrete triple. Presets stop being the atom profiles are built from
and become **per-profile named shortcuts**: you apply one to a role and it copies its
triple in. Nothing points at anything afterwards, so a deleted preset can never orphan a
role.

The **quick switcher** is now `profile.quickPresetIds` — switching profile changes which
chips the composer offers, and every chip is by construction consistent with the profile
it came from. The global `modelQuickSwitcher` setting and `BackendModelPreset.showInQuickSwitcher`
are deleted.

## Project policy

`allowedPresetIds` is deleted — there are no global ids left to allow. Enforcement is
expressed in terms of **profiles**:

```ts
type ProjectModelPolicy = {
  mode: 'inherit' | 'prefer' | 'enforce';
  allowedProfileIds?: string[];   // NEW — replaces allowedPresetIds
  allowedBackends?: AgentBackendType[];  // kept: guards step-level overrides
  pinnedProfileId?: string;
};
```

`allowedBackends` stays because a per-step override can still name a backend directly, and
under `enforce` that has to be refused at session creation regardless of profile.

## Consequences

- `resolveModelForRole` drops its `presets` parameter entirely — a binding is already a
  triple. Fewer inputs, no lookup step, no missing-preset fallback path.
- The profile editor's role rows become backend + model + thinking selectors, plus an
  "apply preset" affordance.
- The settings keys `backendModelPresets` and `modelQuickSwitcher` are deleted; a settings
  migration inlines every role binding and moves the global presets into each profile.
- `shared/types.ts` loses `BackendModelPreset`, `BackendModelPresetsSetting` and
  `ModelQuickSwitcherSetting`.

## Migration (one-way, at startup)

For each stored profile: replace every `presetId` binding with the triple of that preset
(dropping bindings whose preset no longer exists, which were already dead), copy the global
preset list into `profile.presets`, and seed `profile.quickPresetIds` from the presets whose
`showInQuickSwitcher` was not `false`. Then drop the two global keys. Idempotent: a profile
whose roles already hold triples is left untouched.
