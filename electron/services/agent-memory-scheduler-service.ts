import type { AgentMemorySetting, Project } from '@shared/types';
import type { AgentMemoryExtractionRun } from '@shared/agent-memory-types';

import {
  extractProjectMemory,
  mergeGlobalMemory,
} from './agent-memory-extraction-service';
import {
  readAgentMemoryRunTiming,
  recordAgentMemoryRunTiming,
} from './agent-memory-storage';
import { createDebug } from '../lib/debug';

const debug = createDebug('jc:agent-memory-scheduler');

type ProjectIdentity = Pick<Project, 'id' | 'name' | 'path'>;
type ExtractionResult = Promise<{
  processed: boolean;
  run: AgentMemoryExtractionRun | null;
}>;

export type AgentMemorySchedulerFailure =
  | {
      scope: 'project';
      projectId: string;
      phase: 'lookup' | 'extraction';
      error: unknown;
    }
  | { scope: 'global'; phase: 'merge'; error: unknown };

type SchedulerDependencies = {
  now?: () => Date;
  getSetting?: () => Promise<AgentMemorySetting>;
  findProjects?: () => Promise<ProjectIdentity[]>;
  findProjectById?: (id: string) => Promise<ProjectIdentity | undefined>;
  extractProjectMemory?: (params: {
    project: ProjectIdentity;
    recheckProjectExists?: () => Promise<boolean>;
    signal?: AbortSignal;
    config: {
      backend: AgentMemorySetting['extractionBackend'];
      model: string;
      thinkingEffort?: AgentMemorySetting['extractionThinkingEffort'];
      trigger: 'backlog' | 'scheduled';
    };
  }) => ExtractionResult;
  mergeGlobalMemory?: (params: {
    projectIds: readonly string[];
    signal?: AbortSignal;
    config: {
      backend: AgentMemorySetting['extractionBackend'];
      model: string;
      thinkingEffort?: AgentMemorySetting['extractionThinkingEffort'];
      trigger: 'backlog' | 'scheduled';
    };
  }) => ExtractionResult;
  readRunTiming?: (params: {
    scope: 'project' | 'global';
    projectId?: string;
  }) => Promise<{ lastAttemptAt: string | null; lastSuccessAt: string | null }>;
  recordRunTiming?: (params: {
    scope: 'project' | 'global';
    projectId?: string;
    attemptedAt: string;
    succeeded: boolean;
  }) => Promise<void>;
  logFailure?: (failure: AgentMemorySchedulerFailure) => void;
  logSweepFailure?: (error: unknown) => void;
  setInterval?: (
    callback: (_: void) => void,
    delay?: number,
  ) => ReturnType<typeof globalThis.setInterval>;
  clearInterval?: (
    timer: ReturnType<typeof globalThis.setInterval>,
  ) => void;
};

function calendarDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-');
}

function isDue({
  timing,
  timestamp,
  date,
  intervalMs,
}: {
  timing: { lastAttemptAt: number | null; lastSuccessAt: number | null };
  timestamp: number;
  date: string;
  intervalMs: number;
}): boolean {
  const latestAttempt = timing.lastAttemptAt ?? timing.lastSuccessAt;
  if (
    latestAttempt === null ||
    calendarDate(new Date(latestAttempt)) !== date
  ) {
    return true;
  }
  if (
    timing.lastAttemptAt !== null &&
    timestamp - timing.lastAttemptAt < intervalMs
  ) {
    return false;
  }
  return (
    timing.lastSuccessAt === null ||
    timestamp - timing.lastSuccessAt >= intervalMs
  );
}

function parsedTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function createAgentMemorySchedulerService({
  now = () => new Date(),
  getSetting = async () =>
    (await import('../database/repositories/settings')).SettingsRepository.get(
      'agentMemory',
    ),
  findProjects = async () =>
    (await import('../database/repositories/projects')).ProjectRepository.findAll(),
  findProjectById = async (id) =>
    (await import('../database/repositories/projects')).ProjectRepository.findById(
      id,
    ),
  extractProjectMemory: extractProject = extractProjectMemory,
  mergeGlobalMemory: mergeGlobal = mergeGlobalMemory,
  readRunTiming = readAgentMemoryRunTiming,
  recordRunTiming = recordAgentMemoryRunTiming,
  logFailure = (failure) =>
    debug('Agent Memory operation failed: %O', failure),
  logSweepFailure = (error) =>
    debug('Agent Memory scheduled sweep failed: %O', error),
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
}: SchedulerDependencies = {}) {
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let currentAbortController: AbortController | null = null;
  const projectTiming = new Map<
    string,
    { lastAttemptAt: number | null; lastSuccessAt: number | null }
  >();
  let globalTiming:
    | { lastAttemptAt: number | null; lastSuccessAt: number | null }
    | undefined;

  async function loadTiming(
    scope: 'project' | 'global',
    projectId?: string,
  ) {
    const persisted = await readRunTiming({ scope, projectId });
    return {
      lastAttemptAt: parsedTimestamp(persisted.lastAttemptAt),
      lastSuccessAt: parsedTimestamp(persisted.lastSuccessAt),
    };
  }

  async function sweep(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const setting = await getSetting();
    if (!setting.enabled) return;
    signal.throwIfAborted();
    const sweepTime = now();
    const timestamp = sweepTime.getTime();
    const date = calendarDate(sweepTime);
    const intervalMs = setting.extractionIntervalMinutes * 60_000;
    const projects = await findProjects();
    const lookupResults = await Promise.allSettled(
      projects.map(async ({ id }) => ({ id, project: await findProjectById(id) })),
    );
    const failures: AgentMemorySchedulerFailure[] = [];
    const currentProjects: ProjectIdentity[] = [];
    lookupResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value.project) currentProjects.push(result.value.project);
        return;
      }
      failures.push({
        scope: 'project',
        projectId: projects[index].id,
        phase: 'lookup',
        error: result.reason,
      });
    });

    await Promise.all(
      currentProjects.map(async (project) => {
        if (!projectTiming.has(project.id)) {
          projectTiming.set(
            project.id,
            await loadTiming('project', project.id),
          );
        }
      }),
    );

    const dueProjects = currentProjects.filter((project) =>
      isDue({
        timing: projectTiming.get(project.id)!,
        timestamp,
        date,
        intervalMs,
      }),
    );
    const projectResults = await Promise.allSettled(
      dueProjects.map((project) =>
        extractProject({
          project,
          signal,
          recheckProjectExists: async () =>
            Boolean(await findProjectById(project.id)),
          config: {
            backend: setting.extractionBackend,
            model: setting.extractionModel,
            thinkingEffort: setting.extractionThinkingEffort,
            trigger:
              projectTiming.get(project.id)!.lastSuccessAt !== null &&
              calendarDate(
                new Date(projectTiming.get(project.id)!.lastSuccessAt!),
              ) === date
                ? 'scheduled'
                : 'backlog',
          },
        }),
      ),
    );
    signal.throwIfAborted();
    for (const project of dueProjects) {
      projectTiming.get(project.id)!.lastAttemptAt = timestamp;
    }
    for (const [index, result] of projectResults.entries()) {
      const project = dueProjects[index];
      if (result.status === 'fulfilled') {
        projectTiming.get(project.id)!.lastSuccessAt = timestamp;
        if (result.value.run === null) {
          try {
            await recordRunTiming({
              scope: 'project',
              projectId: project.id,
              attemptedAt: sweepTime.toISOString(),
              succeeded: true,
            });
          } catch (error) {
            failures.push({
              scope: 'project',
              projectId: project.id,
              phase: 'extraction',
              error,
            });
          }
        }
      } else {
        failures.push({
          scope: 'project',
          projectId: project.id,
          phase: 'extraction',
          error: result.reason,
        });
        // Persist the attempt even though it failed. Otherwise `lastAttemptAt`
        // never reaches disk for a failing project and every app restart makes
        // it immediately due again, retrying without any backoff.
        try {
          await recordRunTiming({
            scope: 'project',
            projectId: project.id,
            attemptedAt: sweepTime.toISOString(),
            succeeded: false,
          });
        } catch {
          // The extraction failure above is the meaningful one to report.
        }
      }
    }

    globalTiming ??= await loadTiming('global');
    const globalDue = isDue({
      timing: globalTiming,
      timestamp,
      date,
      intervalMs,
    });
    if (globalDue) {
      signal.throwIfAborted();
      const globalProjectLookups = await Promise.allSettled(
        currentProjects.map(({ id }) => findProjectById(id)),
      );
      const globalProjectIds = globalProjectLookups.flatMap((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value ? [result.value.id] : [];
        }
        failures.push({
          scope: 'project',
          projectId: currentProjects[index].id,
          phase: 'lookup',
          error: result.reason,
        });
        return [];
      });
      const [globalResult] = await Promise.allSettled([
        mergeGlobal({
          projectIds: globalProjectIds,
          signal,
          config: {
            backend: setting.extractionBackend,
            model: setting.extractionModel,
            thinkingEffort: setting.extractionThinkingEffort,
            trigger:
              globalTiming.lastSuccessAt !== null &&
              calendarDate(new Date(globalTiming.lastSuccessAt)) === date
                ? 'scheduled'
                : 'backlog',
          },
        }),
      ]);
      signal.throwIfAborted();
      globalTiming.lastAttemptAt = timestamp;
      if (globalResult.status === 'fulfilled') {
        globalTiming.lastSuccessAt = timestamp;
        if (globalResult.value.run === null) {
          try {
            await recordRunTiming({
              scope: 'global',
              attemptedAt: sweepTime.toISOString(),
              succeeded: true,
            });
          } catch (error) {
            failures.push({ scope: 'global', phase: 'merge', error });
          }
        }
      } else {
        failures.push({
          scope: 'global',
          phase: 'merge',
          error: globalResult.reason,
        });
        // See the project branch: record the failed attempt so a restart does
        // not make the global merge immediately due again.
        try {
          await recordRunTiming({
            scope: 'global',
            attemptedAt: sweepTime.toISOString(),
            succeeded: false,
          });
        } catch {
          // The merge failure above is the meaningful one to report.
        }
      }
    }

    if (failures.length > 0) {
      for (const failure of failures) logFailure(failure);
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Agent Memory sweep failed in ${failures.length} operation(s)`,
      );
    }
  }

  function runNow(): Promise<void> {
    if (inFlight) return inFlight;
    const controller = new AbortController();
    currentAbortController = controller;
    inFlight = sweep(controller.signal).finally(() => {
      if (currentAbortController === controller) currentAbortController = null;
      inFlight = null;
    });
    return inFlight;
  }

  function runScheduled(): void {
    void runNow().catch((error) => {
      if (
        !(error instanceof Error) ||
        error.message !== 'Agent Memory extraction canceled'
      ) {
        logSweepFailure(error);
      }
    });
  }

  async function cancelCurrent(): Promise<void> {
    const running = inFlight;
    currentAbortController?.abort(new Error('Agent Memory extraction canceled'));
    if (running) await Promise.allSettled([running]);
  }

  return {
    runNow,
    cancelCurrent,
    start() {
      if (timer !== null) return;
      timer = setInterval(runScheduled, 60_000);
      timer.unref?.();
      runScheduled();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      void cancelCurrent();
    },
  };
}

export const agentMemorySchedulerService = createAgentMemorySchedulerService();
