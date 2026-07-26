import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  AGENT_MEMORY_MAX_CANONICAL_INPUT_BYTES,
  AGENT_MEMORY_MAX_LEGACY_PROFILE_BYTES,
  type AgentMemoryDashboard,
  type AgentMemoryExtractionRun,
  agentMemoryExtractionRunSchema,
  agentMemoryExtractionStateSchema,
  type AgentMemoryItem,
  agentMemoryItemSchema,
  type AgentMemoryPage,
} from '@shared/agent-memory-types';
import type { AgentMemorySetting, Project } from '@shared/types';

import {
  assertSafeAgentMemoryPath,
  getAgentMemoryGlobalPaths,
  getAgentMemoryProjectPaths,
  readAgentMemoryEventPage,
  readAgentMemoryJson,
  readAgentMemoryRunIndex,
} from './agent-memory-storage';
import {
  boundCanonicalAgentMemoryItems,
  extractProjectMemory,
  mergeGlobalMemory,
} from './agent-memory-extraction-service';

type ProjectIdentity = Pick<Project, 'id' | 'name'> & Partial<Pick<Project, 'path'>>;
type ExtractionResult = Promise<{
  processed: boolean;
  run: AgentMemoryExtractionRun | null;
}>;

type DashboardDependencies = {
  homeDirectory?: string;
  readFile?: (
    filePath: Parameters<typeof fs.readFile>[0],
    encoding: 'utf8',
  ) => Promise<string | Buffer>;
  getSetting?: () => Promise<AgentMemorySetting>;
  findProjectById?: (id: string) => Promise<ProjectIdentity | undefined>;
  findProjects?: () => Promise<ProjectIdentity[]>;
  extractProjectMemory?: (params: {
    project: ProjectIdentity;
    recheckProjectExists?: () => Promise<boolean>;
    config: {
      backend: AgentMemorySetting['extractionBackend'];
      model: string;
      thinkingEffort?: AgentMemorySetting['extractionThinkingEffort'];
      trigger: 'manual';
    };
  }) => ExtractionResult;
  mergeGlobalMemory?: (params: {
    projectIds: readonly string[];
    config: {
      backend: AgentMemorySetting['extractionBackend'];
      model: string;
      thinkingEffort?: AgentMemorySetting['extractionThinkingEffort'];
      trigger: 'manual';
    };
  }) => ExtractionResult;
};

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function normalizedPage(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizedPageSize(value: number): number {
  return Number.isFinite(value)
    ? Math.min(100, Math.max(1, Math.floor(value)))
    : 20;
}

function groupItems(items: AgentMemoryItem[]): AgentMemoryDashboard['globalProfile'] {
  const groups = new Map<AgentMemoryItem['category'], AgentMemoryItem[]>();
  for (const item of items) {
    const group = groups.get(item.category) ?? [];
    group.push(item);
    groups.set(item.category, group);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, groupedItems]) => ({
      category,
      items: groupedItems.sort((left, right) =>
        left.statement.localeCompare(right.statement),
      ),
    }));
}

function candidate(item: AgentMemoryItem): AgentMemoryDashboard['candidates'][number] {
  const blockers: AgentMemoryDashboard['candidates'][number]['blockers'] = [];
  if (item.scope !== 'global' && item.taskCount < 2) {
    blockers.push({ kind: 'task-count', current: item.taskCount, required: 2 });
  }
  if (item.projectCount < 2) {
    blockers.push({
      kind: 'project-count',
      current: item.projectCount,
      required: 2,
    });
  }
  return { item, blockers };
}

function parseItems(value: unknown): AgentMemoryItem[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) {
    throw new Error('Invalid Agent Memory item store');
  }
  return boundCanonicalAgentMemoryItems(
    (value as { items: unknown[] }).items.map((item) =>
      agentMemoryItemSchema.parse(item),
    ),
  );
}

function parseRun(value: unknown): AgentMemoryExtractionRun {
  if (!value || typeof value !== 'object' || !('run' in value)) {
    throw new Error('Invalid Agent Memory extraction run');
  }
  return agentMemoryExtractionRunSchema.parse((value as { run: unknown }).run);
}

function runRecordsDirectory(runsDirectory: string): string {
  return path.join(runsDirectory, 'records');
}

