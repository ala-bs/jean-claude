import { cleanIpcError } from '@/lib/ipc-error';

const MAX_LENGTH = 200;

// devicectl/simctl failures arrive as multi-paragraph dumps (the full xcrun
// command line, CoreDevice error codes, LaunchServices internals). That is
// unreadable in a toast, so keep the first meaningful line and special-case the
// failure users actually hit: the app was never installed on the device.
export function summarizeDeviceActionError(error: unknown): string {
  const message = cleanIpcError(error);
  if (!message) return 'Something went wrong.';

  if (/is not installed/i.test(message)) {
    const bundleId = message.match(/BundleIdentifier\s*=\s*(\S+)/)?.[1];
    return bundleId
      ? `${bundleId} is not installed on the selected device. Build and install the app first.`
      : 'The app is not installed on the selected device. Build and install it first.';
  }

  const firstLine =
    message
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'Something went wrong.';

  return firstLine.length > MAX_LENGTH
    ? `${firstLine.slice(0, MAX_LENGTH - 1).trimEnd()}…`
    : firstLine;
}
