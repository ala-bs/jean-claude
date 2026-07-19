import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDirectoryAccess,
  getAllowedDirectories,
  toDirectoryPermissionPattern,
  validateAllowedDirectory,
} from './directory-access';

describe('directory access', () => {
  it('offers existing parents only, excludes root, and marks home', () => {
    const home = fs.realpathSync.native(os.homedir());
    const missingParent = `.jc-missing-${process.pid}-${Date.now()}`;
    const requestedDirectory = path.join(home, missingParent, 'repo');
    const access = buildDirectoryAccess({
      requestedPath: path.join(requestedDirectory, 'src', 'index.ts'),
      requestedDirectory,
    });

    expect(access?.parentDirectories).toContainEqual({
      path: home,
      isHome: true,
    });
    expect(
      access?.parentDirectories.some(
        ({ path: value }) => value === path.parse(value).root,
      ),
    ).toBe(false);
    expect(access?.parentDirectories).not.toContainEqual({ path: requestedDirectory });
    expect(access?.parentDirectories).not.toContainEqual({
      path: path.join(home, missingParent),
    });
  });

  it('rejects unrelated and renderer-invented directories', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-directory-access-'),
    );
    const requestedDirectory = path.join(
      temporaryDirectory,
      'shared',
      'repo',
    );
    fs.mkdirSync(requestedDirectory, { recursive: true });

    try {
      const access = buildDirectoryAccess({
        requestedPath: path.join(requestedDirectory, 'file.ts'),
        requestedDirectory,
      });
      const allowedDirectory = fs.realpathSync.native(
        path.join(temporaryDirectory, 'shared'),
      );

      expect(validateAllowedDirectory(access!, allowedDirectory)).toBe(
        allowedDirectory,
      );
      expect(() =>
        validateAllowedDirectory(access!, temporaryDirectory),
      ).not.toThrow();
      expect(() => validateAllowedDirectory(access!, os.homedir())).toThrow(
        'not a valid parent choice',
      );
      expect(() =>
        validateAllowedDirectory(access!, requestedDirectory),
      ).toThrow('not a valid parent choice');
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects invalid request metadata', () => {
    expect(
      buildDirectoryAccess({
        requestedPath: '../file.ts',
        requestedDirectory: '/safe/repo',
      }),
    ).toBeUndefined();
    expect(
      buildDirectoryAccess({
        requestedPath: '/outside/file.ts',
        requestedDirectory: '/safe/repo',
      }),
    ).toBeUndefined();
  });

  it('rejects symlink loops instead of reconstructing them lexically', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-directory-access-'),
    );
    const loop = path.join(temporaryDirectory, 'loop');
    fs.symlinkSync(loop, loop);

    try {
      expect(
        buildDirectoryAccess({
          requestedPath: path.join(loop, 'file.ts'),
          requestedDirectory: loop,
        }),
      ).toBeUndefined();
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('canonicalizes symlinks before offering parent directories', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-directory-access-'),
    );
    const homeLink = path.join(temporaryDirectory, 'home-link');
    fs.symlinkSync(os.homedir(), homeLink);

    try {
      const access = buildDirectoryAccess({
        requestedPath: path.join(homeLink, 'file-that-may-not-exist'),
        requestedDirectory: homeLink,
      });

      expect(access?.requestedDirectory).toBe(fs.realpathSync.native(os.homedir()));
      expect(access?.parentDirectories).not.toContainEqual({ path: homeLink });
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('does not offer a symlink alias for filesystem root', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-directory-access-'),
    );
    const rootLink = path.join(temporaryDirectory, 'root-link');
    fs.symlinkSync(path.parse(temporaryDirectory).root, rootLink);

    try {
      expect(
        buildDirectoryAccess({
          requestedPath: rootLink,
          requestedDirectory: rootLink,
        }),
      ).toBeUndefined();
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects a selected parent replaced with a symlink', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-directory-access-'),
    );
    const selectedDirectory = path.join(temporaryDirectory, 'shared');
    const requestedDirectory = path.join(selectedDirectory, 'repo');
    fs.mkdirSync(requestedDirectory, { recursive: true });

    try {
      const access = buildDirectoryAccess({
        requestedPath: path.join(requestedDirectory, 'file.ts'),
        requestedDirectory,
      });
      fs.rmSync(selectedDirectory, { recursive: true, force: true });
      fs.symlinkSync(path.parse(temporaryDirectory).root, selectedDirectory);

      expect(() =>
        validateAllowedDirectory(access!, selectedDirectory),
      ).toThrow('changed while awaiting permission');
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects glob metacharacters in persisted directory patterns', () => {
    expect(() => toDirectoryPermissionPattern('/safe/team*')).toThrow(
      'unsupported glob characters',
    );
    expect(
      getAllowedDirectories([
        {
          tool: 'external_directory',
          pattern: '/safe/team*/**',
          action: 'allow',
        },
      ]),
    ).toEqual([]);
    if (path.sep === '/') {
      expect(() => toDirectoryPermissionPattern('/safe/foo\\bar')).toThrow(
        'unsupported glob characters',
      );
    }
  });

  it('round-trips recursive external-directory rules', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-directory-access-'),
    );
    const canonicalDirectory = fs.realpathSync.native(temporaryDirectory);
    const pattern = toDirectoryPermissionPattern(canonicalDirectory);

    try {
      expect(pattern).toBe(`${canonicalDirectory}/**`);
      expect(
        getAllowedDirectories([
          {
            tool: 'external_directory',
            pattern,
            action: 'allow',
          },
          { tool: 'read', pattern: '/safe/**', action: 'allow' },
        ]),
      ).toEqual([canonicalDirectory]);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('drops persisted directories whose canonical identity changed', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-directory-access-'),
    );
    const allowedDirectory = path.join(temporaryDirectory, 'allowed');
    fs.mkdirSync(allowedDirectory);
    const canonicalAllowedDirectory = fs.realpathSync.native(allowedDirectory);
    const pattern = toDirectoryPermissionPattern(canonicalAllowedDirectory);
    const rules = [
      {
        tool: 'external_directory',
        pattern,
        action: 'allow' as const,
      },
    ];

    try {
      expect(getAllowedDirectories(rules)).toEqual([canonicalAllowedDirectory]);
      fs.rmSync(allowedDirectory, { recursive: true });
      fs.symlinkSync(path.parse(temporaryDirectory).root, allowedDirectory);
      expect(getAllowedDirectories(rules)).toEqual([]);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
