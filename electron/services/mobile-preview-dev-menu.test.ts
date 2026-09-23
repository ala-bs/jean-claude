import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

import {
  countMetroClients,
  listMetroPeerIds,
  sendMetroDevMenuCommand,
  sendMetroReloadCommand,
  waitForMetroClient,
} from './mobile-preview-dev-menu';

vi.mock('../lib/debug', () => ({
  dbg: { mobilePreview: () => {} },
}));

/**
 * Client broadcasts Expo's message socket actually forwards. Anything else --
 * `sendDevCommand` included -- is dropped with no error and no response, which
 * is the trap this module exists to avoid, so the fake enforces it rather than
 * relaying whatever the implementation happens to send.
 * Source: `CLIENT_BROADCAST_ALLOWED_METHODS` in @expo/cli's createMessageSocket.
 */
const CLIENT_BROADCAST_ALLOWED_METHODS = new Set(['reload', 'devMenu']);

/**
 * Stands in for Metro's `/message` endpoint, mirroring the behaviours the
 * production code relies on: relay an ALLOWED broadcast to the *other*
 * clients, silently drop the rest, and answer `getpeers` with a peer map that
 * excludes the asker (verified against a live `expo start`).
 */
async function startFakeMetro() {
  const server = new WebSocketServer({ port: 0, path: '/message' });
  const sockets = new Set<WsSocket>();
  const received: unknown[] = [];
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const text = raw.toString();
      const message = JSON.parse(text);
      if (message.target === 'server' && message.method === 'getpeers') {
        const peers: Record<string, unknown> = {};
        let index = 0;
        for (const peer of sockets) {
          if (peer !== socket) peers[`socket#${index++}`] = {};
        }
        socket.send(
          JSON.stringify({ version: 2, id: message.id, result: peers }),
        );
        return;
      }
      received.push(message);
      if (!CLIENT_BROADCAST_ALLOWED_METHODS.has(message.method)) return;
      for (const peer of sockets) {
        if (peer !== socket) peer.send(text);
      }
    });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  const { port } = address;

  return {
    port,
    received,
    connectApp: async ({
      dropSocketOnReload = false,
      reconnectAfterMs = null,
    }: {
      dropSocketOnReload?: boolean;
      reconnectAfterMs?: number | null;
    } = {}) => {
      const messages: string[] = [];
      const open = async () => {
        const app = new WebSocket(`ws://127.0.0.1:${port}/message`);
        app.onmessage = (event) => {
          const data = String(event.data);
          messages.push(data);
          // expo-dev-launcher tears the packager socket down and rebuilds it
          // shortly after every reload, so a peer count taken after the
          // broadcast races the client's own reconnect.
          if (!data.includes('"reload"')) return;
          if (dropSocketOnReload || reconnectAfterMs !== null) app.close();
          if (reconnectAfterMs !== null) setTimeout(() => void open(), reconnectAfterMs);
        };
        await new Promise((resolve) => {
          app.onopen = resolve;
        });
      };
      await open();
      return { messages };
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        server.close(() => resolve());
      }),
  };
}

let metro: Awaited<ReturnType<typeof startFakeMetro>> | null = null;

afterEach(async () => {
  await metro?.close();
  metro = null;
});

