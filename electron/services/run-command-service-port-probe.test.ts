import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'util';

const mocks = vi.hoisted(() => ({
  exec: vi.fn<(command: string) => Promise<{ stdout: string }>>(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  // `run-command-service` wraps `exec` in `promisify` at module load, so the
  // mock has to expose the promisify custom hook to keep the `{ stdout }` shape.
  const exec = (command: string) => mocks.exec(command);
  Object.defineProperty(exec, promisify.custom, {
    value: (command: string) => mocks.exec(command),
  });
  return { ...actual, exec };
});

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../database/repositories/project-commands', () => ({
  ProjectCommandRepository: { findById: vi.fn() },
}));
vi.mock('../database/repositories/projects', () => ({
  ProjectRepository: { findById: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../database/repositories/tasks', () => ({
  TaskRepository: { findById: vi.fn().mockResolvedValue(undefined) },
}));

import { RunCommandService } from './run-command-service';

/** Mimics what `exec` rejects with when our timeout kills the child. */
function timeoutError(): Error & { killed: boolean; signal: string } {
  return Object.assign(new Error('Command failed'), {
    killed: true,
    signal: 'SIGKILL',
  });
}

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('port probes', () => {
  let service: RunCommandService;

  beforeEach(() => {
    mocks.exec.mockReset();
    service = new RunCommandService();
  });

  it('probes with -nP so lsof skips DNS and service-name lookups', async () => {
    mocks.exec.mockResolvedValue({ stdout: '' });

    await service.checkPortInUse(3000);

    expect(mocks.exec).toHaveBeenCalledWith('lsof -nP -ti:3000');
  });

  it('reports the occupying process name and pid', async () => {
    mocks.exec.mockImplementation(async (command: string) =>
      command.startsWith('lsof')
        ? { stdout: '4242\n' }
        : { stdout: 'node\n' },
    );

    await expect(service.checkPortInUse(3000)).resolves.toBe('node (PID 4242)');
  });

  it('treats a timed-out probe as available instead of hanging the caller', async () => {
    mocks.exec.mockRejectedValue(timeoutError());

    await expect(service.checkPortInUse(3000)).resolves.toBeNull();
  });

  it('does not kill anything when the port lookup times out', async () => {
    mocks.exec.mockRejectedValue(timeoutError());

    await expect(service.killPort(3000)).resolves.toBeUndefined();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it('keeps port order stable when probes resolve out of order', async () => {
    const slowPort = 3000;
    mocks.exec.mockImplementation(async (command: string) => {
      if (command.includes(`:${slowPort}`)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { stdout: '11\n' };
      }
      if (command.startsWith('ps')) return { stdout: 'node\n' };
      return { stdout: '22\n' };
    });

    const getPortsInUse = (
      service as unknown as {
        getPortsInUse: (
          commands: { id: string; command: string; ports: number[] }[],
        ) => Promise<{ port: number }[]>;
      }
    ).getPortsInUse.bind(service);

    const portsInUse = await getPortsInUse([
      { id: 'web', command: 'pnpm dev', ports: [3000, 3001] },
    ]);

    expect(portsInUse.map((info) => info.port)).toEqual([3000, 3001]);
  });
});
