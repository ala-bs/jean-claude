import { describe, expect, it, vi } from 'vitest';

// `user-data-dir` calls `app.setPath` on import; stub Electron so importing the
// pure resolver here does not require a live app.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/Users/x/Library/Application Support/jean-claude',
    setPath: () => {},
  },
}));

const { resolveUserDataDir } = await import('./user-data-dir');

const DEFAULT_DIR = '/Users/x/Library/Application Support/jean-claude';

describe('resolveUserDataDir', () => {
  it('leaves the packaged app on the default profile', () => {
    expect(
      resolveUserDataDir({
        defaultUserDataDir: DEFAULT_DIR,
        skipInstanceLock: false,
      }),
    ).toBe(DEFAULT_DIR);
  });

  /**
   * The regression this exists for: a dev instance sharing the packaged app's
   * profile shares its Local Storage LevelDB, and the loser of that lock opens
   * an empty store.
   */
  it('moves a lock-skipping instance off the shared profile', () => {
    const resolved = resolveUserDataDir({
      defaultUserDataDir: DEFAULT_DIR,
      skipInstanceLock: true,
      dbPath: '/repo/worktree-a/db-tmp/jean-claude.db',
    });

    expect(resolved).toBe('/repo/worktree-a/db-tmp/chromium-user-data');
    expect(resolved).not.toBe(DEFAULT_DIR);
  });

  it('keys off the database so a worktree keeps its state across restarts', () => {
    const args = {
      defaultUserDataDir: DEFAULT_DIR,
      skipInstanceLock: true,
      dbPath: '/repo/worktree-a/db-tmp/jean-claude.db',
    };

    expect(resolveUserDataDir(args)).toBe(resolveUserDataDir(args));
  });

  it('gives two worktrees separate profiles so they do not contend either', () => {
    const a = resolveUserDataDir({
      defaultUserDataDir: DEFAULT_DIR,
      skipInstanceLock: true,
      dbPath: '/repo/worktree-a/db-tmp/jean-claude.db',
    });
    const b = resolveUserDataDir({
      defaultUserDataDir: DEFAULT_DIR,
      skipInstanceLock: true,
      dbPath: '/repo/worktree-b/db-tmp/jean-claude.db',
    });

    expect(a).not.toBe(b);
  });

  // Isolating without a database override would silently hand the instance a
  // brand-new empty SQLite file, since the default DB path derives from
  // userData — indistinguishable from the data loss this exists to prevent.
  it('leaves userData alone with no database override to key off', () => {
    expect(
      resolveUserDataDir({
        defaultUserDataDir: DEFAULT_DIR,
        skipInstanceLock: true,
      }),
    ).toBe(DEFAULT_DIR);
  });

  it('lets an explicit override win over everything else', () => {
    expect(
      resolveUserDataDir({
        defaultUserDataDir: DEFAULT_DIR,
        explicitUserDataDir: '/tmp/custom-profile',
        skipInstanceLock: true,
        dbPath: '/repo/worktree-a/db-tmp/jean-claude.db',
      }),
    ).toBe('/tmp/custom-profile');
  });
});
