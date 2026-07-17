import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repositories = vi.hoisted(() => ({
  ProjectRepository: {
    delete: vi.fn(),
    findById: vi.fn(),
  },
  SettingsRepository: {
    get: vi.fn(),
  },
  TaskRepository: {
    findById: vi.fn(),
  },
}));

const aiGeneration = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

const storage = vi.hoisted(() => ({
  getProjectPreferenceMemoryDir: vi.fn(),
  removeProjectPreferenceMemory: vi.fn(),
  writeProjectPreferenceMemoryMetadata: vi.fn(),
}));

vi.mock('../database/repositories', () => repositories);
vi.mock('./ai-generation-service', () => aiGeneration);
vi.mock('./preference-memory-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./preference-memory-storage')>()),
  ...storage,
}));

import {
  consolidatePreferenceMemoryForProject,
  recordPreferenceEvidence,
} from './preference-memory-service';
import { deleteProjectWithPreferenceMemoryCleanup } from './project-deletion-service';

let testDir: string;

function getProjectMemoryDir(projectId = 'project-1'): string {
  return path.join(testDir, 'global-memory', 'projects', projectId);
}

beforeEach(async () => {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-preference-memory-'));
  repositories.ProjectRepository.findById.mockReset();
  repositories.ProjectRepository.findById.mockImplementation(
    async (projectId: string) => ({
      id: projectId,
      name: 'Jean-Claude',
      path: testDir,
    }),
  );
  repositories.ProjectRepository.delete.mockReset();
  repositories.SettingsRepository.get.mockReset();
  repositories.SettingsRepository.get.mockResolvedValue({
    enabled: true,
    consolidationEnabled: false,
    consolidationIntervalMinutes: 1440,
  });
  repositories.TaskRepository.findById.mockReset();
  aiGeneration.generateText.mockReset();
  storage.getProjectPreferenceMemoryDir.mockReset();
  storage.getProjectPreferenceMemoryDir.mockImplementation(
    (projectId: string) => getProjectMemoryDir(projectId),
  );
  storage.removeProjectPreferenceMemory.mockReset();
  storage.removeProjectPreferenceMemory.mockImplementation(
    async ({ projectId }: { projectId: string }) => {
      await fs.rm(getProjectMemoryDir(projectId), {
        force: true,
        recursive: true,
      });
    },
  );
  storage.writeProjectPreferenceMemoryMetadata.mockReset();
  storage.writeProjectPreferenceMemoryMetadata.mockImplementation(
    async ({
      projectId,
      name,
      sourcePath,
      projectMemoryDir,
    }: {
      projectId: string;
      name: string;
      sourcePath: string;
      projectMemoryDir: string;
    }) => {
      await fs.mkdir(projectMemoryDir, { recursive: true });
      await fs.writeFile(
        path.join(projectMemoryDir, 'project.json'),
        `${JSON.stringify({ id: projectId, name, sourcePath }, null, 2)}\n`,
        'utf-8',
      );
    },
  );
});

afterEach(async () => {
  await fs.rm(testDir, { force: true, recursive: true });
});

