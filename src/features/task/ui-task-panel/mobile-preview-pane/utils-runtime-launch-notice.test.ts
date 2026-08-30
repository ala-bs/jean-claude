import { describe, expect, it } from 'vitest';

import {
  getRuntimeLaunchAttemptKey,
  getRuntimeLaunchDismissKey,
  isRuntimeLaunchNoticeDismissable,
  shouldShowRuntimeLaunchNotice,
} from './utils-runtime-launch-notice';

const attemptKey = getRuntimeLaunchAttemptKey([0, 'ios:sim-1', 8081, 1234]);
const base = {
  status: 'error' as const,
  message: 'Failed to launch Expo',
  attemptKey,
  dismissedKey: null as string | null,
};
const dismissed = getRuntimeLaunchDismissKey(base);

describe('shouldShowRuntimeLaunchNotice', () => {
  it('hides settled statuses', () => {
    expect(
      shouldShowRuntimeLaunchNotice({ ...base, status: 'idle', message: '' }),
    ).toBe(false);
    expect(
      shouldShowRuntimeLaunchNotice({ ...base, status: 'ready', message: '' }),
    ).toBe(false);
  });

  it('shows a terminal notice that has not been dismissed', () => {
    expect(shouldShowRuntimeLaunchNotice(base)).toBe(true);
  });

  it('hides the exact notice the user dismissed', () => {
    expect(
      shouldShowRuntimeLaunchNotice({ ...base, dismissedKey: dismissed }),
    ).toBe(false);
  });

  it('still shows a different failure after a dismissal', () => {
    expect(
      shouldShowRuntimeLaunchNotice({
        ...base,
        message: 'Simulator has no app registered',
        dismissedKey: dismissed,
      }),
    ).toBe(true);
  });

  it('shows the same failure again after a new launch attempt', () => {
    expect(
      shouldShowRuntimeLaunchNotice({
        ...base,
        // device switched / dev server restarted / user retried
        attemptKey: getRuntimeLaunchAttemptKey([1, 'ios:sim-2', 8081, 9999]),
        dismissedKey: dismissed,
      }),
    ).toBe(true);
  });

  it('never suppresses in-flight progress notices', () => {
    expect(
      shouldShowRuntimeLaunchNotice({
        ...base,
        status: 'launching',
        dismissedKey: dismissed,
      }),
    ).toBe(true);
  });
});

describe('isRuntimeLaunchNoticeDismissable', () => {
  it('marks only terminal statuses dismissable', () => {
    expect(isRuntimeLaunchNoticeDismissable('error')).toBe(true);
    expect(isRuntimeLaunchNoticeDismissable('unsupported')).toBe(true);
    expect(isRuntimeLaunchNoticeDismissable('launching')).toBe(false);
    expect(isRuntimeLaunchNoticeDismissable('waiting')).toBe(false);
  });
});

describe('getRuntimeLaunchAttemptKey', () => {
  it('is stable for identical inputs and distinct for changed ones', () => {
    expect(getRuntimeLaunchAttemptKey([0, 'a', null])).toBe(
      getRuntimeLaunchAttemptKey([0, 'a', null]),
    );
    expect(getRuntimeLaunchAttemptKey([0, 'a', null])).not.toBe(
      getRuntimeLaunchAttemptKey([1, 'a', null]),
    );
  });
});
