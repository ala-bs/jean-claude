import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  createSkill,
  deleteSkill,
  disableSkill,
  enableSkill,
  executeLegacySkillMigration,
  getAllManagedSkills,
  getAllManagedSkillsUnified,
  previewLegacySkillMigration,
  syncBuiltinSkillSymlinks,
} from './skill-management-service';
import { JC_BUILTIN_SKILLS_DIR } from './builtin-skills-service';


async function writeSkill({
  projectPath,
  relativeDir,
  dirName,
  name,
}: {
  projectPath: string;
  relativeDir: string;
  dirName: string;
  name: string;
}): Promise<string> {
  const skillDir = path.join(projectPath, relativeDir, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${name} body\n`,
    'utf-8',
  );
  return skillDir;
}

describe('skill management project skill discovery', () => {
  it('discovers repo .claude skills for opencode', async () => {
    const projectPath = '/project';
    const skillDir = await writeSkill({
      projectPath,
      relativeDir: '.claude/skills',
      dirName: 'repo-claude-skill',
      name: 'repo-claude-skill',
    });

    const skills = await getAllManagedSkills({
      backendType: 'opencode',
      projectPath,
    });

    expect(skills).toContainEqual(
      expect.objectContaining({
        name: 'repo-claude-skill',
        source: 'project',
        skillPath: skillDir,
        enabledBackends: { opencode: true },
      }),
    );
  });

  it('creates opencode project skills in .opencode skills', async () => {
    const projectPath = '/project';

    const skill = await createSkill({
      enabledBackends: ['opencode'],
      scope: 'project',
      projectPath,
      name: 'native opencode skill',
      description: 'Native OpenCode skill',
      content: 'Use native OpenCode project skill path.',
    });

    expect(skill.skillPath).toBe(
      path.join(projectPath, '.opencode/skills/native-opencode-skill'),
    );
  });

  it('discovers Codex project skills in .codex skills', async () => {
    const projectPath = '/project';
    const skillDir = await writeSkill({
      projectPath,
      relativeDir: '.codex/skills',
      dirName: 'repo-codex-skill',
      name: 'repo-codex-skill',
    });

    const skills = await getAllManagedSkills({
      backendType: 'codex',
      projectPath,
    });

    expect(skills).toContainEqual(
      expect.objectContaining({
        name: 'repo-codex-skill',
        source: 'project',
        skillPath: skillDir,
        enabledBackends: { codex: true },
      }),
    );
  });

  it('creates Codex project skills in .codex skills', async () => {
    const projectPath = '/project';

    const skill = await createSkill({
      enabledBackends: ['codex'],
      scope: 'project',
      projectPath,
      name: 'native codex skill',
      description: 'Native Codex skill',
      content: 'Use native Codex project skill path.',
    });

    expect(skill.skillPath).toBe(
      path.join(projectPath, '.codex/skills/native-codex-skill'),
    );
  });

  it('creates, disables, and enables Codex user skills via ~/.codex skills', async () => {
    const skill = await createSkill({
      enabledBackends: ['codex'],
      scope: 'user',
      name: 'native codex user skill',
      description: 'Native Codex user skill',
      content: 'Use native Codex user skill path.',
    });
    const codexSymlinkPath = path.join(
      os.homedir(),
      '.codex/skills/native-codex-user-skill',
    );

    expect(skill.skillPath).toBe(
      path.join(
        os.homedir(),
        '.config/jean-claude/skills/user/native-codex-user-skill',
      ),
    );
    await expect(fs.realpath(codexSymlinkPath)).resolves.toBe(skill.skillPath);

    let skills = await getAllManagedSkills({ backendType: 'codex' });
    expect(
      skills.find((entry) => entry.skillPath === skill.skillPath)
        ?.enabledBackends,
    ).toEqual({ codex: true });

    await disableSkill({ skillPath: skill.skillPath, backendType: 'codex' });
    await expect(fs.lstat(codexSymlinkPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    skills = await getAllManagedSkills({ backendType: 'codex' });
    expect(
      skills.find((entry) => entry.skillPath === skill.skillPath)
        ?.enabledBackends,
    ).toEqual({ codex: false });

    await enableSkill({ skillPath: skill.skillPath, backendType: 'codex' });
    await expect(fs.realpath(codexSymlinkPath)).resolves.toBe(skill.skillPath);
  });

  it('creates, disables, and enables Copilot user skills via ~/.copilot skills', async () => {
    const skill = await createSkill({
      enabledBackends: ['copilot'],
      scope: 'user',
      name: 'native copilot user skill',
      description: 'Native Copilot user skill',
      content: 'Use native Copilot user skill path.',
    });
    const copilotSymlinkPath = path.join(
      os.homedir(),
      '.copilot/skills/native-copilot-user-skill',
    );

    expect(skill.skillPath).toBe(
      path.join(
        os.homedir(),
        '.config/jean-claude/skills/user/native-copilot-user-skill',
      ),
    );
    await expect(fs.realpath(copilotSymlinkPath)).resolves.toBe(
      skill.skillPath,
    );

    let skills = await getAllManagedSkills({ backendType: 'copilot' });
    expect(
      skills.find((entry) => entry.skillPath === skill.skillPath)
        ?.enabledBackends,
    ).toEqual({ copilot: true });

    await disableSkill({ skillPath: skill.skillPath, backendType: 'copilot' });
    await expect(fs.lstat(copilotSymlinkPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    skills = await getAllManagedSkills({ backendType: 'copilot' });
    expect(
      skills.find((entry) => entry.skillPath === skill.skillPath)
        ?.enabledBackends,
    ).toEqual({ copilot: false });

    await enableSkill({ skillPath: skill.skillPath, backendType: 'copilot' });
    await expect(fs.realpath(copilotSymlinkPath)).resolves.toBe(
      skill.skillPath,
    );
  });

  it('creates, disables, and enables Vibe user skills via ~/.vibe skills', async () => {
    const skill = await createSkill({
      enabledBackends: ['vibe'],
      scope: 'user',
      name: 'native vibe user skill',
      description: 'Native Vibe user skill',
      content: 'Use native Vibe user skill path.',
    });
    const vibeSymlinkPath = path.join(
      os.homedir(),
      '.vibe/skills/native-vibe-user-skill',
    );

    expect(skill.skillPath).toBe(
      path.join(
        os.homedir(),
        '.config/jean-claude/skills/user/native-vibe-user-skill',
      ),
    );
    await expect(fs.realpath(vibeSymlinkPath)).resolves.toBe(skill.skillPath);

    let skills = await getAllManagedSkills({ backendType: 'vibe' });
    expect(
      skills.find((entry) => entry.skillPath === skill.skillPath)
        ?.enabledBackends,
    ).toEqual({ vibe: true });

    await disableSkill({ skillPath: skill.skillPath, backendType: 'vibe' });
    await expect(fs.lstat(vibeSymlinkPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    skills = await getAllManagedSkills({ backendType: 'vibe' });
    expect(
      skills.find((entry) => entry.skillPath === skill.skillPath)
        ?.enabledBackends,
    ).toEqual({ vibe: false });

    await enableSkill({ skillPath: skill.skillPath, backendType: 'vibe' });
    await expect(fs.realpath(vibeSymlinkPath)).resolves.toBe(skill.skillPath);
  });

  it('discovers Vibe project skills from .vibe skills only for Vibe', async () => {
    const projectPath = '/project';
    const vibeSkillDir = await writeSkill({
      projectPath,
      relativeDir: '.vibe/skills',
      dirName: 'project-vibe-skill',
      name: 'project-vibe-skill',
    });
    await writeSkill({
      projectPath,
      relativeDir: '.agents/skills',
      dirName: 'shared-agent-skill',
      name: 'shared-agent-skill',
    });

    const skills = await getAllManagedSkills({
      backendType: 'vibe',
      projectPath,
    });

    expect(skills).toContainEqual(
      expect.objectContaining({
        name: 'project-vibe-skill',
        source: 'project',
        skillPath: vibeSkillDir,
        enabledBackends: { vibe: true },
      }),
    );
    expect(skills.map((skill) => skill.name)).not.toContain(
      'shared-agent-skill',
    );
  });

  it('reports Vibe enabled state for JC-managed skills independently', async () => {
    const skill = await createSkill({
      enabledBackends: ['opencode', 'vibe'],
      scope: 'user',
      name: 'multi backend skill',
      description: 'Multi backend skill',
      content: 'Shared body.',
    });

    await disableSkill({ skillPath: skill.skillPath, backendType: 'opencode' });

    const skills = await getAllManagedSkillsUnified({});
    expect(skills).toContainEqual(
      expect.objectContaining({
        name: 'multi backend skill',
        enabledBackends: expect.objectContaining({
          opencode: false,
          vibe: true,
        }),
      }),
    );
  });

  it('writes Vibe-compatible SKILL.md frontmatter', async () => {
    const skill = await createSkill({
      enabledBackends: ['vibe'],
      scope: 'user',
      name: 'vibe compatible skill',
      description: 'Works with Vibe',
      content: '# Instructions\nUse this skill.',
    });

    const content = await fs.readFile(
      path.join(skill.skillPath, 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('name: vibe compatible skill');
    expect(content).toContain('description: Works with Vibe');
    expect(content).toContain('# Instructions\nUse this skill.');
  });

  it('marks .claude project skills enabled for backends that discover them', async () => {
    const projectPath = '/project';
    const skillDir = await writeSkill({
      projectPath,
      relativeDir: '.claude/skills',
      dirName: 'shared-project-skill',
      name: 'shared-project-skill',
    });

    const skills = await getAllManagedSkillsUnified({ projectPath });
    const skill = skills.find((item) => item.skillPath === skillDir);

    expect(skill?.enabledBackends).toEqual({
      'claude-code': true,
      copilot: true,
      opencode: true,
    });
  });

  it('rejects skill creation when name normalizes without letters or numbers', async () => {
    await expect(
      createSkill({
        enabledBackends: [],
        scope: 'user',
        name: '!!!',
        description: 'Invalid skill',
        content: 'Use invalid skill.',
      }),
    ).rejects.toThrow('Invalid skill target name');

    await expect(
      fs.lstat(
        path.join(os.homedir(), '.config/jean-claude/skills/user/SKILL.md'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('skill management safety', () => {
  it('does not treat a foreign backend symlink as enabled, overwrite it, or remove it', async () => {
    const canonicalPath = path.join(
      os.homedir(),
      '.config/jean-claude/skills/user/safe-skill',
    );
    const foreignTarget = path.join(
      os.homedir(),
      '.config/jean-claude/skills/user/foreign-skill',
    );
    const backendPath = path.join(
      os.homedir(),
      '.config/opencode/skills/safe-skill',
    );
    const enabledBackendPath = path.join(
      os.homedir(),
      '.claude/skills/safe-skill',
    );
    await writeSkill({
      projectPath: path.dirname(canonicalPath),
      relativeDir: '',
      dirName: path.basename(canonicalPath),
      name: 'safe-skill',
    });
    await writeSkill({
      projectPath: path.dirname(foreignTarget),
      relativeDir: '',
      dirName: path.basename(foreignTarget),
      name: 'foreign-skill',
    });
    await fs.mkdir(path.dirname(backendPath), { recursive: true });
    await fs.symlink(foreignTarget, backendPath);
    await fs.mkdir(path.dirname(enabledBackendPath), { recursive: true });
    await fs.symlink(canonicalPath, enabledBackendPath);

    const backendSkills = await getAllManagedSkills({
      backendType: 'opencode',
    });
    const backendSkill = backendSkills.find(
      (entry) => entry.skillPath === canonicalPath,
    );

    expect(backendSkill?.enabledBackends).toEqual({
      opencode: false,
    });

    const skills = await getAllManagedSkillsUnified({});
    const skill = skills.find((entry) => entry.skillPath === canonicalPath);

    expect(skill?.enabledBackends).toEqual({
      'claude-code': true,
      codex: false,
      copilot: false,
      opencode: false,
      vibe: false,
    });

    await expect(
      enableSkill({ skillPath: canonicalPath, backendType: 'opencode' }),
    ).rejects.toThrow('Skill already exists for opencode');
    await disableSkill({ skillPath: canonicalPath, backendType: 'opencode' });
    await deleteSkill({ skillPath: canonicalPath, backendType: 'claude-code' });

    await expect(fs.realpath(backendPath)).resolves.toBe(foreignTarget);
  });

  it('does not overwrite a foreign symlink with the same name as a builtin skill', async () => {
    const builtinName = 'foreign-builtin-safety';
    const builtinPath = await writeSkill({
      projectPath: JC_BUILTIN_SKILLS_DIR,
      relativeDir: '',
      dirName: builtinName,
      name: builtinName,
    });
    const foreignTarget = await writeSkill({
      projectPath: os.homedir(),
      relativeDir: '.config/foreign-skills',
      dirName: builtinName,
      name: 'foreign-builtin-safety-target',
    });
    const backendPath = path.join(
      os.homedir(),
      '.config/opencode/skills',
      builtinName,
    );
    const claudeBackendPath = path.join(
      os.homedir(),
      '.claude/skills',
      builtinName,
    );
    const codexBackendPath = path.join(
      os.homedir(),
      '.codex/skills',
      builtinName,
    );
    await fs.mkdir(path.dirname(backendPath), { recursive: true });
    await fs.rm(backendPath, { force: true, recursive: true });
    await fs.rm(claudeBackendPath, { force: true, recursive: true });
    await fs.symlink(foreignTarget, backendPath);

    try {
      await syncBuiltinSkillSymlinks();

      await expect(fs.realpath(backendPath)).resolves.toBe(foreignTarget);
    } finally {
      await fs.rm(builtinPath, { force: true, recursive: true });
      await fs.rm(foreignTarget, { force: true, recursive: true });
      await fs.rm(backendPath, { force: true });
      await fs.rm(claudeBackendPath, { force: true });
      await fs.rm(codexBackendPath, { force: true });
    }
  });

  it('does not overwrite a user skill symlink with the same name as a builtin skill', async () => {
    const skillName = 'shared-user-builtin-safety';
    const builtinPath = await writeSkill({
      projectPath: JC_BUILTIN_SKILLS_DIR,
      relativeDir: '',
      dirName: skillName,
      name: skillName,
    });
    const userSkillPath = await writeSkill({
      projectPath: path.join(os.homedir(), '.config/jean-claude/skills/user'),
      relativeDir: '',
      dirName: skillName,
      name: skillName,
    });
    const backendPath = path.join(
      os.homedir(),
      '.config/opencode/skills',
      skillName,
    );
    const claudeBackendPath = path.join(
      os.homedir(),
      '.claude/skills',
      skillName,
    );
    const codexBackendPath = path.join(
      os.homedir(),
      '.codex/skills',
      skillName,
    );
    await fs.mkdir(path.dirname(backendPath), { recursive: true });
    await fs.rm(backendPath, { force: true, recursive: true });
    await fs.rm(claudeBackendPath, { force: true, recursive: true });
    await fs.symlink(userSkillPath, backendPath);

    try {
      await syncBuiltinSkillSymlinks();

      await expect(fs.realpath(backendPath)).resolves.toBe(userSkillPath);
    } finally {
      await fs.rm(builtinPath, { force: true, recursive: true });
      await fs.rm(userSkillPath, { force: true, recursive: true });
      await fs.rm(backendPath, { force: true });
      await fs.rm(claudeBackendPath, { force: true });
      await fs.rm(codexBackendPath, { force: true });
    }
  });
});

describe('legacy skill migration', () => {
  it('previews companion files in migratable skill folders', async () => {
    const legacyDir = path.join(os.homedir(), '.claude/skills/rich-skill');
    await fs.mkdir(path.join(legacyDir, 'resources'), { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'SKILL.md'),
      '---\nname: rich-skill\ndescription: Rich skill\n---\n\nUse companions.\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(legacyDir, 'AGENTS.md'),
      'Extra instructions\n',
      'utf-8',
    );

    const preview = await previewLegacySkillMigration();
    const item = preview.items.find((entry) => entry.name === 'rich-skill');

    expect(item).toEqual(
      expect.objectContaining({
        legacyPath: legacyDir,
        status: 'migrate',
        folderEntries: expect.arrayContaining([
          { name: 'AGENTS.md', type: 'file' },
          { name: 'SKILL.md', type: 'file' },
          { name: 'resources', type: 'directory' },
        ]),
      }),
    );
  });

  it('copies companion files when executing migration', async () => {
    const legacyDir = path.join(os.homedir(), '.claude/skills/rich-skill');
    const canonicalDir = path.join(
      os.homedir(),
      '.config/jean-claude/skills/user/rich-skill',
    );
    await fs.mkdir(path.join(legacyDir, 'resources'), { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'SKILL.md'),
      '---\nname: rich-skill\ndescription: Rich skill\n---\n\nUse companions.\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(legacyDir, 'AGENTS.md'),
      'Extra instructions\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(legacyDir, 'resources/example.md'),
      'Example\n',
      'utf-8',
    );

    const preview = await previewLegacySkillMigration();
    const item = preview.items.find((entry) => entry.name === 'rich-skill');
    expect(item).toBeDefined();

    const result = await executeLegacySkillMigration({
      itemIds: [item!.id],
    });

    expect(result.results).toContainEqual(
      expect.objectContaining({ name: 'rich-skill', status: 'migrated' }),
    );
    await expect(
      fs.readFile(path.join(canonicalDir, 'AGENTS.md'), 'utf-8'),
    ).resolves.toBe('Extra instructions\n');
    await expect(
      fs.readFile(path.join(canonicalDir, 'resources/example.md'), 'utf-8'),
    ).resolves.toBe('Example\n');
  });
});