describe('recordPreferenceEvidence', () => {
  it('does not write evidence when preference memory is disabled', async () => {
    repositories.SettingsRepository.get.mockResolvedValue({ enabled: false });

    const result = await recordPreferenceEvidence({
      source: 'task-review-comment',
      taskId: 'task-1',
      comments: [{ body: 'Prefer smaller diff here.' }],
    });

    expect(result).toEqual({ path: '', recorded: 0 });
    expect(repositories.TaskRepository.findById).not.toHaveBeenCalled();
  });

  it('resolves project from task and appends comment evidence', async () => {
    repositories.TaskRepository.findById.mockResolvedValue({
      id: 'task-1',
      projectId: 'project-1',
      name: 'Fix stale UI',
      prompt: 'Please fix stale UI state.',
      worktreePath: testDir,
      branchName: 'task/fix-stale-ui',
      sourceBranch: 'main',
    });
    repositories.ProjectRepository.findById.mockResolvedValue({
      id: 'project-1',
      name: 'Jean-Claude',
      path: testDir,
    });
    const fileContent = Array.from(
      { length: 201 },
      (_, index) => `line-${index + 1}`,
    ).join('\n');
    const expectedExcerpt = Array.from(
      { length: 161 },
      (_, index) => `line-${index + 21}`,
    ).join('\n');
    await fs.mkdir(path.join(testDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(testDir, 'src/app.ts'), fileContent, 'utf-8');

    const result = await recordPreferenceEvidence({
      source: 'task-review-comment',
      taskId: 'task-1',
      comments: [
        {
          body: 'Prefer smaller diff here.',
          filePath: 'src/app.ts',
          lineStart: 101,
          presets: ['simplify'],
          selectedText: 'line-101',
        },
      ],
      context: { targetStepId: 'step-1', ignored: undefined },
    });

    expect(result.recorded).toBe(1);
    expect(result.path).toBe(
      path.join(
        getProjectMemoryDir(),
        'user-reviews',
        `${new Date().toISOString().slice(0, 10)}.jsonl`,
      ),
    );
    expect(storage.writeProjectPreferenceMemoryMetadata).toHaveBeenCalledWith({
      projectId: 'project-1',
      name: 'Jean-Claude',
      sourcePath: testDir,
      projectMemoryDir: getProjectMemoryDir(),
    });
    await expect(
      fs.readFile(path.join(getProjectMemoryDir(), 'project.json'), 'utf-8'),
    ).resolves.toContain(`"sourcePath": "${testDir}"`);

    const raw = await fs.readFile(result.path, 'utf-8');
    const records = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'task-review-comment',
      taskId: 'task-1',
      projectId: 'project-1',
      comment: {
        body: 'Prefer smaller diff here.',
        filePath: 'src/app.ts',
        lineStart: 101,
        presets: ['simplify'],
        selectedText: 'line-101',
      },
      fileSnapshot: {
        filePath: 'src/app.ts',
        content: expectedExcerpt,
        startLine: 21,
        endLine: 181,
        totalLines: 201,
        truncated: true,
        bytes: expect.any(Number),
      },
      metadata: {
        projectName: 'Jean-Claude',
        projectPath: testDir,
        taskName: 'Fix stale UI',
        taskPrompt: 'Please fix stale UI state.',
        worktreePath: testDir,
        branchName: 'task/fix-stale-ui',
        sourceBranch: 'main',
      },
      context: { targetStepId: 'step-1' },
    });
    expect(records[0].id).toEqual(expect.any(String));
    expect(records[0].createdAt).toEqual(expect.any(String));
  });

  it('waits for project metadata before appending evidence', async () => {
    repositories.ProjectRepository.findById.mockResolvedValue({
      id: 'project-1',
      name: 'Jean-Claude',
      path: testDir,
    });
    let finishMetadataWrite: () => void = () => undefined;
    const metadataWrite = new Promise<void>((resolve) => {
      finishMetadataWrite = resolve;
    });
    storage.writeProjectPreferenceMemoryMetadata.mockReturnValueOnce(
      metadataWrite,
    );
    await fs.mkdir(getProjectMemoryDir(), { recursive: true });
    const appendFile = vi.spyOn(fs, 'appendFile');

    try {
      const recordResult = recordPreferenceEvidence({
        source: 'task-review-comment',
        projectId: 'project-1',
        comments: [{ body: 'Prefer focused tests.' }],
      });

      await vi.waitFor(() => {
        expect(
          storage.writeProjectPreferenceMemoryMetadata,
        ).toHaveBeenCalledOnce();
      });
      expect(appendFile).not.toHaveBeenCalled();

      finishMetadataWrite();
      await expect(recordResult).resolves.toMatchObject({ recorded: 1 });
      expect(appendFile).toHaveBeenCalledOnce();
    } finally {
      appendFile.mockRestore();
    }
  });

  it('rejects nested symlinks before capturing evidence', async () => {
    const outsidePath = path.join(testDir, 'outside-reviews');
    await fs.mkdir(getProjectMemoryDir(), { recursive: true });
    await fs.mkdir(outsidePath);
    await fs.symlink(outsidePath, path.join(getProjectMemoryDir(), 'user-reviews'));

    await expect(
      recordPreferenceEvidence({
        source: 'task-review-comment',
        projectId: 'project-1',
        comments: [{ body: 'Do not redirect this.' }],
      }),
    ).rejects.toThrow('Unsafe symlink in project memory');
    await expect(fs.readdir(outsidePath)).resolves.toEqual([]);
  });

  it('does not recreate memory when stale capture follows deletion', async () => {
    let projectExists = true;
    repositories.ProjectRepository.findById.mockImplementation(
      async (projectId: string) =>
        projectExists
          ? { id: projectId, name: 'Jean-Claude', path: testDir }
          : undefined,
    );
    const deletionResult = [{ numDeletedRows: 1n }];
    repositories.ProjectRepository.delete.mockImplementation(async () => {
      projectExists = false;
      return deletionResult;
    });
    let finishMetadataWrite: () => void = () => undefined;
    const metadataWrite = new Promise<void>((resolve) => {
      finishMetadataWrite = resolve;
    });
    storage.writeProjectPreferenceMemoryMetadata.mockReturnValueOnce(
      metadataWrite,
    );
    await fs.mkdir(getProjectMemoryDir(), { recursive: true });

    const firstCapture = recordPreferenceEvidence({
      source: 'task-review-comment',
      projectId: 'project-1',
      comments: [{ body: 'First capture.' }],
    });
    await vi.waitFor(() => {
      expect(storage.writeProjectPreferenceMemoryMetadata).toHaveBeenCalledOnce();
    });

    const deletion = deleteProjectWithPreferenceMemoryCleanup('project-1');
    const staleCapture = recordPreferenceEvidence({
      source: 'task-review-comment',
      projectId: 'project-1',
      comments: [{ body: 'Stale capture.' }],
    });
    expect(repositories.ProjectRepository.delete).not.toHaveBeenCalled();

    finishMetadataWrite();
    await expect(firstCapture).resolves.toMatchObject({ recorded: 1 });
    await expect(deletion).resolves.toBe(deletionResult);
    await expect(staleCapture).resolves.toEqual({ path: '', recorded: 0 });
    await expect(fs.stat(getProjectMemoryDir())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(storage.writeProjectPreferenceMemoryMetadata).toHaveBeenCalledOnce();

    projectExists = true;
    await expect(
      recordPreferenceEvidence({
        source: 'task-review-comment',
        projectId: 'project-1',
        comments: [{ body: 'Capture after re-add.' }],
      }),
    ).resolves.toMatchObject({ recorded: 1 });
    await expect(fs.stat(getProjectMemoryDir())).resolves.toBeDefined();
    expect(storage.writeProjectPreferenceMemoryMetadata).toHaveBeenCalledTimes(2);
  });

  it('consolidates unprocessed daily evidence and records byte offsets', async () => {
    aiGeneration.generateText.mockImplementationOnce(async () => {
      const memoryDir = getProjectMemoryDir();
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(
        path.join(memoryDir, 'user-preferences.md'),
        '# User Preferences\n\n- Prefer minimal targeted diffs.\n',
        'utf-8',
      );
      return 'updated';
    });
    const reviewsDir = path.join(getProjectMemoryDir(), 'user-reviews');
    const evidencePath = path.join(reviewsDir, '2026-06-15.jsonl');
    const firstLine = `${JSON.stringify({ comment: { body: 'Prefer direct state selectors.' } })}\n`;
    const secondLine = `${JSON.stringify({ comment: { body: 'Avoid broad refactors.' } })}\n`;
    await fs.mkdir(reviewsDir, { recursive: true });
    await fs.writeFile(evidencePath, firstLine + secondLine, 'utf-8');
    await fs.writeFile(
      path.join(getProjectMemoryDir(), 'user-reviews-state.json'),
      JSON.stringify({
        files: {
          '2026-06-15.jsonl': { offset: Buffer.byteLength(firstLine) },
        },
      }),
      'utf-8',
    );

    const result = await consolidatePreferenceMemoryForProject({
      id: 'project-1',
      name: 'Jean-Claude',
      path: testDir,
    });

    expect(result).toEqual({ processed: true });
    expect(aiGeneration.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'claude-code',
        model: 'haiku',
        thinkingEffort: 'default',
        skillName: 'user-preference-memory',
        cwd: getProjectMemoryDir(),
        allowedTools: ['Read', 'Write', 'Edit'],
        allowedToolPatterns: {
          Read: [`${getProjectMemoryDir()}/user-preferences.md`],
          Write: [`${getProjectMemoryDir()}/user-preferences.md`],
          Edit: [`${getProjectMemoryDir()}/user-preferences.md`],
        },
        allowRateLimitSwap: false,
        prompt: expect.stringContaining('Avoid broad refactors.'),
      }),
    );
    expect(aiGeneration.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining('Prefer direct state selectors.'),
      }),
    );
    expect(aiGeneration.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          `Global project memory folder: ${getProjectMemoryDir()}`,
        ),
      }),
    );

    const state = JSON.parse(
      await fs.readFile(
        path.join(getProjectMemoryDir(), 'user-reviews-state.json'),
        'utf-8',
      ),
    );
    expect(state.files['2026-06-15.jsonl'].offset).toBe(
      Buffer.byteLength(firstLine + secondLine),
    );
    expect(state.lastConsolidatedAt).toEqual(expect.any(String));

    const historyDir = path.join(
      getProjectMemoryDir(),
      'user-preferences-history',
    );
    const historyFiles = await fs.readdir(historyDir);
    expect(historyFiles).toHaveLength(1);
    const history = JSON.parse(
      await fs.readFile(path.join(historyDir, historyFiles[0]), 'utf-8'),
    );
    expect(history).toMatchObject({
      id: expect.any(String),
      createdAt: state.lastConsolidatedAt,
      projectId: 'project-1',
      projectName: 'Jean-Claude',
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
      evidence: {
        files: [
          {
            fileName: '2026-06-15.jsonl',
            fromOffset: Buffer.byteLength(firstLine),
            toOffset: Buffer.byteLength(firstLine + secondLine),
            recordCount: 1,
          },
        ],
      },
      document: {
        path: 'user-preferences.md',
        sha256: expect.any(String),
        content: '# User Preferences\n\n- Prefer minimal targeted diffs.\n',
      },
    });
  });

  it('does not advance offsets when consolidation does not write preferences', async () => {
    aiGeneration.generateText.mockResolvedValue('no file written');
    const reviewsDir = path.join(getProjectMemoryDir(), 'user-reviews');
    const evidencePath = path.join(reviewsDir, '2026-06-15.jsonl');
    const evidenceLine = `${JSON.stringify({ comment: { body: 'Prefer direct state selectors.' } })}\n`;
    await fs.mkdir(reviewsDir, { recursive: true });
    await fs.writeFile(evidencePath, evidenceLine, 'utf-8');

    const result = await consolidatePreferenceMemoryForProject({
      id: 'project-1',
      name: 'Jean-Claude',
      path: testDir,
    });

    expect(result).toEqual({ processed: false });
    await expect(
      fs.readFile(
        path.join(getProjectMemoryDir(), 'user-reviews-state.json'),
        'utf-8',
      ),
    ).rejects.toThrow();
    await expect(
      fs.readdir(
        path.join(getProjectMemoryDir(), 'user-preferences-history'),
      ),
    ).rejects.toThrow();
  });

  it('refreshes project metadata even when no evidence is pending', async () => {
    repositories.ProjectRepository.findById.mockResolvedValue({
      id: 'project-1',
      name: 'Renamed Project',
      path: '/updated/source/path',
    });
    const result = await consolidatePreferenceMemoryForProject({
      id: 'project-1',
      name: 'Renamed Project',
      path: '/updated/source/path',
    });

    expect(result).toEqual({ processed: false });
    expect(storage.writeProjectPreferenceMemoryMetadata).toHaveBeenCalledWith({
      projectId: 'project-1',
      name: 'Renamed Project',
      sourcePath: '/updated/source/path',
      projectMemoryDir: getProjectMemoryDir(),
    });
    expect(aiGeneration.generateText).not.toHaveBeenCalled();
  });

  it('passes configured backend model and thinking to consolidation generation', async () => {
    aiGeneration.generateText.mockImplementationOnce(async () => {
      const memoryDir = getProjectMemoryDir();
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(
        path.join(memoryDir, 'user-preferences.md'),
        '# User Preferences\n',
        'utf-8',
      );
      return 'updated';
    });
    const reviewsDir = path.join(getProjectMemoryDir(), 'user-reviews');
    await fs.mkdir(reviewsDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewsDir, '2026-06-15.jsonl'),
      `${JSON.stringify({ comment: { body: 'Prefer small diffs.' } })}\n`,
      'utf-8',
    );

    await consolidatePreferenceMemoryForProject(
      { id: 'project-1', name: 'Jean-Claude', path: testDir },
      {
        backend: 'opencode',
        model: 'anthropic/claude-sonnet-4-5',
        thinkingEffort: 'medium',
      },
    );

    expect(aiGeneration.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'opencode',
        model: 'anthropic/claude-sonnet-4-5',
        thinkingEffort: 'medium',
        allowedTools: ['Read', 'Write', 'Edit'],
        allowedToolPatterns: {
          Read: [`${getProjectMemoryDir()}/user-preferences.md`],
          Write: [`${getProjectMemoryDir()}/user-preferences.md`],
          Edit: [`${getProjectMemoryDir()}/user-preferences.md`],
        },
        allowRateLimitSwap: false,
      }),
    );
  });
});
