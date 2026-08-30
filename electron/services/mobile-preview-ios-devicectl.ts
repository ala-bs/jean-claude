import type { MobilePreviewDevice } from '../../shared/mobile-simulator-types';

import { commandExists, runCommand } from './mobile-preview-process';
import { readFile, rm } from 'node:fs/promises';
import { debug } from './mobile-preview-ios-shared-state';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

/**
 * `devicectl` (CoreDevice) drives physical iOS hardware. Only the JSON-to-file
 * interface is supported by Apple for scripting, so every command here writes
 * to a temp file and parses that file instead of stdout.
 */

export const DEVICECTL_LIST_TIMEOUT_MS = 20_000;
export const DEVICECTL_INSTALL_TIMEOUT_MS = 300_000;
export const DEVICECTL_LAUNCH_TIMEOUT_MS = 120_000;
export const DEVICECTL_APP_INFO_TIMEOUT_MS = 60_000;
/** The availability probe only spawns `devicectl --version`; it must not wait as long as a real listing. */
export const DEVICECTL_VERSION_TIMEOUT_MS = 5_000;

const PAIR_REASON =
  'Pair this device in Xcode (Window > Devices and Simulators) to use it for preview.';
const DEVELOPER_MODE_REASON =
  'Enable Developer Mode in Settings > Privacy & Security, then restart the device.';
const UNREACHABLE_REASON =
  'Device is not reachable — connect it over USB or the same Wi-Fi network.';

/**
 * Availability is a property of the machine's Xcode install, not of a single
 * operation, so the probe is cached for the lifetime of the process: install
 * and launch would otherwise spawn two extra processes each, every time.
 * Failures are not cached — a user can install Xcode without restarting the app.
 */
let devicectlAvailabilityProbe: Promise<void> | null = null;

export function resetDevicectlAvailabilityForTests(): void {
  devicectlAvailabilityProbe = null;
}