export function createAgentMemoryDashboardService({
  homeDirectory = os.homedir(),
  readFile,
  getSetting = async () =>
    (await import('../database/repositories/settings')).SettingsRepository.get(
      'agentMemory',
    ),
  findProjectById = async (id) =>
    (await import('../database/repositories/projects')).ProjectRepository.findById(
      id,
    ),
  findProjects = async () =>
    (await import('../database/repositories/projects')).ProjectRepository.findAll(),
  extractProjectMemory: extractProject = extractProjectMemory,
  mergeGlobalMemory: mergeGlobal = mergeGlobalMemory,
}: DashboardDependencies = {}) {
  async function readJson(filePath: string): Promise<unknown | null> {
    try {
      if (!readFile) return readAgentMemoryJson({ homeDirectory, filePath });
      await assertSafeAgentMemoryPath({
        homeDirectory,
        targetPath: filePath,
        type: 'file',
      });
      return JSON.parse(String(await readFile(filePath, 'utf8'))) as unknown;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async function readStoredItems(
    filePath: string,
    allowLegacyProfile = false,
  ): Promise<{ items: AgentMemoryItem[]; repairNeeded: boolean }> {
    let repairNeeded = false;
    try {
      const stat = await fs.stat(filePath);
      repairNeeded = stat.size > AGENT_MEMORY_MAX_CANONICAL_INPUT_BYTES;
      const maxBytes = allowLegacyProfile
        ? AGENT_MEMORY_MAX_LEGACY_PROFILE_BYTES
        : AGENT_MEMORY_MAX_CANONICAL_INPUT_BYTES;
      if (stat.size > maxBytes) {
        throw new Error('Agent Memory canonical input exceeds size limit');
      }
    } catch (error) {
      if (isMissingFile(error)) return { items: [], repairNeeded: false };
      throw error;
    }
    const value = await readJson(filePath);
    return {
      items: value === null ? [] : parseItems(value),
      repairNeeded,
    };
  }

  async function readRunPage({
    projectId,
    page,
    pageSize,
  }: {
    projectId?: string;
    page: number;
    pageSize: number;
  }): Promise<AgentMemoryPage<AgentMemoryExtractionRun>> {
    const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
    const globalEntries = await readAgentMemoryRunIndex({
      scope: 'global',
      homeDirectory,
    });
    const projectPaths = projectId
      ? getAgentMemoryProjectPaths(projectId, homeDirectory)
      : null;
    const projectEntries = projectId
      ? await readAgentMemoryRunIndex({
          scope: 'project',
          projectId,
          homeDirectory,
        })
      : [];
    const entries = [
      ...globalEntries.map((entry) => ({
        ...entry,
        filePath: path.join(
          runRecordsDirectory(globalPaths.runsDirectory),
          entry.fileName,
        ),
      })),
      ...projectEntries.map((entry) => ({
        ...entry,
        filePath: path.join(
          runRecordsDirectory(projectPaths!.runsDirectory),
          entry.fileName,
        ),
      })),
    ]
      .sort(
        (left, right) =>
          right.startedAt.localeCompare(left.startedAt) ||
          right.id.localeCompare(left.id),
      );
    const selected = entries.slice(page * pageSize, (page + 1) * pageSize);
    const items = await Promise.all(
      selected.map(async ({ filePath }) => parseRun(await readJson(filePath))),
    );
    return { items, page, pageSize, total: entries.length };
  }

  function extractionConfig(setting: AgentMemorySetting) {
    return {
      backend: setting.extractionBackend,
      model: setting.extractionModel,
      thinkingEffort: setting.extractionThinkingEffort,
      trigger: 'manual' as const,
    };
  }

  async function requireEnabledSetting(): Promise<AgentMemorySetting> {
    const setting = await getSetting();
    if (!setting.enabled) throw new Error('Agent Memory is disabled');
    return setting;
  }

  return {
    async getDashboard({
      projectId,
      evidencePage = 0,
      extractionRunPage = 0,
      pageSize = 20,
    }: {
      projectId?: string;
      evidencePage?: number;
      extractionRunPage?: number;
      pageSize?: number;
    } = {}): Promise<AgentMemoryDashboard> {
      const safeEvidencePage = normalizedPage(evidencePage);
      const safeRunPage = normalizedPage(extractionRunPage);
      const safePageSize = normalizedPageSize(pageSize);
      const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
      const projectPaths = projectId
        ? getAgentMemoryProjectPaths(projectId, homeDirectory)
        : null;
      const [setting, globalStore, projectStore, evidence, extractionRuns, state] =
        await Promise.all([
          getSetting(),
          readStoredItems(globalPaths.profileJson, true),
          projectPaths
            ? readStoredItems(projectPaths.itemsJson)
            : { items: [], repairNeeded: false },
          projectId
            ? readAgentMemoryEventPage({
                projectId,
                homeDirectory,
                page: safeEvidencePage,
                pageSize: safePageSize,
                validateCanonicalFiles: false,
              })
            : {
                items: [],
                page: safeEvidencePage,
                pageSize: safePageSize,
                total: 0,
              },
          readRunPage({
            projectId,
            page: safeRunPage,
            pageSize: safePageSize,
          }),
          projectPaths
            ? readJson(projectPaths.extractionStateJson).then((value) =>
                value === null ? null : agentMemoryExtractionStateSchema.parse(value),
              )
            : null,
        ]);
      const globalItems = globalStore.items;
      const projectItems = projectStore.items;
      const activeGlobal = globalItems.filter(
        (item) => item.status === 'confirmed' && item.scope === 'global',
      );
      const activeProject = projectItems.filter(
        (item) => item.status === 'confirmed' && item.scope === 'project',
      );
      const candidates = [...globalItems, ...projectItems]
        .filter((item) => item.status === 'candidate')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(candidate);
      return {
        enabled: setting.enabled,
        repairNotice: globalStore.repairNeeded
          ? 'Global Agent Memory profile needs repair and will be compacted during the next merge.'
          : null,
        globalProfile: groupItems(activeGlobal),
        projectMemory: groupItems(activeProject),
        candidates,
        evidence,
        extractionRuns,
        extractionState: state,
      };
    },

    async extractNow(projectId: string) {
      await requireEnabledSetting();
      const project = await findProjectById(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const extractionSetting = await requireEnabledSetting();
      const result = await extractProject({
        project,
        recheckProjectExists: async () => Boolean(await findProjectById(projectId)),
        config: extractionConfig(extractionSetting),
      });
      const projects = await findProjects();
      const mergeSetting = await requireEnabledSetting();
      await mergeGlobal({
        projectIds: projects.map(({ id }) => id),
        config: extractionConfig(mergeSetting),
      });
      return result;
    },

    async retryRun({
      projectId,
      runId,
      scope,
    }: {
      projectId?: string;
      runId: string;
      scope: 'project' | 'global';
    }) {
      await requireEnabledSetting();
      if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
        throw new Error('Invalid Agent Memory run ID');
      }
      await readAgentMemoryRunIndex({ scope, projectId, homeDirectory });
      const runPath =
        scope === 'global'
          ? path.join(
              runRecordsDirectory(
                getAgentMemoryGlobalPaths(homeDirectory).runsDirectory,
              ),
              `${runId}.json`,
            )
          : projectId
            ? path.join(
                runRecordsDirectory(
                  getAgentMemoryProjectPaths(projectId, homeDirectory)
                    .runsDirectory,
                ),
                `${runId}.json`,
              )
            : null;
      if (!runPath) throw new Error('Project run requires project ID');
      const run = parseRun(await readJson(runPath));
      if (run.id !== runId || run.scope !== scope || run.status !== 'failed') {
        throw new Error('Only failed Agent Memory runs can be retried');
      }
      if (scope === 'global') {
        const projects = await findProjects();
        const setting = await requireEnabledSetting();
        return mergeGlobal({
          projectIds: projects.map(({ id }) => id),
          config: extractionConfig(setting),
        });
      }
      const project = await findProjectById(projectId!);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const setting = await requireEnabledSetting();
      return extractProject({
        project,
        recheckProjectExists: async () => Boolean(await findProjectById(projectId!)),
        config: extractionConfig(setting),
      });
    },
  };
}

export const agentMemoryDashboardService = createAgentMemoryDashboardService();
