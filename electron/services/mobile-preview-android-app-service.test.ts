import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createMobilePreviewAndroidAppService } from './mobile-preview-android-app-service';

async function createAndroidProject(prefix: string) {
  const tempRoot = os.tmpdir();
  await fs.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, prefix));
  const gradlePath = path.join(tempDir, 'android', 'app', 'build.gradle');
  await fs.mkdir(path.dirname(gradlePath), { recursive: true });
  await fs.writeFile(gradlePath, 'android { applicationId "com.example.app" }');
  return {
    projectPath: tempDir,
    androidProjectPath: 'android',
    deviceId: 'Medium_Phone',
  };
}

function createService(
  runCommandImpl: (
    command: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>,
) {
  return createMobilePreviewAndroidAppService({
    runCommandImpl: runCommandImpl as never,
  });
}

describe('getAndroidAppStatus', () => {
  /**
   * A booted emulator's rail id is the AVD name, which `adb -s` does not
   * understand. Before boot completes the AVD name resolves to nothing, and the
   * status must come back unknown rather than shelling out with the AVD name.
   */
  it('returns unknown app install status for unresolved Android AVD names before boot completes', async () => {
    const params = await createAndroidProject('jc-android-app-avd-resolve-');

    let booted = false;
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      const commandText = `${command} ${args.join(' ')}`;
      if (commandText === 'adb devices -l') {
        return {
          stdout: booted
            ? 'List of devices attached\nemulator-5554 device model:Medium_Phone\n'
            : 'List of devices attached\n',
          stderr: '',
        };
      }
      if (commandText === 'adb -s emulator-5554 emu avd name') {
        return { stdout: 'Medium_Phone\nOK\n', stderr: '' };
      }
      if (
        commandText ===
        'adb -s emulator-5554 shell pm list packages com.example.app'
      ) {
        return { stdout: 'package:com.example.app\n', stderr: '' };
      }
      expect(commandText).not.toBe(
        'adb -s Medium_Phone shell pm list packages com.example.app',
      );
      throw new Error(`Unexpected command: ${commandText}`);
    });
    const service = createService(runCommandImpl);

    await expect(service.getAndroidAppStatus(params)).resolves.toMatchObject({
      appInstalled: null,
      packageName: 'com.example.app',
    });
    booted = true;

    await expect(service.getAndroidAppStatus(params)).resolves.toMatchObject({
      appInstalled: true,
      packageName: 'com.example.app',
    });
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'pm',
      'list',
      'packages',
      'com.example.app',
    ]);
  });

  it('reports the app as missing when the package is not listed', async () => {
    const params = await createAndroidProject('jc-android-app-missing-');
    const service = createService(async (command, args) => {
      const commandText = `${command} ${args.join(' ')}`;
      if (commandText === 'adb devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device model:Medium_Phone\n',
          stderr: '',
        };
      }
      if (commandText === 'adb -s emulator-5554 emu avd name') {
        return { stdout: 'Medium_Phone\nOK\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(service.getAndroidAppStatus(params)).resolves.toMatchObject({
      appInstalled: false,
      packageName: 'com.example.app',
    });
  });

  it('throws when the configured android project folder does not exist', async () => {
    const params = await createAndroidProject('jc-android-app-nopath-');
    const service = createService(async () => ({ stdout: '', stderr: '' }));

    await expect(
      service.getAndroidAppStatus({ ...params, androidProjectPath: 'nope' }),
    ).rejects.toThrow('No native Android project found at configured path.');
  });

  it('refuses an android project path that escapes the project root', async () => {
    const params = await createAndroidProject('jc-android-app-escape-');
    const service = createService(async () => ({ stdout: '', stderr: '' }));

    await expect(
      service.getAndroidAppStatus({
        ...params,
        androidProjectPath: '../outside',
      }),
    ).rejects.toThrow('Android project path must stay inside the project.');
  });
});

describe('android device usability', () => {
  it('surfaces the actionable reason for an unauthorized physical Android device', async () => {
    const params = await createAndroidProject('jc-android-app-unauthorized-');
    const service = createService(async (command, args) => {
      const commandText = `${command} ${args.join(' ')}`;
      if (commandText === 'adb devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D unauthorized usb:1-2\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${commandText}`);
    });
    const deviceParams = { ...params, deviceId: '1A2B3C4D' };

    await expect(service.getAndroidAppStatus(deviceParams)).rejects.toThrow(
      'Accept the USB debugging prompt on the device.',
    );
    await expect(service.restartAndroidApp(deviceParams)).rejects.toThrow(
      'Accept the USB debugging prompt on the device.',
    );
  });

  it('explains an offline device instead of leaking raw adb output', async () => {
    const params = await createAndroidProject('jc-android-app-offline-');
    const service = createService(async () => ({
      stdout: 'List of devices attached\n1A2B3C4D offline usb:1-2\n',
      stderr: '',
    }));

    await expect(
      service.getAndroidAppStatus({ ...params, deviceId: '1A2B3C4D' }),
    ).rejects.toThrow(
      'Device is offline — reconnect the cable or re-enable USB debugging.',
    );
  });

  it('names an unexpected device state in the error', async () => {
    const params = await createAndroidProject('jc-android-app-badstate-');
    const service = createService(async () => ({
      stdout: 'List of devices attached\n1A2B3C4D bootloader usb:1-2\n',
      stderr: '',
    }));

    await expect(
      service.getAndroidAppStatus({ ...params, deviceId: '1A2B3C4D' }),
    ).rejects.toThrow(
      'Device is in "bootloader" state and cannot be used for preview.',
    );
  });
});

describe('restartAndroidApp', () => {
  it('force-stops the package and relaunches it through the launcher intent', async () => {
    const params = await createAndroidProject('jc-android-app-restart-');
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      const commandText = `${command} ${args.join(' ')}`;
      if (commandText === 'adb devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D device usb:1-2\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService(runCommandImpl);

    await expect(
      service.restartAndroidApp({ ...params, deviceId: '1A2B3C4D' }),
    ).resolves.toMatchObject({ packageName: 'com.example.app' });

    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      '1A2B3C4D',
      'shell',
      'am',
      'force-stop',
      'com.example.app',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      '1A2B3C4D',
      'shell',
      'monkey',
      '-p',
      'com.example.app',
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
  });

  it('refuses to restart when the package id cannot be detected', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(
      path.join(tempRoot, 'jc-android-app-nopkg-'),
    );
    await fs.mkdir(path.join(tempDir, 'android', 'app'), { recursive: true });
    const service = createService(async () => ({ stdout: '', stderr: '' }));

    await expect(
      service.restartAndroidApp({
        projectPath: tempDir,
        androidProjectPath: 'android',
        deviceId: '1A2B3C4D',
      }),
    ).rejects.toThrow('Unable to detect Android package id.');
  });
});
