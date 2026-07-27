import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findCommandById: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node-pty', () => ({ spawn: mocks.spawn }));
vi.mock('../database/repositories/project-commands', () => ({
  ProjectCommandRepository: { findById: mocks.findCommandById },
}));
vi.mock('../database/repositories/projects', () => ({
  ProjectRepository: { findById: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../database/repositories/tasks', () => ({
  TaskRepository: { findById: vi.fn().mockResolvedValue(undefined) },
}));

import {
  RunCommandService,
  runCommandService,
  signalProcessGroupOrProcess,
} from './run-command-service';

type TestRunCommandService = {
  runningProcesses: Map<
    string,
    Map<string, { status: 'running' | 'stopped' | 'errored' }>
  >;
};

const testService = runCommandService as unknown as TestRunCommandService;

function addRunningCommand(taskId: string, runCommandId: string): void {
  let commands = testService.runningProcesses.get(taskId);
  if (!commands) {
    commands = new Map();
    testService.runningProcesses.set(taskId, commands);
  }
  commands.set(runCommandId, { status: 'running' });
}

function removeCommand(taskId: string, runCommandId: string): void {
  const commands = testService.runningProcesses.get(taskId);
  commands?.delete(runCommandId);
  if (commands?.size === 0) testService.runningProcesses.delete(taskId);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('runCommandService.stopAllCommands', () => {
  beforeEach(() => {
    testService.runningProcesses.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testService.runningProcesses.clear();
  });

  it('rejects when a fulfilled stop leaves a command running', async () => {
    addRunningCommand('task-1', 'command-1');
    addRunningCommand('task-2', 'command-2');
    const stopCommand = vi
      .spyOn(runCommandService, 'stopCommand')
      .mockImplementation(async ({ taskId, runCommandId }) => {
        if (runCommandId === 'command-1') removeCommand(taskId, runCommandId);
        return true;
      });

    await expect(runCommandService.stopAllCommands()).rejects.toThrow(
      'Failed to stop all commands: 0 stop request(s) failed; 1 command(s) still running',
    );
    expect(stopCommand).toHaveBeenCalledTimes(2);
    expect(stopCommand).toHaveBeenCalledWith({
      taskId: 'task-1',
      runCommandId: 'command-1',
    });
    expect(stopCommand).toHaveBeenCalledWith({
      taskId: 'task-2',
      runCommandId: 'command-2',
    });
  });

  it('attempts every command before rejecting a stop failure', async () => {
    addRunningCommand('task-1', 'command-1');
    addRunningCommand('task-1', 'command-2');
    const stopCommand = vi
      .spyOn(runCommandService, 'stopCommand')
      .mockImplementation(async ({ taskId, runCommandId }) => {
        removeCommand(taskId, runCommandId);
        if (runCommandId === 'command-1') throw new Error('stop failed');
        return true;
      });

    await expect(runCommandService.stopAllCommands()).rejects.toThrow(
      'Failed to stop all commands: 1 stop request(s) failed; 0 command(s) still running',
    );
    expect(stopCommand).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['startCommandAdmitted', 'startCommand'],
    ['startGroupAdmitted', 'startGroup'],
  ] as const)(
    'drains an admitted %s operation before stopping its process',
    async (admittedMethod, publicMethod) => {
      const registration = createDeferred<void>();
      const internals = runCommandService as unknown as Record<
        string,
        (...args: never[]) => Promise<unknown>
      >;
      vi.spyOn(internals, admittedMethod).mockImplementation(async () => {
        await registration.promise;
        addRunningCommand('task-1', 'command-1');
        return { isRunning: true, commands: [] };
      });
      const stopCommand = vi
        .spyOn(runCommandService, 'stopCommand')
        .mockImplementation(async ({ taskId, runCommandId }) => {
          removeCommand(taskId, runCommandId);
          return true;
        });
      const startPromise =
        publicMethod === 'startCommand'
          ? runCommandService.startCommand({
              taskId: 'task-1',
              projectId: 'project-1',
              workingDir: '/tmp',
              runCommandId: 'command-1',
            })
          : runCommandService.startGroup({
              taskId: 'task-1',
              projectId: 'project-1',
              workingDir: '/tmp',
              runCommandIds: ['command-1'],
            });
      let stopSettled = false;
      const stopPromise = runCommandService.stopAllCommands().then(() => {
        stopSettled = true;
      });

      await Promise.resolve();
      expect(stopSettled).toBe(false);

      registration.resolve();
      await startPromise;
      await stopPromise;
      expect(stopCommand).toHaveBeenCalledWith({
        taskId: 'task-1',
        runCommandId: 'command-1',
      });
    },
  );

  it('rejects command and group starts while stopAll is active', async () => {
    addRunningCommand('task-1', 'command-1');
    const stopRelease = createDeferred<void>();
    vi.spyOn(runCommandService, 'stopCommand').mockImplementation(async () => {
      await stopRelease.promise;
      removeCommand('task-1', 'command-1');
      return true;
    });
    const stopPromise = runCommandService.stopAllCommands();

    await expect(
      runCommandService.startCommand({
        taskId: 'task-2',
        projectId: 'project-1',
        workingDir: '/tmp',
        runCommandId: 'command-2',
      }),
    ).rejects.toThrow('Cannot start commands while stopAll is active');
    await expect(
      runCommandService.startGroup({
        taskId: 'task-2',
        projectId: 'project-1',
        workingDir: '/tmp',
        runCommandIds: ['command-2'],
      }),
    ).rejects.toThrow('Cannot start commands while stopAll is active');

    stopRelease.resolve();
    await stopPromise;
  });

  it('shares concurrent stopAll operations', async () => {
    addRunningCommand('task-1', 'command-1');
    const stopRelease = createDeferred<void>();
    const stopCommand = vi
      .spyOn(runCommandService, 'stopCommand')
      .mockImplementation(async () => {
        await stopRelease.promise;
        removeCommand('task-1', 'command-1');
        return true;
      });

    const first = runCommandService.stopAllCommands();
    const second = runCommandService.stopAllCommands();
    await Promise.resolve();
    expect(stopCommand).toHaveBeenCalledOnce();

    stopRelease.resolve();
    await Promise.all([first, second]);
    expect(stopCommand).toHaveBeenCalledOnce();
  });
});

describe('run command process signaling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    testService.runningProcesses.clear();
  });

  it('falls back to the root PID when process-group signaling returns ESRCH', () => {
    const esrch = Object.assign(new Error('missing process group'), {
      code: 'ESRCH',
    });
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw esrch;
      })
      .mockReturnValueOnce(true);

    signalProcessGroupOrProcess(123, 'SIGTERM');

    expect(kill).toHaveBeenNthCalledWith(1, -123, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 123, 'SIGTERM');
  });

  it('rejects and retains tracking when process-group signaling returns EPERM', async () => {
    const eperm = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw eperm;
    });
    const commands = new Map([
      [
        'command-1',
        {
          commandId: 'command-1',
          name: null,
          command: 'pnpm dev',
          pty: {},
          pid: 123,
          status: 'running' as const,
          pendingLogBatches: { stdout: '', stderr: '' },
          logFlushTimer: null,
          logGeneration: 0,
          exited: false,
          exitPromise: new Promise(() => {}),
        },
      ],
    ]);
    (
      testService.runningProcesses as Map<string, Map<string, unknown>>
    ).set('task-1', commands);
    const stopCommandWithoutLock = (
      runCommandService as unknown as {
        stopCommandWithoutLock: (params: {
          taskId: string;
          runCommandId: string;
        }) => Promise<boolean>;
      }
    ).stopCommandWithoutLock.bind(runCommandService);

    await expect(
      stopCommandWithoutLock({ taskId: 'task-1', runCommandId: 'command-1' }),
    ).rejects.toBe(eperm);
    expect(commands.has('command-1')).toBe(true);
  });

  it('propagates EPERM from explicit command signals', () => {
    const eperm = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw eperm;
    });
    const commands = new Map([
      [
        'command-1',
        {
          commandId: 'command-1',
          name: null,
          command: 'pnpm dev',
          pty: {},
          pid: 123,
          status: 'running' as const,
          pendingLogBatches: { stdout: '', stderr: '' },
          logFlushTimer: null,
          logGeneration: 0,
          exited: false,
          exitPromise: new Promise(() => {}),
        },
      ],
    ]);
    (
      testService.runningProcesses as Map<string, Map<string, unknown>>
    ).set('task-1', commands);

    expect(() =>
      runCommandService.sendSignal({
        taskId: 'task-1',
        runCommandId: 'command-1',
        signal: 'SIGTERM',
      }),
    ).toThrow(eperm);
  });

  it('reports EPERM as both a stop failure and a running survivor', async () => {
    const eperm = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw eperm;
    });
    const commands = new Map([
      [
        'command-1',
        {
          commandId: 'command-1',
          name: null,
          command: 'pnpm dev',
          pty: {},
          pid: 123,
          status: 'running' as const,
          pendingLogBatches: { stdout: '', stderr: '' },
          logFlushTimer: null,
          logGeneration: 0,
          exited: false,
          exitPromise: new Promise(() => {}),
        },
      ],
    ]);
    (
      testService.runningProcesses as Map<string, Map<string, unknown>>
    ).set('task-1', commands);

    await expect(runCommandService.stopAllCommands()).rejects.toThrow(
      'Failed to stop all commands: 1 stop request(s) failed; 1 command(s) still running',
    );
    expect(commands.has('command-1')).toBe(true);
  });
});

