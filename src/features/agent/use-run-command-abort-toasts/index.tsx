import { getRunCommandGroupAbortMessage } from '@shared/run-command-types';
import { useEffect } from 'react';

import { api } from '@/lib/api';
import { useToastStore } from '@/stores/toasts';

/**
 * Surfaces staged group runs that stopped early.
 *
 * A sequence aborts in the background, long after the start call resolved, so
 * there is no promise for a caller to reject. Without this the later stages
 * would simply never run and the only trace would be a debug log.
 *
 * Mounted once at the app root because a group can be launched from a task, a
 * project root favorite, or a PR, and any of those can abort while the user has
 * navigated somewhere else entirely.
 */
export function useRunCommandAbortToasts(): void {
  useEffect(() => {
    return api.runCommands.onGroupAborted((event) => {
      useToastStore.getState().addToast({
        message: getRunCommandGroupAbortMessage(event),
        type: 'error',
      });
    });
  }, []);
}
