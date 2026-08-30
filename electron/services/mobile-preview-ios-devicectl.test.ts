vi.mock('./mobile-preview-process', () => ({
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS: 25,
  commandExists: vi.fn(),
  runCommand: vi.fn(),
  spawnManaged: vi.fn(),
}));
vi.mock('./mobile-preview-window-utils', () => ({
  IOS_SIMULATOR_PROCESS_NAMES: ['Simulator'],
  minimizeMobilePreviewWindows: vi.fn(),
}));
vi.mock('../lib/debug', () => ({
  dbg: { mobilePreview: vi.fn() },
}));

import {
  assertSimulatorOnlyIosDevice,
  installIosAppOnDevice,
  launchIosAppOnDevice,
  listDevicectlDevices,
  listInstalledIosAppBundleIdsOnDevice,
  parseDevicectlDevices,
  parseDevicectlInstalledBundleIds,
  rememberPhysicalIosDevices,
  resetDevicectlAvailabilityForTests,
  resetKnownPhysicalIosDevicesForTests,
} from './mobile-preview-ios-devicectl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commandExistsMock,
  iosIdbAdapter,
  runCommandMock,
} from './mobile-preview-ios-test-helpers';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const PHYSICAL_DEVICE = {
  identifier: 'D0C5D914-4D28-5A76-9B8E-686DB0B06995',
  connectionProperties: {
    pairingState: 'paired',
    tunnelState: 'connected',
    transportType: 'localNetwork',
    authenticationType: 'manualPairing',
  },
  deviceProperties: {
    name: 'iPhone de Patrick',
    osVersionNumber: '26.5.2',
    osBuildUpdate: '23F84',
    developerModeStatus: 'enabled',
    ddiServicesAvailable: true,
  },
  hardwareProperties: {
    platform: 'iOS',
    reality: 'physical',
    marketingName: 'iPhone 14 Pro',
    productType: 'iPhone15,2',
    deviceType: 'iPhone',
    udid: '00008120-000C4D2A0A88401E',
  },
};

