const MOBILE_BUILD_COMMAND_PREFIX = 'mobile-build:';

function decodeIdPart(value: string): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return null;
  }
}

/** Parses the stable command id used by mobile preview builds. */
export function parseMobileBuildCommandId(
  commandId: string,
): { appPath: string; platform: 'ios' | 'android'; deviceId?: string } | null {
  if (!commandId.startsWith(MOBILE_BUILD_COMMAND_PREFIX)) return null;

  const parts = commandId.slice(MOBILE_BUILD_COMMAND_PREFIX.length).split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const [encodedAppPath, platform, encodedDeviceId] = parts;
  if (platform !== 'ios' && platform !== 'android') return null;

  const appPath = decodeIdPart(encodedAppPath);
  if (!appPath) return null;

  if (encodedDeviceId === undefined) return { appPath, platform };

  const deviceId = decodeIdPart(encodedDeviceId);
  if (!deviceId) return null;
  return deviceId === 'no-device'
    ? { appPath, platform }
    : { appPath, platform, deviceId };
}
