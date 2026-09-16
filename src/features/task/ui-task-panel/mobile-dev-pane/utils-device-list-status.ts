import { PLATFORM_LABELS } from './utils-device-options';

/**
 * Reconciles the two per-platform device queries into one UI state.
 *
 * The product rule this encodes: one platform's tooling being absent must never
 * hide the other platform's devices. A missing Android SDK rejects in
 * milliseconds while a cold `simctl` takes seconds, so a naive "any error is an
 * error" reading both hides working simulators and flashes a red error before
 * they arrive.
 */
export function resolveDeviceListStatus({
  deviceCount,
  ios,
  android,
}: {
  deviceCount: number;
  ios: { isLoading: boolean; isFetching: boolean; error: unknown };
  android: { isLoading: boolean; isFetching: boolean; error: unknown };
}): {
  isLoading: boolean;
  isFetching: boolean;
  failedPlatforms: string[];
  /** Non-null only when nothing loaded at all and loading has settled. */
  errors: unknown[];
} {
  const isLoading = ios.isLoading || android.isLoading;
  const failedPlatforms = [
    ios.error ? PLATFORM_LABELS.ios : null,
    android.error ? PLATFORM_LABELS.android : null,
  ].filter((entry): entry is string => entry !== null);

  return {
    isLoading,
    isFetching: ios.isFetching || android.isFetching,
    failedPlatforms,
    errors:
      !isLoading && deviceCount === 0 && failedPlatforms.length > 0
        ? [ios.error, android.error].filter(Boolean)
        : [],
  };
}
