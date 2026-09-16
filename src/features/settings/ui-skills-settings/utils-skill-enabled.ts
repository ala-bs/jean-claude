import type { ManagedSkill } from '@shared/skill-types';

/**
 * A skill counts as enabled when it is active on at least one backend.
 * This is the single source of truth for both the rail's dimmed styling and
 * the enabled-before-disabled ordering — keep them reading from here so the
 * two can never disagree.
 */
export function isSkillEnabled(
  skill: Pick<ManagedSkill, 'enabledBackends'>,
): boolean {
  return Object.values(skill.enabledBackends).some(Boolean);
}

/** Enabled skills first, disabled after. Stable within each half. */
export function sortEnabledFirst(skills: ManagedSkill[]): ManagedSkill[] {
  return [...skills].sort(
    (a, b) => Number(isSkillEnabled(b)) - Number(isSkillEnabled(a)),
  );
}
