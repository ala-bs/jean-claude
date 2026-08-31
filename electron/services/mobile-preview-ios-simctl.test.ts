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
  commandExistsMock,
  installIosPreviewTestHooks,
  iosIdbAdapter,
  runCommandMock,
} from './mobile-preview-ios-test-helpers';
import { describe, expect, it, vi } from 'vitest';
import {
  parseSimctlDeviceTypes,
  parseSimctlDevices,
  parseSimctlRuntimes,
} from './mobile-preview-ios-simctl';

describe('mobile preview iOS simctl', () => {
  installIosPreviewTestHooks();

  it('maps iOS simctl devices and ignores non-iOS runtimes', () => {
    const devices = parseSimctlDevices(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
            { name: 'iPhone 16', udid: 'ios-booted', state: 'Booted' },
            { name: 'iPhone SE', udid: 'ios-shutdown', state: 'Shutdown' },
            { name: 'iPad Unknown', udid: 'ios-unknown', state: 'Creating' },
          ],
          'com.apple.CoreSimulator.SimRuntime.tvOS-18-2': [
            { name: 'Apple TV', udid: 'tvos', state: 'Booted' },
          ],
        },
      }),
    );

    expect(devices).toEqual([
      {
        id: 'ios-booted',
        name: 'iPhone 16',
        platform: 'ios',
        state: 'booted',
        osVersion: 'iOS 18.2',
      },
      {
        id: 'ios-shutdown',
        name: 'iPhone SE',
        platform: 'ios',
        state: 'shutdown',
        osVersion: 'iOS 18.2',
      },
      {
        id: 'ios-unknown',
        name: 'iPad Unknown',
        platform: 'ios',
        state: 'unknown',
        osVersion: 'iOS 18.2',
      },
    ]);
  });

  it('parses available iOS runtimes newest first', () => {
    expect(
      parseSimctlRuntimes(`{
        "runtimes": [{
          "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
          "name": "iOS 18.5",
          "version": "18.5",
          "platform": "iOS",
          "isAvailable": true
        }, {
          "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-10",
          "name": "iOS 18.10",
          "version": "18.10",
          "platform": "iOS",
          "isAvailable": true
        }, {
          "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
          "name": "iOS 17.0",
          "version": "17.0",
          "platform": "iOS",
          "isAvailable": false
        }, {
          "identifier": "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
          "name": "watchOS 11.0",
          "platform": "watchOS",
          "isAvailable": true
        }, {
          "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-Missing-Name",
          "platform": "iOS",
          "isAvailable": true
        }]
      }`),
    ).toEqual([
      {
        id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-10',
        name: 'iOS 18.10',
        version: '18.10',
        platform: 'iOS',
        available: true,
      },
      {
        id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
        name: 'iOS 18.5',
        version: '18.5',
        platform: 'iOS',
        available: true,
      },
      {
        id: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
        name: 'iOS 17.0',
        version: '17.0',
        platform: 'iOS',
        available: false,
      },
    ]);
  });

  it('rejects invalid simctl runtimes JSON', () => {
    expect(() => parseSimctlRuntimes('{')).toThrow(
      /Invalid simctl runtimes JSON/,
    );
  });

  it('rejects invalid simctl runtimes root shape', () => {
    expect(() => parseSimctlRuntimes('{"devices": {}}')).toThrow(
      /expected root runtimes array/,
    );
  });

  it('parses iPhone simulator device types', () => {
    expect(
      parseSimctlDeviceTypes(`{
        "devicetypes": [{
          "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
          "name": "iPhone 16 Pro",
          "productFamily": "iPhone",
          "screen": { "width": 1179, "height": 2556 }
        }, {
          "identifier": "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4",
          "name": "iPad Pro 13-inch (M4)",
          "productFamily": "iPad"
        }, {
          "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-Missing-Name",
          "productFamily": "iPhone"
        }]
      }`),
    ).toEqual([
      {
        id: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
        name: 'iPhone 16 Pro',
        productFamily: 'iPhone',
        screen: { width: 1179, height: 2556 },
      },
    ]);
  });

  it('rejects invalid simctl device types JSON', () => {
    expect(() => parseSimctlDeviceTypes('{')).toThrow(
      /Invalid simctl device types JSON/,
    );
  });

  it('rejects invalid simctl device types root shape', () => {
    expect(() => parseSimctlDeviceTypes('{"runtimes": []}')).toThrow(
      /expected root devicetypes array/,
    );
  });

  it('reports iOS simctl tool status', async () => {
    runCommandMock.mockResolvedValue({ stdout: '/usr/bin/xcrun\n', stderr: '' });

    await expect(iosIdbAdapter.getIosToolStatus()).resolves.toEqual({
      xcrunPath: '/usr/bin/xcrun',
      missingTools: [],
    });
    expect(runCommandMock).toHaveBeenCalledWith('which', ['xcrun']);
  });

  it('reports missing xcrun in iOS tool status', async () => {
    commandExistsMock.mockResolvedValue(false);

    await expect(iosIdbAdapter.getIosToolStatus()).resolves.toEqual({
      xcrunPath: null,
      missingTools: ['xcrun'],
    });
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('lists iOS runtimes through simctl', async () => {
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        runtimes: [
          {
            identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
            name: 'iOS 18.2',
            version: '18.2',
            platform: 'iOS',
            isAvailable: true,
          },
        ],
      }),
      stderr: '',
    });

    await expect(iosIdbAdapter.listIosRuntimes()).resolves.toEqual([
      {
        id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
        name: 'iOS 18.2',
        version: '18.2',
        platform: 'iOS',
        available: true,
      },
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'list',
      'runtimes',
      '--json',
    ]);
  });

  it('lists iOS device types through simctl', async () => {
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        devicetypes: [
          {
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
            name: 'iPhone 16',
            productFamily: 'iPhone',
          },
        ],
      }),
      stderr: '',
    });

    await expect(iosIdbAdapter.listIosDeviceTypes()).resolves.toEqual([
      {
        id: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        name: 'iPhone 16',
        productFamily: 'iPhone',
        screen: null,
      },
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'list',
      'devicetypes',
      '--json',
    ]);
  });

  it('creates an iOS simulator through simctl and returns the UDID', async () => {
    runCommandMock.mockResolvedValue({
      stdout: '  12345678-1234-1234-1234-123456789abc\n',
      stderr: '',
    });

    await expect(
      iosIdbAdapter.createIosDevice({
        name: 'Jean-Claude iPhone',
        deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      }),
    ).resolves.toBe('12345678-1234-1234-1234-123456789abc');

    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'create',
      'Jean-Claude iPhone',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
    ]);
  });

  it('rejects empty iOS simulator creation output', async () => {
    runCommandMock.mockResolvedValue({ stdout: '  \n', stderr: '' });

    await expect(
      iosIdbAdapter.createIosDevice({
        name: 'Jean-Claude iPhone',
        deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      }),
    ).rejects.toThrow(/did not return a device id/);

    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'create',
      'Jean-Claude iPhone',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
    ]);
  });

  it('deletes, erases, and renames iOS simulators through simctl', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.deleteIosDevice('device-1');
    await iosIdbAdapter.eraseIosDevice('device-1');
    await iosIdbAdapter.renameIosDevice({
      deviceId: 'device-1',
      name: 'Jean-Claude iPhone Renamed',
    });

    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'delete',
      'device-1',
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'erase',
      'device-1',
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'rename',
      'device-1',
      'Jean-Claude iPhone Renamed',
    ]);
  });

  it('rejects unsafe simctl values', async () => {
    await expect(
      iosIdbAdapter.deleteIosDevice('-delete-all'),
    ).rejects.toThrow(/cannot start with '-'/);
    await expect(
      iosIdbAdapter.createIosDevice({
        name: '',
        deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      }),
    ).rejects.toThrow(/is required/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('rejects simctl magic selectors for targeted iOS simulator actions', async () => {
    for (const selector of ['all', 'unavailable', 'booted', 'BOOTED']) {
      await expect(iosIdbAdapter.deleteIosDevice(selector)).rejects.toThrow(
        /cannot be a simctl selector/,
      );
      await expect(iosIdbAdapter.eraseIosDevice(selector)).rejects.toThrow(
        /cannot be a simctl selector/,
      );
      await expect(
        iosIdbAdapter.renameIosDevice({
          deviceId: selector,
          name: 'Jean-Claude iPhone Renamed',
        }),
      ).rejects.toThrow(/cannot be a simctl selector/);
    }

    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('lists devices without requiring idb', async () => {
    commandExistsMock.mockImplementation(
      async (command) => command === 'xcrun',
    );
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
            { name: 'iPhone 16', udid: 'ios-1', state: 'Booted' },
          ],
        },
      }),
      stderr: '',
    });

    await expect(iosIdbAdapter.listDevices()).resolves.toEqual([
      {
        id: 'ios-1',
        name: 'iPhone 16',
        platform: 'ios',
        kind: 'simulator',
        state: 'booted',
        osVersion: 'iOS 18.2',
      },
    ]);
    expect(commandExistsMock).toHaveBeenCalledWith('xcrun');
    expect(commandExistsMock).not.toHaveBeenCalledWith('idb');
  });

  it('throws actionable missing xcrun error when listing devices', async () => {
    commandExistsMock.mockImplementation(async () => false);

    await expect(iosIdbAdapter.listDevices()).rejects.toThrow(
      /Missing required iOS preview tool: xcrun.*xcode-select --install/i,
    );
  });

  it('lists devices from simctl JSON', async () => {
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
            { name: 'iPhone 16', udid: 'ios-1', state: 'Booted' },
          ],
        },
      }),
      stderr: '',
    });

    await expect(iosIdbAdapter.listDevices()).resolves.toEqual([
      {
        id: 'ios-1',
        name: 'iPhone 16',
        platform: 'ios',
        kind: 'simulator',
        state: 'booted',
        osVersion: 'iOS 18.2',
      },
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'list',
      'devices',
      '--json',
    ]);
  });

  it('throws contextual error for invalid simctl JSON root', () => {
    expect(() => parseSimctlDevices(JSON.stringify({ devices: [] }))).toThrow(
      /Invalid simctl devices JSON: expected root devices object/,
    );
  });
});
