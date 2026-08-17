export const MOBILE_DEV_SERVER_COMMAND_PREFIX = 'mobile-dev-server:';
const MOBILE_PREVIEW_RUNTIME_PREFIX = 'mobile-runtime:';

function decodeIdentityPart(value: string): string | null {
  if (!value) return null;

  try {
    return decodeURIComponent(value) || null;
  } catch {
    return null;
  }
}

function normalizeAppPath(appPath: string): string {
  return appPath || '.';
}

export function createMobileDevServerCommandId(appPath: string): string {
  return `${MOBILE_DEV_SERVER_COMMAND_PREFIX}${encodeURIComponent(normalizeAppPath(appPath))}`;
}

export function parseMobileDevServerCommandId(commandId: string): string | null {
  if (!commandId.startsWith(MOBILE_DEV_SERVER_COMMAND_PREFIX)) return null;

  const encodedAppPath = commandId.slice(MOBILE_DEV_SERVER_COMMAND_PREFIX.length);
  if (encodedAppPath.includes(':')) return null;
  return decodeIdentityPart(encodedAppPath);
}

export function createMobilePreviewRuntimeKey({
  taskId,
  appPath,
}: {
  taskId: string;
  appPath: string;
}): string {
  return `${MOBILE_PREVIEW_RUNTIME_PREFIX}${encodeURIComponent(taskId)}:${encodeURIComponent(normalizeAppPath(appPath))}`;
}

export function parseMobilePreviewRuntimeKey(
  runtimeKey: string,
): { taskId: string; appPath: string } | null {
  if (!runtimeKey.startsWith(MOBILE_PREVIEW_RUNTIME_PREFIX)) return null;

  const parts = runtimeKey
    .slice(MOBILE_PREVIEW_RUNTIME_PREFIX.length)
    .split(':');
  if (parts.length !== 2) return null;

  const taskId = decodeIdentityPart(parts[0]);
  const appPath = decodeIdentityPart(parts[1]);
  return taskId && appPath ? { taskId, appPath } : null;
}
