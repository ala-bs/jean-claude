import * as fs from 'fs/promises';
import { getNonInteractiveGitEnv } from '../lib/git-non-interactive-env';
import type { GitCloneProtocol } from '../../shared/git-url-utils';
import { sendGlobalPromptToWindow } from './global-prompt-service';
import { spawn } from 'child_process';

export interface CloneFromUrlParams {
  /** Fully-resolved clone URL (ssh or https). */
  cloneUrl: string;
  /** Absolute destination directory. Must not already exist and be non-empty. */
  targetPath: string;
  /**
   * Which protocol `cloneUrl` uses. Controls prompt handling: ssh clones keep
   * an interactive stdin so we can answer the host-key prompt, https clones run
   * fully non-interactive so a private repo fails fast instead of blocking on
   * an invisible username prompt.
   */
  protocol: GitCloneProtocol;
}

export interface CloneFromUrlResult {
  success: boolean;
  error?: string;
}

// Regex patterns to detect the SSH host authenticity prompt.
const SSH_AUTHENTICITY_PATTERN = /The authenticity of host '([^']+)'/;
const FINGERPRINT_PATTERN = /(\w+) key fingerprint is ([^\s.]+)/;

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Map raw git/ssh stderr onto a message a user can act on.
 *
 * `protocol` matters because the same failure has different remedies: an ssh
 * "permission denied" means the key is not registered with the host, while an
 * https one means the credentials or token are wrong.
 */
function toFriendlyError(stderr: string, protocol: GitCloneProtocol): string {
  const trimmed = stderr.trim();

  if (
    stderr.includes('Permission denied') ||
    stderr.includes('Could not read from remote repository')
  ) {
    return protocol === 'ssh'
      ? 'Permission denied. Make sure your SSH key is added to this git host, or switch to HTTPS.'
      : 'Permission denied. Check your git credentials for this host, or switch to SSH.';
  }
  if (
    stderr.includes('Authentication failed') ||
    stderr.includes('could not read Username') ||
    stderr.includes('terminal prompts disabled')
  ) {
    return 'Authentication required. Configure a credential helper for this host, or switch to SSH.';
  }
  if (stderr.includes('already exists and is not an empty directory')) {
    return 'Target directory already exists and is not empty.';
  }
  // Matched on the specific fatal spellings rather than a bare `not found`:
  // the accumulated stderr also carries warnings (`templates not found in …`)
  // that would otherwise shadow the real error below.
  if (
    /(?:^|\n)(?:fatal|remote|ERROR):.*\bnot found\b/i.test(stderr) ||
    stderr.includes('Repository not found') ||
    stderr.includes('does not appear to be a git repository')
  ) {
    return 'Repository not found. Check the URL, or that you have access to it.';
  }
  if (stderr.includes('Host key verification failed')) {
    return 'SSH host verification was rejected.';
  }
  if (
    stderr.includes('Could not resolve host') ||
    stderr.includes('Temporary failure in name resolution')
  ) {
    return 'Could not resolve the git host. Check the URL and your network connection.';
  }

  return trimmed || 'Clone failed.';
}

/**
 * Clone an arbitrary git URL into `targetPath`.
 *
 * Shared by the "clone from URL" flow and the Azure DevOps repo browser, so
 * both get identical host-key prompting and error mapping.
 */
export async function cloneFromUrl(
  params: CloneFromUrlParams,
): Promise<CloneFromUrlResult> {
  const { cloneUrl, targetPath, protocol } = params;

  // Checked here rather than in the IPC handler so every caller — including the
  // Azure repo browser — gets the same guard. A missing directory (ENOENT) is
  // the normal case; git creates it itself.
  try {
    const entries = await fs.readdir(targetPath);
    if (entries.length > 0) {
      return {
        success: false,
        error: 'Target directory already exists and is not empty.',
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        success: false,
        error: 'Target path exists but is not a readable directory.',
      };
    }
  }

  // ssh must keep a usable prompt path so the host-key question can be relayed
  // to the user; BatchMode would turn a first-time host into a hard failure.
  const env =
    protocol === 'ssh'
      ? { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      : { ...process.env, ...getNonInteractiveGitEnv() };

  return new Promise((resolve) => {
    const gitProcess = spawn('git', ['clone', '--', cloneUrl, targetPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stderr = '';
    let promptHandled = false;
    let settled = false;

    // Withdraws a host-key dialog that is still on screen once the clone has
    // already finished or been killed, so the user is not left answering a
    // question about a process that no longer exists.
    const promptAbort = new AbortController();

    function settle(result: CloneFromUrlResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      promptAbort.abort();
      resolve(result);
    }

    // Set when the timeout fires, so the `close` handler reports the timeout
    // rather than whatever exit code the signal produced.
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      // SIGTERM first: git traps it and removes the partial checkout, so a
      // retry into the same folder is not blocked by a non-empty directory.
      // SIGKILL only as a backstop if it ignores the polite request.
      gitProcess.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        gitProcess.kill('SIGKILL');
        // If even SIGKILL leaves us without a `close`, settle anyway so the
        // caller's promise can never hang.
        settle({ success: false, error: 'Clone timed out after 10 minutes.' });
      }, 2000);
      forceKill.unref?.();
    }, CLONE_TIMEOUT_MS);

    gitProcess.stderr.on('data', async (data: Buffer) => {
      stderr += data.toString();

      if (!promptHandled && SSH_AUTHENTICITY_PATTERN.test(stderr)) {
        promptHandled = true;

        const hostMatch = stderr.match(SSH_AUTHENTICITY_PATTERN);
        const fingerprintMatch = stderr.match(FINGERPRINT_PATTERN);

        const host = hostMatch?.[1] ?? 'unknown';
        const keyType = fingerprintMatch?.[1] ?? 'Unknown';
        const fingerprint = fingerprintMatch?.[2] ?? 'unknown';

        const accepted = await sendGlobalPromptToWindow(
          {
            title: 'Unknown SSH Host',
            message: `The authenticity of host '${host}' can't be established.`,
            details: `${keyType} key fingerprint:\n${fingerprint}`,
            acceptLabel: 'Trust & Connect',
            rejectLabel: 'Cancel',
          },
          { signal: promptAbort.signal },
        );

        if (gitProcess.stdin) {
          gitProcess.stdin.write(accepted ? 'yes\n' : 'no\n');
        }
      }
    });

    gitProcess.on('close', (code) => {
      // Settling here rather than in the timer gives git time to unwind its own
      // partial checkout after SIGTERM, so an immediate retry into the same
      // folder is not rejected as "already exists and is not empty".
      if (timedOut) {
        settle({ success: false, error: 'Clone timed out after 10 minutes.' });
      } else if (code === 0) {
        settle({ success: true });
      } else {
        settle({ success: false, error: toFriendlyError(stderr, protocol) });
      }
    });

    gitProcess.on('error', (err) => {
      settle({ success: false, error: `Failed to run git: ${err.message}` });
    });
  });
}
