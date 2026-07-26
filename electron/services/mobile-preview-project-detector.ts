import * as fs from 'node:fs/promises';
import path from 'node:path';

import type {
  MobilePreviewDetectedApp,
  MobilePreviewProjectConfig,
  MobilePreviewProjectStack,
} from '@shared/types';

const MONOREPO_DIRS = ['apps', 'packages', 'mobile', 'clients'];
const IGNORED_DIRS = new Set([
  '.expo',
  '.git',
  'build',
  'dist',
  'node_modules',
]);

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
type PackageManager = NonNullable<MobilePreviewProjectConfig['packageManager']>;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as PackageJson)
      : null;
  } catch {
    return null;
  }
}

async function readMobileAppIdentities(absolutePath: string) {
  let expoConfig: Record<string, unknown> | null = null;
  for (const fileName of ['app.json', 'app.config.json']) {
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(path.join(absolutePath, fileName), 'utf8'),
      );
      if (parsed && typeof parsed === 'object') {
        expoConfig = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      // Try native project files below.
    }
  }
  const expo =
    expoConfig?.expo && typeof expoConfig.expo === 'object'
      ? (expoConfig.expo as Record<string, unknown>)
      : expoConfig;
  const android = expo?.android;
  const ios = expo?.ios;
  const normalizeIdentity = (value: string | null) => {
    const normalized = value?.trim() ?? '';
    return normalized && !normalized.includes('$(') && !normalized.includes('${')
      ? normalized
      : null;
  };
  let androidPackageName =
    android && typeof android === 'object' &&
    typeof (android as Record<string, unknown>).package === 'string'
      ? normalizeIdentity((android as Record<string, unknown>).package as string)
      : null;
  let iosBundleId =
    ios && typeof ios === 'object' &&
    typeof (ios as Record<string, unknown>).bundleIdentifier === 'string'
      ? normalizeIdentity(
          (ios as Record<string, unknown>).bundleIdentifier as string,
        )
      : null;

  try {
    const androidGradle = await fs.readFile(
      path.join(absolutePath, 'android', 'app', 'build.gradle'),
      'utf8',
    );
    androidPackageName = normalizeIdentity(
      androidGradle.match(/\bapplicationId\s+["']([^"']+)["']/)?.[1] ??
        androidPackageName,
    );
  } catch {
    // Native project may be absent or incomplete.
  }

  try {
    const iosEntries = await fs.readdir(path.join(absolutePath, 'ios'));
    for (const entry of iosEntries.filter((name) => name.endsWith('.xcodeproj'))) {
      const project = await fs.readFile(
        path.join(absolutePath, 'ios', entry, 'project.pbxproj'),
        'utf8',
      );
      iosBundleId = normalizeIdentity(
        project.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\n]+)\s*;/)?.[1] ??
          iosBundleId,
      );
      if (iosBundleId) break;
    }
  } catch {
    // Native project may be absent or incomplete.
  }

  return { androidPackageName, iosBundleId };
}

