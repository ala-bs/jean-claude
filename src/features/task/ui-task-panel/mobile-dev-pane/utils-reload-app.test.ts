import { describe, expect, it, vi } from 'vitest';

import { reloadAppOnMetro } from './utils-reload-app';

const DEVICE = { id: 'sim-1', platform: 'ios' as const };

function makeApi({
  connectedClients,
  launchExpo = vi.fn().mockResolvedValue(undefined),
}: {
  connectedClients: number;
  launchExpo?: ReturnType<typeof vi.fn>;
}) {
  return {
    reloadExpo: vi.fn().mockResolvedValue({ connectedClients }),
    launchExpo,
  };
}

function call(
  api: ReturnType<typeof makeApi>,
  overrides: Partial<Parameters<typeof reloadAppOnMetro>[0]> = {},
) {
  return reloadAppOnMetro({
    api: api as unknown as Parameters<typeof reloadAppOnMetro>[0]['api'],
    metroPort: 49801,
    projectId: 'p1',
    taskId: 't1',
    appPath: '/app',
    device: DEVICE,
    reattach: { metroPort: 49801, appScheme: 'myapp' },
    ...overrides,
  });
}

describe('reloadAppOnMetro', () => {
  it('reports a plain reload when an app is attached', async () => {
    const api = makeApi({ connectedClients: 1 });
    await expect(call(api)).resolves.toEqual({ status: 'reloaded' });
    expect(api.launchExpo).not.toHaveBeenCalled();
  });

  it('does not deeplink when the peer count is unknown', async () => {
    // -1 means "could not count", not "nobody": repairing here would hard
    // reload a live app every time the peer query failed.
    const api = makeApi({ connectedClients: -1 });
    await expect(call(api)).resolves.toEqual({ status: 'reloaded' });
    expect(api.launchExpo).not.toHaveBeenCalled();
  });

  it('re-attaches the app when nothing is connected to this Metro', async () => {
    // The real-world case: the simulator app is still bound to another
    // worktree's Metro, so the broadcast reaches nobody.
    const api = makeApi({ connectedClients: 0 });
    await expect(call(api)).resolves.toEqual({
      status: 'reattached',
      metroPort: 49801,
    });
    expect(api.launchExpo).toHaveBeenCalledWith(
      expect.objectContaining({
        metroPort: 49801,
        appScheme: 'myapp',
        deviceId: 'sim-1',
        platform: 'ios',
      }),
    );
  });

  it('uses a fresh requestId per call so launches cannot supersede each other', async () => {
    const api = makeApi({ connectedClients: 0 });
    await call(api);
    await call(api);
    const [first, second] = api.launchExpo.mock.calls.map(
      (args) => (args[0] as { requestId: string }).requestId,
    );
    expect(first).not.toEqual(second);
  });

  it('reports no-client when the app cannot be deeplinked', async () => {
    const api = makeApi({ connectedClients: 0 });
    await expect(call(api, { reattach: null })).resolves.toEqual({
      status: 'no-client',
    });
    expect(api.launchExpo).not.toHaveBeenCalled();
  });

  it('reports no-client when no device is selected', async () => {
    const api = makeApi({ connectedClients: 0 });
    await expect(call(api, { device: null })).resolves.toEqual({
      status: 'no-client',
    });
    expect(api.launchExpo).not.toHaveBeenCalled();
  });

  it('propagates a reloadExpo failure to the caller', async () => {
    // Must NOT be swallowed into `no-client`: the pane's catch block is what
    // adds the port-provenance context to a genuine Metro/IPC failure, and
    // "no app is connected -- open it and try again" would be actively
    // misleading advice for an unreachable dev server.
    const error = new Error('Could not reach the Metro dev server');
    const api = {
      reloadExpo: vi.fn().mockRejectedValue(error),
      launchExpo: vi.fn(),
    };
    await expect(call(api)).rejects.toThrow(
      'Could not reach the Metro dev server',
    );
    expect(api.launchExpo).not.toHaveBeenCalled();
  });

  it('surfaces a failed re-attach separately from a missing app', async () => {
    const error = new Error('simctl openurl failed');
    const api = makeApi({
      connectedClients: 0,
      launchExpo: vi.fn().mockRejectedValue(error),
    });
    await expect(call(api)).resolves.toEqual({
      status: 'reattach-failed',
      error,
    });
  });
});