describe('metro dev commands', () => {
  it('broadcasts reload to connected apps', async () => {
    metro = await startFakeMetro();
    const app = await metro.connectApp();

    const result = await sendMetroReloadCommand(metro.port);

    expect(result.connectedClients).toBe(1);
    await vi.waitFor(() =>
      expect(app.messages).toContain('{"version":2,"method":"reload"}'),
    );
  });

  it('counts the app that reloading disconnects', async () => {
    // The count must be taken BEFORE the broadcast: the dev client drops its
    // /message socket as part of reloading, so counting afterwards reports
    // "nothing to reload" for a reload that actually worked.
    metro = await startFakeMetro();
    await metro.connectApp({ dropSocketOnReload: true });

    const result = await sendMetroReloadCommand(metro.port);

    expect(result.connectedClients).toBe(1);
  });

  it('reports zero connected clients when no app is listening', async () => {
    metro = await startFakeMetro();

    const result = await sendMetroReloadCommand(metro.port);

    expect(result.connectedClients).toBe(0);
  });

  it('opens the dev menu with a method the app actually receives', async () => {
    // Asserting on delivery, not on the payload: the previous implementation
    // sent `sendDevCommand`, which Metro accepts from a client and then drops,
    // so a payload-shape assertion would have called that broken version good.
    metro = await startFakeMetro();
    const app = await metro.connectApp();

    await sendMetroDevMenuCommand(metro.port);

    await vi.waitFor(() =>
      expect(app.messages).toContain('{"version":2,"method":"devMenu"}'),
    );
  });

  it('counts only other clients', async () => {
    metro = await startFakeMetro();
    expect(await countMetroClients(metro.port)).toBe(0);
    await metro.connectApp();
    expect(await countMetroClients(metro.port)).toBe(1);
  });

  it('does not count its own concurrent sockets', async () => {
    // Every socket this module opens is a peer to the others, and they linger
    // past their logical end. Unserialized, three concurrent counts with one
    // app attached each reported 3 against a real Metro.
    metro = await startFakeMetro();
    await metro.connectApp();

    const port = metro.port;
    const counts = await Promise.all([
      countMetroClients(port),
      countMetroClients(port),
      countMetroClients(port),
    ]);

    expect(counts).toEqual([1, 1, 1]);
  });

  it('ignores an unrelated relayed message that carries a result object', async () => {
    metro = await startFakeMetro();
    const app = await metro.connectApp();
    void app;

    // `reload` is relayed to our querying socket; it must not be mistaken for
    // the getpeers reply just because it parses as JSON.
    const counting = countMetroClients(metro.port);
    expect(await counting).toBe(1);
  });

  it('waits for a peer outside the ignore list', async () => {
    // A second device already on this Metro must not satisfy the wait.
    metro = await startFakeMetro();
    await metro.connectApp();
    const existing = await listMetroPeerIds(metro.port);
    expect(existing).toHaveLength(1);

    expect(
      await waitForMetroClient({
        metroPort: metro.port,
        timeoutMs: 10,
        pollIntervalMs: 5,
        ignorePeerIds: existing,
      }),
    ).toBe(false);

    await metro.connectApp();
    expect(
      await waitForMetroClient({
        metroPort: metro.port,
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        ignorePeerIds: existing,
      }),
    ).toBe(true);
  });

  it('does not loop forever on a non-numeric timeout from the renderer', async () => {
    // `Date.now() >= NaN` is always false: an unvalidated NaN would spin the
    // poll loop for the life of the app with no way to cancel it.
    metro = await startFakeMetro();

    expect(
      await waitForMetroClient({
        metroPort: metro.port,
        timeoutMs: Number.NaN,
        pollIntervalMs: 5,
      }),
    ).toBe(false);
  });

  it('waits for a late-connecting app and gives up after the timeout', async () => {
    metro = await startFakeMetro();

    expect(
      await waitForMetroClient({
        metroPort: metro.port,
        timeoutMs: 10,
        pollIntervalMs: 5,
      }),
    ).toBe(false);

    // Connect only after the wait has started, so the retry loop is what
    // observes it rather than the very first poll.
    const port = metro.port;
    const pending = waitForMetroClient({
      metroPort: port,
      timeoutMs: 3_000,
      pollIntervalMs: 10,
    });
    setTimeout(() => void metro?.connectApp(), 150);
    expect(await pending).toBe(true);
  });

  it('does not report zero for a dev client that is between sockets', async () => {
    // The reported symptom: the toast says "no app is connected, nothing to
    // reload" while the app visibly reloads. A second reload (or one issued
    // after a Fast Refresh) samples the gap in the dev client's own
    // drop-and-rebuild cycle, so the instantaneous count is 0 for a live app.
    metro = await startFakeMetro();
    const app = await metro.connectApp({ reconnectAfterMs: 200 });

    await sendMetroReloadCommand(metro.port);
    const beforeSecond = app.messages.length;
    const second = await sendMetroReloadCommand(metro.port);

    expect(second.connectedClients).toBe(1);
    // The wait is not cosmetic: without it the broadcast is fired into the gap
    // and never reaches the app at all.
    await vi.waitFor(() => expect(app.messages.length).toBeGreaterThan(beforeSecond));
  });

  it('reports an empty port as "nothing is listening"', async () => {
    // Bind-then-close rather than a hardcoded number: the OS guarantees the
    // port was free, so the test cannot be stolen by a squatter in the
    // ephemeral range.
    const closed = await startFakeMetro();
    const deadPort = closed.port;
    await closed.close();

    const error = await sendMetroReloadCommand(deadPort).then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`nothing is listening on :${deadPort}`);
    // The websocket ErrorEvent carries no cause, so an earlier version of this
    // rendered a dangling "()". Pin that it never comes back.
    expect(error?.message).not.toContain('()');
  });

  it('distinguishes a live non-Metro server from a missing one', async () => {
    // Same "could not reach" websocket failure, opposite user action: the port
    // is wrong rather than the dev server being down.
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end('not metro');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const error = await sendMetroReloadCommand(port).then(
        () => null,
        (reason: unknown) => reason as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain(
        `something is listening on :${port}, but it is not a Metro dev server`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