function devicectlPayload(devices: unknown[]) {
  return { result: { devices } };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('parseDevicectlDevices', () => {
  it('maps a connected physical iOS device', () => {
    expect(
      parseDevicectlDevices(devicectlPayload([clone(PHYSICAL_DEVICE)])),
    ).toEqual([
      {
        id: 'D0C5D914-4D28-5A76-9B8E-686DB0B06995',
        name: 'iPhone de Patrick',
        platform: 'ios',
        kind: 'physical',
        state: 'booted',
        connection: 'connected',
        osVersion: '26.5.2',
        model: 'iPhone 14 Pro',
        connectionId: '00008120-000C4D2A0A88401E',
      },
    ]);
  });

  it('skips simulators, non-iOS platforms and malformed entries', () => {
    const simulated = clone(PHYSICAL_DEVICE);
    simulated.hardwareProperties.reality = 'simulated';
    const mac = clone(PHYSICAL_DEVICE);
    mac.hardwareProperties.platform = 'macOS';
    const nameless = clone(PHYSICAL_DEVICE) as unknown as Record<
      string,
      unknown
    >;
    delete nameless.deviceProperties;
    delete nameless.identifier;

    expect(
      parseDevicectlDevices(
        devicectlPayload([simulated, mac, nameless, null, 'nope', 42]),
      ),
    ).toEqual([]);
  });

  it('returns an empty list for malformed roots', () => {
    expect(parseDevicectlDevices(null)).toEqual([]);
    expect(parseDevicectlDevices({})).toEqual([]);
    expect(parseDevicectlDevices({ result: { devices: 'nope' } })).toEqual([]);
  });

  it('flags unpaired devices as untrusted', () => {
    const device = clone(PHYSICAL_DEVICE);
    device.connectionProperties.pairingState = 'unpaired';
    const [parsed] = parseDevicectlDevices(devicectlPayload([device]));
    expect(parsed.connection).toBe('untrusted');
    expect(parsed.state).toBe('unknown');
    expect(parsed.unavailableReason).toMatch(/Pair this device in Xcode/);
  });

  it('treats an absent pairingState as unknown rather than unpaired', () => {
    const device = clone(PHYSICAL_DEVICE) as unknown as {
      connectionProperties: Record<string, unknown>;
    };
    delete device.connectionProperties.pairingState;
    const [parsed] = parseDevicectlDevices(devicectlPayload([device]));
    expect(parsed.connection).toBe('connected');
    expect(parsed.unavailableReason).toBeUndefined();
  });

  it('keeps a device whose platform is absent', () => {
    const device = clone(PHYSICAL_DEVICE) as unknown as {
      hardwareProperties: Record<string, unknown>;
    };
    delete device.hardwareProperties.platform;
    expect(parseDevicectlDevices(devicectlPayload([device]))).toHaveLength(1);
  });

  it('flags disabled developer mode as untrusted', () => {
    const device = clone(PHYSICAL_DEVICE);
    device.deviceProperties.developerModeStatus = 'disabled';
    const [parsed] = parseDevicectlDevices(devicectlPayload([device]));
    expect(parsed.connection).toBe('untrusted');
    expect(parsed.unavailableReason).toMatch(/Developer Mode/);
  });

  it('flags unreachable devices as unavailable', () => {
    const device = clone(PHYSICAL_DEVICE);
    device.connectionProperties.tunnelState = 'unavailable';
    const [parsed] = parseDevicectlDevices(devicectlPayload([device]));
    expect(parsed.connection).toBe('unavailable');
    expect(parsed.state).toBe('unknown');
    expect(parsed.unavailableReason).toMatch(/not reachable/);
  });

  it('does not treat a lazily-established tunnel as unreachable', () => {
    // Real devices report tunnelState "disconnected" + ddiServicesAvailable
    // false while devicectl still lists them as "available (paired)".
    const device = clone(PHYSICAL_DEVICE);
    device.connectionProperties.tunnelState = 'disconnected';
    device.deviceProperties.ddiServicesAvailable = false;
    const [parsed] = parseDevicectlDevices(devicectlPayload([device]));
    expect(parsed.connection).toBe('connected');
    expect(parsed.state).toBe('booted');
  });
});

describe('listDevicectlDevices', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    resetKnownPhysicalIosDevicesForTests();
    resetDevicectlAvailabilityForTests();
    await mkdir(tmpdir(), { recursive: true });
    commandExistsMock.mockResolvedValue(true);
  });

  it('writes JSON to a temp file, parses it and cleans it up', async () => {
    let jsonPath: string | undefined;
    runCommandMock.mockImplementation(async (_command, args) => {
      jsonPath = args[args.indexOf('--json-output') + 1];
      await writeFile(
        jsonPath,
        JSON.stringify(devicectlPayload([clone(PHYSICAL_DEVICE)])),
      );
      return { stdout: '', stderr: '' };
    });

    const { ok, devices } = await listDevicectlDevices();
    expect(ok).toBe(true);
    expect(devices).toHaveLength(1);
    expect(devices[0].kind).toBe('physical');
    expect(runCommandMock).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['devicectl', 'list', 'devices', '--json-output']),
      expect.anything(),
    );
    const { access } = await import('node:fs/promises');
    await expect(access(jsonPath!)).rejects.toThrow();
  });

  it('reports ok:false with no devices when devicectl fails', async () => {
    runCommandMock.mockRejectedValue(new Error('xcrun: devicectl not found'));
    await expect(listDevicectlDevices()).resolves.toEqual({
      ok: false,
      devices: [],
    });
  });

  it('distinguishes a successful empty listing from a failed one', async () => {
    runCommandMock.mockImplementation(async (_command, args) => {
      const index = args.indexOf('--json-output');
      if (index >= 0) {
        await writeFile(args[index + 1], JSON.stringify(devicectlPayload([])));
      }
      return { stdout: '', stderr: '' };
    });
    await expect(listDevicectlDevices()).resolves.toEqual({
      ok: true,
      devices: [],
    });
  });
});

