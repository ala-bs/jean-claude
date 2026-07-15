import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../database/repositories/project-commands', () => ({
  ProjectCommandRepository: {},
}));
vi.mock('../database/repositories/projects', () => ({
  ProjectRepository: {},
}));
vi.mock('../database/repositories/tasks', () => ({ TaskRepository: {} }));

import {
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
