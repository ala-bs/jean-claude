import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const IGNORED = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  '.expo',
  '.gradle',
  'DerivedData',
  '.jean-claude',
]);

async function collectFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, absolute)));
    else if (entry.isFile()) files.push(relative(root, absolute));
  }
  return files;
}

export async function fingerprintMobileBuildInputs({
  projectPath,
  appPath,
  platform,
  packageId,
  command,
}: {
  projectPath: string;
  appPath: string;
  platform: 'android' | 'ios';
  packageId: string;
  command: string;
}): Promise<string> {
  const root = resolve(projectPath);
  const appRoot = resolve(root, appPath || '.');
  const files = await collectFiles(appRoot);
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ appPath, platform, packageId, command }));
  for (const file of files) {
    const absolute = join(appRoot, file);
    const metadata = await stat(absolute);
    hash.update(`\n${relative(root, absolute)}:${metadata.size}:`);
    hash.update(await readFile(absolute));
  }
  return hash.digest('hex');
}
