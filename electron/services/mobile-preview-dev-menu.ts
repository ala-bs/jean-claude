/**
 * Drives the React Native / Expo dev commands (dev menu, reload) on whichever
 * app is connected to the dev server.
 *
 * Uses Metro's `/message` websocket — the same channel the Expo CLI uses when
 * you press `m` or `r` in its terminal — so it works for both platforms and
 * needs no device tooling.
 *
 * Two properties of that endpoint drive the shape of this module:
 *
 * 1. A *client* (which is what we are — the CLI broadcasts server-side) may
 *    only broadcast the methods in Expo's `CLIENT_BROADCAST_ALLOWED_METHODS`:
 *    `reload` and `devMenu`. Anything else, `sendDevCommand` included, is
 *    dropped silently with no error and no response. So the payloads below
 *    must stay within that set.
 * 2. Broadcasting is fire-and-forget: Metro relays to connected apps and never
 *    answers. A send therefore proves nothing about delivery. `getpeers` is
 *    the only request the endpoint answers, so it is how we tell "reloaded"
 *    apart from "no app was listening".
 *
 * `getpeers` returns a map keyed by Metro's own socket ids (`socket#7`), which
 * are unique per connection and never reused — verified against a live
 * `expo start`. That identity is what lets `waitForMetroClient` distinguish a
 * newly attached app from one that was already there.
 */
import { dbg } from '../lib/debug';

const DEV_COMMAND_TIMEOUT_MS = 4_000;

function log(format: string, ...args: unknown[]): void {
  dbg.mobilePreview(format, ...args);
}

/**
 * Time given to Metro to flush a broadcast before we disconnect. Our socket is
 * only closed after this delay, and the call only resolves once it is really
 * gone — every open socket counts as a peer, so resolving earlier would make
 * `countMetroClients` count our own connections as connected apps.
 */
const SOCKET_FLUSH_MS = 100;

/**
 * Opens a socket to Metro's `/message` endpoint and hands it to `run`, which
 * settles the returned promise via `finish` / `fail`.
 */
