import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureElectronInstalled,
  runElectronInstaller,
} from './ensure-electron-installed.mjs';

describe('ensureElectronInstalled', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function createElectronPackage() {
    await fs.mkdir(os.tmpdir(), { recursive: true });
    const packageDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'jc-electron-install-'),
    );
    temporaryDirectories.push(packageDirectory);
    await fs.writeFile(path.join(packageDirectory, 'package.json'), '{}');
    await fs.writeFile(path.join(packageDirectory, 'install.js'), '');

    return packageDirectory;
  }

  it('runs the installer and returns the installed executable', async () => {
    const packageDirectory = await createElectronPackage();
    const executableEntry = path.join('Electron.app', 'Electron');
    const executablePath = path.join(
      packageDirectory,
      'dist',
      executableEntry,
    );
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(path.join(packageDirectory, 'path.txt'), executableEntry);
    await fs.writeFile(executablePath, '');
    const runInstaller = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureElectronInstalled({
        resolvePackageJson: () => path.join(packageDirectory, 'package.json'),
        runInstaller,
      }),
    ).resolves.toBe(executablePath);
    expect(runInstaller).toHaveBeenCalledWith({
      env: expect.any(Object),
      installScriptPath: path.join(packageDirectory, 'install.js'),
    });
  });

  it('removes Electron dist overrides from the installer environment', async () => {
    const packageDirectory = await createElectronPackage();
    const executableEntry = 'electron';
    const executablePath = path.join(
      packageDirectory,
      'dist',
      executableEntry,
    );
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(path.join(packageDirectory, 'path.txt'), executableEntry);
    await fs.writeFile(executablePath, '');
    const runInstaller = vi.fn().mockResolvedValue(undefined);

    await ensureElectronInstalled({
      inheritedEnv: {
        ELECTRON_OVERRIDE_DIST_PATH: '/tmp/other-electron',
        PATH: '/usr/bin',
      },
      resolvePackageJson: () => path.join(packageDirectory, 'package.json'),
      runInstaller,
    });

    expect(runInstaller).toHaveBeenCalledWith({
      env: { PATH: '/usr/bin' },
      installScriptPath: path.join(packageDirectory, 'install.js'),
    });
  });

  it('reports package resolution failures with recovery guidance', async () => {
    await expect(
      ensureElectronInstalled({
        resolvePackageJson: () => {
          throw new Error('package missing');
        },
      }),
    ).rejects.toThrow(
      'Could not resolve the Electron package: package missing. Rerun pnpm install.',
    );
  });

  it('reports installer failures with recovery guidance', async () => {
    const packageDirectory = await createElectronPackage();

    await expect(
      ensureElectronInstalled({
        resolvePackageJson: () => path.join(packageDirectory, 'package.json'),
        runInstaller: vi.fn().mockRejectedValue(new Error('download failed')),
      }),
    ).rejects.toThrow(
      'Electron installer failed: download failed. Check your network and rerun pnpm install.',
    );
  });

  it('reports a missing path.txt after installation', async () => {
    const packageDirectory = await createElectronPackage();

    await expect(
      ensureElectronInstalled({
        resolvePackageJson: () => path.join(packageDirectory, 'package.json'),
        runInstaller: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow(
      'Electron installation is incomplete: path.txt is missing. Rerun pnpm install.',
    );
  });

  it('reports a missing executable after installation', async () => {
    const packageDirectory = await createElectronPackage();
    const executableEntry = path.join('Electron.app', 'Electron');
    await fs.writeFile(path.join(packageDirectory, 'path.txt'), executableEntry);

    await expect(
      ensureElectronInstalled({
        resolvePackageJson: () => path.join(packageDirectory, 'package.json'),
        runInstaller: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow(
      `Electron installation is incomplete: executable not found at ${path.join(packageDirectory, 'dist', executableEntry)}. Rerun pnpm install.`,
    );
  });

  it('reports an empty path.txt after installation', async () => {
    const packageDirectory = await createElectronPackage();
    await fs.writeFile(path.join(packageDirectory, 'path.txt'), '  \n');

    await expect(
      ensureElectronInstalled({
        resolvePackageJson: () => path.join(packageDirectory, 'package.json'),
        runInstaller: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow(
      'Electron installation is incomplete: path.txt is empty. Rerun pnpm install.',
    );
  });
});

describe('runElectronInstaller', () => {
  it('rejects when the installer exits nonzero', async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const result = runElectronInstaller({
      env: { PATH: '/usr/bin' },
      installScriptPath: '/electron/install.js',
      spawnProcess,
    });

    child.emit('exit', 2, null);

    await expect(result).rejects.toThrow('process exited with code 2');
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['/electron/install.js'],
      { env: { PATH: '/usr/bin' }, stdio: 'inherit' },
    );
  });

  it('rejects when the installer process cannot start', async () => {
    const child = new EventEmitter();
    const result = runElectronInstaller({
      env: {},
      installScriptPath: '/electron/install.js',
      spawnProcess: vi.fn(() => child),
    });

    child.emit('error', new Error('spawn failed'));

    await expect(result).rejects.toThrow('spawn failed');
  });
});
