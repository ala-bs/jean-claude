import { describe, expect, it } from 'vitest';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import {
  applyDeviceToBuildCommand,
  DEVICE_PLACEHOLDER,
  getDeviceBuildCommandNotice,
  quoteShellArgument,
} from './utils-device-build-command';

const simulator: MobilePreviewDevice = {
  id: 'AAAA-BBBB',
  name: 'iPhone 16',
  platform: 'ios',
  state: 'booted',
  kind: 'simulator',
};

const emulator: MobilePreviewDevice = {
  id: 'Pixel_7_API_34',
  connectionId: 'emulator-5554',
  name: 'Pixel 7 API 34',
  platform: 'android',
  state: 'booted',
  kind: 'simulator',
};

const iphone: MobilePreviewDevice = {
  id: '00008120-000A4D2E0C90201E',
  name: "Pat's iPhone",
  platform: 'ios',
  state: 'booted',
  kind: 'physical',
  connection: 'connected',
};

const pixel: MobilePreviewDevice = {
  id: '39021FDJH00123',
  name: 'Pixel 7',
  platform: 'android',
  state: 'booted',
  kind: 'physical',
  connection: 'connected',
};

describe('applyDeviceToBuildCommand', () => {
  it('returns the command unchanged when there is no device', () => {
    expect(
      applyDeviceToBuildCommand({ command: 'npx expo run:ios', device: null }),
    ).toEqual({
      command: 'npx expo run:ios',
      applied: false,
      reason: 'missing-device-id',
    });
  });

  it('flags a device with an empty id', () => {
    const result = applyDeviceToBuildCommand({
      command: 'npx expo run:ios',
      device: { ...iphone, id: '' },
    });
    expect(result).toEqual({
      command: 'npx expo run:ios',
      applied: false,
      reason: 'missing-device-id',
    });
  });

  describe('explicit CLI in the command', () => {
    it('appends --device for expo run:ios', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:ios',
          device: iphone,
        }),
      ).toEqual({
        command: `npx expo run:ios --device ${iphone.id}`,
        applied: true,
        reason: 'appended',
      });
    });

    it('appends --device for expo run:android', () => {
      const result = applyDeviceToBuildCommand({
        command: 'npx expo run:android --variant debug',
        device: pixel,
      });
      expect(result.command).toBe(
        `npx expo run:android --variant debug --device ${pixel.id}`,
      );
      expect(result.applied).toBe(true);
    });

    it('appends --udid for react-native run-ios', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx react-native run-ios',
          device: iphone,
        }).command,
      ).toBe(`npx react-native run-ios --udid ${iphone.id}`);
    });

    it('appends --deviceId for react-native run-android', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx react-native run-android',
          device: pixel,
        }).command,
      ).toBe(`npx react-native run-android --deviceId ${pixel.id}`);
    });

    it('handles pnpm exec / yarn <cli> runners the same way', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'pnpm exec expo run:ios',
          device: iphone,
        }).command,
      ).toBe(`pnpm exec expo run:ios --device ${iphone.id}`);
      expect(
        applyDeviceToBuildCommand({
          command: 'yarn react-native run-android',
          device: pixel,
        }).command,
      ).toBe(`yarn react-native run-android --deviceId ${pixel.id}`);
    });

    it('ignores stacks when the CLI is visible in the command', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx react-native run-ios',
          device: iphone,
          stacks: ['expo', 'react-native'],
        }).command,
      ).toBe(`npx react-native run-ios --udid ${iphone.id}`);
    });

    it('trims trailing whitespace before appending', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:ios   ',
          device: iphone,
        }).command,
      ).toBe(`npx expo run:ios --device ${iphone.id}`);
    });
  });

  describe('simulators are targeted too', () => {
    it('targets an iOS simulator through expo', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:ios',
          device: simulator,
        }),
      ).toEqual({
        command: `npx expo run:ios --device ${simulator.id}`,
        applied: true,
        reason: 'appended',
      });
    });

    it('targets an iOS simulator through react-native --udid', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx react-native run-ios',
          device: simulator,
        }).command,
      ).toBe(`npx react-native run-ios --udid ${simulator.id}`);
    });

    it('targets an Android emulator through expo using the adb serial', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:android',
          device: emulator,
        }).command,
      ).toBe('npx expo run:android --device emulator-5554');
    });

    it('targets an Android emulator through react-native using the adb serial', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx react-native run-android',
          device: emulator,
        }).command,
      ).toBe('npx react-native run-android --deviceId emulator-5554');
    });

    it('falls back to the rail id when there is no connectionId', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:android',
          device: { ...emulator, connectionId: undefined },
        }).command,
      ).toBe('npx expo run:android --device Pixel_7_API_34');
    });

    it('quotes an AVD name containing spaces', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:android',
          device: {
            ...emulator,
            connectionId: undefined,
            id: 'Pixel 7 API 34',
          },
        }).command,
      ).toBe(`npx expo run:android --device 'Pixel 7 API 34'`);
    });

    it('stays quiet (reason "simulator") when nothing can be applied', () => {
      const result = applyDeviceToBuildCommand({
        command: './scripts/build.sh',
        device: simulator,
      });
      expect(result).toEqual({
        command: './scripts/build.sh',
        applied: false,
        reason: 'simulator',
      });
      expect(getDeviceBuildCommandNotice(result)).toBeNull();
    });

    it('treats a device with no kind as a simulator (back-compat)', () => {
      const result = applyDeviceToBuildCommand({
        command: './scripts/build.sh',
        device: { ...simulator, kind: undefined },
      });
      expect(result.reason).toBe('simulator');
    });
  });

  describe('package-manager script wrappers', () => {
    it.each([
      ['npm run ios', ['expo'], `npm run ios -- --device ${iphone.id}`],
      [
        'npm run ios',
        ['react-native'],
        `npm run ios -- --udid ${iphone.id}`,
      ],
      ['pnpm run ios', ['expo'], `pnpm run ios --device ${iphone.id}`],
      ['pnpm ios', ['react-native'], `pnpm ios --udid ${iphone.id}`],
      ['yarn ios', ['expo'], `yarn ios --device ${iphone.id}`],
      [
        'yarn run ios',
        ['react-native'],
        `yarn run ios --udid ${iphone.id}`,
      ],
      ['bun run ios', ['expo'], `bun run ios --device ${iphone.id}`],
    ] as const)(
      'targets iOS for `%s` with stacks %j',
      (command, stacks, expected) => {
        const result = applyDeviceToBuildCommand({
          command,
          device: iphone,
          stacks: [...stacks],
        });
        expect(result.command).toBe(expected);
        expect(result.reason).toBe('appended');
      },
    );

    it.each([
      ['npm run android', ['expo'], `npm run android -- --device ${pixel.id}`],
      [
        'npm run android',
        ['react-native'],
        `npm run android -- --deviceId ${pixel.id}`,
      ],
      ['pnpm run android', ['expo'], `pnpm run android --device ${pixel.id}`],
      [
        'pnpm android',
        ['react-native'],
        `pnpm android --deviceId ${pixel.id}`,
      ],
      ['yarn android', ['expo'], `yarn android --device ${pixel.id}`],
      [
        'bun run android',
        ['react-native'],
        `bun run android --deviceId ${pixel.id}`,
      ],
    ] as const)(
      'targets Android for `%s` with stacks %j',
      (command, stacks, expected) => {
        expect(
          applyDeviceToBuildCommand({
            command,
            device: pixel,
            stacks: [...stacks],
          }).command,
        ).toBe(expected);
      },
    );

    it('only npm gets a `--` separator', () => {
      const withSeparator = ['npm run ios'];
      const withoutSeparator = ['pnpm run ios', 'yarn ios', 'bun run ios'];
      for (const command of withSeparator) {
        expect(
          applyDeviceToBuildCommand({
            command,
            device: iphone,
            stacks: ['expo'],
          }).command,
        ).toContain(' -- --device ');
      }
      for (const command of withoutSeparator) {
        expect(
          applyDeviceToBuildCommand({
            command,
            device: iphone,
            stacks: ['expo'],
          }).command,
        ).not.toContain(' -- --device ');
      }
    });

    it('does not add a second `--` when one is already present', () => {
      const result = applyDeviceToBuildCommand({
        command: 'npm run ios -- --scheme Debug',
        device: iphone,
        stacks: ['expo'],
      });
      expect(result.command).toBe(
        `npm run ios -- --scheme Debug --device ${iphone.id}`,
      );
      expect(result.command.match(/(^|\s)--(\s|$)/g)).toHaveLength(1);
    });

    it('prefers expo when both expo and react-native are detected', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'pnpm run ios',
          device: iphone,
          stacks: ['expo', 'react-native'],
        }).command,
      ).toBe(`pnpm run ios --device ${iphone.id}`);
    });

    it('targets a script wrapper at a simulator', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'pnpm run android',
          device: emulator,
          stacks: ['expo'],
        }).command,
      ).toBe('pnpm run android --device emulator-5554');
    });

    it.each([undefined, null, [], ['ios'], ['android']])(
      'leaves a script wrapper alone when stacks are %j',
      (stacks) => {
        const result = applyDeviceToBuildCommand({
          command: 'pnpm run ios',
          device: iphone,
          stacks: stacks as never,
        });
        expect(result).toEqual({
          command: 'pnpm run ios',
          applied: false,
          reason: 'unknown-command',
        });
        expect(getDeviceBuildCommandNotice(result)).toContain(
          DEVICE_PLACEHOLDER,
        );
      },
    );

    it.each(['pnpm exec something', 'pnpm add expo', 'npm run', 'yarn --help'])(
      'does not treat `%s` as a script invocation',
      (command) => {
        expect(
          applyDeviceToBuildCommand({
            command,
            device: iphone,
            stacks: ['expo'],
          }).applied,
        ).toBe(false);
      },
    );
  });

  describe('escape hatch and existing selectors', () => {
    it('substitutes {{device}} anywhere in the command and adds nothing else', () => {
      expect(
        applyDeviceToBuildCommand({
          command: `./scripts/build.sh --target ${DEVICE_PLACEHOLDER} --release`,
          device: iphone,
        }),
      ).toEqual({
        command: `./scripts/build.sh --target ${iphone.id} --release`,
        applied: true,
        reason: 'placeholder',
      });
    });

    it('substitutes every {{device}} occurrence', () => {
      expect(
        applyDeviceToBuildCommand({
          command: `a ${DEVICE_PLACEHOLDER} b ${DEVICE_PLACEHOLDER}`,
          device: pixel,
        }).command,
      ).toBe(`a ${pixel.id} b ${pixel.id}`);
    });

    it('prefers {{device}} over the inferred flag for a known CLI', () => {
      const result = applyDeviceToBuildCommand({
        command: `npx expo run:ios --udid ${DEVICE_PLACEHOLDER}`,
        device: iphone,
      });
      expect(result.command).toBe(`npx expo run:ios --udid ${iphone.id}`);
      expect(result.reason).toBe('placeholder');
    });

    it('prefers {{device}} over the script-wrapper inference', () => {
      const result = applyDeviceToBuildCommand({
        command: `npm run ios -- --udid ${DEVICE_PLACEHOLDER}`,
        device: iphone,
        stacks: ['expo'],
      });
      expect(result.command).toBe(`npm run ios -- --udid ${iphone.id}`);
      expect(result.reason).toBe('placeholder');
    });

    it('uses connectionId for the {{device}} substitution', () => {
      expect(
        applyDeviceToBuildCommand({
          command: `build ${DEVICE_PLACEHOLDER}`,
          device: emulator,
        }).command,
      ).toBe('build emulator-5554');
    });

    it.each(['--device', '--udid', '--deviceId'])(
      'does not add a second selector when %s is already present',
      (flag) => {
        const command = `npx expo run:ios ${flag} other-id`;
        expect(applyDeviceToBuildCommand({ command, device: iphone })).toEqual({
          command,
          applied: false,
          reason: 'already-targeted',
        });
      },
    );

    it('detects an existing selector in a script wrapper', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npm run ios -- --device other-id',
          device: iphone,
          stacks: ['expo'],
        }).reason,
      ).toBe('already-targeted');
    });

    it('detects an existing selector written with =', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:android --device=emulator-5554',
          device: pixel,
        }).reason,
      ).toBe('already-targeted');
    });

    it('does not mistake --device-family for a device selector', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:ios --device-family 1',
          device: iphone,
        }).reason,
      ).toBe('appended');
    });
  });

  describe('notices', () => {
    it('leaves an unknown custom command untouched and signals it', () => {
      const result = applyDeviceToBuildCommand({
        command: './scripts/build-and-install.sh',
        device: pixel,
      });
      expect(result).toEqual({
        command: './scripts/build-and-install.sh',
        applied: false,
        reason: 'unknown-command',
      });
      expect(getDeviceBuildCommandNotice(result)).toContain(DEVICE_PLACEHOLDER);
    });

    it('has no notice for any case other than an unknown command', () => {
      for (const device of [simulator, iphone, pixel, emulator]) {
        const result = applyDeviceToBuildCommand({
          command: 'npx expo run:ios',
          device,
        });
        expect(getDeviceBuildCommandNotice(result)).toBeNull();
      }
    });
  });

  describe('shutdown Android emulator (no adb serial yet)', () => {
    const shutdownAvd: MobilePreviewDevice = {
      id: 'Pixel_7_API_34',
      name: 'Pixel 7 API 34',
      platform: 'android',
      state: 'shutdown',
      kind: 'simulator',
    };

    it('does not hand an AVD name to react-native --deviceId', () => {
      const result = applyDeviceToBuildCommand({
        command: 'npx react-native run-android',
        device: shutdownAvd,
      });
      expect(result).toEqual({
        command: 'npx react-native run-android',
        applied: false,
        reason: 'device-not-running',
      });
      expect(getDeviceBuildCommandNotice(result)).toMatch(/adb serial/);
    });

    it('does not hand an AVD name to a react-native script wrapper', () => {
      const result = applyDeviceToBuildCommand({
        command: 'pnpm android',
        device: shutdownAvd,
        stacks: ['react-native'],
      });
      expect(result).toEqual({
        command: 'pnpm android',
        applied: false,
        reason: 'device-not-running',
      });
    });

    it('still targets expo run:android by AVD name', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:android',
          device: shutdownAvd,
        }),
      ).toEqual({
        command: 'npx expo run:android --device Pixel_7_API_34',
        applied: true,
        reason: 'appended',
      });
    });

    it('uses the adb serial once the emulator is booted', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx react-native run-android',
          device: emulator,
        }).command,
      ).toBe('npx react-native run-android --deviceId emulator-5554');
    });

    it('still uses the hardware udid for a physical iPhone', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx react-native run-ios',
          device: iphone,
        }).command,
      ).toBe('npx react-native run-ios --udid 00008120-000A4D2E0C90201E');
    });

    it('still uses the serial for a physical Android device', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx react-native run-android',
          device: pixel,
        }).command,
      ).toBe('npx react-native run-android --deviceId 39021FDJH00123');
    });
  });

  describe('quoting', () => {
    it('quotes device ids that are not shell-safe', () => {
      expect(
        applyDeviceToBuildCommand({
          command: 'npx expo run:android',
          device: { ...pixel, id: 'weird id; rm -rf /' },
        }).command,
      ).toBe(`npx expo run:android --device 'weird id; rm -rf /'`);
    });

    it('quotes an id containing a single quote', () => {
      expect(quoteShellArgument("pat's phone")).toBe("'pat'\\''s phone'");
      expect(
        applyDeviceToBuildCommand({
          command: `build ${DEVICE_PLACEHOLDER}`,
          device: { ...pixel, id: "a'b" },
        }).command,
      ).toBe("build 'a'\\''b'");
    });

    it('leaves plain UUID and adb serial ids unquoted', () => {
      expect(quoteShellArgument('00008120-000A4D2E0C90201E')).toBe(
        '00008120-000A4D2E0C90201E',
      );
      expect(quoteShellArgument('39021FDJH00123')).toBe('39021FDJH00123');
      expect(quoteShellArgument('192.168.1.5:5555')).toBe('192.168.1.5:5555');
    });
  });
});
