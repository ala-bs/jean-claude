import { afterEach, describe, expect, it } from 'vitest';

import { runReloadPreviewCommand } from './reload-preview-service';

describe('runReloadPreviewCommand', () => {
  const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;

  afterEach(() => {
    if (originalElectronRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
    }
  });

  it('removes Electron environment variables from commands', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';

    await expect(
      runReloadPreviewCommand({
        command: process.execPath,
        args: [
          '-e',
          "process.exit(process.env.ELECTRON_RUN_AS_NODE === undefined ? 0 : 1)",
        ],
        cwd: process.cwd(),
        label: 'Environment check',
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects with stderr when the command exits non-zero', async () => {
    await expect(
      runReloadPreviewCommand({
        command: process.execPath,
        args: [
          '-e',
          "process.stderr.write('network unavailable'); process.exit(1)",
        ],
        cwd: process.cwd(),
        label: 'Git pull',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('Git pull failed with exit code 1: network unavailable');
  });

  it('rejects when the command times out', async () => {
    await expect(
      runReloadPreviewCommand({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 1000)'],
        cwd: process.cwd(),
        label: 'Git pull',
        timeoutMs: 25,
      }),
    ).rejects.toThrow(`Git pull timed out after 25ms: ${process.execPath} -e`);
  });
});
