import type { AgentBackendType } from './agent-backend-types';

export type SourceKind = 'github';
export type SourceItemKind = 'skill' | 'agent';

export interface DetectedSourceItem {
  id: string;
  kind: SourceItemKind;
  sourceRelativePath: string;
  sourceCommit: string;
  detectedName: string;
  detectedDescription: string;
  sourceContentHash: string;
}

export interface SourceInstallRecord {
  id: string;
  kind: SourceItemKind;
  sourceItemId: string;
  sourceRelativePath: string;
  sourceCommit: string;
  sourceContentHash: string;
  installedPath: string;
  installedName: string;
  installedContentHash: string;
  installedAt: string;
  updatedAt?: string;
}

export interface ManagedSource {
  id: string;
  type: SourceKind;
  url: string;
  owner: string;
  repo: string;
  branch: string;
  clonePath: string;
  currentCommit: string;
  lastFetchedAt: string;
  lastScanAt: string;
  error?: string;
  items: DetectedSourceItem[];
  installs: SourceInstallRecord[];
}

export interface SourceManifest {
  version: 1;
  sources: ManagedSource[];
}

export interface SourceProvenance {
  sourceId: string;
  owner: string;
  repo: string;
  commit: string;
}

export type SourceInstallStatus =
  | 'available'
  | 'installed'
  | 'up-to-date'
  | 'update-available'
  | 'local-changes'
  | 'source-missing'
  | 'installed-missing'
  | 'conflict';

export interface SourceItemView extends DetectedSourceItem {
  install?: SourceInstallRecord;
  status: SourceInstallStatus;
  currentInstalledContentHash?: string;
}

export interface SourceView extends Omit<ManagedSource, 'items'> {
  items: SourceItemView[];
}

export interface AddGitHubSourceParams {
  url: string;
}

export interface InstallSourceItemParams {
  sourceId: string;
  sourceItemId: string;
  targetName: string;
  enabledBackends: AgentBackendType[];
}

export interface InstallSourceItemsParams {
  items: InstallSourceItemParams[];
}

export interface UpdateSourceInstallParams {
  sourceId: string;
  installId: string;
  overwriteLocalChanges?: boolean;
}
