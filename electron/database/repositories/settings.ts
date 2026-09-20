import {
  AGENT_BACKEND_IDS,
  AGENT_MEMORY_EXTRACTION_BACKENDS,
  type AgentMemorySetting,
  type AiSkillSlotKey,
  AppSettings,
  type CalendarNotificationsSetting,
  DEFAULT_TASK_NOTIFICATION_MODES,
  normalizePromptPrefaceSetting,
  SETTINGS_DEFINITIONS,
  type TaskEventNotificationsSetting,
  type TaskNotificationEvent,
  type TaskNotificationMode,
  type ThinkingEffort,
  type WorkActivitySetting,
} from '@shared/types';
import {
  INHERIT_BINDING,
  isImageModelBinding,
  isModelRole,
  isModelTriple,
  isPresetRefBinding,
  type ModelProfile,
  type ModelProfilesSetting,
  type ModelRole,
  type ModelTriple,
  OFF_BINDING,
  type ProfilePreset,
  roleForSkillSlot,
} from '@shared/model-profiles';
import type { AgentBackendType } from '@shared/agent-backend-types';


import { db } from '../index';
import { dbg } from '../../lib/debug';


function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return (
    value === 'default' ||
    value === 'minimal' ||
    value === 'none' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max' ||
    value === 'xhigh'
  );
}

function normalizeWorkActivitySetting(
  value: unknown,
): WorkActivitySetting | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.enabled === 'boolean') {
    return null;
  }

  return { enabled: value.enabled !== false };
}

function migrateLegacyMemorySettingToAgentMemory(
  value: unknown,
): AgentMemorySetting | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null;

  const defaults = SETTINGS_DEFINITIONS.agentMemory.defaultValue;
  return {
    enabled: value.enabled,
    extractionIntervalMinutes:
      typeof value.consolidationIntervalMinutes === 'number' &&
      Number.isFinite(value.consolidationIntervalMinutes) &&
      value.consolidationIntervalMinutes >= 15
        ? value.consolidationIntervalMinutes
        : defaults.extractionIntervalMinutes,
    extractionBackend:
      typeof value.consolidationBackend === 'string' &&
      AGENT_MEMORY_EXTRACTION_BACKENDS.includes(
        value.consolidationBackend as (typeof AGENT_MEMORY_EXTRACTION_BACKENDS)[number],
      )
        ? (value.consolidationBackend as AgentBackendType)
        : defaults.extractionBackend,
    extractionModel:
      typeof value.consolidationModel === 'string'
        ? value.consolidationModel
        : defaults.extractionModel,
    extractionThinkingEffort: isThinkingEffort(
      value.consolidationThinkingEffort,
    )
      ? value.consolidationThinkingEffort
      : defaults.extractionThinkingEffort,
  };
}

// --- Model profiles (design §6) ---

const BACKEND_LABELS: Record<AgentBackendType, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  copilot: 'Copilot',
  vibe: 'Vibe',
};

const DEFAULT_MIGRATION_BACKEND: AgentBackendType = 'claude-code';

type PresetTriple = {
  backend: AgentBackendType;
  model: string;
  thinkingEffort: ThinkingEffort;
};

function isAgentBackend(value: unknown): value is AgentBackendType {
  return (
    typeof value === 'string' &&
    AGENT_BACKEND_IDS.includes(value as AgentBackendType)
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tripleKey(triple: PresetTriple): string {
  return `${triple.backend}\u0000${triple.model}\u0000${triple.thinkingEffort}`;
}

function legacyPresetId(triple: PresetTriple): string {
  return `legacy-${slugify(triple.backend)}-${slugify(triple.model)}-${slugify(
    triple.thinkingEffort,
  )}`;
}

/**
 * Reads the ordered swap entries out of a stored `rateLimitSwap` value.
 *
 * Two historical shapes exist and both must still migrate: the newer
 * `{ enabled, chain: [{ backend, model?, thinkingEffort? }] }` and the original
 * `{ enabled, rules: [{ backend, threshold?, swapTo? }] }`, whose last rule
 * carried the absolute fallback in `swapTo`.
 */
function legacyRateLimitSwapChain(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.chain)) return value.chain;
  if (!Array.isArray(value.rules)) return [];

  const rules = value.rules.filter(
    (rule): rule is Record<string, unknown> =>
      isRecord(rule) && isAgentBackend(rule.backend),
  );
  const fallback = rules.at(-1)?.swapTo;
  const fallbackBackend = isRecord(fallback) ? fallback.backend : undefined;

  return [
    ...rules.map((rule) => ({ backend: rule.backend })),
    ...(isRecord(fallback) && isAgentBackend(fallbackBackend)
      ? [
          {
            backend: fallbackBackend,
            model:
              typeof fallback.model === 'string' ? fallback.model : undefined,
          },
        ]
      : []),
  ];
}

