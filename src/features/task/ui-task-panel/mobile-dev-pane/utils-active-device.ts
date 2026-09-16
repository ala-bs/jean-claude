import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import {
  makeMobileDevDeviceKey,
  type MobileDevPaneDeviceSelection,
} from '@/stores/mobile-dev-pane';

/**
 * Resolves the persisted selection against the live device list.
 *
 * iOS and Android devices share one list, so a device is identified by
 * `platform:deviceId` rather than id alone -- ids are only unique within a
 * platform, and an AVD name could in principle collide with a simulator UDID.
 *
 * Extracted as a pure function because the rules are easy to get subtly wrong
 * and the failure is silent. Reporting "nothing selected" for a device that is
 * gone is what keeps the picker showing its placeholder, and -- more
 * importantly -- keeps Boot/Restart from targeting a device the user can no
 * longer see.
 */
export function resolveActiveDevice({
  devices,
  selection,
}: {
  devices: MobilePreviewDevice[];
  selection: MobileDevPaneDeviceSelection | null;
}): {
  activeDeviceKey: string;
  activeDevice: MobilePreviewDevice | null;
  persistedDeviceName: string | null;
} {
  const persistedKey = selection ? makeMobileDevDeviceKey(selection) : '';

  const activeDevice =
    devices.find(
      (device) =>
        makeMobileDevDeviceKey({
          platform: device.platform,
          deviceId: device.id,
        }) === persistedKey,
    ) ?? null;

  return {
    // A device can vanish (deleted simulator, unplugged handset). Report
    // "nothing selected" rather than a key no option can match.
    activeDeviceKey: activeDevice ? persistedKey : '',
    activeDevice,
    persistedDeviceName: selection?.deviceName ?? null,
  };
}
