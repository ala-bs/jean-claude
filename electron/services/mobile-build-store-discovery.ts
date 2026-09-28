import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { dbg } from '../lib/debug';

export type DiscoveredMobileArtifact = {
  path: string;
  kind: 'apk' | 'ios-simulator-app';
  sizeBytes: number;
};

async function walk(root: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const absolute = join(root, entry.name);
      if (entry.name.endsWith(suffix)) results.push(absolute);
      else if (entry.isDirectory()) results.push(...(await walk(absolute, suffix)));
    }
    return results;
  } catch {
    return [];
  }
}

export async function discoverMobileBuildArtifact({
  projectPath,
  appPath,
  platform,
  startedAt,
}: {
  projectPath: string;
  appPath: string;
  platform: 'android' | 'ios';
  startedAt: number;
}): Promise<DiscoveredMobileArtifact> {
  const root = resolve(projectPath, appPath || '.');
  const searchRoots =
    platform === 'android'
      ? [join(root, 'android', 'app', 'build', 'outputs', 'apk')]
      : [
          join(root, 'ios', 'build', 'Build', 'Products'),
          join(root, 'build', 'Build', 'Products'),
          ...(await findProjectDerivedDataProductRoots(root)),
        ];
  const candidates = (
    await Promise.all(
      searchRoots.map((searchRoot) =>
        walk(searchRoot, platform === 'android' ? '.apk' : '.app'),
      ),
    )
  ).flat();
  dbg.mobilePreview('Build Store discovery: platform=%s roots=%j candidates=%j startedAt=%d', platform, searchRoots, candidates, startedAt);
  const fresh = [];
  for (const candidate of [...new Set(candidates)]) {
    const metadata = await stat(candidate);
    const latestModifiedAt = metadata.isDirectory() ? await latestModifiedAtInTree(candidate) : metadata.mtimeMs;
    if (latestModifiedAt >= startedAt) {
      fresh.push({
        path: candidate,
        kind: platform === 'android' ? ('apk' as const) : ('ios-simulator-app' as const),
        sizeBytes: platform === 'android' ? metadata.size : 0,
      });
    }
  }
  const choices = platform === 'ios'
    ? fresh.filter((candidate) => candidate.path.includes('iphonesimulator'))
    : fresh;
  if (choices.length !== 1) {
    const listed = choices.map((candidate) => candidate.path).join(', ') || 'none';
    dbg.mobilePreview('Build Store discovery rejected candidates: fresh=%j choices=%j', fresh, choices);
    throw new Error(
      `Could not uniquely discover the ${platform} build artifact (found: ${listed}). ` +
        'Use a standard Expo/React Native output directory.',
    );
  }
  if (choices[0].kind === 'ios-simulator-app') {
    choices[0].sizeBytes = await directorySize(choices[0].path);
  }
  return choices[0];
}

async function findProjectDerivedDataProductRoots(projectRoot: string): Promise<string[]> {
  const derivedDataRoot = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  let entries;
  try {
    entries = await readdir(derivedDataRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadataPath = join(derivedDataRoot, entry.name, 'info.plist');
    try {
      const metadata = await readFile(metadataPath, 'utf8');
      const workspacePath = metadata.match(
        /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/,
      )?.[1];
      if (!workspacePath) continue;
      const workspaceRoot = resolve(workspacePath, '..');
      if (workspaceRoot !== projectRoot && !workspaceRoot.startsWith(`${projectRoot}${sep}`)) {
        continue;
      }
      roots.push(join(derivedDataRoot, entry.name, 'Build', 'Products'));
    } catch {
      // DerivedData entries can disappear while Xcode cleans them.
    }
  }
  return roots;
}

async function latestModifiedAtInTree(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  let latest = (await stat(path)).mtimeMs;
  for (const entry of entries) {
    const child = join(path, entry.name);
    latest = Math.max(
      latest,
      entry.isDirectory() ? await latestModifiedAtInTree(child) : (await stat(child)).mtimeMs,
    );
  }
  return latest;
}

async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
  }
  return total;
}

export function artifactLabel(path: string): string {
  return basename(path);
}
