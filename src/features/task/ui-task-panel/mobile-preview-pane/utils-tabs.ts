export type MobilePreviewPaneTab =
  | 'setup'
  | 'dev-server'
  | 'logs'
  | 'network'
  | 'devtools';

export function isMobilePreviewPaneTabVisible({
  tab,
  networkEnabled,
}: {
  tab: MobilePreviewPaneTab;
  networkEnabled: boolean;
}) {
  return tab !== 'network' || networkEnabled;
}

export function getVisibleMobilePreviewPaneTab({
  tab,
  networkEnabled,
}: {
  tab: MobilePreviewPaneTab;
  networkEnabled: boolean;
}): MobilePreviewPaneTab {
  return isMobilePreviewPaneTabVisible({ tab, networkEnabled }) ? tab : 'setup';
}
