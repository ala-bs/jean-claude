import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiSkillSlotKey } from '@shared/types';

const {
  settingsGetMock,
  resolveForRoleMock,
  getEffectiveProfileMock,
  getActiveProfileMock,
} = vi.hoisted(() => ({
  settingsGetMock: vi.fn(),
  resolveForRoleMock: vi.fn(),
  getEffectiveProfileMock: vi.fn(),
  // A project-scoped decision must never read the globally active profile.
  getActiveProfileMock: vi.fn(() => {
    throw new Error('getActiveProfile is not project-scoped');
  }),
}));

vi.mock('../database/repositories/settings', () => ({
  SettingsRepository: {
    get: settingsGetMock,
  },
}));

vi.mock('./model-profile-service', () => ({
  getModelProfileService: () => ({
    resolveForRole: resolveForRoleMock,
    getEffectiveProfile: getEffectiveProfileMock,
    getActiveProfile: getActiveProfileMock,
  }),
}));

import { resolveAiSkillSlot } from './ai-skill-slot-resolver';

/** Every role bound, so a slot resolves through its own named role. */
const ALL_ROLES_BOUND = {
  id: 'profile-1',
  name: 'Profile',
  roles: {
    agent: 'preset-agent',
    'ai-generation': 'preset-ai-generation',
    'task-name': 'preset-task-name',
    'pr-description': 'preset-pr-description',
    'commit-message': 'preset-commit-message',
    'project-summary': 'preset-project-summary',
    'work-item-summary': 'preset-work-item-summary',
    'project-logo': 'preset-project-logo',
    'project-feature-map': 'preset-project-feature-map',
    'merge-commit-message': 'preset-merge-commit-message',
    'verification-note': 'preset-verification-note',
  },
};

/**
 * A configured slot carrying a stale `(backend, model, thinkingEffort)`.
 *
 * AI Generation no longer owns model choice — only the prompt (`skillName`) —
 * so these three fields must never reach the resolved slot, whether or not the
 * backend they name is still enabled.
 */
function staleModelSlot(skillName: string | null = 'some-skill') {
  return {
    backend: 'claude-code' as const,
    model: 'haiku',
    thinkingEffort: 'high' as const,
    skillName,
  };
}