async function probeDevicectlAvailable(signal?: AbortSignal): Promise<void> {
  const available = await commandExists(
    'xcrun',
    signal ? { signal } : undefined,
  );
  if (!available) {
    throw new Error(
      'Missing required iOS tool: xcrun. Install Xcode and its command line tools to use physical iOS devices.',
    );
  }

  try {
    await runCommand('xcrun', ['devicectl', '--version'], {
      signal,
      timeoutMs: DEVICECTL_VERSION_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `Missing required iOS tool: devicectl. Install Xcode 15 or newer to use physical iOS devices. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

export async function assertDevicectlAvailable(
  signal?: AbortSignal,
): Promise<void> {
  const probe = devicectlAvailabilityProbe ?? probeDevicectlAvailable(signal);
  devicectlAvailabilityProbe = probe;
  try {
    await probe;
  } catch (error) {
    // Don't cache a negative result: the user may install Xcode mid-session.
    if (devicectlAvailabilityProbe === probe) {
      devicectlAvailabilityProbe = null;
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Mirrors the State column of `xcrun devicectl list devices`.
 *
 * Verified against real CoreDevice output: a device devicectl reports as
 * "available (paired)" can sit at `tunnelState: "disconnected"` (the tunnel is
 * established lazily, on demand), while every device it reports as
 * "unavailable" is at `tunnelState: "unavailable"`. So `"connected"` is NOT the
 * marker of availability — `"unavailable"` is the marker of absence.
 *
 * `ddiServicesAvailable` is deliberately not consulted: it is `false` even on
 * an available, paired, Developer-Mode-enabled device (the Developer Disk Image
 * mounts on first use), so treating it as a readiness signal hides usable
 * hardware.
 */
function isReachable(connectionProperties: Record<string, unknown>): boolean {
  const tunnelState = asString(connectionProperties.tunnelState);
  // Missing tunnel state: assume reachable rather than hiding a usable device.
  if (!tunnelState) return true;
  return tunnelState.toLowerCase() !== 'unavailable';
}

function resolveConnection(device: Record<string, unknown>): {
  connection: NonNullable<MobilePreviewDevice['connection']>;
  unavailableReason?: string;
} {
  const connectionProperties = asRecord(device.connectionProperties) ?? {};
  const deviceProperties = asRecord(device.deviceProperties) ?? {};

  // Absent means unknown, not negative: only an EXPLICIT non-paired value is
  // worth telling the user to go pair the device in Xcode. Same rule as
  // `reality` / `developerModeStatus` below.
  const pairingState = asString(connectionProperties.pairingState);
  if (pairingState && pairingState.toLowerCase() !== 'paired') {
    return { connection: 'untrusted', unavailableReason: PAIR_REASON };
  }

  const developerModeStatus = asString(deviceProperties.developerModeStatus);
  if (developerModeStatus && developerModeStatus.toLowerCase() !== 'enabled') {
    return {
      connection: 'untrusted',
      unavailableReason: DEVELOPER_MODE_REASON,
    };
  }

  if (!isReachable(connectionProperties)) {
    return { connection: 'unavailable', unavailableReason: UNREACHABLE_REASON };
  }

  return { connection: 'connected' };
}

/**
 * Maps `xcrun devicectl list devices --json-output` payloads to preview
 * devices. Malformed entries are skipped instead of throwing.
 */
export function parseDevicectlDevices(json: unknown): MobilePreviewDevice[] {
  const root = asRecord(json);
  const result = asRecord(root?.result);
  const devices = result?.devices;
  if (!Array.isArray(devices)) return [];

  return devices.flatMap((entry): MobilePreviewDevice[] => {
    const device = asRecord(entry);
    if (!device) return [];

    const hardwareProperties = asRecord(device.hardwareProperties);
    if (!hardwareProperties) return [];
    // Absent platform means unknown, not "not iOS": devicectl only lists
    // CoreDevice hardware, so drop a device only on an EXPLICIT other platform.
    const platform = asString(hardwareProperties.platform);
    if (platform && platform !== 'iOS') return [];
    // `reality` is absent on stale pairing records that CoreDevice still lists
    // (and that Xcode still shows). devicectl never reports simulators, so only
    // exclude an explicit non-physical value rather than requiring 'physical'.
    const reality = asString(hardwareProperties.reality);
    if (reality && reality !== 'physical') return [];

    const deviceProperties = asRecord(device.deviceProperties) ?? {};
    const id = asString(device.identifier);
    const name =
      asString(deviceProperties.name) ??
      asString(hardwareProperties.marketingName);
    if (!id || !name) return [];

    const { connection, unavailableReason } = resolveConnection(device);
    const osVersion = asString(deviceProperties.osVersionNumber);
    const model = asString(hardwareProperties.marketingName);
    // A physical iPhone has TWO distinct identifiers and they are not
    // interchangeable:
    //   identifier            D0C5D914-4D28-5A76-9B8E-686DB0B06995  (CoreDevice)
    //   hardwareProperties.udid  00008120-000E48C40E07C01E          (hardware)
    // `devicectl` accepts the CoreDevice identifier, but the React Native /
    // Expo CLIs match `--device` against the hardware UDID (or the device
    // name) and fail with `No device UDID or name matching "..."` when handed
    // the CoreDevice one. Keep `id` as the CoreDevice identifier so devicectl
    // calls keep working, and expose the hardware UDID as the transport-level
    // `connectionId` that build commands target.
    const hardwareUdid = asString(hardwareProperties.udid);

    return [
      {
        id,
        name,
        platform: 'ios' as const,
        kind: 'physical' as const,
        state: connection === 'connected' ? ('booted' as const) : ('unknown' as const),
        connection,
        ...(osVersion ? { osVersion } : {}),
        ...(model ? { model } : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(hardwareUdid ? { connectionId: hardwareUdid } : {}),
      },
    ];
  });
}

async function runDevicectlJson({
  args,
  signal,
  timeoutMs,
}: {
  args: string[];
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<unknown> {
  const outputPath = join(tmpdir(), `jc-devicectl-${randomUUID()}.json`);
  try {
    await runCommand('xcrun', [...args, '--json-output', outputPath], {
      signal,
      timeoutMs,
    });
    const raw = await readFile(outputPath, 'utf8');
    return JSON.parse(raw) as unknown;
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Lists physical iOS devices. Fail-soft: a missing or broken Xcode install must
 * never break the simulator device rail, so errors log and yield no devices.
 *
 * `ok` distinguishes "listed successfully, zero devices" from "listing failed".
 * Callers must not prune the physical-device registry when `ok` is `false`, or
 * a single transient devicectl timeout disarms every simulator-only guard.
 */
export async function listDevicectlDevices(signal?: AbortSignal): Promise<{
  ok: boolean;
  devices: MobilePreviewDevice[];
}> {
  try {
    const json = await runDevicectlJson({
      args: ['devicectl', 'list', 'devices'],
      signal,
      timeoutMs: DEVICECTL_LIST_TIMEOUT_MS,
    });
    return { ok: true, devices: parseDevicectlDevices(json) };
  } catch (error) {
    if (!signal?.aborted) {
      debug(
        'devicectl list devices failed, skipping physical iOS devices error=%s',
        error instanceof Error ? error.message : String(error),
      );
    }
    return { ok: false, devices: [] };
  }
}

function assertDevicectlValue(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
  if (value.startsWith('-')) throw new Error(`${label} cannot start with '-'.`);
}

/** Short, safe excerpt of the keys a payload actually had, for error messages. */
function describeKeys(value: unknown): string {
  const record = asRecord(value);
  if (!record) return Array.isArray(value) ? 'array' : typeof value;
  const keys = Object.keys(record);
  if (keys.length === 0) return 'none';
  return keys.slice(0, 10).join(', ') + (keys.length > 10 ? ', …' : '');
}

export async function installIosAppOnDevice({
  deviceId,
  appPath,
  signal,
}: {
  deviceId: string;
  appPath: string;
  signal?: AbortSignal;
}): Promise<{ bundleId: string; installationUrl: string | null }> {
  assertDevicectlValue('iOS device id', deviceId);
  assertDevicectlValue('iOS app path', appPath);
  await assertDevicectlAvailable(signal);

  let json: unknown;
  try {
    json = await runDevicectlJson({
      args: ['devicectl', 'device', 'install', 'app', '--device', deviceId, appPath],
      signal,
      timeoutMs: DEVICECTL_INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `Failed to install ${appPath} on iOS device ${deviceId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Fail loud on a shape mismatch. Returning `null` here would report success
  // for an install that may not have happened, and the exact key names below
  // are unverified against real devicectl output.
  const result = asRecord(json)?.result;
  const installed = asRecord(result)?.installedApplications;
  const first = Array.isArray(installed) ? asRecord(installed[0]) : null;
  if (!first) {
    throw new Error(
      `devicectl install of ${appPath} on iOS device ${deviceId} succeeded but returned no installed application (result keys: ${describeKeys(
        result,
      )}).`,
    );
  }
  const bundleId = asString(first.bundleID);
  if (!bundleId) {
    throw new Error(
      `devicectl install of ${appPath} on iOS device ${deviceId} returned an installed application without a bundleID (application keys: ${describeKeys(
        first,
      )}).`,
    );
  }
  return {
    bundleId,
    installationUrl: asString(first.installationURL),
  };
}

export async function launchIosAppOnDevice({
  deviceId,
  bundleId,
  launchArgs,
  signal,
}: {
  deviceId: string;
  bundleId: string;
  launchArgs?: string[];
  signal?: AbortSignal;
}): Promise<{ processIdentifier: number }> {
  assertDevicectlValue('iOS device id', deviceId);
  assertDevicectlValue('iOS bundle identifier', bundleId);
  for (const arg of launchArgs ?? []) {
    if (typeof arg !== 'string') {
      throw new Error('iOS launch arguments must be strings.');
    }
    // Launch args are appended as bare trailing argv. devicectl's separator
    // convention for forwarding options to the app is unverified, so reject
    // option-looking args rather than have them parsed as devicectl options.
    if (arg.startsWith('-')) {
      throw new Error(`iOS launch argument cannot start with '-': ${arg}`);
    }
  }
  await assertDevicectlAvailable(signal);

  let json: unknown;
  try {
    json = await runDevicectlJson({
      args: [
        'devicectl',
        'device',
        'process',
        'launch',
        '--device',
        deviceId,
        '--terminate-existing',
        bundleId,
        ...(launchArgs ?? []),
      ],
      signal,
      timeoutMs: DEVICECTL_LAUNCH_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `Failed to launch ${bundleId} on iOS device ${deviceId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Fail loud on a shape mismatch — see installIosAppOnDevice.
  const result = asRecord(asRecord(json)?.result);
  const launched = asRecord(result?.process);
  if (!launched) {
    throw new Error(
      `devicectl launch of ${bundleId} on iOS device ${deviceId} succeeded but returned no process (result keys: ${describeKeys(
        result,
      )}).`,
    );
  }
  const pid = Number(launched.processIdentifier);
  if (!Number.isFinite(pid)) {
    throw new Error(
      `devicectl launch of ${bundleId} on iOS device ${deviceId} returned no processIdentifier (process keys: ${describeKeys(
        launched,
      )}).`,
    );
  }
  return { processIdentifier: pid };
}

/**
 * Maps `xcrun devicectl device info apps --json-output` payloads to the list of
 * installed bundle identifiers.
 *
 * UNVERIFIED SHAPE. `result.apps[].bundleIdentifier` is the plausible layout but
 * has not been checked against real CoreDevice output. Every mismatch therefore
 * throws with the keys actually present: callers translate a throw into
 * "installed state unknown" (`appInstalled: null`), never into `false`. A false
 * "not installed" would make the UI trigger a spurious native rebuild.
 *
 * An empty `apps` array is also treated as a mismatch: no real iPhone has zero
 * apps, so an empty list far more likely means the subcommand needs a flag we
 * did not pass than that the app is genuinely absent.
 */
export function parseDevicectlInstalledBundleIds(json: unknown): string[] {
  const result = asRecord(asRecord(json)?.result);
  if (!result) {
    throw new Error(
      `devicectl app listing returned no result object (top-level keys: ${describeKeys(
        json,
      )}).`,
    );
  }
  const apps = result.apps;
  if (!Array.isArray(apps)) {
    throw new Error(
      `devicectl app listing returned no 'apps' array (result keys: ${describeKeys(
        result,
      )}).`,
    );
  }
  if (apps.length === 0) {
    throw new Error(
      `devicectl app listing returned an empty 'apps' array (result keys: ${describeKeys(
        result,
      )}).`,
    );
  }
  return apps.map((entry, index) => {
    const app = asRecord(entry);
    const bundleId = app ? asString(app.bundleIdentifier) : null;
    if (!bundleId) {
      throw new Error(
        `devicectl app listing entry ${index} has no bundleIdentifier (entry keys: ${describeKeys(
          entry,
        )}).`,
      );
    }
    return bundleId;
  });
}

/**
 * Lists the bundle identifiers installed on a physical iOS device.
 *
 * Throws on any failure (missing devicectl, command error, unexpected payload).
 * Callers MUST map a throw to "unknown", not to "not installed".
 */
export async function listInstalledIosAppBundleIdsOnDevice({
  deviceId,
  signal,
}: {
  deviceId: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  assertDevicectlValue('iOS device id', deviceId);
  await assertDevicectlAvailable(signal);
  const json = await runDevicectlJson({
    args: ['devicectl', 'device', 'info', 'apps', '--device', deviceId],
    signal,
    timeoutMs: DEVICECTL_APP_INFO_TIMEOUT_MS,
  });
  return parseDevicectlInstalledBundleIds(json);
}

/**
 * Physical devices discovered by the most recent listing. Every simulator-only
 * code path consults this so a CoreDevice identifier can never be handed to
 * simctl/idb/CoreSimulator.
 */
const knownPhysicalIosDeviceNamesById = new Map<string, string>();

/**
 * Records the physical devices from a listing.
 *
 * The registry is only pruned when `listingSucceeded` is `true`. A failed
 * listing (devicectl timeout, missing Xcode, transient CoreDevice error) must
 * leave previously known devices in place — otherwise the simulator-only guards
 * silently disarm while the renderer may still have a physical device selected,
 * and a CoreDevice UDID reaches simctl, which reports a confusing raw error.
 */
export function rememberPhysicalIosDevices({
  devices,
  listingSucceeded,
}: {
  devices: readonly MobilePreviewDevice[];
  listingSucceeded: boolean;
}): void {
  if (listingSucceeded) knownPhysicalIosDeviceNamesById.clear();
  for (const device of devices) {
    if (device.kind === 'physical') {
      knownPhysicalIosDeviceNamesById.set(device.id, device.name);
    }
  }
}

export function getKnownPhysicalIosDeviceName(deviceId: string): string | null {
  return knownPhysicalIosDeviceNamesById.get(deviceId) ?? null;
}

/**
 * Whether `deviceId` is a physical device from the most recent listing. This is
 * the ONLY supported physical-vs-simulator test: CoreDevice identifiers and
 * CoreSimulator UDIDs are both UUID-shaped, so the id format proves nothing.
 */
export function isKnownPhysicalIosDevice(deviceId: string): boolean {
  return knownPhysicalIosDeviceNamesById.has(deviceId);
}

export function resetKnownPhysicalIosDevicesForTests(): void {
  knownPhysicalIosDeviceNamesById.clear();
}

/**
 * Throws a user-facing error when `deviceId` refers to a physical iOS device.
 * `capability` is a sentence-leading noun phrase, e.g. "Live screen streaming".
 */
export function assertSimulatorOnlyIosDevice({
  deviceId,
  capability,
}: {
  deviceId: string;
  capability: string;
}): void {
  const name = getKnownPhysicalIosDeviceName(deviceId);
  if (!name) return;
  throw new Error(
    `${capability} is not supported on physical iOS devices. ${name} can only be listed and inspected for now — live preview, input, deeplinks and appearance control are simulator-only.`,
  );
}

/**
 * Same as {@link assertSimulatorOnlyIosDevice}, but refreshes the registry from
 * devicectl first when the id is unknown (e.g. a stream started before any
 * device listing happened). Never clears known devices on a devicectl failure.
 */
export async function assertSimulatorOnlyIosDeviceAsync({
  deviceId,
  capability,
  signal,
}: {
  deviceId: string;
  capability: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!getKnownPhysicalIosDeviceName(deviceId)) {
    // Additive merge only: this refresh must never prune, even when it succeeds.
    const { devices } = await listDevicectlDevices(signal);
    rememberPhysicalIosDevices({ devices, listingSucceeded: false });
  }
  assertSimulatorOnlyIosDevice({ deviceId, capability });
}
