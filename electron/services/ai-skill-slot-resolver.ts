// AI skill slot resolution (design §2, "Skill slots and roles").
//
// Split of concerns, per the branch decision "AI generation backend should only
// be handled by the profile":
//
//   AI Generation   → which PROMPT (`skillName`) each feature uses
//   Model Profiles  → which MODEL each feature runs on
//
// So a slot is *configured* (and therefore enabled) by the project or the
// global `aiSkillSlots` setting, and that config supplies only `skillName`.
// The `(backend, model, thinkingEffort)` triple always comes from the model
// profile, through the role that backs the slot. Stored `backend` / `model` /
// `thinkingEffort` values on `AiSkillSlotConfig` are deliberately left in place
// but never read, which keeps the change reversible.
//
//   skillName:
//     project.aiSkillSlots[slot]        explicit per-project, wins
//     global aiSkillSlots[slot]         explicit per-slot
//     built-in slot default             e.g. DEFAULT_PROJECT_FEATURE_MAP_SLOT
//
//   backend / model / thinkingEffort:
//     profile.roles[roleForSkillSlot(slot)]  the named role
//     profile.roles['ai-generation']         catch-all when the role is unset
//     profile.roles['agent']                 via `inherit`

import {
  type AiSkillSlotConfig,
  type AiSkillSlotKey,
  type AiSkillSlotsSetting,
  DEFAULT_PROJECT_FEATURE_MAP_SLOT,
  isAiSkillSlotsSetting,
} from '@shared/types';
import {
  INHERIT_BINDING,
  type ModelRole,
  roleForSkillSlot,
} from '@shared/model-profiles';

import { SettingsRepository } from '../database/repositories/settings';

import { getModelProfileService } from './model-profile-service';

/**
 * The role a slot resolves through.
 *
 * A named role that the project's effective profile leaves unset (or
 * explicitly `inherit`) falls through to the `ai-generation` catch-all, which
 * in turn inherits from `agent`. A named role bound to a triple — or to `off`
 * — is used directly.
 *
 * This is a project-scoped decision, so it reads the *effective* profile (the
 * pinned one for a project whose policy pins a profile), not the globally
 * active one.
 */
async function effectiveRoleForSlot(
  slotKey: AiSkillSlotKey,
  { projectId }: { projectId?: string | null },
): Promise<ModelRole> {
  const role = roleForSkillSlot(slotKey);
  if (role === 'ai-generation') return role;

  const profile = await getModelProfileService().getEffectiveProfile({
    projectId: projectId ?? null,
  });
  const binding = profile?.roles?.[role];
  return binding && binding !== INHERIT_BINDING ? role : 'ai-generation';
}

/**
 * Pairs the configured slot's `skillName` with the model the project's
 * effective profile binds for this slot's role.
 *
 * Resolves `undefined` when the profile turns the role `off`.
 */
async function applyProfileModel(
  slot: AiSkillSlotConfig,
  {
    slotKey,
    projectId,
  }: {
    slotKey: AiSkillSlotKey;
    projectId?: string | null;
  },
): Promise<AiSkillSlotConfig | undefined> {
  const role = await effectiveRoleForSlot(slotKey, { projectId });
  const resolved = await getModelProfileService().resolveForRole({
    role,
    projectId: projectId ?? null,
  });
  if (resolved.off) return undefined;

  return {
    backend: resolved.backend,
    model: resolved.model,
    thinkingEffort: resolved.thinkingEffort,
    skillName: slot.skillName,
  };
}

/**
 * Resolves an AI skill slot configuration.
 *
 * Returns `undefined` when the feature is disabled: either no slot is
 * configured, or the effective profile binds its role to `off`.
 */
export async function resolveAiSkillSlot(
  slotKey: AiSkillSlotKey,
  projectSlots: AiSkillSlotsSetting | null | undefined,
  options: { projectId?: string | null } = {},
): Promise<AiSkillSlotConfig | undefined> {
  const projectId = options.projectId ?? null;

  // 1. Check project override (validate in case of corrupted data)
  if (projectSlots && isAiSkillSlotsSetting(projectSlots)) {
    const projectSlot = projectSlots[slotKey];
    if (projectSlot !== undefined) {
      return applyProfileModel(projectSlot, { slotKey, projectId });
    }
  }

  // 2. Check global setting (SettingsRepository.get already validates)
  const globalSlots = await SettingsRepository.get('aiSkillSlots');
  const globalSlot = globalSlots[slotKey];
  if (globalSlot !== undefined) {
    return applyProfileModel(globalSlot, { slotKey, projectId });
  }

  if (slotKey === 'project-feature-map') {
    return applyProfileModel(DEFAULT_PROJECT_FEATURE_MAP_SLOT, {
      slotKey,
      projectId,
    });
  }

  // 3. Not configured
  return undefined;
}
