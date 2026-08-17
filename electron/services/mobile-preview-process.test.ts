import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  commandExists,
  runBinaryCommand,
  runCommand,
  spawnManaged,
} from './mobile-preview-process';

const fs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

async function waitForFileContent(
  path: string,
  expected: string,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastContent = '';

  while (Date.now() < deadline) {
    try {
      lastContent = await fs.readFile(path, 'utf8');
      if (lastContent === expected) return lastContent;
    } catch {
      // File may not exist yet.
    }
    await sleep(10);
  }

  return lastContent || fs.readFile(path, 'utf8');
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await sleep(10);
  }

  throw new Error(`Process ${pid} did not exit`);
}

describe('mobile preview process helpers', () => {
  it('returns false when a command is missing', async () => {
    await expect(
      commandExists('jean-claude-command-that-does-not-exist'),
    ).resolves.toBe(false);
  });

  it('captures stdout', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      "process.stdout.write('preview-ready')",
    ]);

    expect(result.stdout).toBe('preview-ready');
    expect(result.stderr).toBe('');
  });

  it('writes stdin when input is provided', async () => {
    const result = await runCommand(
      process.execPath,
      [
        '-e',
        "process.stdin.on('data', (chunk) => process.stdout.write(chunk))",
      ],
      { input: 'no\n' },
    );

    expect(result.stdout).toBe('no\n');
  });

  it('rejects non-zero exits with stderr', async () => {
    await expect(
      runCommand(process.execPath, [
        '-e',
        "process.stderr.write('adapter failed'); process.exit(3)",
      ]),
    ).rejects.toThrow(/node.*adapter failed|adapter failed/s);
  });

  it('kills and rejects on timeout', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'mobile-preview-process-'));
    const pidPath = join(tempDir, 'pid');
    const readyPath = join(tempDir, 'ready');
    const termPath = join(tempDir, 'term');

    try {
      const commandPromise = runCommand(
        process.execPath,
        [
          '-e',
          [
            "const { writeFileSync } = require('fs');",
            'writeFileSync(process.env.PID_MARKER, String(process.pid));',
            "process.on('SIGTERM', () => {",
            "  writeFileSync(process.env.TERM_MARKER, 'sigterm');",
            '});',
            "writeFileSync(process.env.READY_MARKER, 'ready');",
            'setInterval(() => {}, 10_000);',
          ].join('\n'),
        ],
        {
          env: {
            ...process.env,
            PID_MARKER: pidPath,
            READY_MARKER: readyPath,
            TERM_MARKER: termPath,
          },
          timeoutMs: 1000,
        },
      );
      const rejection =
        expect(commandPromise).rejects.toThrow(/Command timed out/);

      await expect(waitForFileContent(readyPath, 'ready')).resolves.toBe('ready');
      await expect(waitForFileContent(termPath, 'sigterm')).resolves.toBe(
        'sigterm',
      );
      const pending = await Promise.race([
        commandPromise.then(
          () => false,
          () => false,
        ),
        sleep(25).then(() => true),
      ]);
      expect(pending).toBe(true);
      await rejection;
      const pid = Number(await fs.readFile(pidPath, 'utf8'));
      await waitForProcessExit(pid);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it('waits for runBinaryCommand to close before rejecting a timeout', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'mobile-preview-process-'));
    const readyPath = join(tempDir, 'binary-timeout-ready');
    const termPath = join(tempDir, 'binary-timeout-term');

    try {
      const commandPromise = runBinaryCommand(
        process.execPath,
        [
          '-e',
          [
            "const { writeFileSync } = require('fs');",
            "process.on('SIGTERM', () => {",
            "  writeFileSync(process.env.TERM_MARKER, 'sigterm');",
            '  setTimeout(() => process.exit(0), 100);',
            '});',
            "writeFileSync(process.env.READY_MARKER, 'ready');",
            'setInterval(() => {}, 10_000);',
          ].join('\n'),
        ],
        {
          env: {
            ...process.env,
            READY_MARKER: readyPath,
            TERM_MARKER: termPath,
          },
          timeoutMs: 50,
        },
      );
      let settled = false;
      void commandPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await expect(waitForFileContent(readyPath, 'ready')).resolves.toBe('ready');
      await expect(waitForFileContent(termPath, 'sigterm')).resolves.toBe(
        'sigterm',
      );

      expect(settled).toBe(false);
      await expect(commandPromise).rejects.toThrow(/Command timed out/);
      expect(settled).toBe(true);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it('terminates and rejects runCommand with AbortError on abort', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'mobile-preview-process-'));
    const pidPath = join(tempDir, 'abort-pid');
    const readyPath = join(tempDir, 'abort-ready');
    const termPath = join(tempDir, 'abort-term');
    const controller = new AbortController();

    try {
      const commandPromise = runCommand(
        process.execPath,
        [
          '-e',
          [
            "const { writeFileSync } = require('fs');",
            'writeFileSync(process.env.PID_MARKER, String(process.pid));',
            "process.on('SIGTERM', () => writeFileSync(process.env.TERM_MARKER, 'sigterm'));",
            "writeFileSync(process.env.READY_MARKER, 'ready');",
            'setInterval(() => {}, 10_000);',
          ].join('\n'),
        ],
        {
          env: {
            ...process.env,
            PID_MARKER: pidPath,
            READY_MARKER: readyPath,
            TERM_MARKER: termPath,
          },
          signal: controller.signal,
        },
      );
      const rejection = expect(commandPromise).rejects.toMatchObject({
        name: 'AbortError',
        message: expect.stringMatching(/Command aborted.*node/s),
      });
      await expect(waitForFileContent(readyPath, 'ready')).resolves.toBe('ready');

      controller.abort();

      await expect(waitForFileContent(termPath, 'sigterm')).resolves.toBe(
        'sigterm',
      );
      const pending = await Promise.race([
        commandPromise.then(
          () => false,
          () => false,
        ),
        sleep(25).then(() => true),
      ]);
      expect(pending).toBe(true);
      await rejection;
      const pid = Number(await fs.readFile(pidPath, 'utf8'));
      await waitForProcessExit(pid);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it('waits for runBinaryCommand to close before rejecting an abort', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'mobile-preview-process-'));
    const readyPath = join(tempDir, 'binary-abort-ready');
    const termPath = join(tempDir, 'binary-abort-term');
    const controller = new AbortController();

    try {
      const commandPromise = runBinaryCommand(
        process.execPath,
        [
          '-e',
          [
            "const { writeFileSync } = require('fs');",
            "process.on('SIGTERM', () => {",
            "  writeFileSync(process.env.TERM_MARKER, 'sigterm');",
            '  setTimeout(() => process.exit(0), 100);',
            '});',
            "writeFileSync(process.env.READY_MARKER, 'ready');",
            'setInterval(() => {}, 10_000);',
          ].join('\n'),
        ],
        {
          env: {
            ...process.env,
            READY_MARKER: readyPath,
            TERM_MARKER: termPath,
          },
          signal: controller.signal,
        },
      );
      let settled = false;
      void commandPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await expect(waitForFileContent(readyPath, 'ready')).resolves.toBe('ready');

      controller.abort();

      await expect(waitForFileContent(termPath, 'sigterm')).resolves.toBe(
        'sigterm',
      );
      expect(settled).toBe(false);
      await expect(commandPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(settled).toBe(true);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it('rejects runBinaryCommand with AbortError when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runBinaryCommand(process.execPath, ['-e', "process.stdout.write('late')"], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringMatching(/Command aborted.*node/s),
    });
  });

  it('managed stop is idempotent', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'mobile-preview-process-'));
    const readyPath = join(tempDir, 'managed-ready');

    try {
      const { child, stop } = spawnManaged(
        process.execPath,
        [
          '-e',
          [
            "const { writeFileSync } = require('fs');",
            "process.on('SIGTERM', () => {});",
            "writeFileSync(process.env.READY_MARKER, 'ready');",
            'setInterval(() => {}, 10_000);',
          ].join('\n'),
        ],
        {
          env: { ...process.env, READY_MARKER: readyPath },
        },
      );
      const closePromise = new Promise<{ signal: string | null }>((resolve) => {
        child.once('close', (_code, signal) => resolve({ signal }));
      });

      await expect(waitForFileContent(readyPath, 'ready')).resolves.toBe('ready');
      await Promise.all([stop(), stop()]);

      expect(child.killed).toBe(true);
      const { signal } = await closePromise;
      if (process.platform === 'win32') {
        expect(signal).toBeNull();
      } else {
        expect(signal).toBe('SIGKILL');
      }
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it('terminates a managed process when its signal aborts', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'mobile-preview-process-'));
    const readyPath = join(tempDir, 'managed-abort-ready');
    const controller = new AbortController();

    try {
      const { child } = spawnManaged(
        process.execPath,
        [
          '-e',
          [
            "const { writeFileSync } = require('fs');",
            "writeFileSync(process.env.READY_MARKER, 'ready');",
            'setInterval(() => {}, 10_000);',
          ].join('\n'),
        ],
        {
          env: { ...process.env, READY_MARKER: readyPath },
          signal: controller.signal,
        },
      );
      const closePromise = new Promise<void>((resolve) => {
        child.once('close', () => resolve());
      });
      await waitForFileContent(readyPath, 'ready');

      controller.abort();
      await closePromise;

      expect(child.killed).toBe(true);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });
});
