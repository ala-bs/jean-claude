import { useCallback, useEffect, useState } from 'react';

import { useToastStore } from '@/stores/toasts';

const COPIED_RESET_MS = 2000;

/**
 * Copies a pull request URL to the clipboard and surfaces a toast.
 *
 * `didCopy` flips back to false 2s after the *latest* copy — the timer is keyed
 * on a counter so repeated clicks restart the window instead of being a no-op.
 */
export function useCopyPrLink(url: string | undefined) {
  const addToast = useToastStore((state) => state.addToast);
  const [copyCount, setCopyCount] = useState(0);
  const [didCopy, setDidCopy] = useState(false);

  const copyLink = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setDidCopy(true);
      setCopyCount((count) => count + 1);
      addToast({ type: 'success', message: 'PR link copied to clipboard' });
    } catch {
      addToast({ type: 'error', message: 'Failed to copy PR link' });
    }
  }, [addToast, url]);

  useEffect(() => {
    if (!didCopy) return;
    const timer = setTimeout(() => setDidCopy(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [didCopy, copyCount]);

  return { copyLink, didCopy };
}
