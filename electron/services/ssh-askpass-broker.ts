import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { type ChildProcess, execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { rmSync } from 'fs';

import { dbg } from '../lib/debug';

/**
 * SSH never reads passphrases from stdin: it opens /dev/tty directly. A
 * GUI-launched Electron app has no controlling terminal, so the only way to
 * answer an SSH prompt is the `SSH_ASKPASS` protocol — ssh execs the program
 * named by `SSH_ASKPASS` with the prompt text as argv[1] and reads the answer
 * from its stdout.
 *
 * This module provides that program (a tiny script written to disk on first
 * use) plus a broker: a per-command unix socket the helper calls back into so
 * the main process can show a dialog and hand the answer back.
 *
 *   git push ──▶ ssh ──▶ helper(prompt) ──socket──▶ broker ──▶ renderer dialog
 *                          ◀── answer ──────────────────┘
 */

export type SshPromptKind =
  | 'passphrase'
  | 'password'
  | 'username'
  | 'confirm'
  | 'unknown';

export type SshPromptRequest = {
  /** Raw prompt text ssh handed us. */
  prompt: string;
  kind: SshPromptKind;
  /** Key path parsed out of a passphrase prompt, when present. */
  keyPath: string | null;
  /** 1-based count of prompts seen for this key/prompt during one command. */
  attempt: number;
  /**
   * Aborted when the command ends while a dialog is still open — because git
   * failed, timed out, or the remote dropped. Handlers must withdraw their UI:
   * otherwise the user types a passphrase into a box whose answer goes to a
   * destroyed socket.
   */
  signal: AbortSignal;
};

/**
 * Returns the answer to send back to ssh, or null to cancel (which makes ssh
 * give up on that key).
 */
export type SshPromptHandler = (
  request: SshPromptRequest,
) => Promise<string | null>;

/**
 * Matches both prompt forms, which differ between the first ask and a retry:
 *   Enter passphrase for key '/Users/p/.ssh/id_ed25519':
 *   Bad passphrase, try again for /Users/p/.ssh/id_ed25519:
 * Missing the retry form loses the key path, which resets the attempt counter
 * and hides the "incorrect passphrase" hint from the user.
 */
const PASSPHRASE_PATTERN =
  /(?:enter passphrase for|bad passphrase, try again for)(?: key)?\s*['"]?(.+?)['"]?:?\s*$/i;
/**
 * The trailing colon is what distinguishes a prompt from an error line, so it
 * is required rather than anchoring on "password" at the start. OpenSSH's
 * keyboard-interactive path prefixes the server's prompt with the destination
 * — "(git@host) Password: " — which a `^password` anchor would reject,
 * silently declining a push that used to work.
 */
const PASSWORD_PATTERN = /(?:^|\W)password(\s+for\s+.+)?:\s*$/i;
const USERNAME_PATTERN = /(?:^|\W)username(\s+for\s+.+)?:\s*$/i;
/** Hardware keys ask for a PIN, which is entered exactly like a password. */
const PIN_PATTERN = /enter pin for .+:\s*$/i;
const CONFIRM_PATTERN = /\(yes\/no(?:\/\[fingerprint\])?\)|continue connecting/i;

/**
 * Ceiling on how long the broker waits for an answer. Must stay above the
 * dialog's own timeout, otherwise this fires first, the handler's promise is
 * abandoned without the caller learning the user never answered, and ssh moves
 * on to the next identity — showing a fresh dialog for every remaining key.
 */
const PROMPT_TIMEOUT_MS = 6 * 60 * 1000;

export function classifySshPrompt(prompt: string): {
  kind: SshPromptKind;
  keyPath: string | null;
} {
  if (CONFIRM_PATTERN.test(prompt)) return { kind: 'confirm', keyPath: null };

  const passphraseMatch = prompt.match(PASSPHRASE_PATTERN);
  if (passphraseMatch) {
    return { kind: 'passphrase', keyPath: passphraseMatch[1]?.trim() || null };
  }

  const trimmed = prompt.trim();
  if (USERNAME_PATTERN.test(trimmed)) return { kind: 'username', keyPath: null };
  if (PASSWORD_PATTERN.test(trimmed) || PIN_PATTERN.test(trimmed)) {
    return { kind: 'password', keyPath: null };
  }

  // Deliberately not defaulting to 'password': an unrecognised prompt (a FIDO
  // key PIN, a new OpenSSH wording) would otherwise be shown as a masked box
  // and whatever the user typed fed straight back to ssh.
  return { kind: 'unknown', keyPath: null };
}

// --- helper script on disk -------------------------------------------------

/**
 * The helper must be a real executable file, and a packaged app has no `node`
 * binary — so the shell wrapper re-execs Electron itself in Node mode.
 * `ELECTRON_RUN_AS_NODE` is set inside the wrapper so it never leaks into the
 * environment of git or ssh.
 */
const HELPER_JS = `'use strict';
const net = require('net');

const sock = process.env.JC_ASKPASS_SOCK;
const nonce = process.env.JC_ASKPASS_NONCE;
const prompt = process.argv[2] || '';

if (!sock || !nonce) process.exit(1);

const client = net.connect(sock);
let buffer = '';

client.on('connect', () => {
  client.write(JSON.stringify({ nonce, prompt }) + '\\n');
});

client.on('data', (chunk) => {
  buffer += chunk.toString();
  const newline = buffer.indexOf('\\n');
  if (newline === -1) return;

  let response;
  try {
    response = JSON.parse(buffer.slice(0, newline));
  } catch {
    process.exit(1);
  }

  client.end();

  if (!response || response.cancelled || typeof response.value !== 'string') {
    // Non-zero tells ssh the user declined, so it stops retrying this key.
    process.exit(1);
  }

  process.stdout.write(response.value + '\\n', () => process.exit(0));
});

client.on('error', () => process.exit(1));
`;

const HELPER_SH = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$JC_ASKPASS_ELECTRON" "$(dirname "$0")/askpass-helper.js" "$@"
`;

let runtimeDirPromise: Promise<string> | null = null;

/**
 * Private per-run directory holding the helper scripts and the callback socket.
 *
 * `mkdtemp` is load-bearing, not a convenience: a fixed name under
 * `os.tmpdir()` is safe on macOS (per-user /var/folders) but not on Linux,
 * where /tmp is shared. There, any local user could pre-create the directory
 * or pre-place the helper as a symlink and have their code executed by our
 * push — receiving the passphrase, since the helper is what ssh asks. mkdtemp
 * creates an unpredictable name owned by us at 0700 in a single atomic step.
 */
async function createRuntimeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-askpass-'));
  await fs.chmod(dir, 0o700);

  const jsPath = path.join(dir, 'askpass-helper.js');
  const shPath = path.join(dir, 'askpass-helper.sh');

  // 'wx' fails rather than following a symlink or clobbering an existing file.
  await fs.writeFile(jsPath, HELPER_JS, { mode: 0o700, flag: 'wx' });
  await fs.writeFile(shPath, HELPER_SH, { mode: 0o700, flag: 'wx' });
  // writeFile's mode is masked by the umask; an unusual umask (0177) would
  // leave the helper non-executable and ssh would fail with EACCES.
  await fs.chmod(jsPath, 0o700);
  await fs.chmod(shPath, 0o700);

  // 'exit' does not fire on SIGINT/SIGTERM, which is how a desktop app usually
  // goes away. The path is always mkdtemp-derived, never user input.
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Nothing useful to do while exiting.
    }
  };
  process.once('exit', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  dbg.ssh('askpass runtime dir ready at %s', dir);
  return dir;
}

async function getRuntimeDir(): Promise<string> {
  runtimeDirPromise ??= createRuntimeDir().catch((error) => {
    // Do not cache a failure — a later attempt may succeed.
    runtimeDirPromise = null;
    throw error;
  });

  const dir = await runtimeDirPromise;

  // A tmp reaper (systemd-tmpfiles, macOS periodic cleanup) can delete the
  // directory during a long session. Without this check every later push would
  // fail to bind its socket and silently run with no askpass at all.
  try {
    await fs.access(dir);
    return dir;
  } catch {
    dbg.ssh('askpass runtime dir vanished, recreating');
    runtimeDirPromise = null;
    return getRuntimeDir();
  }
}

// --- broker ----------------------------------------------------------------

type Broker = {
  env: NodeJS.ProcessEnv;
  dispose: () => Promise<void>;
};

async function startBroker(handler: SshPromptHandler): Promise<Broker> {
  const runtimeDir = await getRuntimeDir();
  const helperPath = path.join(runtimeDir, 'askpass-helper.sh');
  const nonce = randomBytes(24).toString('hex');
  // Lives inside the 0700 runtime dir, so the directory permissions protect it
  // regardless of the umask the socket file itself is created with.
  // Unix socket paths are capped near 104 bytes — keep the name short.
  const socketPath = path.join(
    runtimeDir,
    `${randomBytes(4).toString('hex')}.sock`,
  );

  const attempts = new Map<string, number>();
  // Tracked so dispose() can destroy them: server.close() only stops accepting
  // and its callback waits for every open connection, so a helper still
  // attached (e.g. after its ssh was killed) would hang teardown forever.
  const connections = new Set<net.Socket>();
  // Signals open dialogs that nobody is listening for their answer any more.
  const abortController = new AbortController();

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);

      void (async () => {
        try {
          const message = JSON.parse(line) as {
            nonce?: string;
            prompt?: string;
          };

          if (message.nonce !== nonce) {
            dbg.ssh('askpass request rejected: bad nonce');
            socket.end();
            return;
          }

          const prompt = message.prompt ?? '';
          const { kind, keyPath } = classifySshPrompt(prompt);
          const attemptKey = keyPath ?? prompt;
          const attempt = (attempts.get(attemptKey) ?? 0) + 1;
          attempts.set(attemptKey, attempt);

          dbg.ssh(
            'askpass invoked kind=%s key=%s attempt=%d',
            kind,
            keyPath ?? '-',
            attempt,
          );

          const answer = await withTimeout(
            handler({
              prompt,
              kind,
              keyPath,
              attempt,
              signal: abortController.signal,
            }),
            PROMPT_TIMEOUT_MS,
          );

          dbg.ssh(
            'askpass answered kind=%s answered=%s',
            kind,
            answer === null ? 'no' : 'yes',
          );

          socket.end(
            JSON.stringify(
              answer === null ? { cancelled: true } : { value: answer },
            ) + '\n',
          );
        } catch (error) {
          dbg.ssh('askpass handler failed: %O', error);
          socket.end(JSON.stringify({ cancelled: true }) + '\n');
        }
      })();
    });

    socket.on('error', (error) => {
      dbg.ssh('askpass socket error: %O', error);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o600).catch(() => undefined);

  return {
    env: {
      SSH_ASKPASS: helperPath,
      // The whole point: force ssh to use askpass even though it could see a
      // tty. Without this it silently prefers the tty in dev and behaves
      // differently from the packaged app.
      SSH_ASKPASS_REQUIRE: 'force',
      // OpenSSH < 8.4 has no SSH_ASKPASS_REQUIRE and only uses askpass when
      // DISPLAY is set.
      DISPLAY: process.env.DISPLAY || ':0',
      JC_ASKPASS_SOCK: socketPath,
      JC_ASKPASS_NONCE: nonce,
      JC_ASKPASS_ELECTRON: process.execPath,
      // git's own prompts (HTTPS username/password) fall back to SSH_ASKPASS
      // only if GIT_ASKPASS is unset; pointing it at the same helper keeps
      // both paths going through the dialog instead of one silently failing.
      // A user who set their own GIT_ASKPASS keeps it — credential helpers are
      // unaffected either way, since git consults those first.
      GIT_ASKPASS: process.env.GIT_ASKPASS || helperPath,
      // Never let git fall back to a terminal prompt we cannot service.
      GIT_TERMINAL_PROMPT: '0',
    },
    dispose: async () => {
      // Withdraw any dialog still on screen before tearing down the transport,
      // so the user is not left typing a secret into a dead prompt.
      abortController.abort();
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true }).catch(() => undefined);
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for SSH prompt response')),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// --- running commands under the broker -------------------------------------

/**
 * Signals the child's entire process group, falling back to the child alone
 * when it is not a group leader (Windows, or spawn without `detached`).
 */
function killProcessGroup(child: ChildProcess) {
  try {
    if (child.pid != null && process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    // Group already gone, or not a group leader — fall through.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

export type SshCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Runs a command with SSH prompts routed through `handler`.
 *
 * On Windows the askpass helper cannot be a shell script, so the environment
 * is left untouched and whatever askpass the user already has (Git Credential
 * Manager, ssh-agent service) stays in charge.
 */
export async function runWithSshAskpass(params: {
  command: string;
  args: string[];
  cwd?: string;
  handler: SshPromptHandler;
  timeoutMs?: number;
}): Promise<SshCommandResult> {
  let broker: Broker | null = null;

  if (process.platform !== 'win32') {
    try {
      broker = await startBroker(params.handler);
    } catch (error) {
      dbg.ssh('failed to start askpass broker, continuing without: %O', error);
    }
  }

  try {
    return await new Promise<SshCommandResult>((resolve, reject) => {
      const child = spawn(params.command, params.args, {
        cwd: params.cwd,
        // 'ignore' on stdin guarantees no tty is inherited, so ssh has no
        // choice but to use askpass.
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: { ...process.env, ...(broker?.env ?? {}) },
      });

      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const settle = (result: SshCommandResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        resolve(result);
      };

      if (params.timeoutMs != null) {
        timer = setTimeout(() => {
          dbg.ssh('%s timed out, killing process group', params.command);
          // Kill the whole group, not just git: ssh (and the askpass helper it
          // spawned) are children holding our stdio pipes open, so signalling
          // only the leader leaves them running and 'close' never fires.
          killProcessGroup(child);

          // The kill is best-effort — it can fail with EPERM if the child
          // changed process group (a ProxyCommand that calls setsid, a
          // sandbox). Settle regardless, or this promise never resolves and
          // the caller's push hangs for the lifetime of the app.
          graceTimer = setTimeout(() => {
            dbg.ssh('%s did not exit after kill, settling anyway', params.command);
            settle({
              code: null,
              stdout,
              stderr: stderr || `${params.command} timed out`,
            });
          }, 2000);
          graceTimer.unref?.();
        }, params.timeoutMs);
        // Do not keep the event loop alive purely for a pending timeout.
        timer.unref?.();
      }

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        dbg.ssh('%s stderr: %s', params.command, data.toString().trim());
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        reject(
          new Error(`Failed to spawn ${params.command}: ${error.message}`),
        );
      });

      child.on('close', (code) => {
        dbg.ssh('%s exited code=%s', params.command, code);
        settle({ code, stdout, stderr });
      });
    });
  } finally {
    await broker?.dispose().catch(() => undefined);
  }
}

// --- ssh-agent -------------------------------------------------------------

export type SshAgentStatus =
  | { state: 'has-keys'; keys: string[] }
  | { state: 'empty' }
  | { state: 'unavailable' };

/**
 * `ssh-add -l` exits 0 with keys, 1 when the agent is running but empty, and
 * 2 when there is no agent to talk to.
 */
export function getSshAgentStatus(): Promise<SshAgentStatus> {
  return new Promise((resolve) => {
    execFile('ssh-add', ['-l'], { timeout: 5000 }, (error, stdout) => {
      const code =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error
            ? 2
            : 0;

      if (code === 0) {
        const keys = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        dbg.ssh('agent status=has-keys count=%d', keys.length);
        resolve({ state: 'has-keys', keys });
        return;
      }

      const state = code === 1 ? 'empty' : 'unavailable';
      dbg.ssh('agent status=%s', state);
      resolve(state === 'empty' ? { state: 'empty' } : { state: 'unavailable' });
    });
  });
}

/**
 * Reads the SHA256 fingerprint of a key file.
 *
 * `ssh-keygen -lf` prints `256 SHA256:<hash> <comment> (ED25519)`.
 */
async function getKeyFingerprint(keyPath: string): Promise<string | null> {
  try {
    const { stdout } = await new Promise<{ stdout: string }>(
      (resolve, reject) => {
        execFile(
          'ssh-keygen',
          ['-lf', keyPath],
          { timeout: 5000 },
          (error, stdout) => {
            if (error) reject(error);
            else resolve({ stdout });
          },
        );
      },
    );
    return stdout.match(/(SHA256:\S+)/)?.[1] ?? null;
  } catch (error) {
    dbg.ssh('could not fingerprint %s: %O', keyPath, error);
    return null;
  }
}

/**
 * Whether ssh-agent already holds a key.
 *
 * Compares fingerprints, not paths: `ssh-add -l` lists each key's *comment*
 * (often an email or hostname), so matching on the file path never hits and
 * would make us re-offer a key that is already loaded.
 */
export async function isKeyLoadedInAgent(keyPath: string): Promise<boolean> {
  const [status, fingerprint] = await Promise.all([
    getSshAgentStatus(),
    getKeyFingerprint(keyPath),
  ]);

  if (status.state !== 'has-keys' || !fingerprint) return false;
  return status.keys.some((key) => key.includes(fingerprint));
}

/**
 * Adds a key to the running ssh-agent for the rest of the login session.
 * The passphrase is fed through the same askpass channel and is never written
 * to disk, a command line, or the database.
 */
export async function addKeyToAgent(params: {
  keyPath: string;
  passphrase: string;
}): Promise<{ added: boolean; error?: string }> {
  dbg.ssh('ssh-add %s', params.keyPath);

  let served = false;
  const result = await runWithSshAskpass({
    command: 'ssh-add',
    args: [params.keyPath],
    timeoutMs: 30_000,
    handler: async () => {
      // Only answer the first prompt: a second one means the passphrase we
      // hold is wrong, and replaying it would just loop.
      if (served) return null;
      served = true;
      return params.passphrase;
    },
  });

  if (result.code === 0) {
    dbg.ssh('ssh-add succeeded for %s', params.keyPath);
    return { added: true };
  }

  dbg.ssh('ssh-add failed code=%s', result.code);
  return { added: false, error: result.stderr.trim() || 'ssh-add failed' };
}
