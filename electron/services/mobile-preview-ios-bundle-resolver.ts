import type { MobilePreviewIosAppStatusParams } from '../../shared/mobile-simulator-types';

import { access, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { debug } from './mobile-preview-ios-shared-state';
import { constants as fsConstants } from 'node:fs';
import { runCommand } from './mobile-preview-process';

const EXPO_CONFIG_TIMEOUT_MS = 10_000;

export class UnsafeIosAppPathError extends Error {}

export function isSameOrChildPath(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export async function resolveInsideAppRoot(
  appRoot: string,
  targetPath: string,
): Promise<string> {
  const canonicalPath = await realpath(targetPath);
  if (!isSameOrChildPath(appRoot, canonicalPath)) {
    throw new UnsafeIosAppPathError(
      'iOS app path resolves outside trusted root.',
    );
  }
  return canonicalPath;
}

export async function findInsideAppRoot(
  appRoot: string,
  targetPath: string,
): Promise<string | null> {
  try {
    return await resolveInsideAppRoot(appRoot, targetPath);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function readTextFileInsideAppRoot(
  appRoot: string,
  targetPath: string,
): Promise<string> {
  const canonicalPath = await resolveInsideAppRoot(appRoot, targetPath);
  const handle = await open(
    canonicalPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function resolveTrustedIosAppRoot({
  trustedRoot,
  appPath,
}: {
  trustedRoot: string;
  appPath: string;
}): Promise<string> {
  if (!appPath.trim()) {
    throw new Error('iOS app path is required.');
  }
  if (!isAbsolute(appPath)) {
    throw new Error('iOS app path must be absolute.');
  }
  if (!trustedRoot.trim() || !isAbsolute(trustedRoot)) {
    throw new Error('iOS trusted root must be absolute.');
  }
  const canonicalTrustedRoot = await realpath(resolve(trustedRoot));
  if (canonicalTrustedRoot !== resolve(trustedRoot)) {
    throw new UnsafeIosAppPathError('iOS trusted root changed after validation.');
  }
  const canonicalAppPath = await realpath(resolve(appPath));
  if (!isSameOrChildPath(canonicalTrustedRoot, canonicalAppPath)) {
    throw new UnsafeIosAppPathError(
      'iOS app path resolves outside trusted root.',
    );
  }
  return canonicalAppPath;
}

export function normalizeBundleId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bundleId = value.trim();
  if (
    !bundleId ||
    bundleId.startsWith('-') ||
    bundleId.includes('$(') ||
    bundleId.includes('${') ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundleId)
  ) {
    return null;
  }
  return bundleId;
}

export function parseExpoBundleId(output: string): string | null {
  const config = JSON.parse(output) as Record<string, unknown>;
  const expo =
    config.expo && typeof config.expo === 'object'
      ? (config.expo as Record<string, unknown>)
      : config;
  const ios = expo.ios;
  return ios && typeof ios === 'object'
    ? normalizeBundleId((ios as Record<string, unknown>).bundleIdentifier)
    : null;
}

export function getExpoConfigCommand(
  packageManager: MobilePreviewIosAppStatusParams['packageManager'],
): { command: string; args: string[] } {
  if (packageManager === 'pnpm') {
    return { command: 'pnpm', args: ['exec', 'expo', 'config', '--json'] };
  }
  if (packageManager === 'yarn') {
    return { command: 'yarn', args: ['expo', 'config', '--json'] };
  }
  if (packageManager === 'bun') {
    return {
      command: 'bunx',
      args: ['--no-install', 'expo', 'config', '--json'],
    };
  }
  return {
    command: 'npm',
    args: ['exec', '--offline', '--', 'expo', 'config', '--json'],
  };
}

function parsePackageManager(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(pnpm|npm|yarn|bun)(?:@|$)/);
  return match?.[1] as MobilePreviewIosAppStatusParams['packageManager'];
}

export async function resolveAppPackageManager(
  appPath: string,
): Promise<MobilePreviewIosAppStatusParams['packageManager']> {
  const packageJsonPath = await findInsideAppRoot(
    appPath,
    join(appPath, 'package.json'),
  );
  if (packageJsonPath) {
    try {
      const packageJson = JSON.parse(
        await readTextFileInsideAppRoot(appPath, packageJsonPath),
      ) as Record<string, unknown>;
      const packageManager = parsePackageManager(packageJson.packageManager);
      if (packageManager) return packageManager;
    } catch (error) {
      if (error instanceof UnsafeIosAppPathError) throw error;
      // Invalid package metadata does not prevent lockfile detection.
    }
  }

  for (const [lockfile, packageManager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const) {
    if (await findInsideAppRoot(appPath, join(appPath, lockfile))) {
      return packageManager;
    }
  }
  return null;
}

export async function readExpoBundleId({
  appPath,
  packageManager,
  signal,
}: {
  appPath: string;
  packageManager: MobilePreviewIosAppStatusParams['packageManager'];
  signal?: AbortSignal;
}): Promise<string | null> {
  const dynamicConfig =
    (await findInsideAppRoot(appPath, join(appPath, 'app.config.js'))) ??
    (await findInsideAppRoot(appPath, join(appPath, 'app.config.ts')));
  if (dynamicConfig) {
    const appPackageManager = await resolveAppPackageManager(appPath);
    signal?.throwIfAborted();
    const { command, args } = getExpoConfigCommand(
      appPackageManager ?? packageManager,
    );
    try {
      const { stdout } = await runCommand(command, args, {
        cwd: appPath,
        env: { ...process.env, EXPO_OFFLINE: '1', CI: '1' },
        timeoutMs: EXPO_CONFIG_TIMEOUT_MS,
        signal,
      });
      return parseExpoBundleId(stdout);
    } catch (error) {
      debug(
        'Expo config resolution failed errorType=%s',
        error instanceof Error ? error.name : typeof error,
      );
      return null;
    }
  }

  const configPath =
    (await findInsideAppRoot(appPath, join(appPath, 'app.config.json'))) ??
    (await findInsideAppRoot(appPath, join(appPath, 'app.json')));
  if (!configPath) return null;
  try {
    return parseExpoBundleId(await readTextFileInsideAppRoot(appPath, configPath));
  } catch (error) {
    if (error instanceof UnsafeIosAppPathError) throw error;
    return null;
  }
}

export async function getNativeProjectFiles(
  appPath: string,
  signal?: AbortSignal,
): Promise<{
  iosPath: string | null;
  projectFiles: string[];
}> {
  const iosPath = await findInsideAppRoot(appPath, join(appPath, 'ios'));
  if (!iosPath) return { iosPath: null, projectFiles: [] };
  let entries;
  try {
    entries = await readdir(iosPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof UnsafeIosAppPathError) throw error;
    return { iosPath, projectFiles: [] };
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))
    .map((entry) => join(iosPath, entry.name, 'project.pbxproj'))
    .sort();
  const projectFiles: string[] = [];
  for (const projectFile of candidates) {
    signal?.throwIfAborted();
    try {
      const canonicalProjectFile = await resolveInsideAppRoot(
        appPath,
        projectFile,
      );
      if ((await stat(canonicalProjectFile)).isFile()) {
        await access(canonicalProjectFile, fsConstants.R_OK);
        projectFiles.push(canonicalProjectFile);
      }
    } catch (error) {
      if (error instanceof UnsafeIosAppPathError) throw error;
      // Ignore incomplete or unreadable Xcode projects.
    }
  }
  return { iosPath, projectFiles };
}

export function parseXcodeApplicationBundleIds(json: string): string[] | null {
  let settings: unknown;
  try {
    settings = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(settings)) return null;

  const bundleIds = settings.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const buildSettings = (entry as Record<string, unknown>).buildSettings;
    if (!buildSettings || typeof buildSettings !== 'object') return [];
    const values = buildSettings as Record<string, unknown>;
    if (values.PRODUCT_TYPE !== 'com.apple.product-type.application') return [];
    const bundleId = normalizeBundleId(values.PRODUCT_BUNDLE_IDENTIFIER);
    return bundleId ? [bundleId] : [];
  });
  return [...new Set(bundleIds)];
}

function parseBuildSetting(block: string, name: string): string | null {
  const match = block.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|([^;\\n]+))\\s*;`),
  );
  return match ? (match[1] ?? match[2]).trim() : null;
}

function resolveProductNameVariable(value: string, productName: string | null) {
  if (!productName || /\$\(|\$\{/.test(productName)) return value;
  return value
    .replaceAll('$(PRODUCT_NAME)', productName)
    .replaceAll('${PRODUCT_NAME}', productName)
    .replaceAll(
      '$(PRODUCT_NAME:rfc1034identifier)',
      productName.replace(/[^A-Za-z0-9.-]+/g, '-'),
    );
}

async function readPbxFallbackBundleIds(
  appPath: string,
  projectFiles: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const bundleIds: string[] = [];
  for (const projectFile of projectFiles) {
    signal?.throwIfAborted();
    try {
      const project = await readTextFileInsideAppRoot(appPath, projectFile);
      const parsed = parsePbxApplicationBundleIds(project);
      if (parsed === null) return [];
      bundleIds.push(...parsed);
    } catch (error) {
      if (error instanceof UnsafeIosAppPathError) throw error;
      // Ignore incomplete Xcode projects and try the next project.
    }
  }
  return [...new Set(bundleIds)];
}

function readPbxObjectBlock(project: string, objectId: string): string | null {
  const startMatch = new RegExp(
    `(?:^|\\n)\\s*${objectId}(?:\\s*\\/\\*[^\n]*?\\*\\/)?\\s*=\\s*\\{`,
  ).exec(project);
  if (!startMatch) return null;
  const blockStart = startMatch.index + startMatch[0].lastIndexOf('{');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = blockStart; index < project.length; index += 1) {
    const char = project[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      return project.slice(blockStart + 1, index);
    }
  }
  return null;
}

function parsePbxReference(block: string, name: string): string | null {
  return block.match(new RegExp(`\\b${name}\\s*=\\s*([A-Fa-f0-9]{24})\\b`))?.[1] ?? null;
}

function parsePbxReferenceList(block: string, name: string): string[] | null {
  const list = block.match(new RegExp(`\\b${name}\\s*=\\s*\\(([\\s\\S]*?)\\);`))?.[1];
  if (list === undefined) return null;
  return [...list.matchAll(/\b([A-Fa-f0-9]{24})\b/g)].map((match) => match[1]);
}

export function parsePbxApplicationBundleIds(project: string): string[] | null {
  const targetIds = [
    ...project.matchAll(
      /(?:^|\n)\s*([A-Fa-f0-9]{24})(?:\s*\/\*[^\n]*?\*\/)?\s*=\s*\{/g,
    ),
  ].flatMap((match) => {
    const block = readPbxObjectBlock(project, match[1]);
    return block?.match(/\bisa\s*=\s*PBXNativeTarget\s*;/) &&
      parseBuildSetting(block, 'productType') ===
        'com.apple.product-type.application'
      ? [match[1]]
      : [];
  });
  const bundleIds: string[] = [];
  for (const targetId of targetIds) {
    const target = readPbxObjectBlock(project, targetId);
    const configurationListId = target
      ? parsePbxReference(target, 'buildConfigurationList')
      : null;
    const configurationList = configurationListId
      ? readPbxObjectBlock(project, configurationListId)
      : null;
    const configurationIds = configurationList
      ? parsePbxReferenceList(configurationList, 'buildConfigurations')
      : null;
    if (!configurationIds?.length) return null;
    for (const configurationId of configurationIds) {
      const configuration = readPbxObjectBlock(project, configurationId);
      if (!configuration?.match(/\bisa\s*=\s*XCBuildConfiguration\s*;/)) {
        return null;
      }
      const buildSettings = configuration.match(
        /\bbuildSettings\s*=\s*\{([\s\S]*?)\};/,
      )?.[1];
      const rawBundleId = buildSettings
        ? parseBuildSetting(buildSettings, 'PRODUCT_BUNDLE_IDENTIFIER')
        : null;
      if (!rawBundleId) return null;
      const bundleId = normalizeBundleId(
        resolveProductNameVariable(
          rawBundleId,
          parseBuildSetting(buildSettings!, 'PRODUCT_NAME'),
        ),
      );
      if (!bundleId) return null;
      bundleIds.push(bundleId);
    }
  }
  return [...new Set(bundleIds)];
}

export async function readNativeBundleId(
  appPath: string,
  iosPath: string,
  projectFiles: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const resolvedBundleIds: string[] = [];
  let gotValidBuildSettings = false;
  for (const projectFile of projectFiles) {
    signal?.throwIfAborted();
    try {
      const canonicalProjectFile = await resolveInsideAppRoot(
        appPath,
        projectFile,
      );
      const projectDirectory = await resolveInsideAppRoot(
        appPath,
        dirname(canonicalProjectFile),
      );
      const canonicalIosPath = await resolveInsideAppRoot(appPath, iosPath);
      // xcodebuild accepts paths, not directory handles; canonicalize immediately
      // before spawn, leaving only an unavoidable local pathname race.
      const { stdout } = await runCommand(
        'xcrun',
        [
          'xcodebuild',
          '-project',
          projectDirectory,
          '-alltargets',
          '-showBuildSettings',
          '-json',
          '-disableAutomaticPackageResolution',
          '-skipPackageUpdates',
        ],
        { cwd: canonicalIosPath, timeoutMs: 15_000, signal },
      );
      const bundleIds = parseXcodeApplicationBundleIds(stdout);
      if (bundleIds) {
        gotValidBuildSettings = true;
        resolvedBundleIds.push(...bundleIds);
      }
    } catch (error) {
      if (error instanceof UnsafeIosAppPathError) throw error;
      if (signal?.aborted) throw error;
      // Fall back to static project parsing when Xcode cannot load the project.
    }
  }
  if (gotValidBuildSettings) {
    const uniqueBundleIds = [...new Set(resolvedBundleIds)];
    return uniqueBundleIds.length === 1 ? uniqueBundleIds[0] : null;
  }

  const fallbackBundleIds = await readPbxFallbackBundleIds(
    appPath,
    projectFiles,
    signal,
  );
  return fallbackBundleIds.length === 1 ? fallbackBundleIds[0] : null;
}

export async function resolveIosApp({
  appPath,
  iosBundleId,
  packageManager,
  signal,
}: MobilePreviewIosAppStatusParams & { signal?: AbortSignal }): Promise<{
  bundleId: string | null;
  nativeProjectExists: boolean;
}> {
  const { iosPath, projectFiles } = await getNativeProjectFiles(appPath, signal);
  signal?.throwIfAborted();
  const nativeProjectExists = projectFiles.length > 0;
  const bundleId =
    (nativeProjectExists && iosPath
      ? await readNativeBundleId(appPath, iosPath, projectFiles, signal)
      : null) ??
    (await readExpoBundleId({ appPath, packageManager, signal })) ??
    normalizeBundleId(iosBundleId);
  return { bundleId, nativeProjectExists };
}

function validateSimctlInstalledApps(
  apps: unknown,
  errorMessage: string,
): Record<string, unknown> {
  if (
    !apps ||
    typeof apps !== 'object' ||
    Array.isArray(apps) ||
    Object.values(apps).some(
      (app) => !app || typeof app !== 'object' || Array.isArray(app),
    )
  ) {
    throw new Error(errorMessage);
  }
  return apps as Record<string, unknown>;
}

export async function parseSimctlInstalledApps({
  deviceId,
  output,
  signal,
}: {
  deviceId: string;
  output: string;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  let apps: unknown;
  try {
    apps = JSON.parse(output);
  } catch {
    let convertedOutput: string;
    try {
      const converted = await runCommand(
        'plutil',
        ['-convert', 'json', '-o', '-', '--', '-'],
        { input: output, signal },
      );
      convertedOutput = converted.stdout;
    } catch (conversionError) {
      debug(
        'Invalid simctl listapps output deviceId=%s format=%s bytes=%d conversionError=%s',
        deviceId,
        'openstep-or-unknown',
        Buffer.byteLength(output),
        conversionError instanceof Error
          ? conversionError.name
          : typeof conversionError,
      );
      if (signal.aborted) throw conversionError;
      throw new Error(
        'Invalid simctl listapps output: plist conversion failed.',
        { cause: conversionError },
      );
    }

    try {
      apps = JSON.parse(convertedOutput);
      return validateSimctlInstalledApps(
        apps,
        'Invalid simctl listapps output after plist conversion.',
      );
    } catch (conversionError) {
      debug(
        'Invalid simctl listapps output deviceId=%s format=%s bytes=%d conversionError=%s',
        deviceId,
        'openstep-or-unknown',
        Buffer.byteLength(output),
        conversionError instanceof SyntaxError
          ? 'SyntaxError'
          : 'invalid-converted-shape',
      );
      throw new Error(
        'Invalid simctl listapps output after plist conversion.',
        { cause: conversionError },
      );
    }
  }

  try {
    return validateSimctlInstalledApps(
      apps,
      'Invalid simctl listapps JSON output.',
    );
  } catch (shapeError) {
    debug(
      'Invalid simctl listapps output deviceId=%s format=%s bytes=%d conversionError=%s',
      deviceId,
      'json',
      Buffer.byteLength(output),
      'not-attempted',
    );
    throw shapeError;
  }
}

export function isAppNotRunningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /found nothing to terminate/i.test(message) ||
    (/domain=NSPOSIXErrorDomain,\s*code=3\b/i.test(message) &&
      /No such process/i.test(message))
  );
}
