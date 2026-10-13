import type { MobilePlatform, MobilePreviewDevice } from './mobile-simulator-types';

export type MobileBuildArtifactKind = 'apk' | 'ios-simulator-app';
export type MobileBuildArtifact = {
  id: string;
  name: string | null;
  platform: MobilePlatform;
  packageId: string;
  appPath: string;
  fingerprint: string;
  buildCommand: string;
  artifactKind: MobileBuildArtifactKind;
  sizeBytes: number;
  createdAt: string;
  lastUsedAt: string | null;
};
export type MobileBuildStoreListParams = {
  platform: MobilePlatform;
  projectPath: string;
};
export type MobileBuildStoreBuildParams = MobileBuildStoreListParams & {
  taskName?: string;
  packageId: string;
  appPath: string;
  command: string;
  fingerprintCommand?: string;
  taskId: string;
  projectId: string;
};
export type MobileBuildStoreStoreParams = MobileBuildStoreListParams & {
  taskName?: string;
  packageId: string;
  appPath: string;
  command: string;
  fingerprintCommand?: string;
  startedAt: number;
};
export type MobileBuildStoreInstallParams = {
  artifactId: string;
  device: MobilePreviewDevice;
};
export type MobileBuildStoreDeleteParams = { artifactId: string };
export type MobileBuildStoreRenameParams = { artifactId: string; name: string };
