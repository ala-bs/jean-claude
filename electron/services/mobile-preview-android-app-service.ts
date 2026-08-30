import * as fs from 'node:fs/promises';
import path from 'node:path';

import type {
  MobilePreviewAndroidAppRestartResult,
  MobilePreviewAndroidAppStatus,
} from '@shared/mobile-simulator-types';

import { dbg } from '../lib/debug';
import { runCommand } from './mobile-preview-process';

const ANDROID_DEVICE_RESOLUTION_CACHE_TTL_MS = 5_000;

type AdbDevice = {
  id: string;
  state: string;
};

type AndroidAppServiceOptions = {
  runCommandImpl?: typeof runCommand;
};

type AndroidProjectParams = {
  projectPath: string;
  androidProjectPath: string;
};

type AndroidDeviceParams = AndroidProjectParams & {
  deviceId: string;
};

function nowIso() {
  return new Date().toISOString();
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath: string) {
  if (!(await pathExists(filePath))) return null;
  return fs.readFile(filePath, 'utf8');
}

function resolveProjectRelativePath({
  projectPath,
  relativePath,
}: {
  projectPath: string;
  relativePath: string;
}) {
  const root = path.resolve(projectPath);
  const resolvedPath = path.resolve(root, relativePath || '.');
  const relative = path.relative(root, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Android project path must stay inside the project.');
  }
  return resolvedPath;
}

function parseAdbDevices(output: string): AdbDevice[] {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    line.trim().startsWith('List of devices attached'),
  );
  if (headerIndex === -1) return [];

  return lines.slice(headerIndex + 1).flatMap((line) => {
    const [id, state] = line.trim().split(/\s+/);
    return id && state ? [{ id, state }] : [];
  });
}

function parseAdbAvdName(output: string) {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && line !== 'OK') ?? null
  );
}

