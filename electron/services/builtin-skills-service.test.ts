import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { upsertBuiltinSkills } from './builtin-skills-service';

let testDir: string;

beforeEach(async () => {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-builtin-skills-'));
});

afterEach(async () => {
  if (testDir) {
    await fs.rm(testDir, { force: true, recursive: true });
  }
});

describe('builtin skills installation', () => {
  it('preserves existing builtin skill content when requested', async () => {
    const skillMdPath = path.join(testDir, 'task-name-generation', 'SKILL.md');
    await fs.mkdir(path.dirname(skillMdPath), { recursive: true });
    await fs.writeFile(skillMdPath, 'local dev edit', 'utf-8');

    await upsertBuiltinSkills({ preserveExisting: true, skillsDir: testDir });

    await expect(fs.readFile(skillMdPath, 'utf-8')).resolves.toBe(
      'local dev edit',
    );
    await expect(
      fs.readFile(
        path.join(testDir, 'project-feature-mapping', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toContain('name: project-feature-mapping');
    await expect(
      fs.readFile(
        path.join(testDir, 'user-preference-memory', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toContain('name: user-preference-memory');
  });

  it('overwrites existing builtin skill content by default', async () => {
    const skillMdPath = path.join(testDir, 'task-name-generation', 'SKILL.md');
    await fs.mkdir(path.dirname(skillMdPath), { recursive: true });
    await fs.writeFile(skillMdPath, 'stale content', 'utf-8');

    await upsertBuiltinSkills({ skillsDir: testDir });

    await expect(fs.readFile(skillMdPath, 'utf-8')).resolves.toContain(
      'name: task-name-generation',
    );
  });

  it('installs project feature mapping loop instructions', async () => {
    await upsertBuiltinSkills({ skillsDir: testDir });

    const content = await fs.readFile(
      path.join(testDir, 'project-feature-mapping', 'SKILL.md'),
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

  it('honors an explicitly supplied preference memory location', async () => {
    await upsertBuiltinSkills({ skillsDir: testDir });

    const content = await fs.readFile(
      path.join(testDir, 'user-preference-memory', 'SKILL.md'),
      'utf-8',
    );

    expect(content).toContain(
      'use that exact location and resolve its evidence and state files within that folder',
    );
  });

  it('installs the work item summary editorial skill', async () => {
    await upsertBuiltinSkills({ skillsDir: testDir });

    const content = await fs.readFile(
      path.join(testDir, 'work-item-summary', 'SKILL.md'),
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
});
