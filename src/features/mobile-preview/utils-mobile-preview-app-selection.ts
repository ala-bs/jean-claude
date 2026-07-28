import type { MobilePreviewProjectConfig } from '@shared/types';

import {
  getDefaultMobileBuildCommand,
  migrateBuildCommand,
  migrateDetectedCommand,
} from '@/features/task/ui-task-panel/utils-mobile-preview-config';

export function getMobilePreviewConfigForApp({
  config,
  selectedAppPath,
}: {
  config: MobilePreviewProjectConfig;
  selectedAppPath: string | null;
}): MobilePreviewProjectConfig {
  const currentSelectedApp = config.detectedApps.find(
    (app) => app.path === config.selectedAppPath,
  );
  const selectedApp = config.detectedApps.find(
    (app) => app.path === selectedAppPath,
  );

  return {
    ...config,
    selectedAppPath,
    iosBundleId: migrateDetectedCommand({
      currentCommand: config.iosBundleId,
      currentDetectedCommand: currentSelectedApp?.detectedIosBundleId ?? null,
      selectedDetectedCommand: selectedApp?.detectedIosBundleId ?? null,
    }),
    appScheme: migrateDetectedCommand({
      currentCommand: config.appScheme,
      currentDetectedCommand: currentSelectedApp?.detectedAppScheme ?? null,
      selectedDetectedCommand: selectedApp?.detectedAppScheme ?? null,
    }),
    androidProjectPath:
      !config.androidProjectPath ||
      config.androidProjectPath === (currentSelectedApp?.androidProjectPath ?? null)
        ? (selectedApp?.androidProjectPath ?? null)
        : config.androidProjectPath,
    androidPackageName: migrateDetectedCommand({
      currentCommand: config.androidPackageName,
      currentDetectedCommand:
        currentSelectedApp?.detectedAndroidPackageName ?? null,
      selectedDetectedCommand: selectedApp?.detectedAndroidPackageName ?? null,
    }),
    androidBuildCommand: migrateBuildCommand({
      currentCommand: config.androidBuildCommand,
      currentGeneratedCommands: [
        currentSelectedApp?.detectedAndroidBuildCommand,
        getDefaultMobileBuildCommand({
          app: currentSelectedApp,
          packageManager: config.packageManager,
          platform: 'android',
        }),
      ],
      selectedGeneratedCommand:
        selectedApp?.detectedAndroidBuildCommand ??
        getDefaultMobileBuildCommand({
          app: selectedApp,
          packageManager: config.packageManager,
          platform: 'android',
        }),
      legacyPackageManager: config.packageManager,
      platform: 'android',
    }),
    iosBuildCommand: migrateBuildCommand({
      currentCommand: config.iosBuildCommand,
      currentGeneratedCommands: [
        currentSelectedApp?.detectedIosBuildCommand,
        getDefaultMobileBuildCommand({
          app: currentSelectedApp,
          packageManager: config.packageManager,
          platform: 'ios',
        }),
      ],
      selectedGeneratedCommand:
        selectedApp?.detectedIosBuildCommand ??
        getDefaultMobileBuildCommand({
          app: selectedApp,
          packageManager: config.packageManager,
          platform: 'ios',
        }),
      legacyPackageManager: config.packageManager,
      platform: 'ios',
    }),
    dependenciesInstallCommand: migrateDetectedCommand({
      currentCommand: config.dependenciesInstallCommand,
      currentDetectedCommand:
        currentSelectedApp?.detectedDependenciesInstallCommand ?? null,
      selectedDetectedCommand:
        selectedApp?.detectedDependenciesInstallCommand ?? null,
    }),
    metroStartCommand: migrateDetectedCommand({
      currentCommand: config.metroStartCommand,
      currentDetectedCommand:
        currentSelectedApp?.detectedMetroStartCommand ?? null,
      selectedDetectedCommand: selectedApp?.detectedMetroStartCommand ?? null,
    }),
    androidPrebuildCommand: migrateDetectedCommand({
      currentCommand: config.androidPrebuildCommand,
      currentDetectedCommand:
        currentSelectedApp?.detectedAndroidPrebuildCommand ?? null,
      selectedDetectedCommand:
        selectedApp?.detectedAndroidPrebuildCommand ?? null,
    }),
    iosPrebuildCommand: migrateDetectedCommand({
      currentCommand: config.iosPrebuildCommand,
      currentDetectedCommand:
        currentSelectedApp?.detectedIosPrebuildCommand ?? null,
      selectedDetectedCommand: selectedApp?.detectedIosPrebuildCommand ?? null,
    }),
  };
}