function makeCommand(id: string, port: number) {
  return {
    id,
    projectId: 'project-1',
    name: id,
    command: `run ${id}`,
    ports: [port],
    portConflictStrategy: 'prompt' as const,
    portOverrideProvider: 'env' as const,
    portOverrideEnvVar: null,
    portOverrideArgs: null,
    envVars: [],
    confirmBeforeRun: false,
    confirmMessage: null,
    sortOrder: 0,
    createdAt: '2026-07-05T00:00:00.000Z',
  };
}

describe('RunCommandService start ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs afterStop after full stop and before port checks and spawn', async () => {
    const events: string[] = [];
    let onExit!: (event: { exitCode: number; signal: number }) => void;
    mocks.spawn
      .mockImplementationOnce(() => ({
        pid: 101,
        write: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn((callback) => {
          onExit = callback;
        }),
      }))
      .mockImplementationOnce(() => {
        events.push('spawn');
        return { pid: 102, write: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
      });
    mocks.findCommandById.mockResolvedValue(makeCommand('web', 3000));
    const service = new RunCommandService();
    vi.spyOn(service, 'checkPortInUse').mockImplementation(async () => {
      events.push('port-check');
      return null;
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      events.push('stop');
      onExit({ exitCode: 0, signal: 15 });
      return true;
    });

    try {
      const params = {
        taskId: 'task-1',
        projectId: 'project-1',
        workingDir: '/repo',
        runCommandId: 'web',
      };
      await service.startCommand(params);
      events.length = 0;
      await service.startCommand(params, {
        afterStop: () => {
          events.push('after-stop');
        },
      });
      expect(events).toEqual(['stop', 'after-stop', 'port-check', 'spawn']);
    } finally {
      kill.mockRestore();
    }
  });

  it('awaits group afterStop before checking ports or spawning', async () => {
    const afterStop = createDeferred<void>();
    const events: string[] = [];
    const exitCallbacks = new Map<
      number,
      (event: { exitCode: number; signal: number }) => void
    >();
    const commandByPid = new Map<number, string>();
    let nextPid = 200;
    mocks.findCommandById.mockImplementation(async (id: string) =>
      makeCommand(id, id === 'web' ? 3000 : 3001),
    );
    mocks.spawn.mockImplementation((_shell, args: string[]) => {
      const pid = nextPid++;
      commandByPid.set(pid, args[1].replace('run ', ''));
      events.push(`spawn:${args[1]}`);
      return {
        pid,
        write: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn((callback) => exitCallbacks.set(pid, callback)),
      };
    });
    const service = new RunCommandService();
    vi.spyOn(service, 'checkPortInUse').mockImplementation(async (port) => {
      events.push(`port:${port}`);
      return null;
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      const normalizedPid = Math.abs(pid);
      events.push(`stop:${commandByPid.get(normalizedPid)}`);
      exitCallbacks.get(normalizedPid)?.({ exitCode: 0, signal: 15 });
      return true;
    });

    try {
      const params = {
        taskId: 'task-1',
        projectId: 'project-1',
        workingDir: '/repo',
        runCommandIds: ['web', 'api'],
      };
      await service.startGroup(params);
      events.length = 0;
      const start = service.startGroup(params, {
        afterStop: async () => {
          events.push('after-stop:start');
          await afterStop.promise;
          events.push('after-stop:end');
        },
      });
      await vi.waitFor(() => expect(events).toContain('after-stop:start'));
      expect(events).toContain('stop:web');
      expect(events).toContain('stop:api');
      expect(events.at(-1)).toBe('after-stop:start');
      afterStop.resolve();
      await start;
      expect(events.slice(-5)).toEqual([
        'after-stop:end',
        'port:3000',
        'port:3001',
        'spawn:run web',
        'spawn:run api',
      ]);
    } finally {
      kill.mockRestore();
    }
  });

  it('blocks overlapping starts for group members but not unrelated commands', async () => {
    const groupAfterStop = createDeferred<void>();
    const events: string[] = [];
    let nextPid = 300;
    mocks.findCommandById.mockImplementation(async (id: string) =>
      makeCommand(id, id === 'web' ? 3000 : id === 'api' ? 3001 : 4000),
    );
    mocks.spawn.mockImplementation((_shell, args: string[]) => ({
      pid: nextPid++,
      write: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      ...(events.push(`spawn:${args[1]}`), {}),
    }));
    const service = new RunCommandService();
    vi.spyOn(service, 'checkPortInUse').mockImplementation(async (port) => {
      events.push(`port:${port}`);
      return null;
    });

    const groupStart = service.startGroup(
      {
        taskId: 'task-1',
        projectId: 'project-1',
        workingDir: '/repo',
        runCommandIds: ['web', 'api'],
      },
      {
        afterStop: () => {
          events.push('group:after-stop');
          return groupAfterStop.promise;
        },
      },
    );
    await vi.waitFor(() => expect(events).toContain('group:after-stop'));
    const overlapping = service.startCommand({
      taskId: 'task-1',
      projectId: 'project-1',
      workingDir: '/repo',
      runCommandId: 'api',
    });
    await service.startCommand({
      taskId: 'task-1',
      projectId: 'project-1',
      workingDir: '/repo',
      runCommandId: 'other',
    });
    expect(events).toContain('spawn:run other');
    expect(events).not.toContain('port:3001');
    groupAfterStop.resolve();
    await Promise.all([groupStart, overlapping]);
    expect(events.filter((event) => event === 'spawn:run api')).toHaveLength(2);
  });

  it('rejects a group when a command disappears during lookup', async () => {
    mocks.findCommandById.mockImplementation(async (id: string) =>
      id === 'api' ? undefined : makeCommand(id, 3000),
    );
    const service = new RunCommandService();
    await expect(
      service.startGroup({
        taskId: 'task-1',
        projectId: 'project-1',
        workingDir: '/repo',
        runCommandIds: ['web', 'api'],
      }),
    ).rejects.toThrow('api');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe('RunCommandService stopCommandsForTask', () => {
  it('returns false when any tracked command fails to stop', async () => {
    const service = new RunCommandService();
    const stop = vi
      .spyOn(service as never, 'stopCommandWithLock')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const runningProcesses = (service as unknown as {
      runningProcesses: Map<string, Map<string, unknown>>;
    }).runningProcesses;
    runningProcesses.set('task-1', new Map([['web', {}], ['api', {}]]));

    await expect(service.stopCommandsForTask('task-1')).resolves.toBe(false);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('returns false and keeps delayed PTY tracked after kill timeouts', async () => {
    const service = new RunCommandService();
    const runningProcesses = (service as unknown as {
      runningProcesses: Map<string, Map<string, unknown>>;
    }).runningProcesses;
    runningProcesses.set(
      'task-1',
      new Map([
        [
          'web',
          {
            commandId: 'web',
            name: 'Web',
            command: 'pnpm dev',
            pid: 101,
            pty: { write: vi.fn() },
            status: 'running',
            exitCode: null,
            signal: null,
            startedAt: Date.now(),
            stoppedAt: null,
            pendingLogBatches: { stdout: '', stderr: '' },
            logFlushTimer: null,
            logGeneration: 0,
            exited: false,
            exitPromise: new Promise<void>(() => {}),
          },
        ],
      ]),
    );
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      await expect(service.stopCommandsForTask('task-1')).resolves.toBe(false);
      expect(runningProcesses.get('task-1')?.has('web')).toBe(true);
    } finally {
      kill.mockRestore();
    }
  }, 10_000);
});

describe('runCommandService.resetTaskAfterReactivation', () => {
  beforeEach(() => {
    testService.runningProcesses.clear();
  });

  afterEach(() => {
    testService.runningProcesses.clear();
  });

  it('keeps live processes tracked when a task is reactivated without a stop', () => {
    addRunningCommand('task-1', 'command-1');

    runCommandService.resetTaskAfterReactivation('task-1');

    expect(testService.runningProcesses.get('task-1')?.has('command-1')).toBe(
      true,
    );
  });

  it('drops terminated processes and clears empty task entries', () => {
    addRunningCommand('task-1', 'command-1');
    testService.runningProcesses
      .get('task-1')
      ?.set('command-1', { status: 'stopped' });

    runCommandService.resetTaskAfterReactivation('task-1');

    expect(testService.runningProcesses.has('task-1')).toBe(false);
  });
});
