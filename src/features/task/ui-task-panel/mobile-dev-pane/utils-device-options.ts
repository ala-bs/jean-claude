import type {
  MobilePlatform,
  MobilePreviewDevice,
} from '@shared/mobile-simulator-types';
import { PLATFORM_LABELS } from '@shared/mobile-simulator-types';

import {
  makeMobileDevDeviceKey,
  type MobileDevPaneDeviceSelection,
} from '@/stores/mobile-dev-pane';

export const FAVORITES_GROUP_LABEL = 'Favorites';

// Re-exported so existing importers in this pane keep their import path; the
// canonical definition sits beside `MobilePlatform`.
export { PLATFORM_LABELS };

export function isFavoriteDevice({
  favoriteDevices,
  platform,
  deviceId,
}: {
  favoriteDevices: Record<string, MobileDevPaneDeviceSelection>;
  platform: MobilePlatform;
  deviceId: string;
}): boolean {
  return Boolean(
    favoriteDevices[makeMobileDevDeviceKey({ platform, deviceId })],
  );
}

/**
 * Starred devices across both platforms, in device-list order.
 *
 * Intersected with the live list on purpose: a chip for a device that is no
 * longer attached would be a dead end, since selecting it resolves to "nothing
 * selected". The favorite itself is kept in the store so the chip returns when
 * the device does.
 */
export function getFavoriteDevices({
  devices,
  favoriteDevices,
}: {
  devices: MobilePreviewDevice[];
  favoriteDevices: Record<string, MobileDevPaneDeviceSelection>;
}): MobilePreviewDevice[] {
  return devices.filter((device) =>
    isFavoriteDevice({
      favoriteDevices,
      platform: device.platform,
      deviceId: device.id,
    }),
  );
}

/**
 * Dropdown options for the merged iOS + Android list.
 *
 * Ordering is Favorites, then iOS, then Android. `<Combobox>` renders a sticky
 * header whenever an option's `group` differs from its predecessor, so grouping
 * is purely ordering plus labelling. Groups must stay contiguous or a header
 * would repeat.
 *
 * Group labels are suppressed when only one group is non-empty -- a lone "iOS"
 * header above every row is noise. Favorites rows carry their platform in the
 * description instead, since their header can't convey it for a mixed list.
 */
export function buildDeviceOptions({
  devices,
  favoriteDevices,
}: {
  devices: MobilePreviewDevice[];
  favoriteDevices: Record<string, MobileDevPaneDeviceSelection>;
}): {
  value: string;
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
}[] {
  const favorites: MobilePreviewDevice[] = [];
  const byPlatform: Record<MobilePlatform, MobilePreviewDevice[]> = {
    ios: [],
    android: [],
  };

  devices.forEach((device) => {
    if (
      isFavoriteDevice({
        favoriteDevices,
        platform: device.platform,
        deviceId: device.id,
      })
    ) {
      favorites.push(device);
    } else {
      byPlatform[device.platform]?.push(device);
    }
  });

  const nonEmptyGroupCount =
    (favorites.length > 0 ? 1 : 0) +
    (byPlatform.ios.length > 0 ? 1 : 0) +
    (byPlatform.android.length > 0 ? 1 : 0);
  const showGroupLabels = nonEmptyGroupCount > 1;

  const toOption = ({
    device,
    group,
    withPlatform,
  }: {
    device: MobilePreviewDevice;
    group?: string;
    withPlatform?: boolean;
  }) => ({
    value: makeMobileDevDeviceKey({
      platform: device.platform,
      deviceId: device.id,
    }),
    label: device.name,
    description: [
      withPlatform ? PLATFORM_LABELS[device.platform] : undefined,
      device.osVersion,
      device.state === 'booted' ? 'Booted' : undefined,
      device.unavailableReason,
    ]
      .filter(Boolean)
      .join(' · '),
    // Searchable but not displayed. The platform is usually conveyed by the
    // group header rather than the row, yet "android" is an obvious thing to
    // type -- so match it explicitly instead of relying on the value's key
    // format happening to contain it.
    keywords: [
      PLATFORM_LABELS[device.platform],
      device.platform,
      device.id,
      device.state === 'booted' ? 'booted' : 'shutdown',
    ],
    ...(group ? { group } : {}),
  });

  return [
    ...favorites.map((device) =>
      toOption({
        device,
        group: showGroupLabels ? FAVORITES_GROUP_LABEL : undefined,
        // The Favorites header spans both platforms, so name it per row.
        withPlatform: true,
      }),
    ),
    ...(['ios', 'android'] as const).flatMap((platform) =>
      byPlatform[platform].map((device) =>
        toOption({
          device,
          group: showGroupLabels ? PLATFORM_LABELS[platform] : undefined,
          withPlatform: !showGroupLabels,
        }),
      ),
    ),
  ];
}
