import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunCommandGroupAbortEvent } from '@shared/run-command-types';

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
  parseDevServerPortFromOutput,
  resolveEffectivePorts,
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

describe('parseDevServerPortFromOutput', () => {
  it('reads the port Metro reports', () => {
    expect(
      parseDevServerPortFromOutput('› Metro waiting on exp://192.168.1.159:8082'),
    ).toBe(8082);
    expect(
      parseDevServerPortFromOutput('Waiting on http://localhost:8083'),
    ).toBe(8083);
  });

  it('ignores output without a port', () => {
    expect(parseDevServerPortFromOutput('Starting Metro Bundler')).toBeNull();
    expect(parseDevServerPortFromOutput('')).toBeNull();
  });

  it('does not truncate an out-of-range port', () => {
    expect(
      parseDevServerPortFromOutput('Waiting on http://localhost:123456'),
    ).toBeNull();
  });

  it('ignores unrelated localhost URLs', () => {
    expect(
      parseDevServerPortFromOutput('Connected to postgres http://localhost:5432'),
    ).toBeNull();
    expect(
      parseDevServerPortFromOutput('API base url http://localhost:3000'),
    ).toBeNull();
  });
});

describe('parseDevServerPortFromOutput (dev server banners)', () => {
  it('reads the port from a dev-client banner with a percent-encoded url', () => {
    expect(
      parseDevServerPortFromOutput(
        '› Metro waiting on exp+falbala://expo-development-client/?url=http%3A%2F%2F192.168.1.159%3A8085',
      ),
    ).toBe(8085);
  });

  it('reads the port through ANSI styling', () => {
    expect(
      parseDevServerPortFromOutput(
        '\u001b[32m›\u001b[39m Metro waiting on \u001b[1mexp://192.168.1.159:8086\u001b[22m',
      ),
    ).toBe(8086);
  });
});

describe('resolveEffectivePorts', () => {
  it('prefers the port injected into the rewritten command', () => {
    expect(
      resolveEffectivePorts({
        declaredPorts: [8081],
        commandOverride: 'npx expo start --dev-client --port 8090',
      }),
    ).toEqual([8090]);
  });

  it('prefers the declared port env override for the command port var', () => {
    expect(
      resolveEffectivePorts({
        declaredPorts: [8081],
        envOverrides: { PORT: '8091', OTHER_ID: '4242' },
        portEnvVarName: 'PORT',
      }),
    ).toEqual([8091]);
  });

  it('ignores unrelated env values and falls back to declared ports', () => {
    expect(
      resolveEffectivePorts({
        declaredPorts: [8081],
        envOverrides: { SOME_NUMERIC_ID: '4242' },
        portEnvVarName: 'PORT',
      }),
    ).toEqual([8081]);
  });

  it('uses the allocated port when custom args hide it from the command text', () => {
    expect(
      resolveEffectivePorts({
        declaredPorts: [3000],
        // `portOverrideArgs: '-p {PORT}'` produces no `--port <n>` to parse.
        commandOverride: 'pnpm dev -p 3007',
        allocatedPort: 3007,
      }),
    ).toEqual([3007]);
  });

  it('wins over the env override and the rewritten command text', () => {
    // All three are derived from the same allocation, but the allocated port is
    // the source of truth: it survives args formats the regex cannot parse.
    expect(
      resolveEffectivePorts({
        declaredPorts: [3000],
        allocatedPort: 3007,
        envOverrides: { PORT: '4000' },
        portEnvVarName: 'PORT',
      }),
    ).toEqual([3007]);
    expect(
      resolveEffectivePorts({
        declaredPorts: [3000],
        allocatedPort: 3007,
        commandOverride: 'pnpm dev --port 4000',
      }),
    ).toEqual([3007]);
  });

  it.each([99_999, 0, -1, 3007.5])(
    'ignores the invalid allocated port %s',
    (allocatedPort) => {
      expect(
        resolveEffectivePorts({ declaredPorts: [3000], allocatedPort }),
      ).toEqual([3000]);
    },
  );
});