function legacyPresetName(triple: PresetTriple): string {
  const base = `${BACKEND_LABELS[triple.backend]} ${triple.model}`;
  return triple.thinkingEffort === 'default'
    ? base
    : `${base} · ${triple.thinkingEffort}`;
}

/**
 * Key-order-independent deep comparison, used to decide whether a stored value
 * actually changed (object key order must not trigger a rewrite).
 */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((entry, index) => isDeepEqual(entry, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => Object.hasOwn(b, key) && isDeepEqual(a[key], b[key]),
  );
}

/** Reads a stored profile preset entry, dropping the ones we cannot use. */
function normalizeProfilePreset(value: unknown): ProfilePreset | null {
  if (!isRecord(value) || Array.isArray(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.name !== 'string') return null;
  if (!isAgentBackend(value.backend)) return null;
  if (typeof value.model !== 'string') return null;
  return {
    id: value.id,
    name: value.name,
    backend: value.backend,
    model: value.model,
    thinkingEffort: isThinkingEffort(value.thinkingEffort)
      ? value.thinkingEffort
      : 'default',
  };
}

function normalizeProfilePresets(value: unknown): ProfilePreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: ProfilePreset[] = [];
  for (const entry of value) {
    const preset = normalizeProfilePreset(entry);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
  }
  return presets;
}

function normalizeQuickPresetIds(
  value: unknown,
  presets: ProfilePreset[],
): string[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(presets.map((preset) => preset.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !known.has(entry) || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    ids.push(entry);
  }
  return ids;
}

/**
 * Normalizes a stored `modelProfiles` value: drops malformed profiles, presets
 * and role bindings, de-duplicates ids and rewrites the forbidden
 * `agent: 'off'` binding to `'inherit'`. Unknown role ids are preserved on
 * purpose (design §8).
 *
 * Revision 1: a role binding is a `ModelTriple` (or `'inherit'` / `'off'`), and
 * every profile owns `presets` / `quickPresetIds`. A *legacy preset-id* string
 * binding is deliberately preserved verbatim rather than dropped — the startup
 * migration (`migrateProfilePresetIdBindings`) still needs to resolve it into a
 * triple, and discarding it here would silently erase the user's selection.
 *
 * Returns `null` when the value is not an array or already normalized, so the
 * repository does not rewrite untouched rows.
 */
export function normalizeModelProfilesSetting(
  value: unknown,
): ModelProfilesSetting | null {
  if (!Array.isArray(value)) return null;

  const seenIds = new Set<string>();
  const normalized: ModelProfile[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || Array.isArray(entry)) continue;
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
    if (typeof entry.name !== 'string') continue;
    if (!isRecord(entry.roles) || Array.isArray(entry.roles)) continue;
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);

    const roles: Record<string, unknown> = {};
    for (const [role, binding] of Object.entries(entry.roles)) {
      if (!isModelRole(role)) {
        roles[role] = binding;
        continue;
      }
      if (isModelTriple(binding)) {
        roles[role] = {
          backend: binding.backend,
          model: binding.model,
          thinkingEffort: binding.thinkingEffort,
        };
        continue;
      }
      // A role may follow a preset of its profile by reference, and an image
      // role holds an image model id: both are stored shapes, not noise, and
      // dropping them here would silently reset the role.
      if (isPresetRefBinding(binding)) {
        roles[role] = { presetId: binding.presetId };
        continue;
      }
      if (isImageModelBinding(binding)) {
        roles[role] = { imageModel: binding.imageModel };
        continue;
      }
      if (typeof binding !== 'string' || binding.length === 0) continue;
      roles[role] =
        role === 'agent' && binding === OFF_BINDING ? INHERIT_BINDING : binding;
    }

    const presets = normalizeProfilePresets(entry.presets);

    normalized.push({
      id: entry.id,
      name: entry.name,
      presets,
      quickPresetIds: normalizeQuickPresetIds(entry.quickPresetIds, presets),
      roles: roles as ModelProfile['roles'],
    });
  }

  if (isDeepEqual(normalized, value)) return null;
  return normalized;
}

