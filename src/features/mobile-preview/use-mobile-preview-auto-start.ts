import { useCallback, useEffect, useRef, useState } from 'react';

import { useLatestRef } from '@/hooks/use-latest-ref';

import {
  clearDismissedNotice,
  isNoticeDismissed,
  markNoticeDismissed,
} from './mobile-preview-dismissed-notices-store';

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMobilePreviewAutoStart({
  enabled,
  attemptKey,
  start,
}: {
  enabled: boolean;
  attemptKey: string | null;
  start: () => Promise<unknown>;
}) {
  const startRef = useLatestRef(start);
  const attemptedRequestKeysRef = useRef(new Set<string>());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [failure, setFailure] = useState<{
    requestKey: string;
    message: string;
  } | null>(null);
  const requestKey =
    enabled && attemptKey ? `${attemptKey}\0${retryGeneration}` : null;

  useEffect(() => {
    if (!requestKey || attemptedRequestKeysRef.current.has(requestKey)) return;
    attemptedRequestKeysRef.current.add(requestKey);
    let active = true;

    void startRef.current().catch((error: unknown) => {
      if (!active) return;
      setFailure({
        requestKey,
        message: formatError(error) || 'Failed to start preview stream',
      });
    });

    return () => {
      active = false;
    };
  }, [requestKey, startRef]);

  const dismissKey =
    requestKey && failure?.requestKey === requestKey
      ? `auto-start\0${requestKey}\0${failure.message}`
      : null;

  const retry = useCallback(() => {
    clearDismissedNotice(dismissKey);
    setFailure(null);
    setRetryGeneration((value) => value + 1);
  }, [dismissKey]);

  /**
   * User explicitly dismissed the banner: remember it so reopening the preview
   * (which remounts the pane and re-runs the failing attempt) stays quiet.
   */
  const dismissError = useCallback(() => {
    markNoticeDismissed(dismissKey);
    setFailure(null);
  }, [dismissKey]);

  /**
   * The error is merely stale (e.g. a manual start succeeded). Drop it without
   * recording a dismissal — otherwise a later identical failure would be
   * silently swallowed.
   */
  const clearError = useCallback(() => setFailure(null), []);

  return {
    error:
      failure?.requestKey === requestKey && !isNoticeDismissed(dismissKey)
        ? failure.message
        : null,
    retry,
    dismissError,
    clearError,
  };
}
