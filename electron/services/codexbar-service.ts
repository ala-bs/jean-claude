import { shell } from 'electron';



import { runCodexBarCli } from './codexbar-cli';



export interface CodexBarStatus {
  installed: boolean;
  version?: string;
  error?: string;
}

export function getCodexBarStatus(): Promise<CodexBarStatus> {
  return runCodexBarCli(['--version'], { timeout: 5_000, maxBuffer: 128 * 1024 })
    .then(({ stdout }) => ({ installed: true, version: stdout.trim() }))
    .catch((error: Error) => ({ installed: false, error: error.message }));
}

export function openCodexBarInstallPage(): Promise<void> {
  return shell.openExternal('https://github.com/steipete/CodexBar/releases/latest');
}
