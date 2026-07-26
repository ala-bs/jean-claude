import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project, Task, TaskStep } from '@shared/types';

const { emitTaskUpsert } = vi.hoisted(() => ({ emitTaskUpsert: vi.fn() }));

vi.mock('../database/repositories', () => ({
  ProjectRepository: { findById: vi.fn() },
  TaskRepository: { findById: vi.fn() },
}));
vi.mock('../database/repositories/task-steps', () => ({
  TaskStepRepository: { findById: vi.fn(), update: vi.fn() },
}));
vi.mock('./cache-event-service', () => ({
  emitStepUpsert: vi.fn(),
  emitTaskUpsert,
}));

import { createStepPermissionService } from './step-permission-service';

const task = { id: 'task-1', projectId: 'project-1' } as Task;
const project = { id: 'project-1', path: '/repo' } as Project;

afterEach(() => {
  expect(emitTaskUpsert).not.toHaveBeenCalled();
  emitTaskUpsert.mockClear();
});

function makeStep(id: string, sessionRules: TaskStep['sessionRules'] = {}): TaskStep {
  return {
    id,
    taskId: task.id,
    meta: {},
    sessionRules,
  } as TaskStep;
}

function setup(initialSteps: TaskStep[], parentTask: Task | null = task) {
  const steps = new Map(initialSteps.map((step) => [step.id, step]));
  const emitStep = vi.fn();
  const updateStep = vi.fn(async (stepId: string, update: Partial<TaskStep>) => {
    const updated = { ...steps.get(stepId)!, ...update };
    steps.set(stepId, updated);
    return updated;
  });
  const persisted = { project: false, worktree: false, global: false };
  const runPersisted = async <T>(
    scope: keyof typeof persisted,
    afterPersisted?: () => Promise<T>,
  ): Promise<T | false> => {
    persisted[scope] = true;
    try {
      return afterPersisted ? await afterPersisted() : false;
    } catch (error) {
      persisted[scope] = false;
      throw error;
    }
  };
  const addProjectPermission = vi.fn(
    async (params: { afterPersisted: () => Promise<TaskStep> }) =>
      runPersisted('project', params.afterPersisted),
  );
  const addWorktreePermission = vi.fn(
    async (
      _path: string,
      _tool: string,
      _input: Record<string, unknown>,
      afterPersisted: () => Promise<TaskStep>,
    ) => runPersisted('worktree', afterPersisted),
  );
  const addGlobalPermission = vi.fn(
    async (params: { afterPersisted: () => Promise<TaskStep> }) =>
      runPersisted('global', params.afterPersisted),
  );
  const queueSizes: number[] = [];
  const emitPermissionsChanged = vi.fn();
  const service = createStepPermissionService({
    findStep: vi.fn(async (stepId) => steps.get(stepId)),
    findTask: vi.fn(async (taskId) =>
      taskId === task.id ? (parentTask ?? undefined) : undefined,
    ),
    findProject: vi.fn(async () => project as never),
    updateStep,
    emitStep,
    emitPermissionsChanged,
    addProjectPermission,
    addWorktreePermission,
    addGlobalPermission,
    onQueueSizeChange: (size) => queueSizes.push(size),
  });
  return {
    service,
    steps,
    updateStep,
    emitStep,
    emitPermissionsChanged,
    addProjectPermission,
    addWorktreePermission,
    addGlobalPermission,
    persisted,
    queueSizes,
  };
}

