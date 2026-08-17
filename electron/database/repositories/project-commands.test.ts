import { describe, expect, it, vi } from 'vitest';

vi.mock('../index', () => ({ db: {} }));
vi.mock('./project-command-groups', () => ({
  ProjectCommandGroupRepository: { removeCommandFromAllGroups: vi.fn() },
}));

import { ProjectCommandRepository } from './project-commands';

const baseCommand = {
  projectId: 'project-1',
  name: null,
  command: 'pnpm start',
  ports: [8081, 8082],
  portConflictStrategy: 'use-available-port' as const,
  portOverrideProvider: 'args' as const,
  portOverrideEnvVar: null,
  portOverrideArgs: null,
  envVars: [],
  confirmBeforeRun: false,
  confirmMessage: null,
};

describe('project command port override persistence', () => {
  it('rejects invalid available-port override creation before database access', async () => {
    await expect(ProjectCommandRepository.create(baseCommand)).rejects.toThrow(
      'Available-port override requires exactly one requested port; command has 2',
    );
  });

  it('rejects an invalid complete port override update before database access', async () => {
    await expect(
      ProjectCommandRepository.update('command-1', {
        ports: [8081, 8082],
        portConflictStrategy: 'use-available-port',
      }),
    ).rejects.toThrow(
      'Available-port override requires exactly one requested port; command command-1 has 2',
    );
  });
});