describe('devicectl install and launch', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    resetKnownPhysicalIosDevicesForTests();
    resetDevicectlAvailabilityForTests();
    await mkdir(tmpdir(), { recursive: true });
    commandExistsMock.mockResolvedValue(true);
  });

  function mockJsonOutput(payload: unknown) {
    runCommandMock.mockImplementation(async (_command, args) => {
      const index = args.indexOf('--json-output');
      if (index >= 0) await writeFile(args[index + 1], JSON.stringify(payload));
      return { stdout: '', stderr: '' };
    });
  }

  it('installs an app and returns the installed bundle id', async () => {
    mockJsonOutput({
      result: {
        installedApplications: [
          {
            bundleID: 'com.example.app',
            installationURL: 'file:///private/var/containers/Bundle/App.app/',
          },
        ],
      },
    });

    await expect(
      installIosAppOnDevice({ deviceId: 'device-1', appPath: '/tmp/App.app' }),
    ).resolves.toEqual({
      bundleId: 'com.example.app',
      installationUrl: 'file:///private/var/containers/Bundle/App.app/',
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining([
        'devicectl',
        'device',
        'install',
        'app',
        '--device',
        'device-1',
        '/tmp/App.app',
      ]),
      expect.anything(),
    );
  });

  it('launches an app and returns the pid', async () => {
    mockJsonOutput({ result: { process: { processIdentifier: 10684 } } });

    await expect(
      launchIosAppOnDevice({
        deviceId: 'device-1',
        bundleId: 'com.example.app',
        launchArgs: ['dev'],
      }),
    ).resolves.toEqual({ processIdentifier: 10684 });
    const args = runCommandMock.mock.calls.at(-1)![1];
    expect(args.slice(0, 8)).toEqual([
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      'device-1',
      '--terminate-existing',
      'com.example.app',
    ]);
    expect(args).toContain('dev');
  });

  it('rejects launch arguments that would parse as devicectl options', async () => {
    mockJsonOutput({ result: { process: { processIdentifier: 1 } } });

    await expect(
      launchIosAppOnDevice({
        deviceId: 'device-1',
        bundleId: 'com.example.app',
        launchArgs: ['--json-output'],
      }),
    ).rejects.toThrow(/launch argument cannot start with '-'/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('probes devicectl availability only once per process', async () => {
    mockJsonOutput({ result: { process: { processIdentifier: 1 } } });

    await launchIosAppOnDevice({
      deviceId: 'device-1',
      bundleId: 'com.example.app',
    });
    await launchIosAppOnDevice({
      deviceId: 'device-1',
      bundleId: 'com.example.app',
    });

    expect(commandExistsMock).toHaveBeenCalledTimes(1);
    const versionCalls = runCommandMock.mock.calls.filter(
      ([, args]) => args[1] === '--version',
    );
    expect(versionCalls).toHaveLength(1);
  });

  it('throws when install returns no installed application', async () => {
    mockJsonOutput({ result: { deviceIdentifier: 'device-1' } });

    await expect(
      installIosAppOnDevice({ deviceId: 'device-1', appPath: '/tmp/App.app' }),
    ).rejects.toThrow(
      /succeeded but returned no installed application \(result keys: deviceIdentifier\)/,
    );
  });

  it('throws when install returns an empty installedApplications array', async () => {
    mockJsonOutput({ result: { installedApplications: [] } });

    await expect(
      installIosAppOnDevice({ deviceId: 'device-1', appPath: '/tmp/App.app' }),
    ).rejects.toThrow(/returned no installed application/);
  });

  it('throws when the installed application has no bundleID', async () => {
    mockJsonOutput({
      result: { installedApplications: [{ bundleId: 'com.example.app' }] },
    });

    await expect(
      installIosAppOnDevice({ deviceId: 'device-1', appPath: '/tmp/App.app' }),
    ).rejects.toThrow(/without a bundleID \(application keys: bundleId\)/);
  });

  it('accepts an install without an installationURL', async () => {
    mockJsonOutput({
      result: { installedApplications: [{ bundleID: 'com.example.app' }] },
    });

    await expect(
      installIosAppOnDevice({ deviceId: 'device-1', appPath: '/tmp/App.app' }),
    ).resolves.toEqual({
      bundleId: 'com.example.app',
      installationUrl: null,
    });
  });

  it('throws when launch returns no process', async () => {
    mockJsonOutput({ result: { deviceIdentifier: 'device-1' } });

    await expect(
      launchIosAppOnDevice({
        deviceId: 'device-1',
        bundleId: 'com.example.app',
      }),
    ).rejects.toThrow(
      /succeeded but returned no process \(result keys: deviceIdentifier\)/,
    );
  });

  it('throws when launch returns no processIdentifier', async () => {
    mockJsonOutput({ result: { process: { pid: 10684 } } });

    await expect(
      launchIosAppOnDevice({
        deviceId: 'device-1',
        bundleId: 'com.example.app',
      }),
    ).rejects.toThrow(/returned no processIdentifier \(process keys: pid\)/);
  });

  it('throws a descriptive error when launching fails', async () => {
    runCommandMock.mockImplementation(async (_command, args) => {
      if (args[1] === '--version') return { stdout: '518', stderr: '' };
      throw new Error('device locked');
    });

    await expect(
      launchIosAppOnDevice({ deviceId: 'device-1', bundleId: 'com.example' }),
    ).rejects.toThrow(/Failed to launch com.example on iOS device device-1/);
  });

  it('lists installed bundle ids from a well-formed app listing', async () => {
    mockJsonOutput({
      result: {
        apps: [
          { bundleIdentifier: 'com.example.app', name: 'Example' },
          { bundleIdentifier: 'com.other.app' },
        ],
      },
    });

    await expect(
      listInstalledIosAppBundleIdsOnDevice({ deviceId: 'device-1' }),
    ).resolves.toEqual(['com.example.app', 'com.other.app']);
    expect(runCommandMock).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining([
        'devicectl',
        'device',
        'info',
        'apps',
        '--device',
        'device-1',
      ]),
      expect.anything(),
    );
  });

  it('throws when the app listing has an unexpected shape', async () => {
    mockJsonOutput({ result: { applications: [] } });

    await expect(
      listInstalledIosAppBundleIdsOnDevice({ deviceId: 'device-1' }),
    ).rejects.toThrow(/no 'apps' array \(result keys: applications\)/);
  });
});

describe('parseDevicectlInstalledBundleIds', () => {
  it('throws when there is no result object', () => {
    expect(() => parseDevicectlInstalledBundleIds({ error: 'x' })).toThrow(
      /no result object \(top-level keys: error\)/,
    );
  });

  it('throws on an empty apps array rather than reporting "not installed"', () => {
    expect(() =>
      parseDevicectlInstalledBundleIds({ result: { apps: [] } }),
    ).toThrow(/empty 'apps' array/);
  });

  it('throws when an entry has no bundleIdentifier', () => {
    expect(() =>
      parseDevicectlInstalledBundleIds({
        result: { apps: [{ bundleID: 'com.example.app' }] },
      }),
    ).toThrow(/entry 0 has no bundleIdentifier \(entry keys: bundleID\)/);
  });
});

describe('physical iOS device guards', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    resetKnownPhysicalIosDevicesForTests();
    resetDevicectlAvailabilityForTests();
    await mkdir(tmpdir(), { recursive: true });
    commandExistsMock.mockResolvedValue(true);
  });

  it('throws a tailored error for known physical devices', () => {
    rememberPhysicalIosDevices({
      devices: parseDevicectlDevices(
        devicectlPayload([clone(PHYSICAL_DEVICE)]),
      ),
      listingSucceeded: true,
    });

    expect(() =>
      assertSimulatorOnlyIosDevice({
        deviceId: 'D0C5D914-4D28-5A76-9B8E-686DB0B06995',
        capability: 'Live screen streaming',
      }),
    ).toThrow(
      'Live screen streaming is not supported on physical iOS devices. iPhone de Patrick can only be listed and inspected for now — live preview, input, deeplinks and appearance control are simulator-only.',
    );
    expect(() =>
      assertSimulatorOnlyIosDevice({
        deviceId: 'simulator-1',
        capability: 'Live screen streaming',
      }),
    ).not.toThrow();
  });

  it('lists simulators and physical devices together', async () => {
    runCommandMock.mockImplementation(async (_command, args) => {
      if (args[0] === 'devicectl') {
        const index = args.indexOf('--json-output');
        if (index >= 0) {
          await writeFile(
            args[index + 1],
            JSON.stringify(devicectlPayload([clone(PHYSICAL_DEVICE)])),
          );
        }
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
              { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
            ],
          },
        }),
        stderr: '',
      };
    });

    const devices = await iosIdbAdapter.listDevices();
    expect(devices.map((device) => [device.id, device.kind])).toEqual([
      ['device-1', 'simulator'],
      ['D0C5D914-4D28-5A76-9B8E-686DB0B06995', 'physical'],
    ]);

    await expect(
      iosIdbAdapter.setColorScheme(
        'D0C5D914-4D28-5A76-9B8E-686DB0B06995',
        'dark',
      ),
    ).rejects.toThrow(/not supported on physical iOS devices/);
  });

  it('keeps guarding a physical device after a failed devicectl refresh', async () => {
    const simctlPayload = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
          { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
        ],
      },
    });

    runCommandMock.mockImplementation(async (_command, args) => {
      if (args[0] === 'devicectl') {
        const index = args.indexOf('--json-output');
        if (index >= 0) {
          await writeFile(
            args[index + 1],
            JSON.stringify(devicectlPayload([clone(PHYSICAL_DEVICE)])),
          );
        }
        return { stdout: '', stderr: '' };
      }
      return { stdout: simctlPayload, stderr: '' };
    });
    await iosIdbAdapter.listDevices();

    // A routine refresh where devicectl times out must not empty the registry.
    runCommandMock.mockImplementation(async (_command, args) => {
      if (args[0] === 'devicectl') throw new Error('devicectl timed out');
      return { stdout: simctlPayload, stderr: '' };
    });
    const devices = await iosIdbAdapter.listDevices();
    expect(devices.map((device) => device.id)).toEqual(['device-1']);

    await expect(
      iosIdbAdapter.setColorScheme(
        'D0C5D914-4D28-5A76-9B8E-686DB0B06995',
        'dark',
      ),
    ).rejects.toThrow(/not supported on physical iOS devices/);
  });
});