/**
 * Revision 0 → Revision 1 of the model-profiles storage.
 *
 * Each role used to hold the *id* of a preset in the global
 * `backendModelPresets` list. Revision 1 stores the concrete triple inline and
 * moves the presets inside each profile.
 *
 * For every profile: resolve each preset-id binding into that preset's triple
 * (dropping bindings whose preset no longer exists — those were already dead
 * references resolving to nothing), copy the global preset list into
 * `profile.presets` and seed `profile.quickPresetIds` from the presets whose
 * `showInQuickSwitcher` was not `false`.
 *
 * IMPORTANT: the preset id must be resolved BEFORE any normalization.
 * `normalizeRoleBinding` turns every unrecognised value — including a legacy
 * preset id — into `'inherit'`, so normalizing first would erase the user's
 * entire configuration.
 *
 * Idempotent: returns `null` when every profile already holds triples and owns
 * its presets, so nothing is rewritten.
 */
export function migrateProfilePresetIdBindings(input: {
  profiles: unknown;
  presets: unknown;
}): ModelProfile[] | null {
  if (!Array.isArray(input.profiles)) return null;

  const globalPresets: ProfilePreset[] = [];
  const quickFlagById = new Map<string, boolean>();
  if (Array.isArray(input.presets)) {
    for (const entry of input.presets) {
      const preset = normalizeProfilePreset(entry);
      if (!preset) continue;
      if (globalPresets.some((existing) => existing.id === preset.id)) continue;
      globalPresets.push(preset);
      quickFlagById.set(
        preset.id,
        isRecord(entry) ? entry.showInQuickSwitcher !== false : true,
      );
    }
  }

  const tripleByPresetId = new Map<string, ModelTriple>(
    globalPresets.map((preset) => [
      preset.id,
      {
        backend: preset.backend,
        model: preset.model,
        thinkingEffort: preset.thinkingEffort,
      },
    ]),
  );

  const seededQuickPresetIds = globalPresets
    .filter((preset) => quickFlagById.get(preset.id) !== false)
    .map((preset) => preset.id);

  const migrated: ModelProfile[] = [];

  for (const entry of input.profiles) {
    if (!isRecord(entry) || Array.isArray(entry)) continue;
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string') {
      continue;
    }

    const storedRoles =
      isRecord(entry.roles) && !Array.isArray(entry.roles) ? entry.roles : {};
    const roles: Record<string, unknown> = {};

    for (const [role, binding] of Object.entries(storedRoles)) {
      if (!isModelRole(role)) {
        roles[role] = binding;
        continue;
      }
      if (isModelTriple(binding)) {
        roles[role] = {
          backend: binding.backend,
          model: binding.model,
          thinkingEffort: binding.thinkingEffort,
        };
        continue;
      }
      // Already-current shapes: a preset reference and an image binding are
      // both concrete, so the legacy preset-id lookup below must not eat them.
      if (isPresetRefBinding(binding)) {
        roles[role] = { presetId: binding.presetId };
        continue;
      }
      if (isImageModelBinding(binding)) {
        roles[role] = { imageModel: binding.imageModel };
        continue;
      }
      if (binding === INHERIT_BINDING) {
        roles[role] = INHERIT_BINDING;
        continue;
      }
      if (binding === OFF_BINDING) {
        roles[role] = role === 'agent' ? INHERIT_BINDING : OFF_BINDING;
        continue;
      }
      if (typeof binding !== 'string' || binding.length === 0) continue;
      // Legacy preset id: resolve to its triple, or drop the dead reference.
      const triple = tripleByPresetId.get(binding);
      if (triple) roles[role] = { ...triple };
    }

    const hasOwnPresets = Array.isArray(entry.presets);
    const presets = hasOwnPresets
      ? normalizeProfilePresets(entry.presets)
      : globalPresets.map((preset) => ({ ...preset }));
    const quickPresetIds = Array.isArray(entry.quickPresetIds)
      ? normalizeQuickPresetIds(entry.quickPresetIds, presets)
      : seededQuickPresetIds.filter((id) =>
          presets.some((preset) => preset.id === id),
        );

    migrated.push({
      id: entry.id,
      name: entry.name,
      presets,
      quickPresetIds,
      roles: roles as ModelProfile['roles'],
    });
  }

  if (isDeepEqual(migrated, input.profiles)) return null;
  return migrated;
}