async function detectPackageManager(
  projectPath: string,
): Promise<PackageManager | null> {
  if (await pathExists(path.join(projectPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await pathExists(path.join(projectPath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (await pathExists(path.join(projectPath, 'bun.lockb'))) {
    return 'bun';
  }
  if (await pathExists(path.join(projectPath, 'package-lock.json'))) {
    return 'npm';
  }
  return null;
}

function getPackageRunner(packageManager: PackageManager | null) {
  if (packageManager === 'pnpm') return 'pnpm';
  if (packageManager === 'yarn') return 'yarn';
  if (packageManager === 'bun') return 'bun';
  return 'npm';
}

function getDependenciesInstallCommand(packageManager: PackageManager | null) {
  return `${getPackageRunner(packageManager)} install`;
}

function getPackageExec(packageManager: PackageManager | null) {
  if (packageManager === 'pnpm') return 'pnpm exec';
  if (packageManager === 'yarn') return 'yarn';
  if (packageManager === 'bun') return 'bunx';
  return 'npx';
}

function getRunScriptCommand({
  packageManager,
  scriptName,
}: {
  packageManager: PackageManager | null;
  scriptName: string;
}) {
  const runner = getPackageRunner(packageManager);
  return runner === 'npm' || runner === 'bun'
    ? `${runner} run ${scriptName}`
    : `${runner} ${scriptName}`;
}

function getScriptCommand({
  packageJson,
  packageManager,
  preferredNames,
  matches,
}: {
  packageJson: PackageJson | null;
  packageManager: PackageManager | null;
  preferredNames: string[];
  matches: (scriptName: string, scriptCommand: string) => boolean;
}) {
  const scripts = packageJson?.scripts;
  if (!scripts) return null;

  for (const scriptName of preferredNames) {
    const scriptCommand = scripts[scriptName];
    if (scriptCommand && matches(scriptName, scriptCommand)) {
      return getRunScriptCommand({ packageManager, scriptName });
    }
  }

  const matchingScript = Object.entries(scripts).find(([scriptName, scriptCommand]) =>
    matches(scriptName, scriptCommand),
  );
  return matchingScript
    ? getRunScriptCommand({ packageManager, scriptName: matchingScript[0] })
    : null;
}

function getDefaultMetroStartCommand({
  packageJson,
  packageManager,
}: {
  packageJson: PackageJson | null;
  packageManager: PackageManager | null;
}) {
  return getScriptCommand({
    packageJson,
    packageManager,
    preferredNames: ['start', 'dev', 'metro'],
    matches: (_scriptName, scriptCommand) => {
      const normalized = scriptCommand.toLowerCase();
      return (
        normalized.includes('expo start') ||
        normalized.includes('react-native start') ||
        normalized.includes('metro')
      );
    },
  });
}

function getDefaultPrebuildCommand({
  packageJson,
  packageManager,
  platform,
}: {
  packageJson: PackageJson | null;
  packageManager: PackageManager | null;
  platform: 'android' | 'ios';
}) {
  const oppositePlatform = platform === 'android' ? 'ios' : 'android';
  const platformPattern = new RegExp(
    `(?:--platform|-p)(?:\\s+|=)${platform}\\b`,
  );
  const oppositePlatformPattern = new RegExp(
    `(?:--platform|-p)(?:\\s+|=)${oppositePlatform}\\b`,
  );
  const matchesPrebuild = (scriptName: string, scriptCommand: string) => {
    const normalizedName = scriptName.toLowerCase();
    const normalizedCommand = scriptCommand.toLowerCase();
    const targetsPlatform = platformPattern.test(normalizedCommand);
    const targetsOppositePlatform = oppositePlatformPattern.test(
      normalizedCommand,
    );
    const isOppositePlatformOnly =
      (targetsOppositePlatform && !targetsPlatform) ||
      (normalizedName.includes(oppositePlatform) &&
        !normalizedName.includes(platform));
    return normalizedCommand.includes('expo prebuild') && !isOppositePlatformOnly;
  };
  const platformSpecificCommand = getScriptCommand({
    packageJson,
    packageManager,
    preferredNames: [`prebuild:${platform}`, `${platform}:prebuild`],
    matches: (scriptName, scriptCommand) =>
      matchesPrebuild(scriptName, scriptCommand) &&
      (scriptName.toLowerCase().includes(platform) ||
        platformPattern.test(scriptCommand.toLowerCase())),
  });

  return platformSpecificCommand ?? getScriptCommand({
    packageJson,
    packageManager,
    preferredNames: [
      `prebuild:${platform}`,
      `${platform}:prebuild`,
      'prebuild',
    ],
    matches: matchesPrebuild,
  });
}

function getDefaultBuildCommand({
  app,
  packageJson,
  packageManager,
  platform,
}: {
  app: Pick<MobilePreviewDetectedApp, 'stacks'> | null;
  packageJson: PackageJson | null;
  packageManager: PackageManager | null;
  platform: 'android' | 'ios';
}) {
  if (!app) return null;
  if (packageJson?.scripts?.[platform]) {
    return getRunScriptCommand({ packageManager, scriptName: platform });
  }
  if (app.stacks.includes('expo')) {
    return `${getPackageExec(packageManager)} expo run:${platform}`;
  }
  if (app.stacks.includes('react-native')) {
    return `${getPackageExec(packageManager)} react-native run-${platform}`;
  }
  if (!app.stacks.includes(platform)) return null;
  return null;
}

async function listCandidateDirs(projectPath: string): Promise<string[]> {
  const dirs = new Set<string>(['.']);

  await Promise.all(
    MONOREPO_DIRS.map(async (baseName) => {
      const basePath = path.join(projectPath, baseName);
      let entryNames: string[];
      try {
        entryNames = await fs.readdir(basePath);
      } catch {
        return;
      }

      for (const entryName of entryNames) {
        if (IGNORED_DIRS.has(entryName)) continue;
        const entryPath = path.join(basePath, entryName);
        const stats = await fs.stat(entryPath).catch(() => null);
        if (!stats?.isDirectory()) continue;
        dirs.add(path.join(baseName, entryName));
      }
    }),
  );

  return [...dirs];
}

function addStack(
  stacks: Set<MobilePreviewProjectStack>,
  reasons: string[],
  stack: MobilePreviewProjectStack,
  reason: string,
) {
  stacks.add(stack);
  reasons.push(reason);
}

async function detectApp(
  projectPath: string,
  relativePath: string,
  packageManager: PackageManager | null,
): Promise<MobilePreviewDetectedApp | null> {
  const absolutePath = path.join(projectPath, relativePath);
  const packageJson = await readPackageJson(absolutePath);
  const dependencies = packageJson?.dependencies ?? {};
  const devDependencies = packageJson?.devDependencies ?? {};
  const optionalDependencies = packageJson?.optionalDependencies ?? {};
  const identities = await readMobileAppIdentities(absolutePath);
  const stacks = new Set<MobilePreviewProjectStack>();
  const reasons: string[] = [];

  if (dependencies.expo) addStack(stacks, reasons, 'expo', 'expo dependency');
  if (devDependencies.expo) {
    addStack(stacks, reasons, 'expo', 'expo dev dependency');
  }
  if (optionalDependencies.expo) {
    addStack(stacks, reasons, 'expo', 'expo optional dependency');
  }
  if (dependencies['react-native']) {
    addStack(stacks, reasons, 'react-native', 'react-native dependency');
  }
  if (devDependencies['react-native']) {
    addStack(
      stacks,
      reasons,
      'react-native',
      'react-native dev dependency',
    );
  }
  if (optionalDependencies['react-native']) {
    addStack(
      stacks,
      reasons,
      'react-native',
      'react-native optional dependency',
    );
  }

  const hasAppJson =
    (await pathExists(path.join(absolutePath, 'app.json'))) ||
    (await pathExists(path.join(absolutePath, 'app.config.js'))) ||
    (await pathExists(path.join(absolutePath, 'app.config.ts')));
  if (hasAppJson) addStack(stacks, reasons, 'expo', 'Expo app config');

  const hasIos =
    (await pathExists(path.join(absolutePath, 'ios'))) ||
    (await pathExists(path.join(absolutePath, 'Podfile')));
  if (hasIos) addStack(stacks, reasons, 'ios', 'iOS project files');

  let androidProjectPath: string | null = null;
  if (await pathExists(path.join(absolutePath, 'android'))) {
    androidProjectPath =
      relativePath === '.' ? 'android' : path.join(relativePath, 'android');
  } else if (
    (await pathExists(path.join(absolutePath, 'settings.gradle'))) ||
    (await pathExists(path.join(absolutePath, 'settings.gradle.kts')))
  ) {
    androidProjectPath = relativePath;
  }
  if (androidProjectPath) {
    addStack(stacks, reasons, 'android', 'Android project files');
  }

  if (stacks.size === 0) return null;

  return {
    path: relativePath,
    stacks: [...stacks],
    androidProjectPath,
    detectedAndroidPackageName: identities.androidPackageName,
    detectedIosBundleId: identities.iosBundleId,
    detectedDependenciesInstallCommand:
      getDependenciesInstallCommand(packageManager),
    detectedMetroStartCommand: getDefaultMetroStartCommand({
      packageJson,
      packageManager,
    }),
    detectedAndroidPrebuildCommand: getDefaultPrebuildCommand({
      packageJson,
      packageManager,
      platform: 'android',
    }),
    detectedIosPrebuildCommand: getDefaultPrebuildCommand({
      packageJson,
      packageManager,
      platform: 'ios',
    }),
    detectedAndroidBuildCommand: getDefaultBuildCommand({
      app: { stacks: [...stacks] },
      packageJson,
      packageManager,
      platform: 'android',
    }),
    detectedIosBuildCommand: getDefaultBuildCommand({
      app: { stacks: [...stacks] },
      packageJson,
      packageManager,
      platform: 'ios',
    }),
    confidence:
      packageJson && (dependencies.expo || dependencies['react-native'])
        ? 'high'
        : 'medium',
    reasons,
  };
}

function detectAndroidProjectPath(
  detectedApps: MobilePreviewDetectedApp[],
  selectedAppPath: string | null,
): string | null {
  if (!selectedAppPath) return null;
  return (
    detectedApps.find((app) => app.path === selectedAppPath)
      ?.androidProjectPath ?? null
  );
}

function isPackageOnlyMobileCandidate(app: MobilePreviewDetectedApp) {
  const hasNativeProject = app.stacks.includes('ios') || app.stacks.includes('android');
  const hasAppConfig = app.reasons.some((reason) =>
    reason.toLowerCase().includes('app config'),
  );
  const dependencyOnly = app.reasons.every((reason) =>
    reason.toLowerCase().includes('dependency'),
  );

  return dependencyOnly && !hasNativeProject && !hasAppConfig;
}

function reconcileGeneratedCommand({
  currentCommand,
  previousGeneratedCommands,
  nextGeneratedCommand,
}: {
  currentCommand: string | null | undefined;
  previousGeneratedCommands: Array<string | null | undefined>;
  nextGeneratedCommand: string | null | undefined;
}) {
  return !currentCommand || previousGeneratedCommands.includes(currentCommand)
    ? (nextGeneratedCommand ?? null)
    : currentCommand;
}

export async function detectMobilePreviewProjectConfig(
  projectPath: string,
  previousConfig?: MobilePreviewProjectConfig | null,
): Promise<MobilePreviewProjectConfig> {
  const candidates = await listCandidateDirs(projectPath);
  const packageManager = await detectPackageManager(projectPath);
  const detectedApps = (
    await Promise.all(
      candidates.map((candidate) =>
        detectApp(projectPath, candidate, packageManager),
      ),
    )
  ).filter(
    (app): app is MobilePreviewDetectedApp =>
      app !== null && !(app.stacks.length === 1 && app.stacks[0] === 'ios'),
  );
  const runnableApps = detectedApps.filter(
    (app) => !isPackageOnlyMobileCandidate(app),
  );

  const selectedAppPath =
    previousConfig?.selectedAppPath &&
    detectedApps.some((app) => app.path === previousConfig.selectedAppPath)
      ? previousConfig.selectedAppPath
      : runnableApps.length === 1
        ? runnableApps[0].path
        : detectedApps.length === 1
          ? detectedApps[0].path
          : null;
  const detectedAndroidProjectPath = detectAndroidProjectPath(
    detectedApps,
    selectedAppPath,
  );
  const selectedApp =
    detectedApps.find((app) => app.path === selectedAppPath) ?? null;
  const selectedAppPackageJson = selectedApp
    ? await readPackageJson(path.join(projectPath, selectedApp.path))
    : null;
  const previouslyDetectedSelectedApp =
    previousConfig?.detectedApps.find(
      (app) => app.path === previousConfig.selectedAppPath,
    ) ?? null;
  const previousSelectedApp =
    previouslyDetectedSelectedApp ??
    (previousConfig?.selectedAppPath === selectedAppPath ? selectedApp : null);
  const previousSelectedAppPackageJson = previousSelectedApp
    ? await readPackageJson(path.join(projectPath, previousSelectedApp.path))
    : null;
  const previousPackageManager = previousConfig?.packageManager ?? null;
  const nextMetroStartCommand =
    selectedApp?.detectedMetroStartCommand ??
    getDefaultMetroStartCommand({
      packageJson: selectedAppPackageJson,
      packageManager,
    });
  const nextDependenciesInstallCommand =
    selectedApp?.detectedDependenciesInstallCommand ??
    getDependenciesInstallCommand(packageManager);
  const nextAndroidPackageName = selectedApp?.detectedAndroidPackageName ?? null;
  const nextAndroidPrebuildCommand =
    selectedApp?.detectedAndroidPrebuildCommand ??
    getDefaultPrebuildCommand({
      packageJson: selectedAppPackageJson,
      packageManager,
      platform: 'android',
    });
  const nextIosPrebuildCommand =
    selectedApp?.detectedIosPrebuildCommand ??
    getDefaultPrebuildCommand({
      packageJson: selectedAppPackageJson,
      packageManager,
      platform: 'ios',
    });
  const nextAndroidBuildCommand = getDefaultBuildCommand({
    app: selectedApp,
    packageJson: selectedAppPackageJson,
    packageManager,
    platform: 'android',
  });
  const nextIosBuildCommand = getDefaultBuildCommand({
    app: selectedApp,
    packageJson: selectedAppPackageJson,
    packageManager,
    platform: 'ios',
  });
  const getPreviousBuildCommands = (platform: 'android' | 'ios') => [
    getDefaultBuildCommand({
      app: previousSelectedApp,
      packageJson: previousSelectedAppPackageJson,
      packageManager: previousPackageManager,
      platform,
    }),
    getDefaultBuildCommand({
      app: previousSelectedApp,
      packageJson: null,
      packageManager: previousPackageManager,
      platform,
    }),
  ];

  return {
    mode: previousConfig?.mode ?? 'auto',
    selectedAppPath,
    androidProjectPath:
      previousConfig?.androidProjectPath ?? detectedAndroidProjectPath,
    detectedApps,
    detectionUpdatedAt: new Date().toISOString(),
    packageManager,
    metroPort: previousConfig?.metroPort ?? 8081,
    dependenciesInstallCommand: reconcileGeneratedCommand({
      currentCommand: previousConfig?.dependenciesInstallCommand,
      previousGeneratedCommands: [
        previouslyDetectedSelectedApp?.detectedDependenciesInstallCommand,
        getDependenciesInstallCommand(previousPackageManager),
      ],
      nextGeneratedCommand: nextDependenciesInstallCommand,
    }),
    androidPackageName:
      previousConfig?.selectedAppPath === selectedAppPath
        ? reconcileGeneratedCommand({
            currentCommand: previousConfig?.androidPackageName,
            previousGeneratedCommands: [
              previouslyDetectedSelectedApp?.detectedAndroidPackageName,
            ],
            nextGeneratedCommand: nextAndroidPackageName,
          })
        : nextAndroidPackageName,
    metroStartCommand: reconcileGeneratedCommand({
      currentCommand: previousConfig?.metroStartCommand,
      previousGeneratedCommands: [
        previouslyDetectedSelectedApp?.detectedMetroStartCommand,
        getDefaultMetroStartCommand({
          packageJson: previousSelectedAppPackageJson,
          packageManager: previousPackageManager,
        }),
      ],
      nextGeneratedCommand: nextMetroStartCommand,
    }),
    androidPrebuildCommand: reconcileGeneratedCommand({
      currentCommand: previousConfig?.androidPrebuildCommand,
      previousGeneratedCommands: [
        previouslyDetectedSelectedApp?.detectedAndroidPrebuildCommand,
        getDefaultPrebuildCommand({
          packageJson: previousSelectedAppPackageJson,
          packageManager: previousPackageManager,
          platform: 'android',
        }),
      ],
      nextGeneratedCommand: nextAndroidPrebuildCommand,
    }),
    iosPrebuildCommand: reconcileGeneratedCommand({
      currentCommand: previousConfig?.iosPrebuildCommand,
      previousGeneratedCommands: [
        previouslyDetectedSelectedApp?.detectedIosPrebuildCommand,
        getDefaultPrebuildCommand({
          packageJson: previousSelectedAppPackageJson,
          packageManager: previousPackageManager,
          platform: 'ios',
        }),
      ],
      nextGeneratedCommand: nextIosPrebuildCommand,
    }),
    androidBuildCommand: reconcileGeneratedCommand({
      currentCommand: previousConfig?.androidBuildCommand,
      previousGeneratedCommands: getPreviousBuildCommands('android'),
      nextGeneratedCommand: nextAndroidBuildCommand,
    }),
    iosBuildCommand: reconcileGeneratedCommand({
      currentCommand: previousConfig?.iosBuildCommand,
      previousGeneratedCommands: getPreviousBuildCommands('ios'),
      nextGeneratedCommand: nextIosBuildCommand,
    }),
    iosBundleId:
      previousConfig?.selectedAppPath === selectedAppPath
        ? reconcileGeneratedCommand({
            currentCommand: previousConfig?.iosBundleId,
            previousGeneratedCommands: [
              previouslyDetectedSelectedApp?.detectedIosBundleId,
            ],
            nextGeneratedCommand: selectedApp?.detectedIosBundleId,
          })
        : (selectedApp?.detectedIosBundleId ?? null),
  };
}
