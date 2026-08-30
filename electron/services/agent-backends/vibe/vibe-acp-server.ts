import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import {
  getChildProcessEnv,
  getEnvPoolKey,
} from '../../../lib/child-process-env';
import { dbg } from '../../../lib/debug';

import { AcpJsonRpcClient } from '../acp-json-rpc-client';

export interface VibeAcpServerHandle {
  client: AcpJsonRpcClient;
  rootPid?: number;
  dispose(): Promise<void>;
}

const APP_VERSION = '0.0.1';
const ACP_PROTOCOL_VERSION = 1;
const execFileAsync = promisify(execFile);

type VibeAcpServerState = {
  promise: Promise<VibeAcpServerHandle>;
  handle?: VibeAcpServerHandle;
};

// One server per distinct env override set. Projects with no env vars all
// share the '' entry, preserving the previous single-server behaviour.
//
// KNOWN LIMITATION: entries are only removed when their process exits, so
// editing a project env var strands the old key's server until app quit (it
// keeps running with the previous values in its environment). Acceptable for
// now because the pre-existing behaviour also leaked one server for the app's
// lifetime, but this needs refcounting or an idle reaper before env editing
// becomes common. Tracked in the follow-ups for this feature.
const serverStates = new Map<string, VibeAcpServerState>();

export async function getOrCreateVibeAcpServer(
  env?: Record<string, string>,
): Promise<VibeAcpServerHandle> {
  const poolKey = getEnvPoolKey(env);
  let serverState = serverStates.get(poolKey);

  if (serverState === undefined) {
    let state: VibeAcpServerState;
    const clearIfCurrent = () => {
      if (serverStates.get(poolKey) === state) {
        serverStates.delete(poolKey);
      }
    };

    const promise = startVibeAcpServer(clearIfCurrent, env)
      .then(async (handle) => {
        state.handle = handle;
        if (serverStates.get(poolKey) !== state) {
          await handle.dispose();
          throw new Error('Vibe ACP server startup was superseded');
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

export async function resetVibeAcpServerForTest(): Promise<void> {
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

async function startVibeAcpServer(
  clearIfCurrent: () => void,
  env?: Record<string, string>,
): Promise<VibeAcpServerHandle> {
  // Same env as the spawn below: a project-supplied PATH must resolve the same
  // binary here, or we report "not found" for a CLI that would have launched.
  await assertVibeAcpAvailable(env);

  const proc = spawn('vibe-acp', [], {
    env: getChildProcessEnv({ overrides: env }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new AcpJsonRpcClient({ process: proc });

  let terminal = false;
  const clearOnTerminal = () => {
    terminal = true;
    clearIfCurrent();
  };
  proc.on('exit', clearOnTerminal);
  proc.on('error', clearOnTerminal);

  const onStderrData = (chunk: Buffer) => {
    dbg.agent('Vibe ACP stderr: %s', chunk.toString().trimEnd());
  };
  proc.stderr.on('data', onStderrData);

  let disposed = false;

  const handle: VibeAcpServerHandle = {
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
      proc.stderr.off('data', onStderrData);
      const waitForTerminal = waitForProcessTerminal(() => terminal, proc);
      client.dispose();
      await waitForTerminal;
    },
  };

  try {
    await client.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: {
        name: 'jean_claude',
        title: 'Jean-Claude',
        version: APP_VERSION,
      },
      clientCapabilities: {
        terminal: false,
        fs: { readTextFile: false, writeTextFile: false },
        fieldMeta: { 'terminal-auth': false },
      },
    });
    await client.notify('initialized', {});
  } catch (error) {
    await handle.dispose();
    throw error;
  }

  return handle;
}

function waitForProcessTerminal(
  isTerminal: () => boolean,
  proc: ReturnType<typeof spawn>,
): Promise<void> {
  if (isTerminal()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(done, 1_000);
    timeout.unref?.();

    function done() {
      clearTimeout(timeout);
      proc.off('exit', done);
      proc.off('close', done);
      resolve();
    }

    proc.on('exit', done);
    proc.on('close', done);
  });
}

async function assertVibeAcpAvailable(
  env?: Record<string, string>,
): Promise<void> {
  try {
    await execFileAsync('vibe-acp', ['--version'], {
      env: getChildProcessEnv({ overrides: env }),
      timeout: 5_000,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(
        'Vibe ACP server not found. Install mistral-vibe, ensure `vibe-acp` is on PATH, then run setup or set MISTRAL_API_KEY.',
      );
    }

    throw new Error(
      `Unable to run Vibe ACP server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