export type LegacyModelSettingsInput = {
  /** `backends` */
  backends?: unknown;
  backendDefaultModels?: unknown;
  thinkingSettings?: unknown;
  summaryModels?: unknown;
  prReviewAgent?: unknown;
  agentMemory?: unknown;
  rateLimitSwap?: unknown;
  aiSkillSlots?: unknown;
  /** Already-migrated values, passed back in so the migration is idempotent. */
  backendModelPresets?: unknown;
  modelProfiles?: unknown;
  activeModelProfileId?: unknown;
  modelFallbackOrder?: unknown;
};

export type MigratedModelSettings = {
  profiles: ModelProfile[];
  activeModelProfileId: string | null;
  modelFallbackOrder: string[];
};

/**
 * Derives profiles / active profile / fallback order from the eight legacy
 * model settings keys (design §6, migration steps 1-5), in the Revision 1
 * shape: every role holds its own triple and every profile owns its presets.
 *
 * Deterministic and idempotent: profile ids are derived from their content,
 * presets already present are reused by `(backend, model, effort)` instead of
 * being duplicated, and profiles the user authored are preserved (and
 * themselves upgraded to Revision 1). The legacy keys are left untouched —
 * this only ADDS derived values.
 */
export function migrateLegacyModelSettingsToProfiles(
  legacy: LegacyModelSettingsInput,
): MigratedModelSettings {
  // --- existing presets (idempotency) ---
  const presets: ProfilePreset[] = [];
  const presetIdByTriple = new Map<string, string>();

  const knownPresets = [
    ...normalizeProfilePresets(legacy.backendModelPresets),
    // Revision 1 stores presets inside profiles; reuse those too so a re-run
    // keeps the user's own preset names instead of minting `legacy-*` ones.
    ...(Array.isArray(legacy.modelProfiles) ? legacy.modelProfiles : []).flatMap(
      (profile) =>
        isRecord(profile) ? normalizeProfilePresets(profile.presets) : [],
    ),
  ];

  for (const entry of knownPresets) {
    if (presets.some((existing) => existing.id === entry.id)) continue;
    presets.push(entry);
    const key = tripleKey(entry);
    if (!presetIdByTriple.has(key)) presetIdByTriple.set(key, entry.id);
  }

  function ensurePreset(triple: PresetTriple): string {
    const key = tripleKey(triple);
    const existing = presetIdByTriple.get(key);
    if (existing) return existing;

    const id = legacyPresetId(triple);
    presetIdByTriple.set(key, id);
    presets.push({
      id,
      name: legacyPresetName(triple),
      backend: triple.backend,
      model: triple.model,
      thinkingEffort: triple.thinkingEffort,
    });
    return id;
  }

  // --- legacy readers ---
  const backendsSetting = isRecord(legacy.backends) ? legacy.backends : {};
  const enabledBackends = Array.isArray(backendsSetting.enabledBackends)
    ? backendsSetting.enabledBackends.filter(isAgentBackend)
    : [];
  const agentBackend = isAgentBackend(backendsSetting.defaultBackend)
    ? backendsSetting.defaultBackend
    : (enabledBackends[0] ?? DEFAULT_MIGRATION_BACKEND);

  const defaultModels =
    isRecord(legacy.backendDefaultModels) &&
    isRecord(legacy.backendDefaultModels.models)
      ? legacy.backendDefaultModels.models
      : {};
  const efforts =
    isRecord(legacy.thinkingSettings) && isRecord(legacy.thinkingSettings.efforts)
      ? legacy.thinkingSettings.efforts
      : {};

  function modelForBackend(backend: AgentBackendType): string {
    const model = defaultModels[backend];
    return typeof model === 'string' && model.length > 0 ? model : 'default';
  }

  function effortFor(backend: AgentBackendType, model: string): ThinkingEffort {
    const backendEfforts = efforts[backend];
    if (!isRecord(backendEfforts)) return 'default';
    if (isThinkingEffort(backendEfforts[model])) {
      return backendEfforts[model];
    }
    return isThinkingEffort(backendEfforts.default)
      ? backendEfforts.default
      : 'default';
  }

  function tripleFor(
    backend: AgentBackendType,
    model?: string,
    thinkingEffort?: unknown,
  ): PresetTriple {
    const resolvedModel =
      typeof model === 'string' && model.length > 0
        ? model
        : modelForBackend(backend);
    return {
      backend,
      model: resolvedModel,
      thinkingEffort: isThinkingEffort(thinkingEffort)
        ? thinkingEffort
        : effortFor(backend, resolvedModel),
    };
  }

  // --- step 2: the "Default" profile ---
  const roles: Record<string, ModelTriple | typeof INHERIT_BINDING> = {};
  const agentTriple = tripleFor(agentBackend);
  ensurePreset(agentTriple);
  roles.agent = { ...agentTriple };

  function bindRole(role: ModelRole, triple: PresetTriple): void {
    if (role === 'agent' || roles[role]) return;
    ensurePreset(triple);
    roles[role] =
      tripleKey(triple) === tripleKey(agentTriple)
        ? INHERIT_BINDING
        : { ...triple };
  }

  const summaryModels =
    isRecord(legacy.summaryModels) && isRecord(legacy.summaryModels.models)
      ? legacy.summaryModels.models
      : {};
  const summaryModel = summaryModels[agentBackend];
  if (typeof summaryModel === 'string' && summaryModel.length > 0) {
    bindRole('summary', tripleFor(agentBackend, summaryModel));
  }

  if (isRecord(legacy.prReviewAgent)) {
    const prBackend = isAgentBackend(legacy.prReviewAgent.backend)
      ? legacy.prReviewAgent.backend
      : agentBackend;
    bindRole(
      'pr-review',
      tripleFor(
        prBackend,
        typeof legacy.prReviewAgent.modelPreference === 'string'
          ? legacy.prReviewAgent.modelPreference
          : undefined,
        legacy.prReviewAgent.thinkingEffort,
      ),
    );
  }

  if (isRecord(legacy.agentMemory)) {
    const memoryBackend = isAgentBackend(legacy.agentMemory.extractionBackend)
      ? legacy.agentMemory.extractionBackend
      : undefined;
    if (memoryBackend) {
      bindRole(
        'memory',
        tripleFor(
          memoryBackend,
          typeof legacy.agentMemory.extractionModel === 'string'
            ? legacy.agentMemory.extractionModel
            : undefined,
          legacy.agentMemory.extractionThinkingEffort,
        ),
      );
    }
  }

  if (isRecord(legacy.aiSkillSlots) && !Array.isArray(legacy.aiSkillSlots)) {
    for (const [slot, config] of Object.entries(legacy.aiSkillSlots)) {
      if (!isRecord(config)) continue;
      if (!isAgentBackend(config.backend)) continue;
      if (typeof config.model !== 'string' || config.model.length === 0) {
        continue;
      }
      bindRole(
        roleForSkillSlot(slot as AiSkillSlotKey),
        tripleFor(config.backend, config.model, config.thinkingEffort),
      );
    }
  }

  const generated: ModelProfile[] = [
    {
      id: 'legacy-default',
      name: 'Default',
      presets: [],
      quickPresetIds: [],
      roles: roles as ModelProfile['roles'],
    },
  ];

  // --- step 3: one profile per additional enabled backend ---
  for (const backend of enabledBackends) {
    if (backend === agentBackend) continue;
    const id = `legacy-backend-${slugify(backend)}`;
    if (generated.some((profile) => profile.id === id)) continue;
    const triple = tripleFor(backend);
    ensurePreset(triple);
    generated.push({
      id,
      name: BACKEND_LABELS[backend],
      presets: [],
      quickPresetIds: [],
      roles: { agent: { ...triple } },
    });
  }

  // --- step 5: fallback order from the old rate-limit swap chain ---
  const swapChain = legacyRateLimitSwapChain(legacy.rateLimitSwap);
  const modelFallbackOrder: string[] = [];

  for (const entry of swapChain) {
    if (!isRecord(entry) || !isAgentBackend(entry.backend)) continue;
    const triple = tripleFor(
      entry.backend,
      typeof entry.model === 'string' ? entry.model : undefined,
      entry.thinkingEffort,
    );
    ensurePreset(triple);
    let profile = generated.find((candidate) => {
      const binding = candidate.roles.agent;
      return isModelTriple(binding) && tripleKey(binding) === tripleKey(triple);
    });
    if (!profile) {
      profile = {
        id: `legacy-fallback-${slugify(triple.backend)}-${slugify(
          triple.model,
        )}-${slugify(triple.thinkingEffort)}`,
        name: `${BACKEND_LABELS[triple.backend]} fallback`,
        presets: [],
        quickPresetIds: [],
        roles: { agent: { ...triple } },
      };
      generated.push(profile);
    }
    if (!modelFallbackOrder.includes(profile.id)) {
      modelFallbackOrder.push(profile.id);
    }
  }

  // --- every generated profile owns the full derived preset list ---
  for (const profile of generated) {
    profile.presets = presets.map((preset) => ({ ...preset }));
    profile.quickPresetIds = presets.map((preset) => preset.id);
  }

  // --- merge with profiles the user already has, upgraded to Revision 1 ---
  const generatedIds = new Set(generated.map((profile) => profile.id));
  const storedProfiles = Array.isArray(legacy.modelProfiles)
    ? legacy.modelProfiles
    : [];
  const preserved = (
    migrateProfilePresetIdBindings({
      profiles: storedProfiles,
      presets: legacy.backendModelPresets,
    }) ?? (storedProfiles as ModelProfile[])
  ).filter((profile) => !generatedIds.has(profile.id));
  const profiles = [...preserved, ...generated];

  // --- step 4: active profile ---
  const activeModelProfileId =
    typeof legacy.activeModelProfileId === 'string' &&
    profiles.some((profile) => profile.id === legacy.activeModelProfileId)
      ? legacy.activeModelProfileId
      : 'legacy-default';

  return { profiles, activeModelProfileId, modelFallbackOrder };
}

