import {
  type BackendsSetting,
  type InteractionMode,
  isPrReviewChatStepMeta,
  type ModelPreference,
  type PrReviewAgentSetting,
  type Task,
  type TaskStep,
  type ThinkingEffort,
} from '@shared/types';
import type { AgentBackendType } from '@shared/agent-backend-types';

import { getAgentBackendProvider } from './agent-backends/providers';
import type { PermissionScope } from '../../shared/permission-types';

export type CreatePrReviewChatStepParams = {
  taskId: string;
  pullRequestId: number;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedText: string;
  question: string;
};

export type ContinuePrReviewChatStepParams = {
  stepId: string;
  question: string;
};

export type PrReviewChatPromptParams = {
  prTitle: string;
  prDescription?: string | null;
  pullRequestId: number;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedText: string;
  question: string;
};

type PrReviewChatProject = {
  id: string;
  repoProviderId: string | null;
  repoProjectId: string | null;
  repoId: string | null;
  defaultAgentBackend: string | null;
  defaultAgentModelPreference: ModelPreference | null;
};

export type CreatePrReviewChatStepDeps = {
  findTaskById: (taskId: string) => Promise<Task | undefined>;
  findProjectById: (projectId: string) => Promise<PrReviewChatProject | undefined>;
  getPullRequest: (params: {
    providerId: string;
    projectId: string;
    repoId: string;
    pullRequestId: number;
  }) => Promise<{ title: string; description?: string | null }>;
  getPrReviewAgentSetting: () => Promise<PrReviewAgentSetting>;
  getBackendsSetting: () => Promise<BackendsSetting>;
  createStep: (data: {
    taskId: string;
    name: string;
    type: 'agent';
    promptTemplate: string;
    interactionMode: InteractionMode;
    modelPreference: ModelPreference | null;
    thinkingEffort: ThinkingEffort | null;
    agentBackend: AgentBackendType;
    meta: {
      kind: 'pr-review-chat';
      pullRequestId: number;
      filePath: string;
      lineStart: number;
      lineEnd?: number;
      side?: 'old' | 'new';
      selectedText: string;
    };
    autoStart: false;
  }) => Promise<TaskStep>;
  startAgent: (stepId: string) => Promise<void>;
  onStartError?: (step: TaskStep, error: unknown) => void;
};

export type ContinuePrReviewChatStepDeps = {
  findStepById: (stepId: string) => Promise<TaskStep | undefined>;
  findTaskById: (taskId: string) => Promise<Task | undefined>;
  markStepRunning: (stepId: string) => Promise<TaskStep>;
  continueAgent: (stepId: string, prompt: string) => Promise<void>;
  onContinueError?: (step: TaskStep, error: unknown) => void;
};

const PR_REVIEW_ANSWER_STYLE = [
  'Answer style:',
  '- Lead with the use-case in 1 short sentence: what user/workflow this supports.',
  '- Explain intended outcome and constraints before implementation mechanics.',
  '- Prefer reviewer-level framing: why this exists, what problem it solves, what must stay true.',
  '- Mention technical wiring only when it changes behavior, creates risk, or answers the question directly.',
  '- Use max 5 bullets total, or a tiny table if clearer.',
  '- Cite only the 1-3 most relevant files/lines. Do not inventory every reference.',
  '- Avoid vague phrases like "as far as PR shows". If uncertain, say exactly what is uncertain and why.',
  '- Do not restate the PR description or selected code unless needed.',
  '- Be terse: fragments OK, no filler.',
].join('\n');

export function buildReadOnlyPrReviewSessionRules(): PermissionScope {
  return {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    bash: 'deny',
    write: 'deny',
    edit: 'deny',
    multiedit: 'deny',
    notebookedit: 'deny',
    todowrite: 'deny',
  };
}

export function buildPrReviewChatPrompt(params: PrReviewChatPromptParams) {
  const range =
    params.lineEnd && params.lineEnd !== params.lineStart
      ? `${params.lineStart}-${params.lineEnd}`
      : String(params.lineStart);
  const selectedSide = params.side === 'old' ? 'old side' : 'new side';
  const prDescription = params.prDescription?.trim();
  const selectedCodeFence = buildMarkdownFence(params.selectedText);

  return [
    `You are helping review PR #${params.pullRequestId}: ${params.prTitle}.`,
    ...(prDescription
      ? ['', '<pr_description>', prDescription, '</pr_description>']
      : []),
    '',
    'You are running in a local worktree checked out to the PR source branch.',
    'Inspect the repository as needed, but do not modify files, run write commands, commit, push, or post comments.',
    '',
    '<selected_context>',
    `Selected location: ${params.filePath}:${range} (${selectedSide})`,
    '',
    'Selected code:',
    '<selected_lines>',
    selectedCodeFence,
    params.selectedText,
    selectedCodeFence,
    '</selected_lines>',
    '</selected_context>',
    '',
    'Reviewer question:',
    params.question,
    '',
    PR_REVIEW_ANSWER_STYLE,
  ].join('\n');
}

