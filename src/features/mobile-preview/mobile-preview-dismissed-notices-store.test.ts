import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllDismissedNotices,
  clearDismissedNotice,
  isNoticeDismissed,
  markNoticeDismissed,
} from './mobile-preview-dismissed-notices-store';

describe('mobile preview dismissed notices store', () => {
  beforeEach(() => {
    clearAllDismissedNotices();
  });

  it('remembers a dismissal so it survives the pane unmounting', () => {
    expect(isNoticeDismissed('device-a\0boom')).toBe(false);
    markNoticeDismissed('device-a\0boom');
    expect(isNoticeDismissed('device-a\0boom')).toBe(true);
  });

  it('still surfaces a different failure on the same device', () => {
    markNoticeDismissed('device-a\0boom');
    expect(isNoticeDismissed('device-a\0other failure')).toBe(false);
  });

  it('still surfaces the same failure on a fresh attempt', () => {
    markNoticeDismissed('device-a\0retry-0\0boom');
    expect(isNoticeDismissed('device-a\0retry-1\0boom')).toBe(false);
  });

  it('re-arms the notice when the dismissal is cleared by a retry', () => {
    markNoticeDismissed('device-a\0boom');
    clearDismissedNotice('device-a\0boom');
    expect(isNoticeDismissed('device-a\0boom')).toBe(false);
  });

  it('treats a null key as never dismissed and ignores null writes', () => {
    markNoticeDismissed(null);
    clearDismissedNotice(null);
    expect(isNoticeDismissed(null)).toBe(false);
  });
});