/**
 * Regression fixtures captured verbatim from a real
 * `xcrun devicectl list devices --json-output` run (devicectl 518.33, Xcode 26).
 *
 * These encode two facts that hand-written fixtures got wrong, and that caused
 * every real iPhone to be reported as unreachable:
 *
 *  1. A device devicectl's own table shows as "available (paired)" sits at
 *     `tunnelState: "disconnected"` with `ddiServicesAvailable: false`. The
 *     availability marker is `tunnelState === "unavailable"`, not
 *     `=== "connected"`, and DDI availability says nothing about readiness.
 *  2. Stale CoreDevice pairing records omit `hardwareProperties.reality` and
 *     `deviceProperties.developerModeStatus` entirely. They must still be
 *     listed (devicectl lists them), and a missing developerModeStatus must not
 *     be reported as "Developer Mode disabled".
 */
describe('parseDevicectlDevices — real CoreDevice payloads', () => {
  const availableButTunnelDisconnected = {
    identifier: 'D0C5D914-4D28-5A76-9B8E-686DB0B06995',
    connectionProperties: {
      authenticationType: 'manualPairing',
      pairingState: 'paired',
      transportType: 'localNetwork',
      tunnelState: 'disconnected',
      tunnelTransportProtocol: 'tcp',
    },
    deviceProperties: {
      name: 'iPhone de Patrick',
      osVersionNumber: '26.5.2',
      developerModeStatus: 'enabled',
      ddiServicesAvailable: false,
    },
    hardwareProperties: {
      platform: 'iOS',
      reality: 'physical',
      marketingName: 'iPhone 14 Pro',
      productType: 'iPhone15,2',
    },
  };

  const stalePairingRecord = {
    identifier: '33249904-6C1E-582A-99BD-7A15E3554F37',
    connectionProperties: {
      pairingState: 'paired',
      tunnelState: 'unavailable',
    },
    deviceProperties: { name: 'iPhone', osVersionNumber: '26.2', ddiServicesAvailable: false },
    hardwareProperties: { platform: 'iOS' },
  };

  it('treats a paired device with a disconnected tunnel as connected', () => {
    const [device] = parseDevicectlDevices({
      result: { devices: [availableButTunnelDisconnected] },
    });

    expect(device).toMatchObject({
      id: 'D0C5D914-4D28-5A76-9B8E-686DB0B06995',
      name: 'iPhone de Patrick',
      platform: 'ios',
      kind: 'physical',
      state: 'booted',
      connection: 'connected',
      model: 'iPhone 14 Pro',
      osVersion: '26.5.2',
    });
    expect(device?.unavailableReason).toBeUndefined();
  });

  it('keeps stale pairing records that omit reality, without blaming Developer Mode', () => {
    const [device] = parseDevicectlDevices({
      result: { devices: [stalePairingRecord] },
    });

    expect(device).toMatchObject({
      id: '33249904-6C1E-582A-99BD-7A15E3554F37',
      kind: 'physical',
      state: 'unknown',
      connection: 'unavailable',
    });
    expect(device?.unavailableReason).toMatch(/not reachable/i);
  });

  it('reports tunnelState "unavailable" as the only absence marker', () => {
    const devices = parseDevicectlDevices({
      result: {
        devices: [availableButTunnelDisconnected, stalePairingRecord],
      },
    });

    expect(devices).toHaveLength(2);
    expect(devices.map((device) => device.connection)).toEqual([
      'connected',
      'unavailable',
    ]);
  });
});