function withMetroSocket<T>(
  host: string,
  metroPort: number,
  description: string,
  run: (context: {
    socket: WebSocket;
    finish: (value: T) => void;
    fail: (error: Error) => void;
  }) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}:${metroPort}/message`);
    let settled = false;
    const closeSocket = () => {
      try {
        socket.close();
      } catch {
        // Socket may already be closing.
      }
    };
    const settle = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      socket.onmessage = null;
      if (error) {
        socket.onclose = null;
        closeSocket();
        reject(error);
        return;
      }
      const done = () => {
        socket.onclose = null;
        clearTimeout(closeFallback);
        resolve(value as T);
      };
      socket.onclose = done;
      // Never hang on a server that refuses to complete the close handshake.
      const closeFallback = setTimeout(done, DEV_COMMAND_TIMEOUT_MS);
      closeFallback.unref?.();
      setTimeout(closeSocket, SOCKET_FLUSH_MS).unref?.();
    };
    const timer = setTimeout(() => {
      settle(new Error(`Metro did not accept the ${description} in time`));
    }, DEV_COMMAND_TIMEOUT_MS);
    timer.unref?.();

    socket.onerror = () => {
      settle(new Error('Could not reach Metro dev server'));
    };
    run({
      socket,
      finish: (value) => settle(null, value),
      fail: (error) => settle(error),
    });
  });
}

/**
 * Serializes the sockets this module opens, per Metro port.
 *
 * Metro counts *all* connected clients as peers, including the transient
 * sockets used here, and each lingers `SOCKET_FLUSH_MS` past its logical end.
 * Verified against a real `expo start`: three concurrent peer queries with a
 * single app attached each reported 3. Overlapping operations would therefore
 * inflate every count — a reload would look delivered with no app attached,
 * and `waitForMetroClient` would return immediately.
 *
 * Keyed by port rather than global because that is the exact scope of the
 * interference: only sockets on the same dev server see each other. A global
 * queue would also make one task's unreachable port stall another task's pane
 * for the two-host timeout.
 */
const metroSocketQueues = new Map<number, Promise<unknown>>();

function queueMetroSocketWork<T>(
  metroPort: number,
  work: () => Promise<T>,
): Promise<T> {
  const tail = metroSocketQueues.get(metroPort) ?? Promise.resolve();
  const result = tail.then(work, work);
  const settled = result.catch(() => {});
  metroSocketQueues.set(metroPort, settled);
  void settled.then(() => {
    // Drop the entry once this is the last queued work for the port, so a
    // long-lived app does not accumulate one promise per port forever.
    if (metroSocketQueues.get(metroPort) === settled) {
      metroSocketQueues.delete(metroPort);
    }
  });
  return result;
}

async function onEitherLoopbackHost<T>(
  metroPort: number,
  description: string,
  attempt: (host: string) => Promise<T>,
): Promise<T> {
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
      return await attempt(host);
    } catch (error) {
      log('%s failed on %s:%d — %o', description, host, metroPort, error);
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not reach Metro dev server');
}

const GETPEERS_REQUEST_ID = 'jean-claude-getpeers';

function sendMetroMessage(
  metroPort: number,
  payload: Record<string, unknown>,
  description: string,
): Promise<void> {
  return queueMetroSocketWork(metroPort, () =>
    onEitherLoopbackHost(metroPort, description, (host) =>
      withMetroSocket<void>(host, metroPort, description, (context) => {
        context.socket.onopen = () => {
          try {
            context.socket.send(JSON.stringify(payload));
          } catch (error) {
            context.fail(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          log('sent %s to :%d (%o)', description, metroPort, payload);
          context.finish();
        };
      }),
    ),
  );
}

/**
 * Metro's socket ids for every *other* client attached to the message socket —
 * in practice the running apps, since each dev client holds one `/message`
 * connection. Metro excludes the asking socket from the reply.
 */
export function listMetroPeerIds(metroPort: number): Promise<string[]> {
  const description = 'peer query';
  return queueMetroSocketWork(metroPort, () =>
    onEitherLoopbackHost(metroPort, description, (host) =>
      withMetroSocket<string[]>(host, metroPort, description, (context) => {
        context.socket.onopen = () => {
          context.socket.send(
            JSON.stringify({
              version: 2,
              id: GETPEERS_REQUEST_ID,
              target: 'server',
              method: 'getpeers',
            }),
          );
        };
        context.socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as {
              id?: unknown;
              result?: unknown;
            };
            // Metro relays other clients' broadcasts down this same socket, so
            // match the reply by the id we sent. Without it, any relayed
            // payload carrying a `result` object would be read as the peer map
            // and its key count reported as the number of attached apps.
            if (message.id !== GETPEERS_REQUEST_ID) return;
            const peers = message.result;
            if (!peers || typeof peers !== 'object' || Array.isArray(peers)) {
              return;
            }
            const ids = Object.keys(peers);
            log('metro :%d peers %o', metroPort, ids);
            context.finish(ids);
          } catch {
            // Unrelated broadcast traffic; keep waiting for the reply.
          }
        };
      }),
    ),
  );
}

/**
 * Number of apps attached to Metro. A count of 0 means a broadcast reaches
 * nobody.
 */
export async function countMetroClients(metroPort: number): Promise<number> {
  return (await listMetroPeerIds(metroPort)).length;
}

/**
 * Upper bound on `waitForMetroClient`'s budget. The parameter crosses the IPC
 * boundary, where the TypeScript type is only a compile-time promise: a
 * renderer passing `undefined`/`NaN` would make `Date.now() >= deadline`
 * permanently false and spin the poll loop for the life of the app.
 */
const MAX_METRO_CLIENT_WAIT_MS = 60_000;
const METRO_CLIENT_POLL_INTERVAL_MS = 250;

/**
 * Polls until an app that was not already attached shows up on Metro, so
 * callers can avoid talking to an app that is still launching.
 *
 * `ignorePeerIds` is what makes this specific rather than "is anybody home":
 * the pane can have several devices on one Metro port, so "at least one peer"
 * is satisfied instantly by a *different* device's app and the wait becomes a
 * no-op. Peer ids are unique per connection and never reused, so the
 * relaunched app always arrives as an id outside the snapshot.
 *
 * Resolves `false` on timeout rather than throwing: every caller has a
 * reasonable "carry on anyway" path.
 */
export async function waitForMetroClient({
  metroPort,
  timeoutMs,
  ignorePeerIds = [],
  pollIntervalMs = METRO_CLIENT_POLL_INTERVAL_MS,
}: {
  metroPort: number;
  timeoutMs: number;
  ignorePeerIds?: readonly string[];
  pollIntervalMs?: number;
}): Promise<boolean> {
  const budgetMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, MAX_METRO_CLIENT_WAIT_MS)
      : 0;
  const intervalMs =
    Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
      ? pollIntervalMs
      : METRO_CLIENT_POLL_INTERVAL_MS;
  const ignored = new Set(ignorePeerIds);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const peers = await listMetroPeerIds(metroPort);
      if (peers.some((id) => !ignored.has(id))) return true;
    } catch (error) {
      log('peer poll failed on :%d — %o', metroPort, error);
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs).unref?.();
    });
  }
}

/**
 * `devMenu`, not `sendDevCommand`: the latter is only broadcastable by the
 * server, and Expo's message socket silently drops it from a client — so this
 * was a no-op on every platform whenever Metro was reachable (the Android
 * device-level fallback only runs when the send *throws*).
 */
export function sendMetroDevMenuCommand(metroPort: number): Promise<void> {
  return sendMetroMessage(
    metroPort,
    { version: 2, method: 'devMenu' },
    'dev menu command',
  );
}

export async function sendMetroReloadCommand(
  metroPort: number,
): Promise<{ connectedClients: number }> {
  // Counted *before* the broadcast, deliberately. expo-dev-launcher tears the
  // app's `/message` socket down and rebuilds it ~100ms after every reload
  // (RCTPackagerConnection+EXDevLauncherPackagerConnectionInterceptor), so a
  // count taken afterwards races the client's own reconnect and can report
  // "no app connected" for a reload that worked. Before the broadcast the app
  // is still attached, which is exactly the state the user asks about.
  let connectedClients = -1;
  try {
    connectedClients = await countMetroClients(metroPort);
  } catch (error) {
    // Report "unknown" rather than failing: the reload below may still work.
    log('could not count Metro clients before reload — %o', error);
  }
  await sendMetroMessage(
    metroPort,
    { version: 2, method: 'reload' },
    'reload command',
  );
  return { connectedClients };
}