export function buildPrReviewFollowUpPrompt(question: string) {
  return [
    'Follow-up reviewer question:',
    question,
    '',
    'Continue using the same PR review context. Inspect the repository as needed, but do not modify files, run write commands, commit, push, or post comments.',
    PR_REVIEW_ANSWER_STYLE,
  ].join('\n');
}

function buildMarkdownFence(value: string) {
  const longestBacktickRun = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  return '`'.repeat(longestBacktickRun + 1);
}

function assertPrReviewChatBackendSupported(backend: AgentBackendType) {
  const provider = getAgentBackendProvider(backend);
  if (!provider.capabilities.agent.permissions.supported) {
    throw new Error(
      `PR review chat requires backend permission support; ${backend} is not supported`,
    );
  }
}

export async function createPrReviewChatStep(
  params: CreatePrReviewChatStepParams,
  deps: CreatePrReviewChatStepDeps,
): Promise<TaskStep> {
  const task = await deps.findTaskById(params.taskId);
  if (!task) throw new Error(`Task ${params.taskId} not found`);
  if (task.type !== 'pr-review') {
    throw new Error('PR review chat steps can only be created for pr-review tasks');
  }
  if (task.pullRequestId !== String(params.pullRequestId)) {
    throw new Error('PR review chat pull request does not match review task');
  }
  if (!task.worktreePath) {
    throw new Error('PR review worktree is unavailable');
  }

  const project = await deps.findProjectById(task.projectId);
  if (!project) throw new Error(`Project ${task.projectId} not found`);
  if (!project.repoProviderId || !project.repoProjectId || !project.repoId) {
    throw new Error('Project has no linked repository');
  }

  const [pr, setting, backendsSetting] = await Promise.all([
    deps.getPullRequest({
      providerId: project.repoProviderId,
      projectId: project.repoProjectId,
      repoId: project.repoId,
      pullRequestId: params.pullRequestId,
    }),
    deps.getPrReviewAgentSetting(),
    deps.getBackendsSetting(),
  ]);
  const globalDefaultBackend =
    backendsSetting.defaultBackend &&
    backendsSetting.enabledBackends.includes(backendsSetting.defaultBackend)
      ? backendsSetting.defaultBackend
      : null;
  const agentBackend = (setting.backend ??
    project.defaultAgentBackend ??
    globalDefaultBackend ??
    'claude-code') as AgentBackendType;
  assertPrReviewChatBackendSupported(agentBackend);

  const step = await deps.createStep({
    taskId: task.id,
    name: `Ask Agent: ${params.filePath}:${params.lineStart}`,
    type: 'agent',
    promptTemplate: buildPrReviewChatPrompt({
      prTitle: pr.title,
      prDescription: pr.description,
      pullRequestId: params.pullRequestId,
      filePath: params.filePath,
      lineStart: params.lineStart,
      lineEnd: params.lineEnd,
      side: params.side,
      selectedText: params.selectedText,
      question: params.question,
    }),
    interactionMode: 'ask',
    modelPreference:
      setting.modelPreference === 'default'
        ? project.defaultAgentModelPreference
        : setting.modelPreference,
    thinkingEffort: setting.thinkingEffort,
    agentBackend,
    meta: {
      kind: 'pr-review-chat',
      pullRequestId: params.pullRequestId,
      filePath: params.filePath,
      lineStart: params.lineStart,
      lineEnd: params.lineEnd,
      side: params.side,
      selectedText: params.selectedText,
    },
    autoStart: false,
  });

  deps.startAgent(step.id).catch((error) => {
    deps.onStartError?.(step, error);
  });

  return step;
}

export async function continuePrReviewChatStep(
  params: ContinuePrReviewChatStepParams,
  deps: ContinuePrReviewChatStepDeps,
): Promise<TaskStep> {
  const step = await deps.findStepById(params.stepId);
  if (!step) throw new Error(`Step ${params.stepId} not found`);
  if (!isPrReviewChatStepMeta(step.meta)) {
    throw new Error('Step is not a PR review chat step');
  }
  const task = await deps.findTaskById(step.taskId);
  if (!task) throw new Error(`Task ${step.taskId} not found`);
  if (task.type !== 'pr-review') {
    throw new Error('PR review chat steps can only continue for pr-review tasks');
  }
  if (!task.worktreePath) {
    throw new Error('PR review worktree is unavailable');
  }
  if (!step.sessionId) {
    throw new Error('PR review chat step has no session to continue');
  }
  if (step.status === 'running') {
    throw new Error('PR review chat step is already running');
  }

  const runningStep = await deps.markStepRunning(step.id);
  try {
    await deps.continueAgent(step.id, buildPrReviewFollowUpPrompt(params.question));
  } catch (error) {
    deps.onContinueError?.(runningStep, error);
    throw error;
  }

  return runningStep;
}
