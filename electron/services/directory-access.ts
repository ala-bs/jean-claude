import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { NormalizedPermissionRequest } from '@shared/normalized-message-v2';
import type { ResolvedPermissionRule } from '@shared/permission-types';

type DirectoryAccess = NonNullable<
  NormalizedPermissionRequest['directoryAccess']
>;

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function hasGlobMetacharacters(directory: string): boolean {
  return (
    /[*?[\]{}()!]/.test(directory) ||
    (path.sep === '/' && directory.includes('\\'))
  );
}

function canonicalizePath(value: string): string | undefined {
  let current = value;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return path.resolve(fs.realpathSync.native(current), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        if (code === 'ELOOP' || code === 'ENOTDIR') return undefined;
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function canonicalizeDirectoryRequest({
  requestedPath,
  requestedDirectory,
}: {
  requestedPath: string;
  requestedDirectory: string;
}): { requestedPath: string; requestedDirectory: string } | undefined {
  if (!path.isAbsolute(requestedPath) || !path.isAbsolute(requestedDirectory)) {
    return undefined;
  }

  const lexicalPath = path.resolve(requestedPath);
  const lexicalDirectory = path.resolve(requestedDirectory);
  if (!isSameOrChildPath(lexicalPath, lexicalDirectory)) return undefined;

  const normalizedDirectory = canonicalizePath(lexicalDirectory);
  const normalizedPath = canonicalizePath(lexicalPath);
  if (!normalizedDirectory || !normalizedPath) return undefined;
  if (hasGlobMetacharacters(normalizedDirectory)) return undefined;
  if (!isSameOrChildPath(normalizedPath, normalizedDirectory)) return undefined;

  return {
    requestedPath: normalizedPath,
    requestedDirectory: normalizedDirectory,
  };
}

export function canonicalizeDirectoryPath(
  directory: string,
): string | undefined {
  if (!path.isAbsolute(directory)) return undefined;
  try {
    const canonical = fs.realpathSync.native(directory);
    return fs.statSync(canonical).isDirectory() ? canonical : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
}

export function buildDirectoryAccess({
  requestedPath,
  requestedDirectory,
}: {
  requestedPath: string;
  requestedDirectory: string;
}): DirectoryAccess | undefined {
  const canonicalRequest = canonicalizeDirectoryRequest({
    requestedPath,
    requestedDirectory,
  });
  if (!canonicalRequest) return undefined;
  const {
    requestedPath: normalizedPath,
    requestedDirectory: normalizedDirectory,
  } = canonicalRequest;

  const root = path.parse(normalizedDirectory).root;
  const home = canonicalizePath(path.resolve(os.homedir())) ?? path.resolve(os.homedir());
  const parentDirectories: DirectoryAccess['parentDirectories'] = [];
  let current = path.dirname(normalizedDirectory);

  while (current !== root) {
    if (
      canonicalizeDirectoryPath(current) === current &&
      !hasGlobMetacharacters(current)
    ) {
      parentDirectories.push({
        path: current,
        ...(isSameOrChildPath(home, current) ? { isHome: true } : {}),
      });
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  if (parentDirectories.length === 0) return undefined;

  return {
    requestedPath: normalizedPath,
    requestedDirectory: normalizedDirectory,
    parentDirectories,
  };
}

export function validateAllowedDirectory(
  directoryAccess: DirectoryAccess,
  selectedDirectory: string,
): string {
  if (!path.isAbsolute(selectedDirectory)) {
    throw new Error('Allowed directory must be absolute');
  }

  const normalized = canonicalizeDirectoryPath(selectedDirectory);
  if (!normalized) {
    throw new Error('Allowed directory must exist and be a directory');
  }
  const currentRequest = canonicalizeDirectoryRequest({
    requestedPath: directoryAccess.requestedPath,
    requestedDirectory: directoryAccess.requestedDirectory,
  });
  if (
    !currentRequest ||
    currentRequest.requestedPath !== directoryAccess.requestedPath ||
    currentRequest.requestedDirectory !== directoryAccess.requestedDirectory
  ) {
    throw new Error('Requested external path changed while awaiting permission');
  }
  if (
    !directoryAccess.parentDirectories.some(
      (directory) => directory.path === normalized,
    )
  ) {
    throw new Error('Allowed directory is not a valid parent choice');
  }

  return normalized;
}

export function toDirectoryPermissionPattern(directory: string): string {
  if (hasGlobMetacharacters(directory)) {
    throw new Error('Allowed directory contains unsupported glob characters');
  }
  return `${directory.replaceAll('\\', '/').replace(/\/$/, '')}/**`;
}

export function getAllowedDirectories(
  rules: ResolvedPermissionRule[],
): string[] {
  return rules
    .filter(
      (rule) =>
        rule.tool === 'external_directory' &&
        rule.action === 'allow' &&
        rule.pattern.endsWith('/**'),
    )
    .map((rule) => rule.pattern.slice(0, -3))
    .filter((directory) => !hasGlobMetacharacters(directory))
    .flatMap((directory) => {
      if (!path.isAbsolute(directory)) return [];
      const resolved = path.resolve(directory);
      const canonical = canonicalizeDirectoryPath(resolved);
      return canonical === resolved ? [canonical] : [];
    });
}
