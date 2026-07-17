import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function runElectronInstaller({
  installScriptPath,
  env,
  spawnProcess = childProcess.spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [installScriptPath], {
      env,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `process terminated by ${signal}`
            : `process exited with code ${code}`,
        ),
      );
    });
  });
}

export async function ensureElectronInstalled({
  inheritedEnv = process.env,
  resolvePackageJson = () => require.resolve('electron/package.json'),
  runInstaller = runElectronInstaller,
} = {}) {
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson();
  } catch (error) {
    throw new Error(
      `Could not resolve the Electron package: ${describeError(error)}. Rerun pnpm install.`,
    );
  }

  const packageDirectory = path.dirname(packageJsonPath);
  const installScriptPath = path.join(packageDirectory, 'install.js');
  const installerEnv = { ...inheritedEnv };
  delete installerEnv.ELECTRON_OVERRIDE_DIST_PATH;

  try {
    await runInstaller({ installScriptPath, env: installerEnv });
  } catch (error) {
    throw new Error(
      `Electron installer failed: ${describeError(error)}. Check your network and rerun pnpm install.`,
    );
  }

  const pathFile = path.join(packageDirectory, 'path.txt');
  let executableEntry;
  try {
    executableEntry = (await fs.readFile(pathFile, 'utf8')).trim();
  } catch {
    throw new Error(
      'Electron installation is incomplete: path.txt is missing. Rerun pnpm install.',
    );
  }

  if (!executableEntry) {
    throw new Error(
      'Electron installation is incomplete: path.txt is empty. Rerun pnpm install.',
    );
  }

  const executablePath = path.join(
    packageDirectory,
    'dist',
    executableEntry,
  );
  try {
    await fs.access(executablePath);
  } catch {
    throw new Error(
      `Electron installation is incomplete: executable not found at ${executablePath}. Rerun pnpm install.`,
    );
  }

  return executablePath;
}

const isDirectExecution =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  ensureElectronInstalled().catch((error) => {
    console.error(describeError(error));
    process.exitCode = 1;
  });
}