function normalizeSettingValue<K extends keyof AppSettings>(
  key: K,
  value: unknown,
): AppSettings[K] | null {
  if (key === 'modelProfiles') {
    return normalizeModelProfilesSetting(value) as AppSettings[K];
  }
  if (key === 'workActivity') {
    return normalizeWorkActivitySetting(value) as AppSettings[K];
  }
  if (key === 'promptPreface') {
    return normalizePromptPrefaceSetting(value) as AppSettings[K];
  }
  return null;
}

async function writeSettingValue<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('settings')
    .values({ key, value: JSON.stringify(value), updatedAt: now })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        value: JSON.stringify(value),
        updatedAt: now,
      }),
    )
    .execute();
}

function parseAgentMemorySettingRow(
  row: { value: string } | undefined,
): AgentMemorySetting | null {
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as unknown;
    return SETTINGS_DEFINITIONS.agentMemory.validate(value) ? value : null;
  } catch {
    return null;
  }
}

async function persistMigratedAgentMemorySetting(
  migrated: AgentMemorySetting,
): Promise<AgentMemorySetting> {
  return db.transaction().execute(async (trx) => {
    const concurrent = await trx
      .selectFrom('settings')
      .where('key', '=', 'agentMemory')
      .selectAll()
      .executeTakeFirst();
    const concurrentValue = parseAgentMemorySettingRow(concurrent);
    if (concurrentValue) return concurrentValue;

    const now = new Date().toISOString();
    await trx
      .insertInto('settings')
      .values({
        key: 'agentMemory',
        value: JSON.stringify(migrated),
        updatedAt: now,
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
    const persisted = await trx
      .selectFrom('settings')
      .where('key', '=', 'agentMemory')
      .selectAll()
      .executeTakeFirst();
    return parseAgentMemorySettingRow(persisted) ?? migrated;
  });
}

function migrateTaskEventNotificationsSetting(
  value: unknown,
): TaskEventNotificationsSetting | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const obj = value as Record<string, unknown>;
  if (obj.modes && typeof obj.modes === 'object') {
    return null;
  }

  if (
    !('mode' in obj) ||
    !('enabled' in obj) ||
    typeof obj.enabled !== 'object' ||
    obj.enabled === null
  ) {
    return null;
  }

  const enabled = obj.enabled as Record<string, unknown>;
  const mode = obj.mode as TaskNotificationMode;
  const modes = Object.fromEntries(
    (
      Object.keys(DEFAULT_TASK_NOTIFICATION_MODES) as TaskNotificationEvent[]
    ).map((event) => [event, enabled[event] === false ? 'disabled' : mode]),
  ) as Record<TaskNotificationEvent, TaskNotificationMode>;

  return { modes };
}

function normalizeCalendarNotificationsSetting(
  value: unknown,
): CalendarNotificationsSetting | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const obj = value as Record<string, unknown>;
  return {
    ...obj,
    showStartWindow:
      typeof obj.showStartWindow === 'boolean' ? obj.showStartWindow : false,
    meetingJoinTarget:
      obj.meetingJoinTarget === 'web' || obj.meetingJoinTarget === 'app'
        ? obj.meetingJoinTarget
        : 'web',
  } as CalendarNotificationsSetting;
}


