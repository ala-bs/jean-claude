/**
 * Decides what escape does while the Azure Board details pane is open.
 * Mirrors the details pane back button: step back one level first, and only
 * fall through to the overlay when the pane is already closed.
 */
export type DetailsPaneEscapeAction =
  | 'none'
  | 'back-to-related-bugs'
  | 'pop-work-item'
  | 'close-related-bugs'
  | 'close-details-pane';

export function resolveDetailsPaneEscape({
  isDetailsPaneOpen,
  workItemStackDepth,
  hasRelatedBugsStory,
  isRelatedBugsPanelOpen,
}: {
  isDetailsPaneOpen: boolean;
  workItemStackDepth: number;
  hasRelatedBugsStory: boolean;
  isRelatedBugsPanelOpen: boolean;
}): DetailsPaneEscapeAction {
  if (!isDetailsPaneOpen) return 'none';
  if (workItemStackDepth > 1) {
    return hasRelatedBugsStory ? 'back-to-related-bugs' : 'pop-work-item';
  }
  if (isRelatedBugsPanelOpen) return 'close-related-bugs';
  return 'close-details-pane';
}
