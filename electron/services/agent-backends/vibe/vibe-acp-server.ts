import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { dbg } from '../../../lib/debug';
import { getChildProcessEnv } from '../../../lib/child-process-env';

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

let serverState: VibeAcpServerState | undefined;

export async function getOrCreateVibeAcpServer(): Promise<VibeAcpServerHandle> {
  if (serverState === undefined) {
    let state: VibeAcpServerState;
    const clearIfCurrent = () => {
      if (serverState === state) {
        serverState = undefined;
      }
    };

    const promise = startVibeAcpServer(clearIfCurrent)
      .then(async (handle) => {
        state.handle = handle;
        if (serverState !== state) {
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
  }

  return serverState.promise;
}

export async function resetVibeAcpServerForTest(): Promise<void> {
  const state = serverState;
  serverState = undefined;

  if (state === undefined) {
    return;
  }

  if (state.handle !== undefined) {
    await state.handle.dispose();
    return;
  }

  void state.promise.then((handle) => handle.dispose()).catch(() => undefined);
}

async function startVibeAcpServer(
  clearIfCurrent: () => void,
): Promise<VibeAcpServerHandle> {
  await assertVibeAcpAvailable();

  const proc = spawn('vibe-acp', [], {
    env: getChildProcessEnv(),
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

async function assertVibeAcpAvailable(): Promise<void> {
  try {
    await execFileAsync('vibe-acp', ['--version'], {
      env: getChildProcessEnv(),
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
