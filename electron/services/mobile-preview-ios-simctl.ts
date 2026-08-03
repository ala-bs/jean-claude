import type {
  MobilePreviewDevice,
  MobilePreviewIosDeviceType,
  MobilePreviewIosRuntime,
} from '../../shared/mobile-simulator-types';

import { commandExists, runCommand } from './mobile-preview-process';
import {
  debug,
  isIosPreviewDisposed,
  pendingIosSimulatorBootsByDeviceId,
} from './mobile-preview-ios-shared-state';
import {
  IOS_SIMULATOR_PROCESS_NAMES,
  minimizeMobilePreviewWindows,
} from './mobile-preview-window-utils';

type SimctlDevice = {
  name?: unknown;
  udid?: unknown;
  state?: unknown;
};

type SimctlDevicesResponse = {
  devices?: Record<string, SimctlDevice[]>;
};

const IOS_RUNTIME_PREFIX = 'com.apple.CoreSimulator.SimRuntime.iOS-';

export function assertDeeplinkUrl(url: string): void {
  if (!url.trim()) {
    throw new Error('Deeplink URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Deeplink URL must include a valid scheme');
  }

  if (!parsed.protocol || parsed.protocol === 'file:') {
    throw new Error('Unsupported deeplink URL scheme');
  }
}

export function getPendingIosBootWaiterCountForTests(deviceId: string): number {
  return pendingIosSimulatorBootsByDeviceId.get(deviceId)?.waiters.size ?? 0;
}

export async function getCommandPath(command: string): Promise<string> {
  try {
    const { stdout } = await runCommand('which', [command]);
    return stdout.trim() || '(not found)';
  } catch (error) {
    return `lookup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function assertXcrunAvailable(signal?: AbortSignal): Promise<void> {
  const available = signal
    ? await commandExists('xcrun', { signal })
    : await commandExists('xcrun');
  if (!available) {
    throw new Error(
      'Missing required iOS preview tool: xcrun. Install Xcode Command Line Tools with `xcode-select --install` to list and boot iOS simulators.',
    );
  }
}

export async function assertIdbAvailable(signal?: AbortSignal): Promise<void> {
  if (!(await commandExists('idb', signal ? { signal } : undefined))) {
    throw new Error(
      'Missing required iOS preview tool: idb. Install iOS streaming tools: `brew tap facebook/fb && brew install idb-companion` and `python3 -m pip install fb-idb` (or `pipx install fb-idb`). Then ensure the `idb` command is on PATH and restart Jean-Claude.',
    );
  }
}

export function mapDeviceState(state: unknown): MobilePreviewDevice['state'] {
  if (state === 'Booted') return 'booted';
  if (state === 'Shutdown') return 'shutdown';
  return 'unknown';
}

function formatIosRuntimeVersion(runtime: string): string {
  const version = runtime.slice(IOS_RUNTIME_PREFIX.length).replaceAll('-', '.');
  return `iOS ${version}`;
}

export function parseSimctlDevices(json: string): MobilePreviewDevice[] {
  let parsed: SimctlDevicesResponse;

  try {
    parsed = JSON.parse(json) as SimctlDevicesResponse;
  } catch (error) {
    throw new Error(
      `Invalid simctl devices JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.devices ||
    typeof parsed.devices !== 'object' ||
    Array.isArray(parsed.devices)
  ) {
    throw new Error(
      'Invalid simctl devices JSON: expected root devices object.',
    );
  }

  return Object.entries(parsed.devices).flatMap(([runtime, devices]) => {
    if (!runtime.startsWith(IOS_RUNTIME_PREFIX)) return [];
    if (!Array.isArray(devices)) return [];

    return devices.flatMap((device) => {
      if (typeof device.udid !== 'string' || typeof device.name !== 'string') {
        return [];
      }

      return [
        {
          id: device.udid,
          name: device.name,
          platform: 'ios' as const,
          state: mapDeviceState(device.state),
          osVersion: formatIosRuntimeVersion(runtime),
        },
      ];
    });
  });
}

export function parseSimctlRuntimes(
  json: string,
): MobilePreviewIosRuntime[] {
  let parsed: { runtimes?: unknown };

  try {
    parsed = JSON.parse(json) as { runtimes?: unknown };
  } catch (error) {
    throw new Error(
      `Invalid simctl runtimes JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.runtimes)) {
    throw new Error(
      'Invalid simctl runtimes JSON: expected root runtimes array.',
    );
  }

  return parsed.runtimes
    .filter(
      (runtime): runtime is Record<string, unknown> =>
        !!runtime && typeof runtime === 'object',
    )
    .filter((runtime) => runtime.platform === 'iOS')
    .map((runtime) => ({
      id: typeof runtime.identifier === 'string' ? runtime.identifier : '',
      name: typeof runtime.name === 'string' ? runtime.name : '',
      version: typeof runtime.version === 'string' ? runtime.version : null,
      platform: 'iOS',
      available: runtime.isAvailable === true,
    }))
    .filter((runtime) => runtime.id && runtime.name)
    .sort((a, b) =>
      (b.version ?? b.name).localeCompare(a.version ?? a.name, undefined, {
        numeric: true,
      }),
    );
}

export function parseSimctlDeviceTypes(
  json: string,
): MobilePreviewIosDeviceType[] {
  let parsed: { devicetypes?: unknown };

  try {
    parsed = JSON.parse(json) as { devicetypes?: unknown };
  } catch (error) {
    throw new Error(
      `Invalid simctl device types JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.devicetypes)
  ) {
    throw new Error(
      'Invalid simctl device types JSON: expected root devicetypes array.',
    );
  }

  return parsed.devicetypes
    .filter(
      (deviceType): deviceType is Record<string, unknown> =>
        !!deviceType && typeof deviceType === 'object',
    )
    .map((deviceType) => ({
      id:
        typeof deviceType.identifier === 'string' ? deviceType.identifier : '',
      name: typeof deviceType.name === 'string' ? deviceType.name : '',
      productFamily:
        typeof deviceType.productFamily === 'string'
          ? deviceType.productFamily
          : null,
      screen: parseIosDeviceTypeScreen(deviceType),
    }))
    .filter(
      (deviceType) =>
        deviceType.id &&
        deviceType.name &&
        deviceType.productFamily === 'iPhone',
    );
}