async function parseAndroidPackageName(absoluteAndroidProjectPath: string) {
  const gradleCandidates = [
    path.join(absoluteAndroidProjectPath, 'app', 'build.gradle'),
    path.join(absoluteAndroidProjectPath, 'app', 'build.gradle.kts'),
  ];
  for (const filePath of gradleCandidates) {
    const content = await readFileIfExists(filePath);
    const applicationId = content?.match(
      /applicationId\s*[=(]?\s*["']([^"']+)["']/,
    )?.[1];
    if (applicationId) return applicationId;
    const namespace = content?.match(/namespace\s*[=(]?\s*["']([^"']+)["']/)?.[1];
    if (namespace) return namespace;
  }

  const manifest = await readFileIfExists(
    path.join(
      absoluteAndroidProjectPath,
      'app',
      'src',
      'main',
      'AndroidManifest.xml',
    ),
  );
  return manifest?.match(/<manifest\b[^>]*\spackage="([^"]+)"/)?.[1] ?? null;
}

export function createMobilePreviewAndroidAppService({
  runCommandImpl = runCommand,
}: AndroidAppServiceOptions = {}) {
  const androidDeviceResolutionCache = new Map<
    string,
    { adbSerial: string; expiresAt: number }
  >();

  /**
   * A booted emulator's rail id is the AVD name (`Pixel_7_API_34`), which
   * `adb -s` does not understand, so it has to be mapped to the `emulator-NNNN`
   * serial by asking each emulator console for its AVD name.
   */
  async function resolveAndroidAdbSerial(
    deviceIdOrAvdName: string,
  ): Promise<string>;
  async function resolveAndroidAdbSerial(
    deviceIdOrAvdName: string,
    options: { allowUnresolved: false },
  ): Promise<string | null>;
  async function resolveAndroidAdbSerial(
    deviceIdOrAvdName: string,
    options: { allowUnresolved?: boolean } = {},
  ): Promise<string | null> {
    const cached = androidDeviceResolutionCache.get(deviceIdOrAvdName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.adbSerial;
    }

    const { stdout } = await runCommandImpl('adb', ['devices', '-l']);
    const devices = parseAdbDevices(stdout);
    dbg.mobilePreview(
      'android-app adb devices=%o',
      devices.map((device) => `${device.id}:${device.state}`),
    );
    if (devices.some((device) => device.id === deviceIdOrAvdName)) {
      androidDeviceResolutionCache.set(deviceIdOrAvdName, {
        adbSerial: deviceIdOrAvdName,
        expiresAt: Date.now() + ANDROID_DEVICE_RESOLUTION_CACHE_TTL_MS,
      });
      return deviceIdOrAvdName;
    }

    for (const device of devices) {
      if (!device.id.startsWith('emulator-') || device.state !== 'device') {
        continue;
      }

      try {
        const { stdout: avdOutput } = await runCommandImpl('adb', [
          '-s',
          device.id,
          'emu',
          'avd',
          'name',
        ]);
        if (parseAdbAvdName(avdOutput) === deviceIdOrAvdName) {
          androidDeviceResolutionCache.set(deviceIdOrAvdName, {
            adbSerial: device.id,
            expiresAt: Date.now() + ANDROID_DEVICE_RESOLUTION_CACHE_TTL_MS,
          });
          dbg.mobilePreview(
            'android-app resolved avd=%s serial=%s',
            deviceIdOrAvdName,
            device.id,
          );
          return device.id;
        }
      } catch {
        // Some Android devices do not answer emulator console commands.
      }
    }

    dbg.mobilePreview(
      'android-app using unresolved device id=%s',
      deviceIdOrAvdName,
    );
    return options.allowUnresolved === false ? null : deviceIdOrAvdName;
  }

  /**
   * `adb devices -l` also lists devices that cannot accept shell commands
   * (`unauthorized`, `offline`, ...). Those serials resolve fine, so without
   * this guard `pm list packages` / `am force-stop` would surface raw adb text
   * instead of the actionable reason install and launch already report.
   */
  async function assertAndroidDeviceUsable(adbSerial: string): Promise<void> {
    const { stdout } = await runCommandImpl('adb', ['devices', '-l']);
    const device = parseAdbDevices(stdout).find(
      (candidate) => candidate.id === adbSerial,
    );
    if (!device || device.state === 'device') return;
    if (device.state === 'unauthorized' || device.state === 'authorizing') {
      throw new Error('Accept the USB debugging prompt on the device.');
    }
    if (device.state === 'offline') {
      throw new Error(
        'Device is offline — reconnect the cable or re-enable USB debugging.',
      );
    }
    throw new Error(
      `Device is in "${device.state}" state and cannot be used for preview.`,
    );
  }

  return {
    async getAndroidAppStatus(
      params: AndroidDeviceParams,
    ): Promise<MobilePreviewAndroidAppStatus> {
      const absoluteAndroidProjectPath = resolveProjectRelativePath({
        projectPath: params.projectPath,
        relativePath: params.androidProjectPath,
      });
      if (!(await pathExists(absoluteAndroidProjectPath))) {
        throw new Error('No native Android project found at configured path.');
      }

      const packageName = await parseAndroidPackageName(
        absoluteAndroidProjectPath,
      );
      if (!packageName) {
        return { appInstalled: null, packageName: null };
      }

      const adbSerial = await resolveAndroidAdbSerial(params.deviceId, {
        allowUnresolved: false,
      });
      if (!adbSerial) {
        return { appInstalled: null, packageName };
      }
      await assertAndroidDeviceUsable(adbSerial);
      const { stdout } = await runCommandImpl('adb', [
        '-s',
        adbSerial,
        'shell',
        'pm',
        'list',
        'packages',
        packageName,
      ]);

      return {
        appInstalled: stdout
          .split(/\r?\n/)
          .some((line) => line.trim() === `package:${packageName}`),
        packageName,
      };
    },

    async restartAndroidApp(
      params: AndroidDeviceParams,
    ): Promise<MobilePreviewAndroidAppRestartResult> {
      const absoluteAndroidProjectPath = resolveProjectRelativePath({
        projectPath: params.projectPath,
        relativePath: params.androidProjectPath,
      });
      if (!(await pathExists(absoluteAndroidProjectPath))) {
        throw new Error('No native Android project found at configured path.');
      }

      const packageName = await parseAndroidPackageName(
        absoluteAndroidProjectPath,
      );
      if (!packageName) {
        throw new Error('Unable to detect Android package id.');
      }

      const adbSerial = await resolveAndroidAdbSerial(params.deviceId);
      await assertAndroidDeviceUsable(adbSerial);
      dbg.mobilePreview(
        'android-app restart device=%s package=%s',
        adbSerial,
        packageName,
      );
      await runCommandImpl('adb', [
        '-s',
        adbSerial,
        'shell',
        'am',
        'force-stop',
        packageName,
      ]);
      await runCommandImpl('adb', [
        '-s',
        adbSerial,
        'shell',
        'monkey',
        '-p',
        packageName,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ]);

      return { packageName, restartedAt: nowIso() };
    },
  };
}

export const mobilePreviewAndroidAppService =
  createMobilePreviewAndroidAppService();
