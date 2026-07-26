import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncBuiltinSkillSymlinks } from './skill-management-service';
import { upsertBuiltinSkills } from './builtin-skills-service';

let testDir: string;

function getTestBuiltinSkillsDir(): string {
  return path.join(
    testDir,
    '.config',
    'jean-claude',
    'skills',
    'builtin',
  );
}

beforeEach(async () => {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-builtin-skills-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (testDir) {
    await fs.rm(testDir, { force: true, recursive: true });
  }
});

describe('builtin skills installation', () => {
  it('preserves existing builtin skill content when requested', async () => {
    const skillMdPath = path.join(
      getTestBuiltinSkillsDir(),
      'task-name-generation',
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(skillMdPath), { recursive: true });
    await fs.writeFile(skillMdPath, 'local dev edit', 'utf-8');

    await upsertBuiltinSkills({ preserveExisting: true, homeDirectory: testDir });

    await expect(fs.readFile(skillMdPath, 'utf-8')).resolves.toBe(
      'local dev edit',
    );
    await expect(
      fs.readFile(
        path.join(getTestBuiltinSkillsDir(), 'project-feature-mapping', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toContain('name: project-feature-mapping');
  });

  it('overwrites existing builtin skill content by default', async () => {
    const skillMdPath = path.join(
      getTestBuiltinSkillsDir(),
      'task-name-generation',
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(skillMdPath), { recursive: true });
    await fs.writeFile(skillMdPath, 'stale content', 'utf-8');

    await upsertBuiltinSkills({ homeDirectory: testDir });

    await expect(fs.readFile(skillMdPath, 'utf-8')).resolves.toContain(
      'name: task-name-generation',
    );
  });

  it('installs project feature mapping loop instructions', async () => {
    await upsertBuiltinSkills({ homeDirectory: testDir });

    const content = await fs.readFile(
      path.join(getTestBuiltinSkillsDir(), 'project-feature-mapping', 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('First look for new features');
    expect(content).toContain('Then run up to 5 improvement loops');
    expect(content).toContain('Loops 2-5: deepen each flagged feature/subfeature');
    expect(content).toContain('Every node must include id');
    expect(content).toContain('Preserve existing ids');
    expect(content).toContain(
      'Stop early when a full pass finds no new missing features',
    );
  });

  it('removes retired managed skill files and only their exact backend symlinks', async () => {
    const retiredName = 'user-preference-memory';
    const retiredSkillDir = path.join(getTestBuiltinSkillsDir(), retiredName);
    const managedBackendDir = path.join(testDir, 'managed-backend');
    const foreignBackendDir = path.join(testDir, 'foreign-backend');
    const userOwnedBackendDir = path.join(testDir, 'user-owned-backend');
    const foreignTarget = path.join(testDir, 'foreign-skill');
    const unrelatedBuiltin = path.join(
      getTestBuiltinSkillsDir(),
      'unrelated-builtin',
    );

    await fs.mkdir(retiredSkillDir, { recursive: true });
    await fs.writeFile(path.join(retiredSkillDir, 'SKILL.md'), 'retired');
    await fs.mkdir(foreignTarget, { recursive: true });
    await fs.mkdir(unrelatedBuiltin, { recursive: true });
    await fs.writeFile(path.join(unrelatedBuiltin, 'keep.txt'), 'keep');
    await fs.mkdir(managedBackendDir, { recursive: true });
    await fs.mkdir(foreignBackendDir, { recursive: true });
    await fs.mkdir(userOwnedBackendDir, { recursive: true });
    await fs.symlink(retiredSkillDir, path.join(managedBackendDir, retiredName));
    await fs.symlink(foreignTarget, path.join(foreignBackendDir, retiredName));
    await fs.mkdir(path.join(userOwnedBackendDir, retiredName));
    await fs.writeFile(
      path.join(userOwnedBackendDir, retiredName, 'keep.txt'),
      'keep',
    );

    await upsertBuiltinSkills({
      homeDirectory: testDir,
      backendSkillsDirs: [
        managedBackendDir,
        foreignBackendDir,
        userOwnedBackendDir,
      ],
    });

    await expect(fs.lstat(retiredSkillDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.lstat(path.join(managedBackendDir, retiredName)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.realpath(path.join(foreignBackendDir, retiredName)),
    ).resolves.toBe(foreignTarget);
    await expect(
      fs.readFile(
        path.join(userOwnedBackendDir, retiredName, 'keep.txt'),
        'utf-8',
      ),
    ).resolves.toBe('keep');
    await expect(
      fs.readFile(path.join(unrelatedBuiltin, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
  });

  it('skips a symlinked builtin parent without blocking startup', async () => {
    const homeDirectory = path.join(testDir, 'home');
    const skillsDirectory = path.join(
      homeDirectory,
      '.config',
      'jean-claude',
      'skills',
    );
    const externalSkills = path.join(testDir, 'external-skills');
    const externalRetired = path.join(
      externalSkills,
      'builtin',
      'user-preference-memory',
    );
    await fs.mkdir(path.dirname(skillsDirectory), { recursive: true });
    await fs.mkdir(externalRetired, { recursive: true });
    await fs.writeFile(path.join(externalRetired, 'keep.txt'), 'keep');
    await fs.symlink(externalSkills, skillsDirectory);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      upsertBuiltinSkills({
        homeDirectory,
        backendSkillsDirs: [],
      }),
    ).resolves.toBeUndefined();

    await expect(
      fs.readFile(path.join(externalRetired, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    expect(warning).toHaveBeenCalledWith(
      '[builtin-skills] Maintenance skipped',
      {
        category: 'unsafe-canonical-path',
        path: skillsDirectory,
      },
    );
  });

  it('installs the work item summary editorial skill', async () => {
    await upsertBuiltinSkills({ homeDirectory: testDir });

    const content = await fs.readFile(
      path.join(getTestBuiltinSkillsDir(), 'work-item-summary', 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain('name: work-item-summary');
    expect(content).toContain('work item summary generation service');
    expect(content).toContain('about 180 words');
    expect(content).toContain('6-10 bullets as a ceiling');
    expect(content).toContain('not a quota');
    expect(content).toContain('Keep sparse items much shorter');
    expect(content).toContain('sole authority');
    expect(content).toContain('never propose implementation methods');
    expect(content).toContain('validation mechanisms');
    expect(content).toContain('schemas or fields');
    expect(content).toContain('authorization policy');
    expect(content).toContain('assumed subrequirements');
    expect(content).toContain('latest explicit comment decision wins');
    expect(content).toContain('Ask at most 3 source-grounded questions');
    expect(content).toContain('Always include exactly one factual visual');
    expect(content).toContain('at most 8 nodes');
    expect(content).toContain('Output Markdown only');
  });

  it('skips a symlinked config ancestor while cleaning a safe backend link', async () => {
    const homeDirectory = path.join(testDir, 'home');
    const externalConfig = path.join(testDir, 'external-config');
    const externalRetired = path.join(
      externalConfig,
      'jean-claude',
      'skills',
      'builtin',
      'user-preference-memory',
    );
    await fs.mkdir(homeDirectory, { recursive: true });
    await fs.mkdir(externalRetired, { recursive: true });
    await fs.writeFile(path.join(externalRetired, 'keep.txt'), 'keep');
    await fs.symlink(externalConfig, path.join(homeDirectory, '.config'));
    const safeBackend = path.join(homeDirectory, '.claude', 'skills');
    const safeBackendLink = path.join(
      safeBackend,
      'user-preference-memory',
    );
    await fs.mkdir(safeBackend, { recursive: true });
    await fs.symlink(
      path.join(
        homeDirectory,
        '.config',
        'jean-claude',
        'skills',
        'builtin',
        'user-preference-memory',
      ),
      safeBackendLink,
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      upsertBuiltinSkills({
        homeDirectory,
        backendSkillsDirs: [safeBackend],
      }),
    ).resolves.toBeUndefined();

    await expect(
      fs.readFile(path.join(externalRetired, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    await expect(fs.lstat(safeBackendLink)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(warning).toHaveBeenCalledWith(
      '[builtin-skills] Maintenance skipped',
      {
        category: 'unsafe-canonical-path',
        path: path.join(homeDirectory, '.config'),
      },
    );
  });

  it('skips an unsafe backend root while cleaning other safe backends', async () => {
    const retiredName = 'user-preference-memory';
    const retiredSkillDir = path.join(getTestBuiltinSkillsDir(), retiredName);
    const safeBackend = path.join(testDir, '.claude', 'skills');
    const safeBackendLink = path.join(safeBackend, retiredName);
    const unsafeBackend = path.join(testDir, '.config', 'unsafe', 'skills');
    const externalBackend = path.join(testDir, 'external-backend');
    const externalRetired = path.join(externalBackend, retiredName);
    await fs.mkdir(retiredSkillDir, { recursive: true });
    await fs.writeFile(path.join(retiredSkillDir, 'SKILL.md'), 'retired');
    await fs.mkdir(safeBackend, { recursive: true });
    await fs.symlink(retiredSkillDir, safeBackendLink);
    await fs.mkdir(path.dirname(unsafeBackend), { recursive: true });
    await fs.mkdir(externalRetired, { recursive: true });
    await fs.writeFile(path.join(externalRetired, 'keep.txt'), 'keep');
    await fs.symlink(externalBackend, unsafeBackend);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      upsertBuiltinSkills({
        homeDirectory: testDir,
        backendSkillsDirs: [unsafeBackend, safeBackend],
      }),
    ).resolves.toBeUndefined();

    await expect(fs.lstat(safeBackendLink)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.readFile(path.join(externalRetired, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    expect(warning).toHaveBeenCalledWith(
      '[builtin-skills] Maintenance skipped',
      {
        category: 'unsafe-backend-path',
        path: unsafeBackend,
      },
    );
  });

  it('never relinks a retained retired skill after unsafe canonical cleanup', async () => {
    const homeDirectory = path.join(testDir, 'home');
    const canonicalSkillsParent = path.join(
      homeDirectory,
      '.config',
      'jean-claude',
      'skills',
    );
    const externalSkillsParent = path.join(testDir, 'external-skills');
    const externalBuiltin = path.join(externalSkillsParent, 'builtin');
    const retiredName = 'user-preference-memory';
    const validName = 'project-feature-mapping';
    const backendSkillsDir = path.join(homeDirectory, '.claude', 'skills');
    const unrelatedSkill = path.join(backendSkillsDir, 'user-owned-skill');
    await fs.mkdir(path.dirname(canonicalSkillsParent), { recursive: true });
    await fs.mkdir(path.join(externalBuiltin, retiredName), { recursive: true });
    await fs.writeFile(
      path.join(externalBuiltin, retiredName, 'SKILL.md'),
      'retired',
    );
    await fs.mkdir(path.join(externalBuiltin, validName));
    await fs.writeFile(
      path.join(externalBuiltin, validName, 'SKILL.md'),
      'valid',
    );
    await fs.symlink(externalSkillsParent, canonicalSkillsParent);
    await fs.mkdir(unrelatedSkill, { recursive: true });
    await fs.writeFile(path.join(unrelatedSkill, 'keep.txt'), 'keep');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      (async () => {
        await upsertBuiltinSkills({
          homeDirectory,
          backendSkillsDirs: [backendSkillsDir],
        });
        await syncBuiltinSkillSymlinks({
          builtinSkillsDir: path.join(canonicalSkillsParent, 'builtin'),
          backendSkillsDirs: [backendSkillsDir],
        });
      })(),
    ).resolves.toBeUndefined();

    await expect(
      fs.lstat(path.join(backendSkillsDir, retiredName)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.realpath(path.join(backendSkillsDir, validName)),
    ).resolves.toBe(path.join(externalBuiltin, validName));
    await expect(
      fs.readFile(path.join(unrelatedSkill, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    await expect(
      fs.readFile(path.join(externalBuiltin, retiredName, 'SKILL.md'), 'utf-8'),
    ).resolves.toBe('retired');
  });
});
