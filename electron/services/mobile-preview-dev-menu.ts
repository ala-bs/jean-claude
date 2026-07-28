/**
 * Drives the React Native / Expo dev commands (dev menu, reload) on whichever
 * app is connected to the dev server.
 *
 * Uses Metro's `/message` websocket — the same channel the Expo CLI uses when
 * you press `m` or `r` in its terminal — so it works for both platforms and
 * needs no device tooling.
 */
const DEV_COMMAND_TIMEOUT_MS = 4_000;

async function sendToHost(
  host: string,
  metroPort: number,
  payload: Record<string, unknown>,
  description: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${metroPort}/message`);
    let settled = false;
    const closeSocket = () => {
      try {
        socket.close();
      } catch {
        // Socket may already be closing.
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      if (error) {
        closeSocket();
        reject(error);
      } else {
        // Give Metro a tick to flush before tearing the socket down.
        setTimeout(closeSocket, 100).unref?.();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`Metro did not accept the ${description} in time`));
    }, DEV_COMMAND_TIMEOUT_MS);
    timer.unref?.();

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      finish();
    };
    socket.onerror = () => {
      finish(new Error('Could not reach Metro dev server'));
    };
  });
}

async function sendMetroMessage(
  metroPort: number,
  payload: Record<string, unknown>,
  description: string,
): Promise<void> {
  if (!Number.isInteger(metroPort) || metroPort < 1 || metroPort > 65_535) {
    throw new Error('Invalid Metro port');
  }
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket is not available in this runtime');
  }

  // Metro may bind the IPv6 wildcard only; `localhost` also resolves to ::1.
  let lastError: unknown;
  for (const host of ['127.0.0.1', 'localhost']) {
    try {
      await sendToHost(host, metroPort, payload, description);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not reach Metro dev server');
}

export function sendMetroDevMenuCommand(metroPort: number): Promise<void> {
  return sendMetroMessage(
    metroPort,
    { version: 2, method: 'sendDevCommand', params: { name: 'toggleDevMenu' } },
    'dev menu command',
  );
}

export function sendMetroReloadCommand(metroPort: number): Promise<void> {
  return sendMetroMessage(
    metroPort,
    { version: 2, method: 'reload' },
    'reload command',
  );
}