/**
 * Regression: a physical iPhone carries two different identifiers and they are
 * NOT interchangeable. Passing the CoreDevice `identifier` to `expo run:ios`
 * fails at runtime with:
 *   CommandError: No device UDID or name matching "d0c5d914-..."
 * because the RN/Expo CLIs match on the hardware UDID. Both values are present
 * on every device in real `devicectl list devices` output.
 */
describe('parseDevicectlDevices — CoreDevice identifier vs hardware UDID', () => {
  it('exposes the hardware UDID as connectionId, keeping identifier as id', () => {
    const [device] = parseDevicectlDevices(
      devicectlPayload([clone(PHYSICAL_DEVICE)]),
    );

    expect(device.id).toBe('D0C5D914-4D28-5A76-9B8E-686DB0B06995');
    expect(device.connectionId).toBe('00008120-000C4D2A0A88401E');
    expect(device.connectionId).not.toBe(device.id);
  });

  it('omits connectionId when the payload has no hardware udid', () => {
    const device = clone(PHYSICAL_DEVICE) as unknown as {
      hardwareProperties: Record<string, unknown>;
    };
    delete device.hardwareProperties.udid;
    const [parsed] = parseDevicectlDevices(devicectlPayload([device]));

    expect(parsed.connectionId).toBeUndefined();
    expect(parsed.id).toBe('D0C5D914-4D28-5A76-9B8E-686DB0B06995');
  });
});
