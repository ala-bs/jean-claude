import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  addKeyToAgent,
  classifySshPrompt,
  getSshAgentStatus,
  isKeyLoadedInAgent,
  runWithSshAskpass,
} from './ssh-askpass-broker';

// vitest.setup.ts swaps fs/promises for memfs globally. This suite spawns real
// ssh binaries that must be able to read the askpass helper, so it needs the
// real filesystem.
vi.mock('fs/promises', async () =>
  vi.importActual<typeof import('fs/promises')>('fs/promises'),
);

const execFileAsync = promisify(execFile);

describe('classifySshPrompt', () => {
  it('extracts the key path from a passphrase prompt', () => {
    expect(
      classifySshPrompt("Enter passphrase for key '/Users/p/.ssh/id_ed25519': "),
    ).toEqual({ kind: 'passphrase', keyPath: '/Users/p/.ssh/id_ed25519' });
  });

  it('handles the ssh-add prompt form, which omits the word "key"', () => {
    expect(
      classifySshPrompt('Enter passphrase for /Users/p/.ssh/id_work:'),
    ).toEqual({ kind: 'passphrase', keyPath: '/Users/p/.ssh/id_work' });
  });

  it('keeps the key path on a retry prompt, which is worded differently', () => {
    expect(
      classifySshPrompt('Bad passphrase, try again for /Users/p/.ssh/id_work: '),
    ).toEqual({ kind: 'passphrase', keyPath: '/Users/p/.ssh/id_work' });
  });

  it('detects host authenticity confirmations', () => {
    expect(
      classifySshPrompt(
        'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
      ).kind,
    ).toBe('confirm');
  });

  it('detects password prompts', () => {
    expect(classifySshPrompt("git@github.com's password:")).toEqual({
      kind: 'password',
      keyPath: null,
    });
  });

  it('detects a git HTTPS username prompt so it is not masked', () => {
    expect(classifySshPrompt("Username for 'https://github.com': ")).toEqual({
      kind: 'username',
      keyPath: null,
    });
  });

  it('does not mistake a permission error for a prompt needing a key path', () => {
    expect(classifySshPrompt('Permission denied (publickey).').keyPath).toBeNull();
  });

  it('classifies anything unrecognised as unknown rather than a password', () => {
    // Answering an unrecognised prompt with a masked box would invite the user
    // to type a secret into whatever ssh happens to be asking.
    expect(classifySshPrompt('Confirm user presence for key ED25519-SK').kind).toBe(
      'unknown',
    );
    expect(classifySshPrompt('Permission denied, please try again.').kind).toBe(
      'unknown',
    );
  });

  it.each([
    // OpenSSH prefixes the keyboard-interactive prompt with the destination,
    // so anchoring on a leading "password" silently declines a working login.
    ['(git@gerrit.example.com) Password: ', 'password'],
    ['Password: ', 'password'],
    ["Password for 'https://u@github.com': ", 'password'],
    ["git@github.com's password: ", 'password'],
    // Hardware keys ask for a PIN, entered exactly like a password.
    ['Enter PIN for ED25519-SK key /u/.ssh/id_sk: ', 'password'],
    ["Username for 'https://github.com': ", 'username'],
    ["Enter passphrase for key '/u/.ssh/id_ed25519': ", 'passphrase'],
    ['Bad passphrase, try again for /u/.ssh/id_work: ', 'passphrase'],
    [
      'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
      'confirm',
    ],
    // Not prompts: no trailing colon.
    ['Permission denied (publickey).', 'unknown'],
    ['Permission denied, please try again.', 'unknown'],
  ])('classifies %j as %s', (prompt, expected) => {
    expect(classifySshPrompt(prompt).kind).toBe(expected);
  });
});

/**
 * End-to-end proof that the askpass channel actually works.
 *
 * `ssh-keygen -y` needs the passphrase of an encrypted private key and reads it
 * exactly the way `git push` does — from /dev/tty, or from SSH_ASKPASS when
 * there is no tty. If this passes, a real push can be answered too.
 */
