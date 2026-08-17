import {
  addProjectPermissionRule,
  addWorktreePermission,
  buildToolPermissionConfig,
  isUnrestrictedBashPattern,
  normalizeToolRequest,
} from './permission-settings-service';
import type { PermissionAction, PermissionScope } from '../../shared/permission-types';
import { ProjectRepository, TaskRepository } from '../database/repositories';
import type { Task, TaskStep } from '../../shared/types';
import { addGlobalPermission } from './global-permissions-service';
import { dbg } from '../lib/debug';
import { emitPermissionsChanged } from './permission-event-service';
import { emitStepUpsert } from './cache-event-service';
import { isPrReviewChatStepMeta } from '@shared/types';
import { TaskStepRepository } from '../database/repositories/task-steps';

type Dependencies = {
  findStep: (stepId: string) => Promise<TaskStep | undefined>;
  findTask: (taskId: string) => Promise<Task | undefined>;
  findProject: typeof ProjectRepository.findById;
  updateStep: typeof TaskStepRepository.update;
  emitStep: typeof emitStepUpsert;
  emitPermissionsChanged: typeof emitPermissionsChanged;
  addProjectPermission: (params: {
    projectPath: string;
    toolName: string;
    input: Record<string, unknown>;
    afterPersisted: () => Promise<TaskStep>;
  }) => Promise<TaskStep | false>;
  addWorktreePermission: (
    projectPath: string,
    toolName: string,
    input: Record<string, unknown>,
    afterPersisted: () => Promise<TaskStep>,
  ) => Promise<TaskStep | false>;
  addGlobalPermission: (params: {
    toolName: string;
    input: Record<string, unknown>;
    afterPersisted: () => Promise<TaskStep>;
  }) => Promise<TaskStep | false>;
  onQueueSizeChange?: (size: number) => void;
};

function removeRule(
  scope: PermissionScope,
  toolName: string,
  pattern?: string,
): PermissionScope {
  const updated = { ...scope };
  const tool = toolName.toLowerCase();
  if (!pattern) {
    delete updated[tool];
    return updated;
  }

  const existing = updated[tool];
  if (typeof existing === 'object' && existing !== null) {
    const patterns = { ...existing } as Record<string, PermissionAction>;
    delete patterns[pattern];
    const remaining = Object.keys(patterns);
    if (remaining.length === 0) {
      delete updated[tool];
    } else if (remaining.length === 1 && remaining[0] === '*') {
      updated[tool] = patterns['*']!;
    } else {
      updated[tool] = patterns;
    }
  } else if (pattern === '*') {
    delete updated[tool];
  }
  return updated;
}

function assertNotBareBash(
  toolName: string,
  input: Record<string, unknown>,
): void {
  const { tool, matchValue } = normalizeToolRequest(toolName, input);
  if (isUnrestrictedBashPattern(tool, matchValue)) {
    throw new Error('Bare "bash" without a command pattern is not allowed');
  }
}