describe('runCommandService staged group runs', () => {
  type FakePty = {
    pid: number;
    onData: (listener: (data: string) => void) => void;
    onExit: (
      listener: (event: { exitCode: number; signal?: number }) => void,
    ) => void;
    write: () => void;
    kill: () => void;
    resize: () => void;
    exit: (exitCode: number) => void;
  };

  let spawned: Array<{ command: string; pty: FakePty }>;
  let nextPid: number;
  let patchedInternals: Record<string, unknown>;
  // startGroup resolves once the first stage is up; the rest of the sequence
  // continues in the background, so tests need a handle on it.
  let sequences: Array<Promise<unknown>>;
  const sequenceSettled = async () => {
    await Promise.allSettled(sequences);
  };
  /** Commands that were actually torn down while live. */
  let stoppedCommandIds: string[];

  function makeCommand(id: string) {
    return {
      id,
      projectId: 'project-1',
      name: id,
      command: `run ${id}`,
      ports: [],
      portConflictStrategy: 'prompt' as const,
      portOverrideProvider: 'env' as const,
      portOverrideEnvVar: null,
      portOverrideArgs: null,
      envVars: [],
      confirmBeforeRun: false,
      confirmMessage: null,
      isFavorite: false,
      isHidden: false,
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  function stage(
    id: string,
    entries: Array<[string, boolean]>,
    delayMs = 0,
  ) {
    return {
      id,
      delayMs,
      entries: entries.map(([commandId, waitForExit]) => ({
        commandId,
        waitForExit,
      })),
    };
  }

  function ptyFor(commandId: string): FakePty {
    const match = spawned.find((entry) =>
      entry.command.includes(`run ${commandId}`),
    );
    if (!match) throw new Error(`No spawned process for ${commandId}`);
    return match.pty;
  }

  const startParams = {
    taskId: 'task-1',
    projectId: 'project-1',
    workingDir: '/tmp/worktree',
  };

  beforeEach(() => {
    spawned = [];
    sequences = [];
    stoppedCommandIds = [];
    nextPid = 1000;
    testService.runningProcesses.clear();
    mocks.findCommandById.mockImplementation(async (id: string) =>
      makeCommand(id),
    );

    mocks.spawn.mockImplementation((_shell: string, args: string[]) => {
      let exitListener: (event: { exitCode: number; signal?: number }) => void =
        () => {};
      const pty: FakePty = {
        pid: nextPid++,
        onData: () => {},
        onExit: (listener) => {
          exitListener = listener;
        },
        write: () => {},
        kill: () => {},
        resize: () => {},
        exit: (exitCode: number) => exitListener({ exitCode, signal: 0 }),
      };
      spawned.push({ command: args[args.length - 1], pty });
      return pty;
    });

    // Bypass the network/database work around spawning so the tests exercise
    // only the staging logic. Saved and restored so the shared singleton is not
    // permanently mutated for later suites.
    const internals = runCommandService as unknown as Record<string, unknown>;
    patchedInternals = {
      getPortsInUse: internals.getPortsInUse,
      getPortOverrides: internals.getPortOverrides,
      getRunCommandContext: internals.getRunCommandContext,
      getCommandEnv: internals.getCommandEnv,
      stopCommandWithoutLock: internals.stopCommandWithoutLock,
      trackPendingSequence: internals.trackPendingSequence,
    };
    const realTrack = internals.trackPendingSequence as (
      sequence: Promise<unknown>,
    ) => void;
    internals.trackPendingSequence = (sequence: Promise<unknown>) => {
      sequences.push(sequence);
      realTrack.call(runCommandService, sequence);
    };

    // Record only teardowns of a live process, which is the signal that a
    // later stage really restarted an earlier stage's command.
    const realStopWithoutLock = internals.stopCommandWithoutLock as (
      args: unknown,
    ) => Promise<boolean>;
    internals.stopCommandWithoutLock = async (args: unknown) => {
      const { runCommandId } = args as { runCommandId: string };
      const tracked = testService.runningProcesses
        .get('task-1')
        ?.get(runCommandId);
      if (tracked?.status === 'running') stoppedCommandIds.push(runCommandId);
      return realStopWithoutLock.call(runCommandService, args);
    };
    internals.getPortsInUse = async () => [];
    internals.getPortOverrides = async () => new Map();
    internals.getRunCommandContext = async () => ({});
    internals.getCommandEnv = async () => ({});
  });

  afterEach(() => {
    const internals = runCommandService as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patchedInternals)) {
      internals[key] = value;
    }
    vi.restoreAllMocks();
    testService.runningProcesses.clear();
  });

  it('runs stages in order, blocking on wait-for-exit commands', async () => {
    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['migrate', 'server'],
      stages: [stage('s1', [['migrate', true]]), stage('s2', [['server', false]])],
    });

    // Stage 2 must not start until the blocking command in stage 1 exits.
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    expect(spawned[0].command).toContain('run migrate');

    ptyFor('migrate').exit(0);

    await run;
    await sequenceSettled();
    expect(spawned.map((entry) => entry.command)).toEqual([
      expect.stringContaining('run migrate'),
      expect.stringContaining('run server'),
    ]);
  });

  it('starts commands in the same stage together', async () => {
    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['slow', 'sibling'],
      // `slow` blocks the stage, but `sibling` must already have been spawned
      // alongside it rather than waiting its turn.
      stages: [stage('s1', [['slow', true], ['sibling', false]])],
    });

    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    ptyFor('slow').exit(0);
    await run;
  });

  it('does not wait for commands without waitForExit', async () => {
    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['server', 'web'],
      stages: [stage('s1', [['server', false]]), stage('s2', [['web', false]])],
    });

    // Neither process ever exits, yet the run completes.
    await run;
    await sequenceSettled();
    expect(spawned).toHaveLength(2);
  });

  it('aborts later stages when a blocking command fails', async () => {
    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['lint', 'deploy'],
      stages: [stage('s1', [['lint', true]]), stage('s2', [['deploy', false]])],
    });

    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    ptyFor('lint').exit(1);

    await run;
    await sequenceSettled();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toContain('run lint');
  });

  it('leaves already-started commands running after an aborted stage', async () => {
    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['server', 'check', 'deploy'],
      stages: [
        stage('s1', [['server', false]]),
        stage('s2', [['check', true]]),
        stage('s3', [['deploy', false]]),
      ],
    });

    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    ptyFor('check').exit(2);

    await run;
    await sequenceSettled();
    expect(spawned).toHaveLength(2);
    expect(
      testService.runningProcesses.get('task-1')?.get('server')?.status,
    ).toBe('running');
  });

  it('treats a missing stage plan as one all-at-once stage', async () => {
    await runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['web', 'api'],
    });

    expect(spawned).toHaveLength(2);
  });

  it('skips hidden members instead of failing the group', async () => {
    mocks.findCommandById.mockImplementation(async (id: string) => ({
      ...makeCommand(id),
      isHidden: id === 'hidden',
    }));

    await runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['web', 'hidden'],
      stages: [stage('s1', [['web', false], ['hidden', false]])],
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toContain('run web');
  });

  it('waits the configured delay between stages', async () => {
    vi.useFakeTimers();
    try {
      const run = runCommandService.startGroup({
        ...startParams,
        runCommandIds: ['first', 'second'],
        stages: [
          stage('s1', [['first', false]], 5000),
          stage('s2', [['second', false]]),
        ],
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(spawned).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(4999);
      expect(spawned).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await run;
      await sequenceSettled();
      expect(spawned).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not delay after the final stage', async () => {
    vi.useFakeTimers();
    try {
      const run = runCommandService.startGroup({
        ...startParams,
        runCommandIds: ['only'],
        stages: [stage('s1', [['only', false]], 600000)],
      });

      // Resolves without the timer ever firing.
      await run;
      await sequenceSettled();
      expect(spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts a command that appears again in a later stage', async () => {
    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['build'],
      // Stage 1 leaves it running, so stage 2 must stop and respawn it.
      stages: [stage('s1', [['build', false]]), stage('s2', [['build', true]])],
    });

    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    spawned[1].pty.exit(0);

    await run;
    await sequenceSettled();
    expect(spawned).toHaveLength(2);
    // The first instance must have been stopped, not merely overwritten.
    expect(stoppedCommandIds).toContain('build');
  });

  it('aborts instead of orphaning a command it could not restart', async () => {
    // A process that survives every kill leaves stopCommandWithoutLock false.
    // Spawning over it would strand an untracked, unkillable process holding
    // its ports, so the sequence must stop instead.
    const internals = runCommandService as unknown as Record<string, unknown>;
    const realStop = internals.stopCommandWithoutLock as (
      args: unknown,
    ) => Promise<boolean>;
    // Refuse only for a process that is actually alive: the group prologue
    // also stops members, and must still succeed there.
    internals.stopCommandWithoutLock = async (args: unknown) => {
      const { runCommandId } = args as { runCommandId: string };
      const tracked = testService.runningProcesses
        .get('task-1')
        ?.get(runCommandId);
      if (tracked?.status === 'running') return false;
      return realStop.call(runCommandService, args);
    };

    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['build', 'after'],
      stages: [
        stage('s1', [['build', false]]),
        stage('s2', [['build', true]]),
        stage('s3', [['after', false]]),
      ],
    });

    await run;
    await sequenceSettled();
    // No duplicate 'build', and the sequence stopped rather than continuing.
    expect(spawned).toHaveLength(1);
  });

  it('honors a stop that lands while the group is still starting up', async () => {
    // Cancellation must be registered before the locks are taken, otherwise a
    // stop arriving during the prologue finds nothing to cancel and then
    // queues behind the whole sequence.
    const internals = runCommandService as unknown as Record<string, unknown>;
    const releasePrologue = createDeferred<void>();
    internals.getRunCommandContext = async () => {
      await releasePrologue.promise;
      return {};
    };

    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['web'],
      stages: [stage('s1', [['web', false]])],
    });

    await Promise.resolve();
    void runCommandService.stopCommand({
      taskId: 'task-1',
      runCommandId: 'web',
    });
    releasePrologue.resolve();

    await run;
    await sequenceSettled();
    expect(spawned).toHaveLength(0);
  });

  it('reports an aborted sequence so the renderer can surface it', async () => {
    const aborts: RunCommandGroupAbortEvent[] = [];
    const unsubscribe = runCommandService.onGroupAbort((event) =>
      aborts.push(event),
    );

    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['lint', 'build', 'deploy'],
      stages: [
        stage('s1', [['lint', true]]),
        stage('s2', [['build', false]]),
        stage('s3', [['deploy', false]]),
      ],
    });

    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    ptyFor('lint').exit(1);

    await run;
    await sequenceSettled();
    unsubscribe();

    expect(aborts).toEqual([
      {
        taskId: 'task-1',
        skippedStageCount: 2,
        reason: { type: 'commandFailed', commandName: 'lint', exitCode: 1 },
      },
    ]);
  });

  it('does not report an abort when the user stopped the run', async () => {
    // A stopped process usually exits non-zero; that must not be mistaken for
    // a stage failure and toasted at the user who asked for the stop.
    const aborts: RunCommandGroupAbortEvent[] = [];
    const unsubscribe = runCommandService.onGroupAbort((event) =>
      aborts.push(event),
    );

    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['slow', 'next'],
      stages: [stage('s1', [['slow', true]]), stage('s2', [['next', false]])],
    });

    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const stop = runCommandService.stopCommand({
      taskId: 'task-1',
      runCommandId: 'slow',
    });
    ptyFor('slow').exit(143);

    await run;
    await sequenceSettled();
    await stop;
    unsubscribe();

    expect(aborts).toEqual([]);
  });

  it('acknowledges the start once the first stage is up, not when the sequence ends', async () => {
    // Callers await this while holding locks of their own (the PR lifecycle
    // lock, the renderer's "starting" state), and a sequence is unbounded:
    // a waited command that never exits would pin them forever.
    let settled = false;
    const run = runCommandService
      .startGroup({
        ...startParams,
        runCommandIds: ['server', 'never'],
        stages: [
          stage('s1', [['server', false]]),
          stage('s2', [['never', true]]),
        ],
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await run;
    expect(settled).toBe(true);
    // Stage 2 is still running and will never finish on its own.
    expect(spawned).toHaveLength(2);

    await runCommandService.stopCommandsForTask('task-1');
    await sequenceSettled();
  });

  it('stops a staged run when a stop request cancels it', async () => {
    const run = runCommandService.startGroup({
      ...startParams,
      runCommandIds: ['slow', 'never'],
      stages: [stage('s1', [['slow', true]]), stage('s2', [['never', false]])],
    });

    await vi.waitFor(() => expect(spawned).toHaveLength(1));

    // A stop must interrupt the sequence rather than queue behind the locks
    // it holds for the whole run.
    const stop = runCommandService.stopCommand({
      taskId: 'task-1',
      runCommandId: 'slow',
    });

    await run;
    await sequenceSettled();
    expect(spawned).toHaveLength(1);
    ptyFor('slow').exit(0);
    await stop;
  });
});
