import { execFile } from 'child_process';



export function runCodexBarCli(
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  const commands = [
    process.env.CODEXBAR_CLI_PATH,
    'codexbar',
    '/opt/homebrew/bin/codexbar',
    '/usr/local/bin/codexbar',
  ].filter((command): command is string => Boolean(command));

  return runNext(commands, args, options);
}

function runNext(
  commands: string[],
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  const [command, ...rest] = commands;
  if (!command) {
    return Promise.reject(new Error('CodexBar CLI was not found on PATH.'));
  }

  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }

      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && rest.length > 0) {
        runNext(rest, args, options).then(resolve, reject);
        return;
      }

      if (code === 'ENOENT') {
        reject(new Error('CodexBar CLI was not found on PATH.'));
        return;
      }

      const exitCode = typeof error.code === 'number' ? error.code : null;
      const reason = stderr.trim();
      const message = cleanExecFileMessage(error.message);
      reject(
        new Error(
          reason ||
            message ||
            (exitCode != null
              ? `CodexBar CLI exited with code ${exitCode}.`
              : 'CodexBar CLI failed.'),
        ),
      );
    });
  });
}

function cleanExecFileMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('Command failed:')) return trimmed;

  const lines = trimmed.split('\n').slice(1).join('\n').trim();
  return lines;
}
