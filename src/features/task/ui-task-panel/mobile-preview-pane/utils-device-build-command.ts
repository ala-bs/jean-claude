import {
  isPhysicalMobilePreviewDevice,
  type MobilePreviewDevice,
} from '@shared/mobile-simulator-types';

/**
 * The `{{device}}` escape hatch. When a user's custom build command contains
 * this token we substitute the device id and add nothing else — that is the
 * only way to target CLIs whose flag we cannot guess.
 */
export const DEVICE_PLACEHOLDER = '{{device}}';

/**
 * Best-effort mapping from build-command text to the CLI's device selector.
 *
 * This is deliberately a tiny table rather than a parser: the commands are
 * user-editable strings, so anything not listed here is left alone and the user
 * is told to use `{{device}}`.
 *
 * | command contains            | selector flag |
 * | --------------------------- | ------------- |
 * | `expo run:ios`              | `--device`    |
 * | `expo run:android`          | `--device`    |
 * | `react-native run-ios`      | `--udid`      |
 * | `react-native run-android`  | `--deviceId`  |
 *
 * The same flags apply to simulators/emulators and to physical hardware:
 * `expo run:<platform> --device` accepts a simulator udid or an AVD name, and
 * `react-native run-ios --udid` accepts a simulator udid.
 */
const DEVICE_SELECTOR_TABLE: ReadonlyArray<{ match: string; flag: string }> = [
  // react-native entries first: `react-native run-ios` does not contain
  // `expo run:ios`, but keeping the more specific CLI first documents intent.
  { match: 'react-native run-ios', flag: '--udid' },
  { match: 'react-native run-android', flag: '--deviceId' },
  { match: 'expo run:ios', flag: '--device' },
  { match: 'expo run:android', flag: '--device' },
];

/**
 * Flags whose value is passed straight through to a transport (`adb -s` for
 * `--deviceId`, CoreSimulator/CoreDevice for `--udid`). These need the real
 * connection id — an Android AVD name such as `Pixel_7_API_34` is rejected with
 * `error: device 'Pixel_7_API_34' not found`.
 *
 * `expo run:<platform> --device` is deliberately not in this set: the Expo CLI
 * resolves the value itself and happily accepts an AVD name for a shutdown
 * emulator (it boots it), so `id` remains a valid selector there.
 */
const TRANSPORT_ID_FLAGS = new Set(['--udid', '--deviceId']);

/** Selectors that already pin a device, in any of the supported CLIs. */
const EXISTING_SELECTOR_PATTERN = /(^|\s)--(device|udid|deviceId)(=|\s|$)/;

/**
 * Package-manager script runners. The default build command produced by
 * detection is usually `pnpm run ios` / `npm run android` / `yarn ios`, which
 * hides the underlying CLI — so the flag has to come from the app's detected
 * stacks instead of from the command text.
 *
 * `needsSeparator` records the one runner (npm) that swallows extra flags
 * unless they come after a literal `--`.
 */
const SCRIPT_RUNNERS: ReadonlyArray<{
  /** First token of the command. */
  binary: string;
  /** True when a bare `<binary> <script>` (no `run`) is also valid. */
  allowsImplicitRun: boolean;
  needsSeparator: boolean;
}> = [
  { binary: 'npm', allowsImplicitRun: false, needsSeparator: true },
  { binary: 'pnpm', allowsImplicitRun: true, needsSeparator: false },
  { binary: 'yarn', allowsImplicitRun: true, needsSeparator: false },
  { binary: 'bun', allowsImplicitRun: false, needsSeparator: false },
];

/** `run`-like subcommands accepted by the runners above. */
const RUN_SUBCOMMANDS = new Set(['run', 'run-script']);

/** Subcommands that are definitely not a script name. */
const NON_SCRIPT_SUBCOMMANDS = new Set([
  'exec',
  'dlx',
  'x',
  'add',
  'install',
  'i',
  'remove',
  'why',
  'create',
  'init',
  'workspace',
  'workspaces',
  'node',
  'test',
]);

/**
 * Wrap the id for a POSIX shell command string. Ids are normally UUIDs or adb
 * serials, but AVD names and simulator names reach here too and may contain
 * spaces, so anything outside a conservative safe set gets single-quoted (with
 * the usual `'\''` dance for embedded quotes).
 */
