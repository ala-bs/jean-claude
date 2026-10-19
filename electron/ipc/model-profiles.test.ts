// IPC surface for model profiles and project model policy (design §3/§4).
//
// `handlers.ts` is a single 8k-line module that opens the database and talks to
// Electron at import time, so the suite stubs `better-sqlite3` and `electron`
// before importing it, then drives the captured `ipcMain.handle` callbacks
// directly. The model profile service itself is faked: what is under test is
// the wiring (does the handler call the service, does it invalidate the policy
// cache, does it broadcast), not the resolver.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedModel } from '@shared/model-profiles';

const sentMessages: Array<{ channel: string; payload: unknown }> = [];

vi.mock('better-sqlite3', () => ({
  default: class {
    pragma() {}
    prepare() {
      return { run: () => {}, get: () => undefined, all: () => [] };
    }
    exec() {}
    close() {}
  },
}));

vi.mock('electron', () => {
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: 1,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        sentMessages.push({ channel, payload });
      },
    },
  };
  return {
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: { getAllWindows: () => [window], fromWebContents: () => window },
    app: { getPath: () => '/tmp', on: vi.fn(), whenReady: () => Promise.resolve() },
    shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    clipboard: { writeText: vi.fn(), readText: () => '' },
    safeStorage: { isEncryptionAvailable: () => false },
    nativeTheme: { on: vi.fn() },
    net: { fetch: vi.fn() },
  };
});

const modelProfileService = {
  listProfiles: vi.fn(),
  listPresets: vi.fn(),
  getActiveProfile: vi.fn(),
  activateProfile: vi.fn(),
  clearProjectProfilePick: vi.fn(),
  getEffectivePolicy: vi.fn(),
  resolveForRole: vi.fn(),
  getFallbackOrder: vi.fn(),
  activateFallbackProfile: vi.fn(),
  invalidateProjectPolicyCache: vi.fn(),
};

vi.mock('../services/model-profile-service', () => ({
  getModelProfileService: () => modelProfileService,
  createModelProfileService: () => modelProfileService,
}));

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();

async function loadHandlers() {
  if (handlers.size > 0) return;
  const { ipcMain } = await import('electron');
  (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  );
  const { registerIpcHandlers } = await import('./handlers');
  registerIpcHandlers();
}

function invoke(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, ...args);
}

const profile = { id: 'codex-fallback', name: 'Codex fallback', roles: {} };

beforeEach(async () => {
  await loadHandlers();
  sentMessages.length = 0;
  for (const fn of Object.values(modelProfileService)) fn.mockReset();
});

describe('modelProfiles:activate', () => {
  it('persists the active profile and broadcasts the switch', async () => {
    modelProfileService.activateProfile.mockResolvedValue(profile);

    const result = await invoke('modelProfiles:activate', 'codex-fallback');

    expect(modelProfileService.activateProfile).toHaveBeenCalledWith({
      profileId: 'codex-fallback',
      projectId: null,
    });
    expect(result).toEqual(profile);
    expect(sentMessages).toContainEqual({
      channel: 'modelProfiles:activated',
      payload: { profile },
    });
  });

  it('does not broadcast when the profile does not exist', async () => {
    modelProfileService.activateProfile.mockRejectedValue(
      new Error('Unknown model profile: nope'),
    );

    await expect(invoke('modelProfiles:activate', 'nope')).rejects.toThrow(
      'Unknown model profile: nope',
    );
    expect(
      sentMessages.filter((m) => m.channel === 'modelProfiles:activated'),
    ).toHaveLength(0);
  });
});

describe('modelProfiles:resolve', () => {
  it('returns the blocked result produced under an enforce policy', async () => {
    const blocked: ResolvedModel = {
      backend: 'claude-code',
      model: 'default',
      thinkingEffort: 'default',
      source: 'policy',
      blocked: {
        reason: 'backend-not-allowed',
        message: 'This project only permits claude-code.',
        allowed: { backends: ['claude-code'] },
      },
    };
    modelProfileService.resolveForRole.mockResolvedValue(blocked);

    const result = await invoke('modelProfiles:resolve', {
      role: 'agent',
      projectId: 'project-1',
      override: null,
    });

    expect(modelProfileService.resolveForRole).toHaveBeenCalledWith({
      role: 'agent',
      projectId: 'project-1',
      override: null,
    });
    expect(result).toEqual(blocked);
  });
});

describe('projects:getEffectivePolicy', () => {
  it('returns the effective policy for the project', async () => {
    const effective = {
      policy: { mode: 'enforce' as const, allowedBackends: ['codex' as const] },
      source: 'file' as const,
      filePath: '/repo/.jean-claude/model-policy.json',
    };
    modelProfileService.getEffectivePolicy.mockResolvedValue(effective);

    const result = await invoke('projects:getEffectivePolicy', 'project-1');

    expect(modelProfileService.getEffectivePolicy).toHaveBeenCalledWith({
      projectId: 'project-1',
    });
    expect(result).toEqual(effective);
  });
});

describe('policy cache invalidation', () => {
  it('invalidates the cached policy when a project is updated', async () => {
    const { ProjectRepository } = await import('../database/repositories');
    vi.spyOn(ProjectRepository, 'update').mockResolvedValue({
      id: 'project-1',
      name: 'Repo',
      path: '/repo',
    } as never);

    await invoke('projects:update', 'project-1', { name: 'Repo' });

    expect(
      modelProfileService.invalidateProjectPolicyCache,
    ).toHaveBeenCalledWith({ projectId: 'project-1' });
  });

  it('invalidates the cached policy when a project is created', async () => {
    const { ProjectRepository } = await import('../database/repositories');
    vi.spyOn(ProjectRepository, 'create').mockResolvedValue({
      id: 'project-2',
      name: 'New',
      path: '/new',
    } as never);

    await invoke('projects:create', {
      name: 'New',
      path: '/new',
      mobilePreviewConfig: null,
    });

    expect(
      modelProfileService.invalidateProjectPolicyCache,
    ).toHaveBeenCalledWith({ projectId: 'project-2' });
  });

  it('invalidates the cached policy when the model policy is written', async () => {
    const { ProjectRepository } = await import('../database/repositories');
    vi.spyOn(ProjectRepository, 'setModelPolicy').mockResolvedValue({
      id: 'project-3',
      name: 'Policed',
      path: '/policed',
    } as never);

    await invoke('projects:setModelPolicy', 'project-3', { mode: 'enforce' });

    expect(ProjectRepository.setModelPolicy).toHaveBeenCalledWith('project-3', {
      mode: 'enforce',
    });
    expect(
      modelProfileService.invalidateProjectPolicyCache,
    ).toHaveBeenCalledWith({ projectId: 'project-3' });
    // A per-project profile pick only means "not the current default", so a
    // policy write must forget it — otherwise it shadows the new default.
    expect(
      modelProfileService.clearProjectProfilePick,
    ).toHaveBeenCalledWith({ projectId: 'project-3' });
  });
});
