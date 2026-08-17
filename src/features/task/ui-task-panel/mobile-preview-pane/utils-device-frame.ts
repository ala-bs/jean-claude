import type { MobilePlatform } from '@shared/mobile-simulator-types';

export function getDeviceCornerRadiusRatio({
  platform,
  deviceName,
}: {
  platform: MobilePlatform;
  deviceName: string;
}): number {
  const name = deviceName.toLowerCase();

  if (platform === 'ios') {
    if (/iphone (se|[4-8](?:\s|$| plus))/.test(name)) return 0;
    if (/iphone (x|xs|xr|11)/.test(name)) return 0.105;
    if (/iphone (12|13|14|15|16|17)/.test(name)) return 0.118;
    if (name.includes('iphone')) return 0.11;
    if (name.includes('ipad')) return 0.035;
    return 0.04;
  }

  if (/pixel[_\s-]?(6|7|8|9|10)/.test(name)) return 0.085;
  if (/galaxy|samsung/.test(name)) return 0.065;
  return 0.04;
}
