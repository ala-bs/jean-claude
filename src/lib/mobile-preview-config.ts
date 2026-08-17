import type {
  MobilePreviewDetectedApp,
  MobilePreviewProjectConfig,
} from '@shared/types';

export function getDefaultMobileBuildCommand({
  app,
  packageManager,
  platform,
}: {
  app: MobilePreviewDetectedApp | null | undefined;
  packageManager: MobilePreviewProjectConfig['packageManager'];
  platform: 'android' | 'ios';
}) {
  if (!app) return null;
  const packageExec =
    packageManager === 'pnpm'
      ? 'pnpm exec'
      : packageManager === 'yarn'
        ? 'yarn'
        : packageManager === 'bun'
          ? 'bunx'
          : 'npx';
  if (app.stacks.includes('expo')) {
    return `${packageExec} expo run:${platform}`;
  }
  if (app.stacks.includes('react-native')) {
    return `${packageExec} react-native run-${platform}`;
  }
  return null;
}

export function migrateBuildCommand({
  currentCommand,
  currentGeneratedCommands,
  selectedGeneratedCommand,
  legacyPackageManager,
  platform,
}: {
  currentCommand: string | null | undefined;
  currentGeneratedCommands: Array<string | null | undefined>;
  selectedGeneratedCommand: string | null | undefined;
  legacyPackageManager?: MobilePreviewProjectConfig['packageManager'];
  platform?: 'android' | 'ios';
}) {
  const legacyGeneratedCommands = platform
    ? legacyPackageManager === 'npm' || legacyPackageManager == null
      ? [`npm run ${platform}`]
      : legacyPackageManager === 'bun'
        ? [`bun run ${platform}`, `bun ${platform}`]
        : legacyPackageManager
          ? [`${legacyPackageManager} ${platform}`]
          : []
    : [];
  return !currentCommand ||
    currentGeneratedCommands.includes(currentCommand) ||
    legacyGeneratedCommands.includes(currentCommand)
    ? (selectedGeneratedCommand ?? null)
    : currentCommand;
}

export function migrateDetectedCommand({
  currentCommand,
  currentDetectedCommand,
  selectedDetectedCommand,
}: {
  currentCommand: string | null | undefined;
  currentDetectedCommand: string | null | undefined;
  selectedDetectedCommand: string | null | undefined;
}) {
  return !currentCommand || currentCommand === currentDetectedCommand
    ? (selectedDetectedCommand ?? null)
    : currentCommand;
}

export function migrateIosBundleId({
  currentSelectedAppPath,
  selectedAppPath,
  iosBundleId,
}: {
  currentSelectedAppPath: string | null;
  selectedAppPath: string | null;
  iosBundleId: string | null | undefined;
}) {
  return currentSelectedAppPath === selectedAppPath ? (iosBundleId ?? null) : null;
}