describe.skipIf(process.platform === 'win32')('command timeout', () => {
  it('settles instead of hanging when the command outlives its timeout', async () => {
    // `sh -c 'sleep 30'` leaves a grandchild holding the stdio pipes, which is
    // exactly the shape that made 'close' never fire when only the process
    // group leader was signalled.
    const started = Date.now();
    const result = await runWithSshAskpass({
      command: 'sh',
      args: ['-c', 'sleep 30'],
      timeoutMs: 500,
      handler: async () => null,
    });

    expect(result.code).not.toBe(0);
    // Must not have waited for the full sleep.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

/** CI images without openssh-client should skip, not fail. */
function hasSshTooling(): boolean {
  if (process.platform === 'win32') return false;
  try {
    for (const bin of ['ssh-keygen', 'ssh-add', 'ssh-agent']) {
      execFileSync('command', ['-v', bin], { shell: '/bin/sh', stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasSshTooling())('askpass end-to-end', () => {
  let dir: string;
  let keyPath: string;
  const passphrase = 'correct-horse-battery-staple';

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-askpass-test-'));
    keyPath = path.join(dir, 'id_ed25519');
    await execFileAsync('ssh-keygen', [
      '-q',
      '-t', 'ed25519',
      '-N', passphrase,
      '-C', 'jean-claude-test',
      '-f', keyPath,
    ]);
  }, 30_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('answers a real passphrase prompt through the helper', async () => {
    const prompts: string[] = [];

    const result = await runWithSshAskpass({
      command: 'ssh-keygen',
      args: ['-y', '-f', keyPath],
      timeoutMs: 20_000,
      handler: async (request) => {
        prompts.push(request.prompt);
        expect(request.kind).toBe('passphrase');
        expect(request.keyPath).toBe(keyPath);
        return passphrase;
      },
    });

    expect(prompts).toHaveLength(1);
    expect(result.code).toBe(0);
    // -y prints the public key derived from the unlocked private key.
    expect(result.stdout).toContain('ssh-ed25519');

    // The helper is exec'd by ssh and is handed the passphrase, so a
    // predictable path in a shared /tmp would let another local user pre-place
    // their own script (or a symlink) and have it run as us. Pin the
    // properties that prevent it: unpredictable name, ours, no group/world
    // access. Asserted here rather than in a test of its own to avoid paying
    // for another real ssh-keygen run.
    const runtimeDirs = (await fs.readdir(os.tmpdir())).filter((entry) =>
      entry.startsWith('jc-askpass-'),
    );
    expect(runtimeDirs.length).toBeGreaterThan(0);
    for (const runtimeDir of runtimeDirs) {
      const stats = await fs.stat(path.join(os.tmpdir(), runtimeDir));
      expect(stats.mode & 0o077).toBe(0);
      expect(stats.uid).toBe(process.getuid?.());
    }

    // The first implementation used this fixed, guessable path.
    await expect(
      fs.stat(path.join(os.tmpdir(), 'jean-claude-askpass')),
    ).rejects.toThrow();
  }, 30_000);

  it('fails without unlocking the key when the passphrase is wrong', async () => {
    const result = await runWithSshAskpass({
      command: 'ssh-keygen',
      args: ['-y', '-f', keyPath],
      timeoutMs: 20_000,
      handler: async () => 'wrong-passphrase',
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('ssh-ed25519');
  }, 30_000);

  it('cancelling stops the command instead of hanging', async () => {
    const result = await runWithSshAskpass({
      command: 'ssh-keygen',
      args: ['-y', '-f', keyPath],
      timeoutMs: 20_000,
      handler: async () => null,
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('ssh-ed25519');
  }, 30_000);

  /**
   * ssh and ssh-add re-invoke askpass after a bad passphrase (up to three
   * tries). This is what makes the retry dialog work, so it is worth pinning
   * against the real binary rather than assuming it.
   */
  describe('with a real ssh-agent', () => {
    let agentPid: string | undefined;
    let previousAuthSock: string | undefined;

    beforeAll(async () => {
      const { stdout } = await execFileAsync('ssh-agent', ['-s']);
      const sock = stdout.match(/SSH_AUTH_SOCK=([^;]+);/)?.[1];
      agentPid = stdout.match(/SSH_AGENT_PID=([^;]+);/)?.[1];
      previousAuthSock = process.env.SSH_AUTH_SOCK;
      if (sock) process.env.SSH_AUTH_SOCK = sock;
    }, 30_000);

    afterAll(async () => {
      if (previousAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previousAuthSock;
      if (agentPid) {
        await execFileAsync('kill', [agentPid]).catch(() => undefined);
      }
    });

    it('re-prompts with an incrementing attempt number, then succeeds', async () => {
      const attempts: number[] = [];

      const result = await runWithSshAskpass({
        command: 'ssh-add',
        args: [keyPath],
        timeoutMs: 20_000,
        handler: async (request) => {
          attempts.push(request.attempt);
          // Succeed on the third try to prove retries reach the handler.
          return request.attempt >= 3 ? passphrase : 'wrong-passphrase';
        },
      });

      expect(attempts).toEqual([1, 2, 3]);
      expect(result.code).toBe(0);
    }, 30_000);

    it('addKeyToAgent loads the key so later operations need no passphrase', async () => {
      await execFileAsync('ssh-add', ['-D']).catch(() => undefined);

      const outcome = await addKeyToAgent({ keyPath, passphrase });
      expect(outcome).toEqual({ added: true });

      const status = await getSshAgentStatus();
      expect(status.state).toBe('has-keys');
      // Matched by fingerprint: `ssh-add -l` lists comments, not paths.
      await expect(isKeyLoadedInAgent(keyPath)).resolves.toBe(true);
    }, 30_000);

    it('reports a key that is not in the agent as not loaded', async () => {
      await execFileAsync('ssh-add', ['-D']).catch(() => undefined);
      await expect(isKeyLoadedInAgent(keyPath)).resolves.toBe(false);
    }, 30_000);

    it('addKeyToAgent does not loop when the passphrase is wrong', async () => {
      await execFileAsync('ssh-add', ['-D']).catch(() => undefined);

      const outcome = await addKeyToAgent({
        keyPath,
        passphrase: 'wrong-passphrase',
      });

      expect(outcome.added).toBe(false);
    }, 30_000);
  });
});