describe('stepPermissionService', () => {
  it('mutates only requested step and emits step upsert', async () => {
    const sibling = makeStep('step-2', { write: 'allow' });
    const { service, steps, emitStep } = setup([makeStep('step-1'), sibling]);

    const updated = await service.addSessionAllowedTool({
      stepId: 'step-1',
      toolName: 'Bash',
      input: { command: 'pnpm test' },
    });

    expect(updated.sessionRules).toEqual({
      bash: { 'pnpm test': 'allow' },
    });
    expect(steps.get('step-2')).toBe(sibling);
    expect(emitStep).toHaveBeenCalledWith(updated);
  });

  it('removes one pattern without dropping unrelated rules', async () => {
    const { service } = setup([
      makeStep('step-1', {
        bash: { 'pnpm test': 'allow', 'pnpm lint': 'allow' },
        read: 'allow',
      }),
    ]);

    const updated = await service.removeSessionAllowedTool({
      stepId: 'step-1',
      toolName: 'bash',
      pattern: 'pnpm test',
    });

    expect(updated.sessionRules).toEqual({
      bash: { 'pnpm lint': 'allow' },
      read: 'allow',
    });
  });

  it.each([
    {
      name: 'project',
      run: (service: ReturnType<typeof createStepPermissionService>) =>
        service.allowForProject({
          stepId: 'step-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        }),
      persistentCall: 'addProjectPermission' as const,
    },
    {
      name: 'project worktrees',
      run: (service: ReturnType<typeof createStepPermissionService>) =>
        service.allowForProjectWorktrees({
          stepId: 'step-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        }),
      persistentCall: 'addWorktreePermission' as const,
    },
    {
      name: 'global',
      run: (service: ReturnType<typeof createStepPermissionService>) =>
        service.allowGlobally({
          stepId: 'step-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        }),
      persistentCall: 'addGlobalPermission' as const,
    },
  ])('updates $name settings and current step', async ({ run, persistentCall }) => {
    const context = setup([makeStep('step-1')]);

    const updated = await run(context.service);

    expect(context[persistentCall]).toHaveBeenCalledTimes(1);
    expect(context.updateStep).toHaveBeenCalledWith('step-1', {
      sessionRules: { bash: { 'pnpm test': 'allow' } },
    });
    expect(context.emitStep).toHaveBeenCalledWith(updated);
    expect(emitTaskUpsert).not.toHaveBeenCalled();
  });

  it('does not update step when worktree persistence rejects a rule', async () => {
    const context = setup([makeStep('step-1')]);
    context.addWorktreePermission.mockResolvedValueOnce(false);

    await expect(
      context.service.allowForProjectWorktrees({
        stepId: 'step-1',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      }),
    ).rejects.toThrow('Permission rule was rejected');

    expect(context.updateStep).not.toHaveBeenCalled();
    expect(context.emitStep).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'project',
      scope: 'project' as const,
      run: (service: ReturnType<typeof createStepPermissionService>) =>
        service.allowForProject({
          stepId: 'step-1',
          toolName: 'Read',
          input: {},
        }),
    },
    {
      name: 'project worktrees',
      scope: 'worktree' as const,
      run: (service: ReturnType<typeof createStepPermissionService>) =>
        service.allowForProjectWorktrees({
          stepId: 'step-1',
          toolName: 'Read',
          input: {},
        }),
    },
    {
      name: 'global',
      scope: 'global' as const,
      run: (service: ReturnType<typeof createStepPermissionService>) =>
        service.allowGlobally({
          stepId: 'step-1',
          toolName: 'Read',
          input: {},
        }),
    },
  ])('rolls back $name persistence when step update fails', async ({ run, scope }) => {
    const context = setup([makeStep('step-1')]);
    context.updateStep.mockRejectedValueOnce(new Error('step write failed'));

    await expect(run(context.service)).rejects.toThrow('step write failed');

    expect(context.persisted[scope]).toBe(false);
    expect(context.emitStep).not.toHaveBeenCalled();
  });

  it.each([
    ['project', 'addProjectPermission'],
    ['project worktrees', 'addWorktreePermission'],
    ['global', 'addGlobalPermission'],
  ] as const)('does not update step when %s persistence fails', async (_, key) => {
    const context = setup([makeStep('step-1')]);
    context[key].mockRejectedValueOnce(new Error('settings write failed'));
    const run =
      key === 'addProjectPermission'
        ? context.service.allowForProject
        : key === 'addWorktreePermission'
          ? context.service.allowForProjectWorktrees
          : context.service.allowGlobally;

    await expect(
      run({ stepId: 'step-1', toolName: 'Read', input: {} }),
    ).rejects.toThrow('settings write failed');
    expect(context.updateStep).not.toHaveBeenCalled();
  });

  it('rejects bare Bash before session or persistent writes', async () => {
    const context = setup([makeStep('step-1')]);

    for (const command of ['', '***', '?*', '*?', ' * ? ']) {
      await expect(
        context.service.addSessionAllowedTool({
          stepId: 'step-1',
          toolName: 'Bash',
          input: command ? { command } : {},
        }),
      ).rejects.toThrow('Bare "bash"');
    }
    await expect(
      context.service.allowGlobally({
        stepId: 'step-1',
        toolName: 'bash',
        input: { command: ' ** ' },
      }),
    ).rejects.toThrow('Bare "bash"');

    expect(context.updateStep).not.toHaveBeenCalled();
    expect(context.addGlobalPermission).not.toHaveBeenCalled();
  });

  it('ignores provider-reported bare Bash but keeps exact commands', async () => {
    const context = setup([makeStep('step-1')]);

    const updated = await context.service.syncSessionAllowedTools({
      stepId: 'step-1',
      tools: ['bash', 'bash:', 'bash:***', 'bash:?*', 'bash:pnpm test', 'bash:git *', 'read'],
    });

    expect(updated.sessionRules).toEqual({
      bash: { 'pnpm test': 'allow', 'git *': 'allow' },
      read: 'allow',
    });

    const bareOnly = setup([makeStep('step-2')]);
    await expect(
      bareOnly.service.syncSessionAllowedTools({
        stepId: 'step-2',
        tools: ['bash', 'bash:', 'bash:***', 'bash:?*', 'bash:*?', 'bash: * ? '],
      }),
    ).resolves.toBe(bareOnly.steps.get('step-2'));
    expect(bareOnly.updateStep).not.toHaveBeenCalled();
  });

  it('rejects missing parents and read-only PR review chat steps', async () => {
    const step = makeStep('step-1');
    step.meta = {
      kind: 'pr-review-chat',
      pullRequestId: 1,
      filePath: 'a.ts',
      lineStart: 1,
      selectedText: 'x',
    };
    const { service, updateStep } = setup([step]);

    await expect(
      service.allowGlobally({
        stepId: 'missing',
        toolName: 'Read',
        input: {},
      }),
    ).rejects.toThrow('Step missing not found');
    const orphan = setup([makeStep('orphan')], null);
    await expect(
      orphan.service.addSessionAllowedTool({
        stepId: 'orphan',
        toolName: 'Read',
        input: {},
      }),
    ).rejects.toThrow('Task task-1 not found');
    const mutations = [
      () =>
        service.addSessionAllowedTool({
          stepId: step.id,
          toolName: 'Read',
          input: {},
        }),
      () =>
        service.removeSessionAllowedTool({
          stepId: step.id,
          toolName: 'read',
        }),
      () =>
        service.allowForProject({
          stepId: step.id,
          toolName: 'Read',
          input: {},
        }),
      () =>
        service.allowForProjectWorktrees({
          stepId: step.id,
          toolName: 'Read',
          input: {},
        }),
      () =>
        service.allowGlobally({
          stepId: step.id,
          toolName: 'Read',
          input: {},
        }),
    ];
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toThrow('read-only');
    }
    await expect(
      service.syncSessionAllowedTools({ stepId: step.id, tools: ['read'] }),
    ).resolves.toBe(step);
    expect(updateStep).not.toHaveBeenCalled();
  });

  it('serializes concurrent updates for one step', async () => {
    const { service } = setup([makeStep('step-1')]);

    const [first, second] = await Promise.all([
      service.addSessionAllowedTool({
        stepId: 'step-1',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      }),
      service.addSessionAllowedTool({
        stepId: 'step-1',
        toolName: 'Bash',
        input: { command: 'pnpm lint' },
      }),
    ]);

    expect(first.sessionRules).toEqual({ bash: { 'pnpm test': 'allow' } });
    expect(second.sessionRules).toEqual({
      bash: { 'pnpm test': 'allow', 'pnpm lint': 'allow' },
    });
  });

  it('recovers queue after rejection', async () => {
    const readOnlyStep = makeStep('step-1');
    readOnlyStep.meta = {
      kind: 'pr-review-chat',
      pullRequestId: 1,
      filePath: 'a.ts',
      lineStart: 1,
      selectedText: 'x',
    };
    const { service, steps, queueSizes } = setup([readOnlyStep]);

    await expect(
      service.addSessionAllowedTool({
        stepId: 'step-1',
        toolName: 'Read',
        input: {},
      }),
    ).rejects.toThrow();
    steps.set('step-1', makeStep('step-1'));

    const updated = await service.addSessionAllowedTool({
      stepId: 'step-1',
      toolName: 'Read',
      input: {},
    });
    expect(updated.sessionRules).toEqual({ read: 'allow' });
    expect(queueSizes).toEqual([1, 0, 1, 0]);
  });
});

describe('session rule changes notify live agent sessions', () => {
  it.each([
    [
      'addSessionAllowedTool',
      (service: ReturnType<typeof setup>['service']) =>
        service.addSessionAllowedTool({
          stepId: 'step-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        }),
    ],
    [
      'allowForProject',
      (service: ReturnType<typeof setup>['service']) =>
        service.allowForProject({
          stepId: 'step-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        }),
    ],
    [
      'allowForProjectWorktrees',
      (service: ReturnType<typeof setup>['service']) =>
        service.allowForProjectWorktrees({
          stepId: 'step-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        }),
    ],
    [
      'allowGlobally',
      (service: ReturnType<typeof setup>['service']) =>
        service.allowGlobally({
          stepId: 'step-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        }),
    ],
    [
      'syncSessionAllowedTools',
      (service: ReturnType<typeof setup>['service']) =>
        service.syncSessionAllowedTools({
          stepId: 'step-1',
          tools: ['bash:pnpm test'],
        }),
    ],
  ])('emits a session-scoped permissions change from %s', async (_name, run) => {
    const { service, emitPermissionsChanged } = setup([makeStep('step-1')]);

    await run(service);

    expect(emitPermissionsChanged).toHaveBeenCalledWith({
      scope: 'session',
      stepId: 'step-1',
    });
  });

  it('emits a session-scoped permissions change when a rule is removed', async () => {
    const { service, emitPermissionsChanged } = setup([
      makeStep('step-1', { bash: { 'pnpm test': 'allow' } }),
    ]);

    await service.removeSessionAllowedTool({
      stepId: 'step-1',
      toolName: 'bash',
      pattern: 'pnpm test',
    });

    expect(emitPermissionsChanged).toHaveBeenCalledWith({
      scope: 'session',
      stepId: 'step-1',
    });
  });

  it('does not emit when a sync reports no usable tools', async () => {
    const { service, emitPermissionsChanged } = setup([makeStep('step-1')]);

    await service.syncSessionAllowedTools({ stepId: 'step-1', tools: ['bash'] });

    expect(emitPermissionsChanged).not.toHaveBeenCalled();
  });
});
