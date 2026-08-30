import { useEffect } from 'react';

import {
  getLocalStorageBootGuardState,
  resolveLocalStorageBootGuard,
  subscribeLocalStorageBootGuard,
} from '@/lib/local-storage-boot-guard';
import { api } from '@/lib/api';
import { useProjects } from '@/hooks/use-projects';
import { useToastStore } from '@/stores/toasts';

/**
 * Tells the localStorage boot guard which case an empty bucket was.
 *
 * Mounted from `app.tsx`, outside the router, deliberately. Inside the root
 * route it would be replaced by `RootErrorBoundary` whenever `RootLayout`
 * throws, and the guard — which withholds writes until someone resolves it —
 * would then starve silently: no persistence for the session and no explanation.
 *
 * Two signals, checked in order of authority:
 *
 * 1. `hasExistingLocalStorageBucket` (from the main process, before the window
 *    loaded). If this profile never had a bucket on disk, an empty read is a
 *    genuine first run. This is what keeps a fresh dev worktree — whose SQLite
 *    is a *copy*, so projects exist while the Chromium profile is brand new —
 *    from looking exactly like a failed read.
 * 2. Projects in SQLite, a separate store that still answers when the bucket
 *    fails. A profile with projects and a bucket that existed cannot be on a
 *    first run, so an empty read there means the read failed.
 */
export function LocalStorageBootGuardBridge() {
  const { data: projects, isError } = useProjects();
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    if (!api.app.hasExistingLocalStorageBucket) {
      resolveLocalStorageBootGuard({ hadPriorData: false });
      return;
    }

    // A failed query proves nothing either way, and `undefined` means the query
    // has not resolved — reading either as "no projects" would resolve the guard
    // the wrong way, which is exactly the overwrite it exists to prevent. Leave
    // it withholding: not persisting this session is recoverable, overwriting is
    // not.
    if (isError || projects === undefined) return;

    resolveLocalStorageBootGuard({ hadPriorData: projects.length > 0 });
  }, [isError, projects]);

  useEffect(() => {
    let reported = false;
    const announce = (
      next: ReturnType<typeof getLocalStorageBootGuardState>,
    ) => {
      if (next !== 'blocked') return;
      // Ask the main process to record *why* — only it can see whether the
      // previous instance was still alive and holding the LevelDB lock. Fired
      // once per session; a failure here must not swallow the user-facing toast.
      if (!reported) {
        reported = true;
        void api.app
          .reportLocalStorageBootBlocked()
          .then((logPath) => {
            console.error(
              '[ls-guard] boot failure recorded in diagnostics log:',
              logPath,
            );
          })
          .catch((error: unknown) => {
            console.error('[ls-guard] failed to record diagnostics', error);
          });
      }
      addToast({
        type: 'error',
        message:
          'Saved settings could not be read this session and are being protected ' +
          'from being overwritten. Restart Jean-Claude to restore them.',
      });
    };

    announce(getLocalStorageBootGuardState());
    return subscribeLocalStorageBootGuard(announce);
  }, [addToast]);

  return null;
}
