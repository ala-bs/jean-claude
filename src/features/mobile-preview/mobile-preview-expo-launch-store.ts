/**
 * Tracks which Expo auto-launches already completed, keyed by runtime owner key.
 *
 * This lives at module scope on purpose: the mobile preview pane remounts when
 * the workspace is re-entered (navigating back to the same task, runtime key
 * churn, task cache refetch). A component-local ref would be lost on remount and
 * the pane would re-issue `launchExpo`, which deep-links the simulator and
 * visibly reloads the running app.
 */
const completedLaunchOwnerKeys = new Set<string>();

export function hasCompletedExpoLaunch(ownerKey: string): boolean {
  return completedLaunchOwnerKeys.has(ownerKey);
}

export function markExpoLaunchCompleted(ownerKey: string): void {
  completedLaunchOwnerKeys.add(ownerKey);
}

export function clearCompletedExpoLaunch(ownerKey: string): void {
  completedLaunchOwnerKeys.delete(ownerKey);
}

export function clearAllCompletedExpoLaunches(): void {
  completedLaunchOwnerKeys.clear();
}
