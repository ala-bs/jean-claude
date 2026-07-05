import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';

const require = createRequire(import.meta.url);

export type CopilotClientLike = {
  start(): Promise<void>;
  stop?: () => Promise<unknown>;
  listModels(): Promise<unknown[]>;
  createSession(config?: unknown): Promise<CopilotSessionLike>;
  resumeSession(sessionId: string, config?: unknown): Promise<CopilotSessionLike>;
};

type CopilotSessionLike = {
  sessionId: string;
  on(handler: (event: { type?: unknown; data?: unknown }) => void): () => void;
  send(options: unknown): Promise<unknown>;
  sendAndWait?: (options: unknown) => Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
};

export function createCopilotClient({ cwd }: { cwd: string }): CopilotClientLike {
  const cliPath = resolveCopilotCliPath();
  return new CopilotClient({
    workingDirectory: cwd,
    useLoggedInUser: true,
    ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {}),
  }) as CopilotClientLike;
}

function getCopilotPlatformPackageName(): string {
  if (process.platform === 'linux') {
    return `@github/copilot-linux-${process.arch}`;
  }
  return `@github/copilot-${process.platform}-${process.arch}`;
}

function resolveCopilotCliPath(): string | undefined {
  if (process.env.COPILOT_CLI_PATH) {
    return process.env.COPILOT_CLI_PATH;
  }

  const packageName = getCopilotPlatformPackageName();
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const cliPath = getCopilotExecutablePath(path.dirname(packageJsonPath));
    if (existsSync(cliPath)) return cliPath;
  } catch {
    // pnpm may install optional native packages without exposing them through
    // this module's resolution paths. Fall back to deriving the store path from
    // the bundled @github/copilot package before letting the SDK use defaults.
  }

  try {
    const sdkPath = require.resolve('@github/copilot-sdk');
    const sdkRoot = findAncestorDir(sdkPath, 'copilot-sdk');
    if (!sdkRoot) return undefined;

    const copilotPackageJsonPath = path.join(
      path.dirname(sdkRoot),
      'copilot',
      'package.json',
    );
    const copilotPackage = JSON.parse(
      readFileSync(copilotPackageJsonPath, 'utf8'),
    ) as { version?: string };
    const pnpmDir = findAncestorDir(copilotPackageJsonPath, '.pnpm');
    if (!copilotPackage.version || !pnpmDir) return undefined;

    const packageRoot = path.join(
      pnpmDir,
      `${packageName.replace('/', '+')}@${copilotPackage.version}`,
      'node_modules',
      packageName,
    );
    const cliPath = getCopilotExecutablePath(packageRoot);
    return existsSync(cliPath) ? cliPath : undefined;
  } catch {
    return undefined;
  }
}

function getCopilotExecutablePath(packageRoot: string): string {
  return path.join(
    packageRoot,
    process.platform === 'win32' ? 'copilot.exe' : 'copilot',
  );
}

function findAncestorDir(startPath: string, dirname: string): string | null {
  let current = path.dirname(startPath);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === dirname) return current;
    current = path.dirname(current);
  }
  return null;
}
