import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Global settings live under `os.homedir()`; point it at an in-memory path so
// the developer's real ~/.config/jean-claude is never touched.
const testHome = vi.hoisted(() => ({ path: '/tmp/jc-test-home' }));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, default: actual, homedir: () => testHome.path };
});

vi.mock('write-file-atomic', async () => {
  const mockedFs = await import('fs/promises');
  return {
    default: (filePath: string, content: string) =>
      mockedFs.writeFile(filePath, content, 'utf-8'),
  };
});

const mocks = vi.hoisted(() => ({
  emitPermissionsChanged: vi.fn(),
}));

vi.mock('./permission-event-service', () => ({
  emitPermissionsChanged: mocks.emitPermissionsChanged,
  onPermissionsChanged: () => () => {},
}));

import {
  addGlobalPermission,
  editGlobalPermission,
  removeGlobalPermission,
} from './global-permissions-service';
import {
  addProjectPermission,
  addProjectPermissionRule,
  addWorktreePermission,
  editProjectPermissionRule,
  removeProjectPermissionRule,
} from './permission-settings-service';

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-perm-emit-'));
  tempDirs.push(projectPath);
  return projectPath;
}

beforeEach(() => {
  mocks.emitPermissionsChanged.mockClear();
});

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  // The fake home is a real directory; leaving it behind leaks state between runs.
  await fs.rm(testHome.path, { recursive: true, force: true });
});

it.each([
  [
    'addProjectPermission',
    (projectPath: string) =>
      addProjectPermission(projectPath, 'Bash', { command: 'ls' }),
    'project',
  ],
  [
    'addProjectPermissionRule',
    (projectPath: string) =>
      addProjectPermissionRule({
        projectPath,
        toolName: 'Bash',
        input: { command: 'ls' },
      }),
    'project',
  ],
  [
    'addWorktreePermission',
    (projectPath: string) =>
      addWorktreePermission(projectPath, 'Bash', { command: 'ls' }),
    'worktree',
  ],
])('emits permissions:changed from %s', async (_name, run, scope) => {
  const projectPath = await createTempProject();

  await run(projectPath);

  expect(mocks.emitPermissionsChanged).toHaveBeenCalledWith({
    scope,
    projectPath,
  });
});

it('emits permissions:changed when project rules are removed or edited', async () => {
  const projectPath = await createTempProject();
  await addProjectPermissionRule({
    projectPath,
    toolName: 'Bash',
    input: { command: 'ls' },
  });

  mocks.emitPermissionsChanged.mockClear();
  await removeProjectPermissionRule({
    projectPath,
    tool: 'bash',
    pattern: 'ls',
  });
  expect(mocks.emitPermissionsChanged).toHaveBeenCalledWith({
    scope: 'project',
    projectPath,
  });

  mocks.emitPermissionsChanged.mockClear();
  await editProjectPermissionRule({
    projectPath,
    tool: 'bash',
    oldPattern: undefined,
    newPattern: 'git status',
    action: 'allow',
  });
  expect(mocks.emitPermissionsChanged).toHaveBeenCalledWith({
    scope: 'project',
    projectPath,
  });
});

it('emits a global permissions:changed for every global write path', async () => {
  await addGlobalPermission({ toolName: 'Bash', input: { command: 'ls' } });
  expect(mocks.emitPermissionsChanged).toHaveBeenCalledWith({
    scope: 'global',
  });

  // Writes stay inside the fake home directory.
  await expect(
    fs.readFile(
      path.join(testHome.path, '.config', 'jean-claude', 'settings.json'),
      'utf-8',
    ),
  ).resolves.toContain('bash');

  mocks.emitPermissionsChanged.mockClear();
  await editGlobalPermission({
    tool: 'bash',
    oldPattern: 'ls',
    newPattern: 'git status',
    action: 'allow',
  });
  expect(mocks.emitPermissionsChanged).toHaveBeenCalledWith({
    scope: 'global',
  });

  mocks.emitPermissionsChanged.mockClear();
  await removeGlobalPermission({ tool: 'bash', pattern: 'git status' });
  expect(mocks.emitPermissionsChanged).toHaveBeenCalledWith({
    scope: 'global',
  });
});

it('does not emit when a rule is rejected', async () => {
  const projectPath = await createTempProject();

  await expect(
    addWorktreePermission(projectPath, 'Bash', {}),
  ).resolves.toBe(false);

  expect(mocks.emitPermissionsChanged).not.toHaveBeenCalled();
});
