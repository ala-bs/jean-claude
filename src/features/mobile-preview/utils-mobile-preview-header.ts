import {
  isMobilePreviewProjectEnabled,
  type Project,
} from '@shared/types';
import type { RunStatus } from '@shared/run-command-types';

import { parseMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';

export function getMobilePreviewHeaderState({
  projects,
  runCommandRunning,
}: {
  projects: readonly Project[];
  runCommandRunning: Readonly<Record<string, RunStatus>>;
}) {
  let runningCount = 0;
  for (const status of Object.values(runCommandRunning)) {
    for (const command of status.commands) {
      if (
        command.status === 'running' &&
        parseMobileDevServerCommandId(command.id)
      ) {
        runningCount += 1;
      }
    }
  }

  return {
    runningCount,
    isVisible:
      runningCount > 0 ||
      projects.some((project) =>
        isMobilePreviewProjectEnabled(project.mobilePreviewConfig),
      ),
  };
}