describe('resolveAiSkillSlot', () => {
  beforeEach(() => {
    settingsGetMock.mockReset();
    resolveForRoleMock.mockReset();
    getEffectiveProfileMock.mockReset();

    // Only `aiSkillSlots` may be read: the slot's backend is no longer a
    // setting the resolver consults, so reading `backends` would throw.
    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'aiSkillSlots') {
        return Promise.resolve({});
      }
      throw new Error(`Unexpected setting key: ${key}`);
    });

    getEffectiveProfileMock.mockResolvedValue(ALL_ROLES_BOUND);
    resolveForRoleMock.mockResolvedValue({
      backend: 'opencode',
      model: 'openai/gpt-5.1-codex',
      thinkingEffort: 'default',
      source: 'profile',
    });
  });

  it.each([
    ['task-name', 'task-name'],
    ['pr-description', 'pr-description'],
    ['commit-message', 'commit-message'],
    ['project-summary', 'project-summary'],
    ['work-item-summary', 'work-item-summary'],
    ['logo-generation', 'project-logo'],
    ['project-feature-map', 'project-feature-map'],
    ['merge-commit-message', 'merge-commit-message'],
    ['verification-note', 'verification-note'],
  ] as [AiSkillSlotKey, string][])(
    'resolves the %s slot through the %s role',
    async (slotKey, role) => {
      const slot = await resolveAiSkillSlot(slotKey, {
        [slotKey]: staleModelSlot(),
      });

      expect(resolveForRoleMock).toHaveBeenCalledWith(
        expect.objectContaining({ role }),
      );
      expect(slot).toMatchObject({
        backend: 'opencode',
        model: 'openai/gpt-5.1-codex',
        thinkingEffort: 'default',
      });
    },
  );

  it('falls through a named role left unset to the ai-generation role', async () => {
    getEffectiveProfileMock.mockResolvedValue({
      id: 'profile-1',
      name: 'Profile',
      roles: { agent: 'preset-agent', 'ai-generation': 'preset-ai-generation' },
    });

    await resolveAiSkillSlot('task-name', {
      'task-name': staleModelSlot(),
    });

    expect(resolveForRoleMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ai-generation' }),
    );
  });

  it('falls through an inherited named role to the ai-generation role', async () => {
    getEffectiveProfileMock.mockResolvedValue({
      id: 'profile-1',
      name: 'Profile',
      roles: { agent: 'preset-agent', 'task-name': 'inherit' },
    });

    await resolveAiSkillSlot('task-name', {
      'task-name': staleModelSlot(),
    });

    expect(resolveForRoleMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ai-generation' }),
    );
  });

  it('disables the feature when the profile turns its role off', async () => {
    resolveForRoleMock.mockResolvedValue({
      backend: 'opencode',
      model: 'default',
      thinkingEffort: 'default',
      source: 'profile',
      off: true,
    });

    await expect(
      resolveAiSkillSlot('commit-message', {
        'commit-message': staleModelSlot(),
      }),
    ).resolves.toBeUndefined();
  });

  it('ignores the model stored on a project slot, even on an enabled backend', async () => {
    const slot = await resolveAiSkillSlot('pr-description', {
      'pr-description': {
        backend: 'opencode',
        model: 'anthropic/claude-sonnet-4-5',
        thinkingEffort: 'medium',
        skillName: 'shared-skill',
      },
    });

    expect(slot).toEqual({
      backend: 'opencode',
      model: 'openai/gpt-5.1-codex',
      thinkingEffort: 'default',
      skillName: 'shared-skill',
    });
    expect(resolveForRoleMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'pr-description' }),
    );
  });

  it('ignores the model stored on a global slot', async () => {
    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'aiSkillSlots') {
        return Promise.resolve({
          'task-name': {
            backend: 'opencode',
            model: 'anthropic/claude-sonnet-4-5',
            thinkingEffort: 'medium',
            skillName: 'task-name-generation',
          },
        });
      }
      throw new Error(`Unexpected setting key: ${key}`);
    });

    const slot = await resolveAiSkillSlot('task-name', null);

    expect(slot).toEqual({
      backend: 'opencode',
      model: 'openai/gpt-5.1-codex',
      thinkingEffort: 'default',
      skillName: 'task-name-generation',
    });
  });

  it('prefers the project slot skill over the global slot skill', async () => {
    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'aiSkillSlots') {
        return Promise.resolve({
          'task-name': staleModelSlot('global-skill'),
        });
      }
      throw new Error(`Unexpected setting key: ${key}`);
    });

    const slot = await resolveAiSkillSlot('task-name', {
      'task-name': staleModelSlot('project-skill'),
    });

    expect(slot?.skillName).toBe('project-skill');
  });

  it('falls back to the global slot skill when the project has no override', async () => {
    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'aiSkillSlots') {
        return Promise.resolve({
          'task-name': staleModelSlot('global-skill'),
        });
      }
      throw new Error(`Unexpected setting key: ${key}`);
    });

    const slot = await resolveAiSkillSlot('task-name', {
      'commit-message': staleModelSlot('unrelated-skill'),
    });

    expect(slot?.skillName).toBe('global-skill');
  });

  it('keeps the selected skill name on every slot', async () => {
    const slot = await resolveAiSkillSlot('commit-message', {
      'commit-message': staleModelSlot('my-commit-skill'),
    });

    expect(slot).toEqual({
      backend: 'opencode',
      model: 'openai/gpt-5.1-codex',
      thinkingEffort: 'default',
      skillName: 'my-commit-skill',
    });
  });

  it('keeps the selected work item summary skill', async () => {
    const slot = await resolveAiSkillSlot('work-item-summary', {
      'work-item-summary': staleModelSlot('work-item-summary'),
    });

    expect(slot).toEqual({
      backend: 'opencode',
      model: 'openai/gpt-5.1-codex',
      thinkingEffort: 'default',
      skillName: 'work-item-summary',
    });
  });

  it('keeps a global work item summary skill', async () => {
    settingsGetMock.mockImplementation((key: string) => {
      if (key === 'aiSkillSlots') {
        return Promise.resolve({
          'work-item-summary': staleModelSlot('work-item-summary'),
        });
      }
      throw new Error(`Unexpected setting key: ${key}`);
    });

    const slot = await resolveAiSkillSlot('work-item-summary', null);

    expect(slot).toEqual({
      backend: 'opencode',
      model: 'openai/gpt-5.1-codex',
      thinkingEffort: 'default',
      skillName: 'work-item-summary',
    });
  });

  it('keeps work item summaries disabled when no slot is configured', async () => {
    await expect(
      resolveAiSkillSlot('work-item-summary', null),
    ).resolves.toBeUndefined();
    expect(resolveForRoleMock).not.toHaveBeenCalled();
  });

  it('falls back the default project feature map slot but keeps its builtin skill', async () => {
    const slot = await resolveAiSkillSlot('project-feature-map', null);

    expect(slot).toEqual({
      backend: 'opencode',
      model: 'openai/gpt-5.1-codex',
      thinkingEffort: 'default',
      skillName: 'project-feature-mapping',
    });
    expect(resolveForRoleMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'project-feature-map' }),
    );
  });

  it('disables the default project feature map slot when its own role is off', async () => {
    resolveForRoleMock.mockResolvedValue({
      backend: 'opencode',
      model: 'default',
      thinkingEffort: 'default',
      source: 'profile',
      off: true,
    });

    await expect(
      resolveAiSkillSlot('project-feature-map', null),
    ).resolves.toBeUndefined();
    expect(resolveForRoleMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'project-feature-map' }),
    );
  });

  it('passes the project id so the project policy applies', async () => {
    await resolveAiSkillSlot(
      'commit-message',
      { 'commit-message': staleModelSlot() },
      { projectId: 'project-1' },
    );

    expect(resolveForRoleMock).toHaveBeenCalledWith({
      role: 'commit-message',
      projectId: 'project-1',
    });
  });

  it("uses the pinned profile's role binding for a pinned project", async () => {
    // The pinned profile binds `task-name`; the globally active one does not.
    getEffectiveProfileMock.mockImplementation(
      async ({ projectId }: { projectId?: string | null }) =>
        projectId === 'pinned-project'
          ? ALL_ROLES_BOUND
          : {
              id: 'global',
              name: 'Global',
              roles: {
                agent: 'preset-agent',
                'ai-generation': 'preset-ai-generation',
              },
            },
    );

    await resolveAiSkillSlot(
      'task-name',
      { 'task-name': staleModelSlot() },
      { projectId: 'pinned-project' },
    );

    expect(getEffectiveProfileMock).toHaveBeenCalledWith({
      projectId: 'pinned-project',
    });
    expect(resolveForRoleMock).toHaveBeenCalledWith({
      role: 'task-name',
      projectId: 'pinned-project',
    });
  });

  it("uses the active profile's role binding for an unpinned project", async () => {
    getEffectiveProfileMock.mockResolvedValue({
      id: 'global',
      name: 'Global',
      roles: { agent: 'preset-agent', 'ai-generation': 'preset-ai-generation' },
    });

    await resolveAiSkillSlot(
      'task-name',
      { 'task-name': staleModelSlot() },
      { projectId: 'unpinned-project' },
    );

    expect(resolveForRoleMock).toHaveBeenCalledWith({
      role: 'ai-generation',
      projectId: 'unpinned-project',
    });
  });
});
