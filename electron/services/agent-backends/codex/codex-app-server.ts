import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import {
  getChildProcessEnv,
  getEnvPoolKey,
} from '../../../lib/child-process-env';
import { dbg } from '../../../lib/debug';

import { CodexJsonRpcClient } from './codex-json-rpc-client';

export interface CodexAppServerHandle {
  client: CodexJsonRpcClient;
  rootPid?: number;
  dispose(): Promise<void>;
}

const APP_VERSION = '0.0.1';
const execFileAsync = promisify(execFile);

type CodexAppServerState = {
  promise: Promise<CodexAppServerHandle>;
  handle?: CodexAppServerHandle;
};

// One app-server per distinct env override set. Projects with no env vars all
// share the '' entry, preserving the previous single-server behaviour.
//
// KNOWN LIMITATION: entries are only removed when their process exits, so
// editing a project env var strands the old key's server until app quit (it
// keeps running with the previous values in its environment). Acceptable for
// now because the pre-existing behaviour also leaked one server for the app's
// lifetime, but this needs refcounting or an idle reaper before env editing
// becomes common. Tracked in the follow-ups for this feature.
const serverStates = new Map<string, CodexAppServerState>();

export async function getOrCreateCodexAppServer(
  env?: Record<string, string>,
): Promise<CodexAppServerHandle> {
  const poolKey = getEnvPoolKey(env);
  let serverState = serverStates.get(poolKey);

  if (serverState === undefined) {
    let state: CodexAppServerState;
    const clearIfCurrent = () => {
      if (serverStates.get(poolKey) === state) {
        serverStates.delete(poolKey);
      }
    };

    const promise = startCodexAppServer(clearIfCurrent, env)
      .then(async (handle) => {
        state.handle = handle;
        if (serverStates.get(poolKey) !== state) {
          await handle.dispose();
          throw new Error('Codex app-server startup was superseded');
        }

        return handle;
      })
      .catch((error: unknown) => {
        clearIfCurrent();
        throw error;
      });
    state = { promise };
    serverState = state;
    serverStates.set(poolKey, state);
  }

  return serverState.promise;
}

export async function resetCodexAppServerForTest(): Promise<void> {
  const states = [...serverStates.values()];
  serverStates.clear();

  // allSettled so one failing dispose can't strand the remaining servers.
  // Only already-started servers are awaited: a startup still in flight is
  // disposed fire-and-forget, because awaiting it here would deadlock a reset
  // that happens while a caller is blocked mid-handshake.
  await Promise.allSettled(
    states
      .filter((state) => state.handle !== undefined)
      .map((state) => state.handle!.dispose()),
  );

  for (const state of states) {
    if (state.handle !== undefined) continue;
    void state.promise.then((handle) => handle.dispose()).catch(() => undefined);
  }
}

async function startCodexAppServer(
  clearIfCurrent: () => void,
  env?: Record<string, string>,
): Promise<CodexAppServerHandle> {
  // Same env as the spawn below: a project-supplied PATH must resolve the same
  // binary here, or we report "not found" for a CLI that would have launched.
  await assertCodexCliAvailable(env);

  const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
    env: getChildProcessEnv({ overrides: env }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new CodexJsonRpcClient({ process: proc });

  const clearOnTerminal = () => clearIfCurrent();
  proc.on('exit', clearOnTerminal);
  proc.on('error', clearOnTerminal);

  proc.stderr.on('data', (chunk: Buffer) => {
    dbg.agent('Codex app-server stderr: %s', chunk.toString().trimEnd());
  });

  let disposed = false;

  const handle: CodexAppServerHandle = {
    client,
    rootPid: proc.pid,
    async dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      clearIfCurrent();
      proc.off('exit', clearOnTerminal);
      proc.off('error', clearOnTerminal);
      client.dispose();
    },
  };

  try {
    await client.request('initialize', {
      clientInfo: {
        name: 'jean_claude',
        title: 'Jean-Claude',
        version: APP_VERSION,
      },
      capabilities: { experimentalApi: true },
    });
    await client.notify('initialized', {});
  } catch (error) {
    await handle.dispose();
    throw error;
  }

  return handle;
}

async function assertCodexCliAvailable(
  env?: Record<string, string>,
): Promise<void> {
  try {
    await execFileAsync('codex', ['--version'], {
      env: getChildProcessEnv({ overrides: env }),
      timeout: 5_000,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(
        'Codex CLI not found. Install Codex and ensure `codex` is on PATH, then sign in before running Codex tasks.',
      );
    }

    throw new Error(
      `Unable to run Codex CLI: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