function parseIosDeviceTypeScreen(deviceType: Record<string, unknown>) {
  const screen = deviceType.screen;
  if (screen && typeof screen === 'object' && !Array.isArray(screen)) {
    const width = Number((screen as Record<string, unknown>).width);
    const height = Number((screen as Record<string, unknown>).height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const width = Number(deviceType.width ?? deviceType.screenWidth);
  const height = Number(deviceType.height ?? deviceType.screenHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }

  return null;
}

export function assertDeviceId(deviceId: string): void {
  if (!deviceId.trim()) {
    throw new Error('iOS simulator deviceId is required.');
  }
}

export function assertSafeSimctlValue(label: string, value: string): void {
  if (!value.trim()) {
    throw new Error(`${label} is required.`);
  }

  if (value.startsWith('-')) {
    throw new Error(`${label} cannot start with '-'.`);
  }
}

export function assertSafeSimctlDeviceSelector(label: string, value: string): void {
  assertSafeSimctlValue(label, value);

  const selector = value.trim().toLowerCase();
  if (
    selector === 'all' ||
    selector === 'unavailable' ||
    selector === 'booted'
  ) {
    throw new Error(`${label} cannot be a simctl selector: ${value}.`);
  }
}

export async function getDevice(
  deviceId: string,
  signal: AbortSignal,
): Promise<MobilePreviewDevice | null> {
  const { stdout } = await runCommand(
    'xcrun',
    ['simctl', 'list', 'devices', '--json'],
    { signal },
  );
  return (
    parseSimctlDevices(stdout).find((device) => device.id === deviceId) ?? null
  );
}

export async function ensureIosSimulatorBooted(
  deviceId: string,
  signal?: AbortSignal,
): Promise<MobilePreviewDevice> {
  if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');
  let entry = pendingIosSimulatorBootsByDeviceId.get(deviceId);
  if (entry?.abortController.signal.aborted) {
    if (pendingIosSimulatorBootsByDeviceId.get(deviceId) === entry) {
      pendingIosSimulatorBootsByDeviceId.delete(deviceId);
    }
    entry = undefined;
  }
  if (!entry) {
    const abortController = new AbortController();
    const promise = (async () => {
      const device = await getDevice(deviceId, abortController.signal);
      if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');
      if (!device) {
        throw new Error(`iOS simulator not found: ${deviceId}`);
      }
      if (device.state === 'booted') return device;
      if (device.state !== 'shutdown') {
        throw new Error(
          `iOS simulator ${deviceId} is not ready to stream (state: ${device.state}). Only booted or shutdown simulators are supported.`,
        );
      }

      debug('iOS preview booting simulator deviceId=%s', deviceId);
      await runCommand('xcrun', ['simctl', 'boot', deviceId], {
        signal: abortController.signal,
      });
      if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');
      await runCommand('xcrun', ['simctl', 'bootstatus', deviceId, '-b'], {
        signal: abortController.signal,
      });
      if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');
      void minimizeMobilePreviewWindows({
        processNames: IOS_SIMULATOR_PROCESS_NAMES,
        windowNameIncludes: [device.name],
      });
      debug('iOS preview simulator booted deviceId=%s', deviceId);
      return device;
    })();
    entry = { promise, abortController, waiters: new Set() };
    pendingIosSimulatorBootsByDeviceId.set(deviceId, entry);
    const createdEntry = entry;
    void promise
      .finally(() => {
        if (pendingIosSimulatorBootsByDeviceId.get(deviceId) === createdEntry) {
          pendingIosSimulatorBootsByDeviceId.delete(deviceId);
        }
      })
      .catch(() => {});
  }

  const waiter = Symbol('ios-simulator-boot-waiter');
  entry.waiters.add(waiter);
  return new Promise<MobilePreviewDevice>((resolveWaiter, rejectWaiter) => {
    let settled = false;
    const releaseWaiter = (cancelled: boolean, reason?: unknown) => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', cancelWaiter);
      entry.waiters.delete(waiter);
      if (cancelled && entry.waiters.size === 0) {
        entry.abortController.abort(reason);
      }
      return true;
    };
    const cancelWaiter = () => {
      const reason =
        signal?.reason ?? new DOMException('Operation cancelled', 'AbortError');
      if (releaseWaiter(true, reason)) rejectWaiter(reason);
    };
    entry.promise.then(
      (device) => {
        if (releaseWaiter(false)) resolveWaiter(device);
      },
      (error) => {
        if (releaseWaiter(false)) rejectWaiter(error);
      },
    );
    if (signal?.aborted) cancelWaiter();
    else signal?.addEventListener('abort', cancelWaiter, { once: true });
  });
}