export const SettingsRepository = {
  async get<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
    const def = SETTINGS_DEFINITIONS[key];
    const row = await db
      .selectFrom('settings')
      .where('key', '=', key)
      .selectAll()
      .executeTakeFirst();

    if (!row && key === 'agentMemory') {
      const legacyRow = await db
        .selectFrom('settings')
        .where('key', '=', 'preferenceMemory')
        .selectAll()
        .executeTakeFirst();
      if (legacyRow) {
        try {
          const migrated = migrateLegacyMemorySettingToAgentMemory(
            JSON.parse(legacyRow.value),
          );
          if (migrated && def.validate(migrated)) {
            try {
              return (await persistMigratedAgentMemorySetting(
                migrated,
              )) as AppSettings[K];
            } catch (e) {
              dbg.db(
                'Failed to persist migrated Agent Memory setting: %O',
                e,
              );
            }
            return migrated as AppSettings[K];
          }
        } catch (e) {
          dbg.db(
            'Failed to migrate legacy Preference Memory setting: %O',
            e,
          );
        }
      }
    }

    if (!row) {
      return def.defaultValue as AppSettings[K];
    }

    try {
      const parsed = JSON.parse(row.value);
      if (key === 'taskEventNotifications') {
        const migrated = migrateTaskEventNotificationsSetting(parsed);
        if (migrated && def.validate(migrated)) {
          return migrated as AppSettings[K];
        }
      }
      if (key === 'calendarNotifications') {
        const normalized = normalizeCalendarNotificationsSetting(parsed);
        if (normalized && def.validate(normalized)) {
          return normalized as AppSettings[K];
        }
      }
      const normalized = normalizeSettingValue(key, parsed);
      if (normalized && def.validate(normalized)) {
        dbg.db('Normalized legacy value for setting "%s"', key);
        await writeSettingValue(key, normalized);
        return normalized;
      }
      if (def.validate(parsed)) {
        return parsed as AppSettings[K];
      }
      dbg.db('Invalid value for setting "%s", using default', key);
      return def.defaultValue as AppSettings[K];
    } catch (e) {
      dbg.db('Failed to parse setting "%s", using default: %O', key, e);
      return def.defaultValue as AppSettings[K];
    }
  },

  async set<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ): Promise<void> {
    if (!SETTINGS_DEFINITIONS[key].validate(value)) {
      throw new Error(`Invalid value for setting "${key}"`);
    }
    await writeSettingValue(key, value);
  },
};