export function quoteShellArgument(value: string) {
  if (value.length > 0 && /^[A-Za-z0-9._:@%+=/-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type ApplyDeviceToBuildCommandResult = {
  command: string;
  /** True when the command now targets `device` explicitly because of us. */
  applied: boolean;
  reason:
    | 'simulator'
    | 'placeholder'
    | 'already-targeted'
    | 'appended'
    | 'unknown-command'
    | 'missing-device-id'
    | 'device-not-running';
};

/**
 * The identifier the platform CLI expects for this device: the adb serial for
 * a booted Android emulator (whose rail id is the AVD name), the udid/serial
 * everywhere else.
 */
function getDeviceSelectorValue(device: MobilePreviewDevice) {
  return device.connectionId ?? device.id ?? '';
}

/**
 * True when `flag` needs a transport-level id that we cannot produce for this
 * device. Android emulators are listed under their AVD name and only gain a
 * `connectionId` (the `emulator-5554` serial) once booted *and* re-listed, so a
 * shutdown — or merely stale — emulator would otherwise contribute the AVD name
 * to `--deviceId`/`--udid`, which `adb -s` rejects outright. Emitting nothing
 * and showing a notice beats emitting a value the CLI will refuse.
 */
function isMissingTransportId({
  device,
  flag,
}: {
  device: MobilePreviewDevice;
  flag: string;
}) {
  if (!TRANSPORT_ID_FLAGS.has(flag)) return false;
  if (device.kind === 'physical') return false;
  if (device.platform !== 'android') return false;
  return !device.connectionId;
}

/** Detect `npm run ios` / `pnpm ios` / `yarn ios` / `bun run ios` shapes. */
function matchScriptRunner(command: string) {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const [binary, second] = tokens;
  if (!binary || !second) return null;

  const runner = SCRIPT_RUNNERS.find((candidate) => candidate.binary === binary);
  if (!runner) return null;

  if (RUN_SUBCOMMANDS.has(second)) {
    // `npm run` with no script name is not a script invocation.
    if (!tokens[2]) return null;
    return runner;
  }
  if (!runner.allowsImplicitRun) return null;
  if (second.startsWith('-') || NON_SCRIPT_SUBCOMMANDS.has(second)) return null;
  return runner;
}

/** The selector flag a script wrapper needs, inferred from detected stacks. */
function getFlagFromStacks({
  stacks,
  platform,
}: {
  stacks: readonly string[] | null | undefined;
  platform: MobilePreviewDevice['platform'];
}) {
  if (!stacks) return null;
  // Expo wins: an Expo app almost always also depends on react-native, but the
  // script it exposes runs `expo run:<platform>`.
  if (stacks.includes('expo')) return '--device';
  if (stacks.includes('react-native')) {
    return platform === 'ios' ? '--udid' : '--deviceId';
  }
  return null;
}

/** Append `flag value`, inserting npm's `--` separator only when needed. */
function appendSelector({
  command,
  flag,
  value,
  needsSeparator,
}: {
  command: string;
  flag: string;
  value: string;
  needsSeparator: boolean;
}) {
  const trimmed = command.trimEnd();
  const hasSeparator = /(^|\s)--(\s|$)/.test(trimmed);
  const separator = needsSeparator && !hasSeparator ? ' --' : '';
  return `${trimmed}${separator} ${flag} ${quoteShellArgument(value)}`;
}

/**
 * Point a user-editable build command at a specific device.
 *
 * Applies to simulators/emulators as well as physical hardware: selecting a
 * device in the rail should always be what the build targets, otherwise the CLI
 * picks its own default simulator. The selector is either substituted into
 * `{{device}}` (highest precedence), or appended using
 * {@link DEVICE_SELECTOR_TABLE} when the CLI is visible in the command, or
 * inferred from the app's detected `stacks` when the command is a package
 * manager script wrapper such as `pnpm run ios`.
 *
 * When nothing can be inferred the command is returned unchanged so the UI can
 * tell the user to add `{{device}}` themselves — we never guess a flag.
 */
export function applyDeviceToBuildCommand({
  command,
  device,
  stacks,
}: {
  command: string;
  device: MobilePreviewDevice | null | undefined;
  /**
   * `MobilePreviewDetectedApp.stacks` for the selected app. Required to target
   * package-manager script wrappers, which hide the underlying CLI.
   */
  stacks?: readonly string[] | null;
}): ApplyDeviceToBuildCommandResult {
  const isPhysical = isPhysicalMobilePreviewDevice(device);
  /** Nothing applicable: stay quiet for simulators, nag for real hardware. */
  const notApplied = (
    reason: ApplyDeviceToBuildCommandResult['reason'],
  ): ApplyDeviceToBuildCommandResult => ({
    command,
    applied: false,
    reason: isPhysical ? reason : 'simulator',
  });

  if (!device) {
    return { command, applied: false, reason: 'missing-device-id' };
  }
  const deviceId = getDeviceSelectorValue(device);
  if (!deviceId) {
    return { command, applied: false, reason: 'missing-device-id' };
  }

  if (command.includes(DEVICE_PLACEHOLDER)) {
    return {
      command: command.replaceAll(
        DEVICE_PLACEHOLDER,
        quoteShellArgument(deviceId),
      ),
      applied: true,
      reason: 'placeholder',
    };
  }

  if (EXISTING_SELECTOR_PATTERN.test(command)) {
    return { command, applied: false, reason: 'already-targeted' };
  }

  const entry = DEVICE_SELECTOR_TABLE.find((candidate) =>
    command.includes(candidate.match),
  );
  if (entry) {
    if (isMissingTransportId({ device, flag: entry.flag })) {
      return { command, applied: false, reason: 'device-not-running' };
    }
    return {
      command: appendSelector({
        command,
        flag: entry.flag,
        value: deviceId,
        needsSeparator: false,
      }),
      applied: true,
      reason: 'appended',
    };
  }

  const runner = matchScriptRunner(command);
  if (!runner) return notApplied('unknown-command');

  const flag = getFlagFromStacks({ stacks, platform: device.platform });
  if (!flag) return notApplied('unknown-command');
  if (isMissingTransportId({ device, flag })) {
    return { command, applied: false, reason: 'device-not-running' };
  }

  return {
    command: appendSelector({
      command,
      flag,
      value: deviceId,
      needsSeparator: runner.needsSeparator,
    }),
    applied: true,
    reason: 'appended',
  };
}

/**
 * User-facing explanation for the one case that needs action from them.
 * Returns null when nothing needs to be said.
 */
export function getDeviceBuildCommandNotice(
  result: ApplyDeviceToBuildCommandResult,
) {
  if (result.reason === 'device-not-running') {
    return `This build command selects a device by its adb serial, which only exists once the emulator is running. Start the emulator (or refresh the device list if you just booted it) and run the build again, or add ${DEVICE_PLACEHOLDER} to the build command (project settings) to choose the value yourself.`;
  }
  if (result.reason !== 'unknown-command') return null;
  return `We could not tell how this build command selects a device, so it will not target the selected device. Add ${DEVICE_PLACEHOLDER} where the device id belongs in the build command (project settings).`;
}
