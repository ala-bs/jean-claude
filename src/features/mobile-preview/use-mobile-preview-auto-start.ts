import { useCallback, useEffect, useRef, useState } from 'react';

import { useLatestRef } from '@/hooks/use-latest-ref';

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

  const retry = useCallback(() => {
    setFailure(null);
    setRetryGeneration((value) => value + 1);
  }, []);
  const clearError = useCallback(() => setFailure(null), []);

  return {
    error: failure?.requestKey === requestKey ? failure.message : null,
    retry,
    clearError,
  };
}
