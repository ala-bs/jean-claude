import { describe, expect, it } from 'vitest';

import { summarizeDeviceActionError } from './utils-action-error';

describe('summarizeDeviceActionError', () => {
  it('turns a devicectl "not installed" dump into actionable copy', () => {
    const error = new Error(
      `Error invoking remote method 'mobilePreview:restartIosApp': Error: Failed to launch com.linp.acorn on iOS device D0C5D914: Command failed with exit code 1: xcrun devicectl device process launch --device D0C5D914 --terminate-existing com.linp.acorn
ERROR: The application failed to launch. (com.apple.dt.CoreDeviceError error 10002 (0x2712))
NSLocalizedRecoverySuggestion = Provide a valid bundle identifier.
BundleIdentifier = com.linp.acorn
NSLocalizedFailureReason = The requested application com.linp.acorn is not installed.`,
    );

    expect(summarizeDeviceActionError(error)).toBe(
      'com.linp.acorn is not installed on the selected device. Build and install the app first.',
    );
  });

  it('keeps only the first line of other multi-line errors', () => {
    expect(
      summarizeDeviceActionError(new Error('Boot failed\nstack trace here')),
    ).toBe('Boot failed');
  });

  it('truncates very long single-line errors', () => {
    const result = summarizeDeviceActionError(new Error('x'.repeat(400)));
    expect(result).toHaveLength(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('falls back when the error has no message', () => {
    expect(summarizeDeviceActionError(new Error(''))).toBe(
      'Something went wrong.',
    );
  });
});