export function createStepPermissionService(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    findStep: TaskStepRepository.findById,
    findTask: TaskRepository.findById,
    findProject: ProjectRepository.findById,
    updateStep: TaskStepRepository.update,
    emitStep: emitStepUpsert,
    emitPermissionsChanged,
    addProjectPermission: addProjectPermissionRule,
    addWorktreePermission,
    addGlobalPermission,
    ...overrides,
  };
  const queues = new Map<string, Promise<void>>();

  const serialize = <T>(stepId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(stepId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(stepId, tail);
    dependencies.onQueueSizeChange?.(queues.size);
    return result.finally(() => {
      if (queues.get(stepId) === tail) {
        queues.delete(stepId);
        dependencies.onQueueSizeChange?.(queues.size);
      }
    });
  };

  const getContext = async (stepId: string) => {
    const step = await dependencies.findStep(stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);
    const task = await dependencies.findTask(step.taskId);
    if (!task) throw new Error(`Task ${step.taskId} not found`);
    if (isPrReviewChatStepMeta(step.meta)) {
      throw new Error('PR review chat steps are read-only and cannot allow tools');
    }
    return { step, task };
  };

  const updateStepRule = async (
    step: TaskStep,
    toolName: string,
    input: Record<string, unknown>,
  ) => {
    assertNotBareBash(toolName, input);
    const { tool, matchValue } = normalizeToolRequest(toolName, input);
    const sessionRules = { ...(step.sessionRules ?? {}) };
    sessionRules[tool] = buildToolPermissionConfig({
      existing: sessionRules[tool],
      matchValue,
    });
    const updated = await dependencies.updateStep(step.id, { sessionRules });
    // Session rules feed the live run's permission snapshot — tell the agent
    // service so it re-resolves rules for this step immediately.
    dependencies.emitPermissionsChanged({ scope: 'session', stepId: step.id });
    return updated;
  };

  const addStepRule = async (
    step: TaskStep,
    toolName: string,
    input: Record<string, unknown>,
  ) => {
    const updated = await updateStepRule(step, toolName, input);
    dependencies.emitStep(updated);
    return updated;
  };

  return {
    addSessionAllowedTool: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) =>
      serialize(params.stepId, async () => {
        const { step } = await getContext(params.stepId);
        return addStepRule(step, params.toolName, params.input);
      }),

    removeSessionAllowedTool: (params: {
      stepId: string;
      toolName: string;
      pattern?: string;
    }) =>
      serialize(params.stepId, async () => {
        const { step } = await getContext(params.stepId);
        const updated = await dependencies.updateStep(step.id, {
          sessionRules: removeRule(
            step.sessionRules ?? {},
            params.toolName,
            params.pattern,
          ),
        });
        dependencies.emitPermissionsChanged({
          scope: 'session',
          stepId: step.id,
        });
        dependencies.emitStep(updated);
        return updated;
      }),

    allowForProject: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) =>
      serialize(params.stepId, async () => {
        const { step, task } = await getContext(params.stepId);
        assertNotBareBash(params.toolName, params.input);
        const project = await dependencies.findProject(task.projectId);
        if (!project) throw new Error(`Project ${task.projectId} not found`);
        const added = await dependencies.addProjectPermission({
          projectPath: project.path,
          toolName: params.toolName,
          input: params.input,
          afterPersisted: () => updateStepRule(step, params.toolName, params.input),
        });
        if (!added) throw new Error('Permission rule was rejected');
        dependencies.emitStep(added);
        return added;
      }),

    allowForProjectWorktrees: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) =>
      serialize(params.stepId, async () => {
        const { step, task } = await getContext(params.stepId);
        assertNotBareBash(params.toolName, params.input);
        const project = await dependencies.findProject(task.projectId);
        if (!project) throw new Error(`Project ${task.projectId} not found`);
        const added = await dependencies.addWorktreePermission(
          project.path,
          params.toolName,
          params.input,
          () => updateStepRule(step, params.toolName, params.input),
        );
        if (!added) throw new Error('Permission rule was rejected');
        dependencies.emitStep(added);
        return added;
      }),

    allowGlobally: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) =>
      serialize(params.stepId, async () => {
        const { step } = await getContext(params.stepId);
        assertNotBareBash(params.toolName, params.input);
        const added = await dependencies.addGlobalPermission({
          toolName: params.toolName,
          input: params.input,
          afterPersisted: () => updateStepRule(step, params.toolName, params.input),
        });
        if (!added) throw new Error('Permission rule was rejected');
        dependencies.emitStep(added);
        return added;
      }),

    syncSessionAllowedTools: (params: { stepId: string; tools: string[] }) =>
      serialize(params.stepId, async () => {
        const step = await dependencies.findStep(params.stepId);
        if (!step) throw new Error(`Step ${params.stepId} not found`);
        if (isPrReviewChatStepMeta(step.meta)) return step;
        if (!(await dependencies.findTask(step.taskId))) {
          throw new Error(`Task ${step.taskId} not found`);
        }
        const sessionRules = { ...(step.sessionRules ?? {}) };
        let hasValidTool = false;
        for (const entry of params.tools) {
          const colonIndex = entry.indexOf(':');
          if (colonIndex === -1) {
            if (isUnrestrictedBashPattern(entry, '')) {
              dbg.agentPermission('Ignoring provider-reported bare Bash session grant');
              continue;
            }
            hasValidTool = true;
            sessionRules[entry] = 'allow';
            continue;
          }
          const tool = entry.slice(0, colonIndex);
          const matchValue = entry.slice(colonIndex + 1);
          if (isUnrestrictedBashPattern(tool, matchValue)) {
            dbg.agentPermission('Ignoring provider-reported bare Bash session grant');
            continue;
          }
          hasValidTool = true;
          sessionRules[tool] = buildToolPermissionConfig({
            existing: sessionRules[tool],
            matchValue,
          });
        }
        if (!hasValidTool) return step;
        const updated = await dependencies.updateStep(step.id, { sessionRules });
        dependencies.emitPermissionsChanged({
          scope: 'session',
          stepId: step.id,
        });
        dependencies.emitStep(updated);
        return updated;
      }),
  };
}

export const stepPermissionService = createStepPermissionService();
