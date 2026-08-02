// Agent Service — backend-agnostic orchestration layer.
// Manages agent sessions using the AgentBackend interface.
// Sessions are keyed by stepId — each step is an independent agent session.
// Handles session lifecycle, message persistence, IPC forwarding,
// prompt queueing, notifications, and session allow tools.

import { AsyncLocalStorage } from 'node:async_hooks';
import { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';

import {
  AGENT_CHANNELS,
  type AgentQuestion,
  DECIDE_FOR_ME,
  getStableQuestionKeys,
  type PermissionResponse,
  type QuestionResponse,
  type QueuedPrompt,
} from '@shared/agent-types';
import type {
  AgentBackendConfig,
  AgentBackendType,
  AgentEvent,
  AgentTaskContext,
  NormalizedPermissionRequest,
  NormalizedQuestion,
  NormalizedQuestionRequest,
  PromptImagePart,
  PromptPart,
} from '@shared/agent-backend-types';
import {
  type AgentBackendProvider,
  type AgentRunHandle,
  type Capability,
  requireCapability,
  type RunAgentCapability,
} from '@shared/agent-backend-provider-types';
import {
  type AgentMemoryFollowUpCapture,
  type AgentMemoryPromptCapture,
  type AgentMemoryQuestionResponseDetail,
  agentMemoryQuestionResponseDetailInputSchema,
  type AgentMemoryQueuedPromptCapture,
} from '@shared/agent-memory-types';
import {
  deriveAgentMemoryPromptCaptureFromSubmittedContent,
  reconcileAgentMemoryPromptCaptureWithDiagnostics,
} from '@shared/agent-memory-review-reconciliation';
import {
  getDefaultInteractionModeForBackend,
  normalizeInteractionModeForBackend,
} from '@shared/types';
import {
  type InteractionMode,
  isPrReviewChatStepMeta,
  isSkillCreationStepMeta,
  type ReviewStepMeta,
  type Task,
  type TaskNotificationEvent,
  type TaskStep,
  type TaskStepType,
  type ThinkingEffort,
} from '@shared/types';
import type {
  NormalizedEntry,
  ToolUseByName,
} from '@shared/normalized-message-v2';
import type {
  PermissionsChangedEvent,
  PermissionScope,
  ResolvedPermissionRule,
} from '@shared/permission-types';
import type { AgentUIEventPayload } from '@shared/agent-ui-events';
import type { AiUsageFeature } from '@shared/ai-usage-types';

import {
  AgentMessageRepository,
  ProjectRepository,
  RawMessageRepository,
  TaskRepository,
} from '../database/repositories';
import {
  buildAgentPromptMarkdown,
  getPromptText,
  textPrompt,
} from './prompt-utils';
import {
  buildToolPermissionConfig,
  flattenScope,
  normalizeToolRequest,
  readSettings,
  resolveRules,
} from './permission-settings-service';
import {
  captureAgentMemoryEventSafe,
  captureAgentMemoryPromptSubmissionSafe,
} from './agent-memory-capture-service';
import {
  emitPermissionsChanged,
  onPermissionsChanged,
} from './permission-event-service';
import {
  emitStepUpsert,
  emitTaskPatch,
  emitTaskUpsert,
} from './cache-event-service';
import {
  toDirectoryPermissionPattern,
  validateAllowedDirectory,
} from './directory-access';
import { agentResourceMonitorService } from './agent-resource-monitor-service';
import { aiUsageTrackingService } from './ai-usage-tracking-service';
import { applyConfiguredPromptPreface } from './prompt-preface-service';
import { assertValidWorkspacePath } from './system-project-service';
import { buildJcMcpServersConfigForCwd } from './jc-mcp-config';
import { buildReadOnlyPrReviewSessionRules } from './pr-review-agent-service';
import { buildSessionIdStepUpdate } from './agent-session-update';
import { ClaudeCodeBackend } from './agent-backends/claude/claude-code-backend';
import { CopilotBackend } from './agent-backends/copilot/copilot-backend';
import { dbg } from '../lib/debug';
import { generateTaskName } from './name-generation-service';
import { getAgentBackendProvider } from './agent-backends/providers';
import { JcMcpBridgeService } from './jc-mcp-bridge-service';
import { normalizeThinkingEffortForModel } from '../../shared/thinking-settings';
import { notificationService } from './notification-service';
import { OpenCodeBackend } from './agent-backends/opencode/opencode-backend';
import { pathExists } from '../lib/fs';
import { QuestionBrokerService } from './question-broker-service';
import { resolveGlobalRules } from './global-permissions-service';
import { SettingsRepository } from '../database/repositories/settings';
import { shellEditTracker } from './shell-edit-tracker';
import { startAgentWithPrReviewLifecycle } from './pr-review-task-service';
import { stepPermissionService } from './step-permission-service';
import { StepService } from './step-service';
import { TaskStepRepository } from '../database/repositories/task-steps';

/** In-memory store for queued prompt parts, keyed by QueuedPrompt.id.
 *  Keeps full PromptPart[] (with image base64) out of the QueuedPrompt.content
 *  field which crosses IPC to the renderer for display. */
const queuedPromptParts = new Map<string, PromptPart[]>();
const queuedPromptCaptures = new Map<string, AgentMemoryPromptCapture>();
const MAX_PENDING_QUEUED_PROMPT_SUBMISSIONS = 256;
const MAX_QUEUED_PROMPT_TOMBSTONES = 2_048;
const queuedPromptSubmissionTombstones = new Map<string, string>();

type CanonicalQuestionMemoryDetail = AgentMemoryQuestionResponseDetail & {
  question: string;
};

class QuestionResponseValidationError extends Error {
  // `reason` is a fixed internal enum string, never user or agent content, so
  // it is safe to surface. Without it the toast is unactionable and the real
  // cause is only visible with DEBUG enabled.
  constructor(requestId: string, reason?: string) {
    super(
      reason
        ? `Invalid question response for request ${requestId} (${reason})`
        : `Invalid question response for request ${requestId}`,
    );
    this.name = 'QuestionResponseValidationError';
  }
}

function questionMemoryAnswerFromDetail({
  question,
  detail,
}: {
  question: NormalizedQuestion;
  detail: AgentMemoryQuestionResponseDetail;
}): { answer: string } | { error: string } {
  const optionLabels = new Set(question.options.map((option) => option.label));
  if (detail.selectedLabels.some((label) => !optionLabels.has(label))) {
    return { error: 'invalid-selected-label' };
  }
  if (
    detail.customAnswer &&
    question.allowFreeform === false &&
    detail.customAnswer !== DECIDE_FOR_ME
  ) {
    return { error: 'custom-answer-disabled' };
  }

  const note = detail.notes ? `Notes: ${detail.notes}` : null;
  const isMulti = question.type === 'multi_choice' || question.multiSelect;
  const isText =
    question.type === 'text' ||
    (!question.type && question.options.length === 0);

  if (isMulti) {
    const parts = [...detail.selectedLabels, detail.customAnswer, note]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part));
    return { answer: JSON.stringify(parts) };
  }

  if (isText) {
    if (detail.selectedLabels.length > 0) {
      return { error: 'text-question-has-selected-labels' };
    }
  } else if (
    detail.selectedLabels.length > 1 ||
    (detail.selectedLabels.length === 1 && detail.customAnswer)
  ) {
    return { error: 'invalid-single-choice-detail' };
  }

  return {
    answer: [detail.selectedLabels[0], detail.customAnswer, note]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join(', '),
  };
}

function canonicalizeQuestionResponse({
  request,
  response,
}: {
  request: NormalizedQuestionRequest;
  response: QuestionResponse;
}): {
  answers: Record<string, string>;
  memoryDetails: CanonicalQuestionMemoryDetail[];
  questionKeys: string[];
} {
  const reject = (reason: string, questionIndex?: number): never => {
    dbg.agent(
      questionIndex === undefined
        ? 'Rejecting question response request=%s reason=%s'
        : 'Rejecting question response request=%s questionIndex=%d reason=%s',
      request.requestId,
      ...(questionIndex === undefined
        ? [reason]
        : [questionIndex, reason]),
    );
    throw new QuestionResponseValidationError(request.requestId, reason);
  };

  if (!Array.isArray(response.memoryDetails)) {
    return reject('invalid-details');
  }
  if (
    !response.answers ||
    typeof response.answers !== 'object' ||
    Array.isArray(response.answers)
  ) {
    return reject('invalid-answer-map');
  }

  const questionKeys = getStableQuestionKeys(request.questions);
  const questionIndexByKey = new Map(
    questionKeys.map((questionKey, index) => [questionKey, index]),
  );
  const parsedDetails = response.memoryDetails.map((detail) => {
    const parsed =
      agentMemoryQuestionResponseDetailInputSchema.safeParse(detail);
    if (!parsed.success) {
      return reject('invalid-detail-shape');
    }
    return parsed.data;
  });
  const detailByKey = new Map<string, AgentMemoryQuestionResponseDetail>();
  for (const detail of parsedDetails) {
    if (!questionIndexByKey.has(detail.questionKey)) {
      return reject('unknown-question-key');
    }
    if (detailByKey.has(detail.questionKey)) {
      return reject('duplicate-detail');
    }
    detailByKey.set(detail.questionKey, detail);
  }

  const answers: Record<string, string> = {};
  const memoryDetails: CanonicalQuestionMemoryDetail[] = [];
  for (const [questionIndex, question] of request.questions.entries()) {
    const questionKey = questionKeys[questionIndex];
    const rendererAnswer = response.answers[questionKey];
    const detail = detailByKey.get(questionKey);
    if (rendererAnswer === undefined) {
      if (detail) return reject('detail-without-answer', questionIndex);
      if (question.required ?? true) {
        return reject('missing-required-answer', questionIndex);
      }
      continue;
    }
    if (!detail) return reject('answer-without-detail', questionIndex);

    const expected = questionMemoryAnswerFromDetail({
      question,
      detail,
    });
    if ('error' in expected) {
      return reject(expected.error, questionIndex);
    }
    if (rendererAnswer !== expected.answer) {
      return reject('delivered-answer-mismatch', questionIndex);
    }

    answers[questionKey] = expected.answer;
    memoryDetails.push({
      ...detail,
      questionKey,
      question: question.question,
    });
  }
  return {
    answers,
    memoryDetails,
    // Every question key in the backend's original order, including skipped
    // optional questions. Backends (e.g. OpenCode) map answers positionally, so
    // omitting a skipped question would shift later answers onto the wrong
    // questions.
    questionKeys,
  };
}

function appendPromptParts(
  existingParts: PromptPart[],
  incomingParts: PromptPart[],
): PromptPart[] {
  const combinedParts = [...existingParts];

  for (const part of incomingParts) {
    if (part.type !== 'text') {
      combinedParts.push(part);
      continue;
    }

    const lastPart = combinedParts[combinedParts.length - 1];
    if (!lastPart || lastPart.type !== 'text') {
      combinedParts.push(part);
      continue;
    }

    combinedParts[combinedParts.length - 1] = {
      type: 'text',
      text: [lastPart.text, part.text]
        .filter((text) => text.trim().length > 0)
        .join('\n\n'),
    };
  }

  return combinedParts;
}

function capturesMatch(
  rendererCapture: AgentMemoryPromptCapture,
  serverCapture: AgentMemoryPromptCapture,
): boolean {
  return JSON.stringify(rendererCapture) === JSON.stringify(serverCapture);
}

function diagnosticIdHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function admitAgentMemoryPromptCapture({
  capture,
  content,
  source,
  stepId,
}: {
  capture: AgentMemoryPromptCapture;
  content: string;
  source: 'immediate' | 'queued';
  stepId: string;
}): AgentMemoryPromptCapture {
  const admission = deriveAgentMemoryPromptCaptureFromSubmittedContent(
    capture,
    content,
  );
  const diagnostics = admission.diagnostics;
  if (
    diagnostics.rejectedCommentIds.length > 0 ||
    diagnostics.rejectedCommentsWithoutId > 0 ||
    diagnostics.metadataMismatchCommentIds.length > 0 ||
    diagnostics.unrepresentedRendererCommentIds.length > 0
  ) {
    dbg.agent('Agent Memory prompt admission metadata mismatch: %O', {
      event: 'agent-memory-prompt-admission-mismatch',
      source,
      stepId,
      hasReviewXml: diagnostics.hasReviewXml,
      rejectedXmlCommentIdHashes:
        diagnostics.rejectedCommentIds.map(diagnosticIdHash),
      rejectedCommentsWithoutId: diagnostics.rejectedCommentsWithoutId,
      metadataMismatchCommentIdHashes:
        diagnostics.metadataMismatchCommentIds.map(diagnosticIdHash),
      unrepresentedRendererCommentIdHashes:
        diagnostics.unrepresentedRendererCommentIds.map(diagnosticIdHash),
    });
  }
  return admission.capture;
}

function replacePromptText(parts: PromptPart[], content: string): PromptPart[] {
  const textPartIndex = parts.findIndex((part) => part.type === 'text');
  const nonTextParts = parts.filter((part) => part.type !== 'text');

  if (textPartIndex === -1) {
    return [{ type: 'text', text: content }, ...nonTextParts];
  }

  return [
    ...parts.slice(0, textPartIndex).filter((part) => part.type !== 'text'),
    { type: 'text' as const, text: content },
    ...parts.slice(textPartIndex + 1).filter((part) => part.type !== 'text'),
  ];
}

const TASK_NOTIFICATION_TITLE_PREFIX: Record<TaskNotificationEvent, string> = {
  completed: '✅',
  'permission-required': '🔐',
  question: '❓',
  errored: '❌',
};

/**
 * Build a review prompt that instructs the agent to use `run_review` MCP
 * tools in parallel for each configured reviewer focus area.
 */
function buildReviewPrompt({
  basePrompt,
  meta,
  startCommitHash,
  workItemContext,
}: {
  basePrompt: string;
  meta: ReviewStepMeta | undefined;
  startCommitHash: string | null;
  workItemContext?: string;
}): string {
  const reviewers = meta?.reviewers ?? [];
  const reviewerList = reviewers
    .map(
      (r, i) =>
        `${i + 1}. **${r.label}** (backend: ${r.backend ?? 'claude-code'}${r.model && r.model !== 'default' ? `, model: ${r.model}` : ''}${r.thinkingEffort && r.thinkingEffort !== 'default' ? `, variant: ${r.thinkingEffort}` : ''}): ${r.focusPrompt}`,
    )
    .join('\n');

  const extra = basePrompt.trim()
    ? `\n\nAdditional instructions from the user:\n${basePrompt}`
    : '';

  const diffHint = startCommitHash
    ? `To see only the changes introduced by this task, each reviewer should run: git diff ${startCommitHash}\nThis covers all committed, staged, and unstaged changes since the task started. Do NOT diff against the source branch directly as that may include unrelated upstream changes.`
    : 'Each reviewer should use git diff HEAD to inspect recent changes, combined with git status for untracked files.';

  const workItemSection = workItemContext
    ? [
        '',
        '## Associated Work Items',
        '',
        'The following work items are linked to this PR. Include these in each reviewer prompt.',
        'The "Requirements Alignment" reviewer should specifically verify that the code changes fulfill these requirements.',
        '',
        workItemContext,
      ].join('\n')
    : '';

  return [
    'You are a code review coordinator.',
    '',
    'IMPORTANT: Do NOT investigate the code yourself. Do NOT run git diff, read files, or do any exploration.',
    'Your ONLY job is to:',
    '1. Immediately dispatch all reviewers in parallel using the `run_review` MCP tool.',
    '2. Wait for all reviews to complete.',
    '3. Synthesize the findings into a comprehensive summary organized by severity and category.',
    '',
    'When calling `run_review`, set the `backend` field to the backend listed for each reviewer. If a model is specified, set the `model` field accordingly. If a variant is specified, set the `thinkingEffort` field accordingly.',
    "Include the diff instructions below in each reviewer's prompt so they know how to find the changes.",
    '',
    '## Diff instructions (include in each reviewer prompt)',
    '',
    diffHint,
    '',
    '## Reviewers',
    '',
    reviewerList,
    '',
    'IMPORTANT: Do NOT implement any changes. Present your findings and recommendations, then wait for the user to decide on next steps.',
    workItemSection,
    extra,
  ].join('\n');
}

// --- Active session tracking ---

interface ActiveSession {
  stepId: string;
  taskId: string; // kept for worktree/project lookups
  projectId: string;
  runStartPromise?: Promise<AgentRunHandle>;
  runHandle: AgentRunHandle | null;
  sdkSessionId: string | null; // The persistent session ID for resumption
  backendType: AgentBackendType;
  usageFeature: AiUsageFeature;
  currentModel: string | null;
  requestedBackendType: AgentBackendType;
  swapModel?: string;
  swapThinkingEffort?: ThinkingEffort;
  provider: AgentBackendProvider;
  agentTaskContext: AgentTaskContext;
  messageIndex: number;
  queuedPrompts: QueuedPrompt[];
  abortController: AbortController;
  // Track pending requests for getPendingRequest()
  pendingRequests: Array<{
    requestId: string;
    type: 'permission' | 'question';
    permissionRequest?: NormalizedPermissionRequest;
    questionRequest?: NormalizedQuestionRequest;
    source?: 'backend' | 'jc-mcp';
  }>;
  hasTerminalError: boolean;
  /**
   * True once a terminal `result`/`error` event was handled for the current
   * turn while the backend stream is still open. Background subagents keep
   * streaming after the main turn reports a result, so activity arriving after
   * this flag is set means the step is actually still running.
   */
  turnFinalized: boolean;
  /**
   * Terminal status we reported for the last finalized turn, kept so that a
   * step reactivated by post-result activity can be closed again if the stream
   * ends without emitting another `result`.
   */
  lastTerminalStatus: 'completed' | 'errored' | null;
  stopRequested: boolean;
  /** Context needed to re-resolve permission rules while the run is live. */
  permissionContext?: {
    projectPath: string;
    workingDir: string;
    isWorktree: boolean;
  };
  agentMemoryCaptureEligible: boolean;
  previousResultFallback: string | null;
  queuedPromptIdsBySubmissionId: Map<string, string>;
  /** Identifies this session's shell-edit tracking, see `shellEditTracker`. */
  shellEditToken?: object;
}

function queuedPromptTombstoneKey(stepId: string, submissionId: string): string {
  return `${stepId}\0${submissionId}`;
}

function rememberQueuedPromptTombstone(
  stepId: string,
  submissionId: string,
  promptId: string,
): void {
  const tombstoneKey = queuedPromptTombstoneKey(stepId, submissionId);
  queuedPromptSubmissionTombstones.delete(tombstoneKey);
  queuedPromptSubmissionTombstones.set(tombstoneKey, promptId);
  while (queuedPromptSubmissionTombstones.size > MAX_QUEUED_PROMPT_TOMBSTONES) {
    const oldestTombstoneKey = queuedPromptSubmissionTombstones.keys().next()
      .value;
    if (!oldestTombstoneKey) break;
    queuedPromptSubmissionTombstones.delete(oldestTombstoneKey);
  }
}

function tombstoneQueuedPromptSubmissionIds(
  session: ActiveSession,
  promptId: string,
): void {
  for (const [submissionId, queuedPromptId] of
    session.queuedPromptIdsBySubmissionId) {
    if (queuedPromptId === promptId) {
      session.queuedPromptIdsBySubmissionId.delete(submissionId);
      rememberQueuedPromptTombstone(session.stepId, submissionId, promptId);
    }
  }
}

function tombstoneAllQueuedPromptSubmissionIds(session: ActiveSession): void {
  for (const [submissionId, promptId] of
    session.queuedPromptIdsBySubmissionId) {
    rememberQueuedPromptTombstone(session.stepId, submissionId, promptId);
  }
  session.queuedPromptIdsBySubmissionId.clear();
}

function rememberPendingQueuedPromptSubmission(
  session: ActiveSession,
  submissionId: string,
  promptId: string,
): void {
  session.queuedPromptIdsBySubmissionId.delete(submissionId);
  session.queuedPromptIdsBySubmissionId.set(submissionId, promptId);
  while (
    session.queuedPromptIdsBySubmissionId.size >
    MAX_PENDING_QUEUED_PROMPT_SUBMISSIONS
  ) {
    const oldestSubmissionId = session.queuedPromptIdsBySubmissionId
      .keys()
      .next().value;
    if (!oldestSubmissionId) break;
    const oldestPromptId = session.queuedPromptIdsBySubmissionId.get(
      oldestSubmissionId,
    );
    session.queuedPromptIdsBySubmissionId.delete(oldestSubmissionId);
    if (oldestPromptId) {
      rememberQueuedPromptTombstone(
        session.stepId,
        oldestSubmissionId,
        oldestPromptId,
      );
    }
  }
}

function getUsageFeatureForStep(type: TaskStepType): AiUsageFeature {
  switch (type) {
    case 'skill-creation':
      return 'skill';
    case 'feature-map':
      return 'feature-map';
    case 'review':
    case 'pr-review':
      return 'review';
    case 'create-pull-request':
      return 'pr';
    case 'agent':
    case 'fork':
      return 'agent';
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function assertPrReviewAgentRunAllowed({
  task,
  step,
  provider,
}: {
  task: Task;
  step: TaskStep;
  provider: AgentBackendProvider;
}) {
  if (!isPrReviewChatStepMeta(step.meta)) return;

  if (task.type !== 'pr-review') {
    throw new Error('PR review chat steps can only run under PR review tasks');
  }
  if (task.pullRequestId !== String(step.meta.pullRequestId)) {
    throw new Error('PR review chat step pull request does not match review task');
  }
  if (step.interactionMode !== 'ask') {
    throw new Error('PR review chat steps must use ask interaction mode');
  }
  if (!provider.capabilities.agent.permissions.supported) {
    throw new Error(
      `PR review chat requires backend permission support; ${provider.id} is not supported`,
    );
  }

  const canonicalizeRules = (rules: TaskStep['sessionRules']) =>
    flattenScope(rules)
      .map(({ tool, pattern, action }) => ({ tool, pattern, action }))
      .sort(
        (left, right) =>
          left.tool.localeCompare(right.tool) ||
          left.pattern.localeCompare(right.pattern) ||
          left.action.localeCompare(right.action),
      );
  const actualRules = JSON.stringify(canonicalizeRules(step.sessionRules ?? {}));
  const expectedRules = JSON.stringify(
    canonicalizeRules(buildReadOnlyPrReviewSessionRules()),
  );
  if (actualRules !== expectedRules) {
    throw new Error('PR review chat steps must use read-only session rules');
  }
}

/**
 * Resolve the backend-agnostic permission rules for a run: global rules,
 * project/worktree rules from `.jean-claude/settings.local.json`, and the
 * step's own session rules, in precedence order.
 *
 * Used both when a run starts and whenever persisted rules change while the
 * run is live.
 */
export async function resolvePermissionRulesForStep({
  projectPath,
  workingDir,
  isWorktree,
  sessionRules,
}: {
  projectPath: string;
  workingDir: string;
  isWorktree: boolean;
  sessionRules: PermissionScope;
}): Promise<ResolvedPermissionRule[]> {
  const globalRules = await resolveGlobalRules();
  const settings = await readSettings(projectPath);
  return [
    ...resolveRules(settings, isWorktree, globalRules, workingDir),
    ...flattenScope(sessionRules),
  ];
}

class AgentService {
  private sessions: Map<string, ActiveSession> = new Map(); // key is stepId
  private stepStopPromises = new Map<string, Promise<void>>();
  private backendRunCompletions = new Map<
    string,
    { owner: symbol; promise: Promise<void> }
  >();
  private backendRunContext = new AsyncLocalStorage<symbol>();
  private runStopPromises = new WeakMap<AgentRunHandle, Promise<void>>();
  private runDisposePromises = new WeakMap<AgentRunHandle, Promise<void>>();
  private runCleanupPromises = new WeakMap<AgentRunHandle, Promise<void>>();
  private resultUpdateUsageQueues = new Map<string, Promise<void>>();
  private requestResponsePromises = new Map<string, Promise<void>>();
  /**
   * Steps with per-session auto-accept enabled. In-memory only: cleared when
   * the app restarts. Deny rules still run in the backend before a request is
   * ever emitted, so this only auto-allows what would have prompted the user.
   */
  private autoAcceptSteps = new Set<string>();
  private startingSteps = new Set<string>();
  private registeringSteps = new Set<string>();
  private pendingSessionRegistrations = new Set<Promise<void>>();
  private stopAllActive = false;
  private stopAllPromise: Promise<void> | null = null;
  private stepStartPromises = new Map<string, Promise<void>>();
  private mainWindow: BrowserWindow | null = null;
  private focusedTaskId: string | null = null;
  private pendingImageAttachments = new Map<string, PromptImagePart[]>();
  private readonly questionBroker = new QuestionBrokerService();
  private readonly jcMcpBridgeService = new JcMcpBridgeService(
    this.questionBroker,
  );

  constructor() {
    onPermissionsChanged((event) => {
      void this.refreshPermissionRules(event).catch((error) => {
        dbg.agentPermission(
          'Failed refreshing permission rules for live sessions: %O',
          error,
        );
      });
    });
    agentResourceMonitorService.setSnapshotListener((snapshot) => {
      this.emitEvent(snapshot.taskId, snapshot.stepId, {
        type: 'resource-snapshot',
        snapshot,
      });
    });
  }

  /**
   * Re-resolve permission rules for every live session affected by a
   * persisted permission change and push the fresh snapshot into its backend.
   *
   * Global changes affect every active session; project/worktree changes only
   * affect sessions whose project matches `projectPath`; session changes affect
   * the single step they name.
   */
  private async refreshPermissionRules(
    event: PermissionsChangedEvent,
  ): Promise<void> {
    const entries =
      event.scope === 'session'
        ? ([[event.stepId, this.sessions.get(event.stepId)]] as Array<
            [string, ActiveSession | undefined]
          >)
        : ([...this.sessions.entries()] as Array<
            [string, ActiveSession | undefined]
          >);
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(async ([stepId, session]) => {
        if (!session) return;
        const context = session.permissionContext;
        if (!context || !session.runHandle) return;
        if (
          (event.scope === 'project' || event.scope === 'worktree') &&
          (!event.projectPath || event.projectPath !== context.projectPath)
        ) {
          return;
        }

        const capability =
          session.provider.capabilities.agent.permissionRuleUpdates;
        if (!capability?.supported) return;

        const step = await TaskStepRepository.findById(stepId);
        if (!step) return;
        const sessionRules = isPrReviewChatStepMeta(step.meta)
          ? buildReadOnlyPrReviewSessionRules()
          : (step.sessionRules ?? {});

        const rules = await resolvePermissionRulesForStep({
          projectPath: context.projectPath,
          workingDir: context.workingDir,
          isWorktree: context.isWorktree,
          sessionRules,
        });

        // The run may have finished while we were resolving.
        if (this.sessions.get(stepId) !== session || !session.runHandle) return;

        try {
          await capability.implementation.update({
            handle: session.runHandle,
            rules,
          });
          dbg.agentPermission(
            'Refreshed permission rules for live step %s (%d rules)',
            stepId,
            rules.length,
          );
        } catch (error) {
          dbg.agentPermission(
            'Failed pushing refreshed permission rules to step %s: %O',
            stepId,
            error,
          );
        }
      }),
    );
  }

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  setFocusedTask(taskId: string | null): void {
    this.focusedTaskId = taskId;
  }

  /**
   * Store images for a task that will be started shortly.
   * Images are consumed (deleted) when start() is called.
   */
  setPendingImages(taskId: string, images: PromptImagePart[]): void {
    this.pendingImageAttachments.set(taskId, images);
  }

  private admitSessionRegistration(
    stepId: string,
    duplicateBehavior: 'ignore' | 'reject',
  ): (() => void) | null {
    if (this.stopAllActive) {
      throw new Error('Cannot start agent sessions while stopAll is active');
    }
    if (this.registeringSteps.has(stepId)) {
      if (duplicateBehavior === 'ignore') return null;
      throw new Error(
        `Session registration already in progress for step ${stepId}`,
      );
    }

    this.registeringSteps.add(stepId);
    let resolveRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    this.pendingSessionRegistrations.add(registration);
    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      this.registeringSteps.delete(stepId);
      this.pendingSessionRegistrations.delete(registration);
      resolveRegistration();
    };
  }

  private deleteSession(stepId: string, session: ActiveSession): void {
    tombstoneAllQueuedPromptSubmissionIds(session);
    if (session.shellEditToken) {
      shellEditTracker.end(stepId, session.shellEditToken);
    }
    if (this.sessions.get(stepId) === session) {
      this.sessions.delete(stepId);
      this.autoAcceptSteps.delete(stepId);
    }
  }

  private async shouldAbortTerminalHandling(
    stepId: string,
    session: ActiveSession,
  ): Promise<boolean> {
    if (this.sessions.get(stepId) === session && !session.stopRequested) {
      return false;
    }
    if (session.stopRequested) {
      await StepService.interruptStep(stepId);
    }
    return true;
  }

  private getLiveWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed(),
    );
  }

  private isMainWindowAlive(): boolean {
    return (
      this.mainWindow !== null &&
      !this.mainWindow.isDestroyed() &&
      !this.mainWindow.webContents.isDestroyed()
    );
  }

  private emitEvent(
    taskId: string,
    stepId: string,
    event: AgentUIEventPayload,
  ) {
    for (const window of this.getLiveWindows()) {
      window.webContents.send(AGENT_CHANNELS.EVENT, {
        taskId,
        stepId,
        ...event,
      });
    }
  }

  private async emitPendingRequest(
    session: ActiveSession,
    request: ActiveSession['pendingRequests'][number],
  ): Promise<void> {
    const { taskId, stepId } = session;
    const task = await TaskRepository.update(taskId, { status: 'waiting' });
    emitTaskUpsert(task);
    this.emitEvent(taskId, stepId, { type: 'status', status: 'waiting' });

    if (request.type === 'question' && request.questionRequest) {
      this.emitEvent(taskId, stepId, {
        type: 'question',
        requestId: request.requestId,
        ...(request.questionRequest.contextReminder
          ? { contextReminder: request.questionRequest.contextReminder }
          : {}),
        questions: this.toAgentQuestions(request.questionRequest.questions),
      });
      await this.notifyTaskEvent({
        taskId,
        stepId,
        event: 'question',
        notificationId: `${taskId}:question`,
        title: 'Question from Agent',
        body: 'Task "{taskName}" has a question',
      });
      return;
    }

    if (request.type === 'permission' && request.permissionRequest) {
      this.emitEvent(taskId, stepId, {
        type: 'permission',
        ...request.permissionRequest,
      });
      await this.notifyTaskEvent({
        taskId,
        stepId,
        event: 'permission-required',
        notificationId: `${taskId}:permission`,
        title: 'Permission Required',
        body: `Task "{taskName}" needs approval for ${request.permissionRequest.toolName}`,
      });
    }
  }

  private async markTaskUnreadIfBackground(taskId: string): Promise<void> {
    const isFocused = () =>
      this.isMainWindowAlive() &&
      this.mainWindow!.isFocused() &&
      this.focusedTaskId === taskId;

    if (isFocused()) return;

    const task = await TaskRepository.setHasUnread(taskId, true);
    if (isFocused()) {
      const focusedTask = await TaskRepository.setHasUnread(taskId, false);
      if (focusedTask) {
        emitTaskPatch({
          taskId,
          projectId: focusedTask.projectId,
          patch: { hasUnread: false, updatedAt: focusedTask.updatedAt },
          invalidateFeed: false,
        });
      }
      return;
    }

    if (task) {
      emitTaskPatch({
        taskId,
        projectId: task.projectId,
        patch: { hasUnread: true, updatedAt: task.updatedAt },
        invalidateFeed: false,
      });
    }
  }

  /**
   * Persist and emit a synthetic normalized entry (not from a backend).
   * Used for user message echo, error messages, and interruption messages
   * generated by agent-service. These have no raw SDK backing, so rawMessageId is null.
   */
  private async persistAndEmitSyntheticEntry(
    taskId: string,
    session: ActiveSession,
    entry: NormalizedEntry,
  ) {
    try {
      await AgentMessageRepository.create({
        taskId,
        stepId: session.stepId,
        messageIndex: session.messageIndex++,
        entry,
        rawMessageId: null,
      });
    } catch (error) {
      dbg.agent('Failed to persist synthetic entry: %O', error);
    }
    this.emitEvent(taskId, session.stepId, { type: 'entry', entry });
  }

  /**
   * Emits one authoritative edit entry covering every file changed during the
   * turn, shell commands and Edit/Write tool uses alike.
   */
  private async emitTurnEditEntry(
    stepId: string,
    session: ActiveSession,
  ): Promise<void> {
    let files;
    try {
      files = await shellEditTracker.captureTurn(stepId);
    } catch (error) {
      dbg.agent('Failed to capture turn diff: %O', error);
      return;
    }
    if (!files?.length) return;
    await this.persistAndEmitSyntheticEntry(session.taskId, session, {
      id: nanoid(),
      date: new Date().toISOString(),
      isSynthetic: true,
      type: 'tool-use',
      toolId: `turn-edit-${nanoid()}`,
      name: 'edit',
      input: {
        filePath: files[0]!.filePath,
        oldString: '',
        newString: '',
        files: files.map((file) => ({
          filePath: file.filePath,
          type: file.type,
          patch: file.patch,
          additions: file.additions,
          deletions: file.deletions,
          before: file.before,
          after: file.after,
        })),
        isTurnSummary: true,
      },
    });
  }

  /**
   * Resolve the task display name for notifications.
   * Uses task name, falling back to truncated prompt from the task or step.
   */
  private async resolveTaskDisplayName(
    taskId: string,
    stepId: string,
  ): Promise<string> {
    const task = await TaskRepository.findById(taskId);
    if (task?.name) {
      return task.name;
    }

    // Fall back to task prompt (truncated)
    if (task?.prompt) {
      const firstLine = task.prompt.split('\n')[0].trim();
      return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
    }

    // Fall back to step prompt (truncated)
    const step = await TaskStepRepository.findById(stepId);
    const prompt = step?.promptTemplate;
    if (prompt) {
      const firstLine = prompt.split('\n')[0].trim();
      return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
    }

    return 'Untitled task';
  }

  private async generateAndPersistTaskName(
    taskId: string,
    stepId: string,
    prompt: string,
  ): Promise<void> {
    try {
      const task = await TaskRepository.findById(taskId);
      const name = await generateTaskName(
        prompt,
        null,
        task
          ? {
              feature: 'task-name',
              projectId: task.projectId,
              taskId,
              stepId,
              taskName: task.name,
            }
          : undefined,
      );
      if (name) {
        const updatedTask = await TaskRepository.update(taskId, { name });
        emitTaskUpsert(updatedTask);
        this.emitEvent(taskId, stepId, { type: 'name-updated', name });
        dbg.agent('Generated task name for %s: %s', taskId, name);
      }
    } catch (error) {
      dbg.agent('Failed to generate task name for %s: %O', taskId, error);
    }
  }

  private async shouldNotifyTaskEvent(
    event: TaskNotificationEvent,
  ): Promise<boolean> {
    const settings = await SettingsRepository.get('taskEventNotifications');
    const mode = settings.modes[event];

    if (mode === 'disabled') {
      return false;
    }

    if (
      mode === 'background' &&
      this.isMainWindowAlive() &&
      this.mainWindow!.isFocused()
    ) {
      return false;
    }

    return true;
  }

  private async notifyTaskEvent({
    taskId,
    stepId,
    event,
    notificationId,
    title,
    body,
    guard,
  }: {
    taskId: string;
    stepId: string;
    event: TaskNotificationEvent;
    notificationId: string;
    title: string;
    body: string;
    guard?: () => boolean;
  }): Promise<void> {
    if (!this.isMainWindowAlive()) {
      return;
    }

    if (!(await this.shouldNotifyTaskEvent(event))) {
      return;
    }

    const task = await TaskRepository.findById(taskId);
    const displayName = task?.name
      ? task.name
      : await this.resolveTaskDisplayName(taskId, stepId);
    if (guard && !guard()) return;
    notificationService.notify({
      id: notificationId,
      title: `${TASK_NOTIFICATION_TITLE_PREFIX[event]} ${title}`,
      body: body.replace('{taskName}', displayName),
      onClick: () => {
        if (!this.isMainWindowAlive()) {
          return;
        }

        const mainWindow = this.mainWindow!;
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();

        if (task) {
          mainWindow.webContents.send('notifications:open-task', {
            taskId,
            projectId: task.projectId,
          });
        }
      },
    });
  }

  private async handleAutoStartFailure(
    stepId: string,
    error: unknown,
  ): Promise<void> {
    try {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      dbg.agent(
        'Error auto-starting dependent step %s: %s',
        stepId,
        errorMessage,
      );

      const step = await TaskStepRepository.findById(stepId);
      if (!step) return;

      await StepService.errorStep(stepId);
      this.emitEvent(step.taskId, stepId, {
        type: 'status',
        status: 'errored',
        error: `Auto-start failed: ${errorMessage}`,
      });
      await this.notifyTaskEvent({
        taskId: step.taskId,
        stepId,
        event: 'errored',
        notificationId: `${step.taskId}:auto-start-error:${stepId}`,
        title: 'Task Failed',
        body: 'Task "{taskName}" encountered an error',
      });
    } catch (handlerError) {
      dbg.agent(
        'Failed to handle auto-start failure for step %s: %O',
        stepId,
        handlerError,
      );
    }
  }

  private clearPendingRequests(session: ActiveSession): void {
    notificationService.close(`${session.taskId}:permission`);
    notificationService.close(`${session.taskId}:question`);
    session.pendingRequests = [];
  }

  // --- Session management ---

  private async createSession(stepId: string): Promise<ActiveSession> {
    const step = await TaskStepRepository.findById(stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);

    const task = await TaskRepository.findById(step.taskId);
    if (!task) throw new Error(`Task ${step.taskId} not found`);

    const existingMessageCount =
      await AgentMessageRepository.getMessageCountByStepId(stepId);
    const existingRawMessageCount =
      await RawMessageRepository.getNextMessageIndexByStepId(stepId);

    const requestedBackend: AgentBackendType = (step.agentBackend ??
      'claude-code') as AgentBackendType;

    const backendType = requestedBackend;
    const swapModel: string | undefined = undefined;
    const swapThinkingEffort: ThinkingEffort | undefined = undefined;
    const provider = getAgentBackendProvider(backendType);
    if (!provider) {
      throw new Error(`Unknown agent backend: "${backendType}"`);
    }
    assertPrReviewAgentRunAllowed({ task, step, provider });

    const agentTaskContext: AgentTaskContext = {
      taskId: step.taskId,
      sessionStartIndex: existingMessageCount,
      rawSessionStartIndex:
        existingRawMessageCount > 0
          ? existingRawMessageCount
          : existingMessageCount,
      persistRaw: async (params) => {
        const row = await RawMessageRepository.create({
          taskId: step.taskId,
          stepId,
          messageIndex: params.messageIndex,
          backendSessionId: params.backendSessionId,
          rawData: params.rawData,
          rawFormat: backendType,
        });
        return row.id;
      },
      updateRaw: async (params) => {
        await RawMessageRepository.updateRawData(params.rowId, params.rawData);
      },
    };

    const session: ActiveSession = {
      stepId,
      taskId: step.taskId,
      projectId: task.projectId,
      runHandle: null,
      sdkSessionId: step.sessionId ?? null,
      backendType,
      usageFeature: getUsageFeatureForStep(step.type),
      currentModel: swapModel ?? step.modelPreference,
      requestedBackendType: requestedBackend,
      swapModel,
      swapThinkingEffort,
      provider,
      agentTaskContext,
      messageIndex: existingMessageCount,
      queuedPrompts: [],
      abortController: new AbortController(),
      pendingRequests: [],
      hasTerminalError: false,
      turnFinalized: false,
      lastTerminalStatus: null,
      stopRequested: false,
      agentMemoryCaptureEligible:
        task.type === 'agent' && (step.type === 'agent' || step.type === 'fork'),
      previousResultFallback: step.output,
      queuedPromptIdsBySubmissionId: new Map(),
    };

    this.sessions.set(stepId, session);
    dbg.agentSession(
      'Created session for step %s (task: %s, backend: %s, resuming: %s, messageIndex: %d)',
      stepId,
      step.taskId,
      backendType,
      session.sdkSessionId ? 'yes' : 'no',
      existingMessageCount,
    );
    return session;
  }

  private trackBackendRun(
    stepId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const owner = Symbol(stepId);
    const promise = this.backendRunContext.run(owner, operation);
    const trackedRun = { owner, promise };
    this.backendRunCompletions.set(stepId, trackedRun);
    void promise.then(
      () => {
        if (this.backendRunCompletions.get(stepId) === trackedRun) {
          this.backendRunCompletions.delete(stepId);
        }
      },
      () => {
        if (this.backendRunCompletions.get(stepId) === trackedRun) {
          this.backendRunCompletions.delete(stepId);
        }
      },
    );
    return promise;
  }

  private async waitForBackendRun(
    stepId: string,
    trackedRun = this.backendRunCompletions.get(stepId),
  ): Promise<void> {
    if (!trackedRun || this.backendRunContext.getStore() === trackedRun.owner) {
      return;
    }
    await trackedRun.promise;
  }

  private async waitForPreviousBackendRun(stepId: string): Promise<void> {
    try {
      await this.waitForBackendRun(stepId);
    } catch (error) {
      dbg.agentSession(
        'Previous backend run for step %s failed before replacement: %O',
        stepId,
        error,
      );
    }
  }

  private async stopRunHandle(runHandle: AgentRunHandle): Promise<void> {
    const existingStop = this.runStopPromises.get(runHandle);
    if (existingStop) {
      await existingStop;
      return;
    }

    const stopPromise = runHandle.stop();
    this.runStopPromises.set(runHandle, stopPromise);
    await stopPromise;
  }

  private async disposeRunHandle(runHandle: AgentRunHandle): Promise<void> {
    const existingDispose = this.runDisposePromises.get(runHandle);
    if (existingDispose) {
      await existingDispose;
      return;
    }

    const disposePromise = runHandle.dispose();
    this.runDisposePromises.set(runHandle, disposePromise);
    await disposePromise;
  }

  private async cleanupRunHandle(runHandle: AgentRunHandle): Promise<void> {
    const existingCleanup = this.runCleanupPromises.get(runHandle);
    if (existingCleanup) {
      await existingCleanup;
      return;
    }

    const cleanupPromise = (async () => {
      try {
        await this.stopRunHandle(runHandle);
      } finally {
        await this.disposeRunHandle(runHandle);
      }
    })();
    this.runCleanupPromises.set(runHandle, cleanupPromise);
    await cleanupPromise;
  }

  private async stopCurrentRunHandle(
    stepId: string,
    session: ActiveSession,
  ): Promise<void> {
    const runHandles: AgentRunHandle[] = [];
    const activeRunHandle = session.runHandle;
    const startingRun = session.runStartPromise;

    if (activeRunHandle) {
      runHandles.push(activeRunHandle);
    }

    const startedRunHandle =
      (await startingRun?.catch((error) => {
        dbg.agentSession(
          'Backend startup for step %s failed while stopping: %O',
          stepId,
          error,
        );
        return null;
      })) ??
      null;

    if (startedRunHandle) {
      runHandles.push(startedRunHandle);
    }

    if (runHandles.length === 0) {
      return;
    }

    await Promise.all(
      [...new Set(runHandles)].map((runHandle) =>
        this.cleanupRunHandle(runHandle),
      ),
    );
  }

  // --- Main event loop ---

  /**
   * Run the agent backend for a step, processing events from the backend's
   * event stream. Handles message persistence, permission/question forwarding,
   * result handling, and queued prompts.
   */
  private async runBackend(
    stepId: string,
    parts: PromptPart[],
    session: ActiveSession,
    options?: {
      generateNameOnInit?: boolean;
      initialPrompt?: string;
      isInitialPrompt?: boolean;
      onRunStarting?: () => void;
    },
  ): Promise<void> {
    if (session.stopRequested) return;
    const { taskId } = session;
    const task = await TaskRepository.findById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const project = await ProjectRepository.findById(task.projectId);
    if (!project) {
      throw new Error(`Project ${task.projectId} not found`);
    }

    // Validate worktree exists if this is a worktree task
    if (task.worktreePath && !(await pathExists(task.worktreePath))) {
      throw new Error(
        `The worktree for this task has been deleted. To continue working, ` +
          `create a new task or restore the worktree at: ${task.worktreePath}`,
      );
    }

    let workingDir = task.worktreePath ?? project.path;

    // Get step for mode/model
    const step = await TaskStepRepository.findById(stepId);
    if (!step) {
      throw new Error(`Step ${stepId} not found`);
    }
    assertPrReviewAgentRunAllowed({ task, step, provider: session.provider });

    // For skill-creation steps, use the workspace path as CWD
    if (step?.type === 'skill-creation' && isSkillCreationStepMeta(step.meta)) {
      await assertValidWorkspacePath(step.meta.workspacePath);
      if (!(await pathExists(step.meta.workspacePath))) {
        throw new Error(
          `The skill workspace has been deleted or cleaned up. ` +
            `Create a new skill task to continue.`,
        );
      }
      workingDir = step.meta.workspacePath;
    }

    // Baseline snapshot so shell commands that edit files (sed -i, scripts,
    // heredoc redirects) still show up in the prompt-group diff summary.
    session.shellEditToken = shellEditTracker.begin({ stepId, workingDir });

    dbg.agentSession(
      'runBackend for step %s (task %s): backend=%s, cwd=%s, resuming=%s',
      stepId,
      taskId,
      session.backendType,
      workingDir,
      session.sdkSessionId ? 'yes' : 'no',
    );

    if (session.stopRequested) return;

    // Create new abort controller for this query iteration
    session.abortController = new AbortController();
    session.turnFinalized = false;
    session.lastTerminalStatus = null;

    if (options?.generateNameOnInit && task.name === null) {
      // NOTE: fire-and-forget
      void this.generateAndPersistTaskName(
        taskId,
        stepId,
        options.initialPrompt ?? getPromptText(parts),
      ).catch((err) => {
        dbg.agent('Error generating task name: %O', err);
      });
    }

    // Load backend-agnostic permissions and compile for the target backend.
    const isWorktree = !!task.worktreePath;
    const sessionRules = isPrReviewChatStepMeta(step.meta)
      ? buildReadOnlyPrReviewSessionRules()
      : (step.sessionRules ?? {});
    session.permissionContext = {
      projectPath: project.path,
      workingDir,
      isWorktree,
    };
    const rules = await resolvePermissionRulesForStep({
      projectPath: project.path,
      workingDir,
      isWorktree,
      sessionRules,
    });

    const backendChanged = session.backendType !== session.requestedBackendType;
    const modelPreference =
      session.swapModel ?? (backendChanged ? undefined : step?.modelPreference);
    const thinkingEffort =
      session.swapThinkingEffort ??
      (backendChanged ? undefined : step?.thinkingEffort);
    const normalizedThinkingEffort = normalizeThinkingEffortForModel({
      backend: session.backendType,
      model: modelPreference ?? 'default',
      effort: thinkingEffort,
      allowCopilotEffortWithoutCapabilities: true,
    });
    session.currentModel = modelPreference ?? null;

    let jcMcpRegistrationId: string | null = null;
    let runHandle: AgentRunHandle | null = null;
    let resourceMonitorOwner: symbol | undefined;
    try {
      let mcpServers: AgentBackendConfig['mcpServers'];
      if (session.backendType !== 'codex') {
        const questionBridge = await this.jcMcpBridgeService.registerStep({
          taskId,
          stepId,
          onQuestionRequest: async (request) => {
            await this.enqueueQuestionRequest(
              stepId,
              session,
              request,
              'jc-mcp',
            );
          },
          onQuestionCancelled: async (requestId) => {
            await this.cancelPendingQuestionRequest(
              stepId,
              session,
              requestId,
            );
          },
        });
        jcMcpRegistrationId = questionBridge.registrationId;
        mcpServers = buildJcMcpServersConfigForCwd({
          cwd: workingDir,
          questionBridge,
          enableAgentTool: step?.type === 'feature-map',
          enableReviewTool: step?.type === 'review',
          environmentMode: session.backendType === 'opencode' ? 'argv' : 'env',
        });
      }

      // Start the backend
      dbg.agentSession('Starting backend for step %s', stepId);
      const effectiveParts =
        step?.type === 'feature-map'
          ? parts
          : await applyConfiguredPromptPreface({
              parts,
              projectPath: project.path,
              isInitialPrompt: options?.isInitialPrompt ?? false,
              backend: session.backendType,
              model: modelPreference ?? 'default',
            });

      if (session.backendType === 'opencode' || session.backendType === 'vibe') {
        const promptText = buildAgentPromptMarkdown(effectiveParts).trim();
        if (promptText) {
          await this.persistAndEmitSyntheticEntry(taskId, session, {
            id: nanoid(),
            date: new Date().toISOString(),
            isSynthetic: true,
            type: 'user-prompt',
            value: promptText,
            isSDKSynthetic: true,
          });
        }
      }

      const config = {
        type: session.backendType,
        cwd: workingDir,
        interactionMode: normalizeInteractionModeForBackend({
          backend: session.backendType,
          mode: (step?.interactionMode ??
            getDefaultInteractionModeForBackend({
              backend: session.backendType,
            })) as InteractionMode,
        }),
        model:
          modelPreference && modelPreference !== 'default'
            ? modelPreference
            : undefined,
        thinkingEffort:
          normalizedThinkingEffort !== 'default'
            ? normalizedThinkingEffort
            : undefined,
        sessionId: session.sdkSessionId ?? undefined,
        persistedSessionRules: sessionRules,
        permissionRules: rules,
        mcpServers,
      };

      const runCapability = requireCapability(
        session.provider.id,
        'agent.run',
        session.provider.capabilities.agent
          .run as Capability<RunAgentCapability>,
      );
      if (session.stopRequested) return;
      session.runStartPromise = runCapability.start({
        context: session.agentTaskContext,
        config,
        parts: effectiveParts,
      });
      options?.onRunStarting?.();
      runHandle = await session.runStartPromise;

      session.runHandle = runHandle;
      session.runStartPromise = undefined;

      resourceMonitorOwner = agentResourceMonitorService.start({
        taskId,
        stepId,
        backend: session.backendType,
        rootPid: runHandle.rootPid ?? null,
      });

      for await (const event of runHandle.events) {
        if (session.abortController.signal.aborted) {
          dbg.agentSession('Step %s aborted, breaking event loop', stepId);
          break;
        }

        await this.processEvent(stepId, session, event, runHandle);
      }
    } finally {
      // An interrupted turn still changed files, and no `result` event will
      // arrive to report them. Emits nothing when the turn ended normally,
      // because the `result` handler already consumed the diff.
      if (session.abortController.signal.aborted) {
        await this.emitTurnEditEntry(stepId, session);
      }
      if (jcMcpRegistrationId) {
        await this.jcMcpBridgeService.unregisterStep(stepId, jcMcpRegistrationId);
      }
      if (resourceMonitorOwner) {
        await agentResourceMonitorService.stop(stepId, resourceMonitorOwner);
      }
      if (runHandle) {
        await this.cleanupRunHandle(runHandle);
      }
    }

    // A step reactivated by post-result background activity may never get a
    // second `result` (the stream just ends). Drain anything queued during that
    // window, or close the step so it doesn't stay stuck on "running". Runs
    // after cleanup so it can safely start a follow-up run.
    await this.closeReactivatedStep(stepId, session, runHandle);
  }

  private enqueueResultUpdateUsage(
    sourceId: string,
    params: Parameters<typeof aiUsageTrackingService.recordUsage>[0],
  ): void {
    const previous = this.resultUpdateUsageQueues.get(sourceId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await aiUsageTrackingService.recordUsage(params);
      } catch (error) {
        dbg.agent('Failed to record result update usage: %O', error);
      }
    });

    this.resultUpdateUsageQueues.set(sourceId, next);
    void next.then(() => {
      if (this.resultUpdateUsageQueues.get(sourceId) === next) {
        this.resultUpdateUsageQueues.delete(sourceId);
      }
    });
  }

  /**
   * Queue a normalized question request and emit it through the existing inline UI path.
   */
  private async enqueueQuestionRequest(
    stepId: string,
    session: ActiveSession,
    request: NormalizedQuestionRequest,
    source: 'backend' | 'jc-mcp',
  ): Promise<void> {
    const { taskId } = session;

    session.pendingRequests.push({
      requestId: request.requestId,
      type: 'question',
      questionRequest: request,
      source,
    });

    // Step stays 'running' (agent session is active, just paused);
    // task-level status becomes 'waiting' for UI purposes.
    const task = await TaskRepository.update(taskId, { status: 'waiting' });
    emitTaskUpsert(task);
    this.emitEvent(taskId, stepId, { type: 'status', status: 'waiting' });

    if (session.pendingRequests.length === 1) {
      this.emitQuestionRequest(taskId, stepId, request);
    }

    await this.notifyTaskEvent({
      taskId,
      stepId,
      event: 'question',
      notificationId: `${taskId}:question`,
      title: 'Question from Agent',
      body: 'Task "{taskName}" has a question',
    });
  }

  private emitQuestionRequest(
    taskId: string,
    stepId: string,
    request: NormalizedQuestionRequest,
  ): void {
    this.emitEvent(taskId, stepId, {
      type: 'question',
      requestId: request.requestId,
      ...(request.contextReminder
        ? { contextReminder: request.contextReminder }
        : {}),
      questions: this.toAgentQuestions(request.questions),
    });
  }

  private toAgentQuestions(questions: NormalizedQuestion[]): AgentQuestion[] {
    const questionKeys = getStableQuestionKeys(questions);
    return questions.map((q, index) => ({
      key: questionKeys[index],
      ...(q.id !== undefined ? { id: q.id } : {}),
      ...(q.type !== undefined ? { type: q.type } : {}),
      question: q.question,
      header: q.header,
      options: q.options.map((o) => ({
        ...(o.id !== undefined ? { id: o.id } : {}),
        label: o.label,
        description: o.description,
        ...(o.recommended !== undefined
          ? { recommended: o.recommended }
          : {}),
      })),
      multiSelect: q.multiSelect,
      ...(q.required !== undefined ? { required: q.required } : {}),
      ...(q.allowFreeform !== undefined ? { allowFreeform: q.allowFreeform } : {}),
    }));
  }

  private async cancelPendingQuestionRequest(
    stepId: string,
    session: ActiveSession,
    requestId: string,
  ): Promise<void> {
    const requestIndex = session.pendingRequests.findIndex(
      (request) => request.requestId === requestId,
    );
    if (requestIndex === -1) return;

    const [request] = session.pendingRequests.splice(requestIndex, 1);
    if (request.type !== 'question') return;

    this.emitEvent(session.taskId, stepId, {
      type: 'question',
      requestId,
      questions: [],
    });

    if (session.pendingRequests.length === 0) {
      const task = await TaskRepository.update(session.taskId, {
        status: 'running',
      });
      emitTaskUpsert(task);
      this.emitEvent(session.taskId, stepId, { type: 'status', status: 'running' });
      return;
    }

    const next = session.pendingRequests[0];
    if (next.type === 'question' && next.questionRequest) {
      this.emitQuestionRequest(session.taskId, stepId, next.questionRequest);
    } else if (next.type === 'permission' && next.permissionRequest) {
      this.emitEvent(session.taskId, stepId, {
        type: 'permission',
        ...next.permissionRequest,
      });
    }
  }

  /**
   * Process a single event from the backend event stream.
   */
  /**
   * The Claude backend reports a `result` for the main turn while background
   * subagents (and the follow-up turn they trigger) keep streaming on the same
   * run handle. When live activity arrives after we already finalized the turn,
   * flip the step back to `running` so the UI stops showing it as done.
   */
  private async reactivateAfterFinalizedTurn(
    stepId: string,
    session: ActiveSession,
    runHandle: AgentRunHandle | null,
  ): Promise<void> {
    if (!session.turnFinalized) return;
    if (session.stopRequested || session.hasTerminalError) return;
    if (this.sessions.get(stepId) !== session) return;
    // Late events from a superseded run handle must not resurrect the step.
    if (session.runHandle !== runHandle) return;
    if (session.abortController.signal.aborted) return;

    const step = await TaskStepRepository.findById(stepId);
    if (!step) return;
    session.turnFinalized = false;
    if (step.status === 'running') return;

    dbg.agentSession(
      'Step %s received activity after result — restoring running state',
      stepId,
    );
    await StepService.update(stepId, { status: 'running' });
    // A pending permission/question keeps the task on `waiting` even though the
    // step is running — don't let the sync clobber that.
    if (session.pendingRequests.length === 0) {
      await StepService.syncTaskStatus(session.taskId);
    }
    this.emitEvent(session.taskId, stepId, {
      type: 'status',
      status: session.pendingRequests.length > 0 ? 'waiting' : 'running',
    });
  }

  /** Pop the next queued prompt and its associated parts/capture metadata. */
  private takeNextQueuedPrompt(session: ActiveSession): {
    prompt: QueuedPrompt;
    parts: PromptPart[];
    capture: ReturnType<typeof queuedPromptCaptures.get>;
  } | null {
    const prompt = session.queuedPrompts.shift();
    if (!prompt) return null;
    const parts =
      queuedPromptParts.get(prompt.id) ?? textPrompt(prompt.content);
    const capture = queuedPromptCaptures.get(prompt.id);
    queuedPromptParts.delete(prompt.id);
    queuedPromptCaptures.delete(prompt.id);
    tombstoneQueuedPromptSubmissionIds(session, prompt.id);
    return { prompt, parts, capture };
  }

  /**
   * Runs once the backend stream ends. Only does something when the step was
   * flipped back to `running` by post-result activity (background subagents)
   * and no second `result` arrived: drains a prompt queued during that window,
   * otherwise restores the terminal status so the step can't stay stuck.
   */
  private async closeReactivatedStep(
    stepId: string,
    session: ActiveSession,
    runHandle: AgentRunHandle | null,
  ): Promise<void> {
    // Ownership guards run BEFORE consuming the session-scoped terminal state,
    // so a superseded run frame can't swallow the current run's status.
    if (this.sessions.get(stepId) !== session) return;
    if (session.runHandle !== runHandle) return;

    const status = session.lastTerminalStatus;
    session.lastTerminalStatus = null;
    if (!status || session.turnFinalized) return;

    if (session.stopRequested || session.hasTerminalError) return;
    if (session.abortController.signal.aborted) return;

    // A prompt queued while the step was reactivated would otherwise be lost,
    // because only the `result` handler drains the queue.
    const queued = this.takeNextQueuedPrompt(session);
    if (queued && status === 'errored') {
      // Mirror the result handler: an errored turn discards the queue.
      this.emitEvent(session.taskId, stepId, {
        type: 'queue-update',
        queuedPrompts: session.queuedPrompts,
      });
    }
    if (queued && status === 'completed') {
      dbg.agentSession(
        'Step %s draining prompt queued after post-result activity',
        stepId,
      );
      this.emitEvent(session.taskId, stepId, {
        type: 'queue-update',
        queuedPrompts: session.queuedPrompts,
      });
      if (queued.capture && session.agentMemoryCaptureEligible) {
        void captureAgentMemoryPromptSubmissionSafe({
          source: 'queued-prompt',
          sourceId: `queued-prompt:${queued.prompt.id}`,
          projectId: session.projectId,
          taskId: session.taskId,
          stepId,
          userText: queued.capture.userText,
          previousAgentResult: session.previousResultFallback,
          reviews: queued.capture.reviews,
        });
      }
      await this.runBackend(stepId, queued.parts, session);
      return;
    }

    const step = await TaskStepRepository.findById(stepId);
    if (!step || step.status !== 'running') return;

    dbg.agentSession(
      'Step %s stream ended after post-result activity — restoring %s',
      stepId,
      status,
    );
    this.clearPendingRequests(session);
    if (status === 'errored') {
      await StepService.errorStep(stepId);
    } else {
      // Dependent steps were already auto-started at the premature `result`,
      // so the returned ids are intentionally ignored here.
      await StepService.completeStep(stepId);
    }
    await this.markTaskUnreadIfBackground(session.taskId);
    this.emitEvent(session.taskId, stepId, { type: 'status', status });
  }

  private async processEvent(
    stepId: string,
    session: ActiveSession,
    event: AgentEvent,
    runHandle: AgentRunHandle | null = null,
  ): Promise<void> {
    const { taskId } = session;

    // Any live activity after a finalized turn means background work (usually a
    // subagent) is still running on this handle. Permission/question events
    // count too — otherwise a post-result prompt would land on a step the UI
    // still shows as completed.
    if (
      event.type === 'entry' ||
      event.type === 'entry-update' ||
      event.type === 'tool-result' ||
      event.type === 'permission-request' ||
      event.type === 'question'
    ) {
      await this.reactivateAfterFinalizedTurn(stepId, session, runHandle);
    }

    switch (event.type) {
      case 'session-id': {
        session.sdkSessionId = event.sessionId;
        // Only persist the first session ID — once set it is immutable.
        const existing = await TaskStepRepository.findById(stepId);
        if (!existing?.sessionId) {
          const updatedStep = await TaskStepRepository.update(
            stepId,
            buildSessionIdStepUpdate({
              sessionId: event.sessionId,
              backendType: session.backendType,
              requestedBackendType: session.requestedBackendType,
              swapModel: session.swapModel,
              swapThinkingEffort: session.swapThinkingEffort,
            }),
          );
          emitStepUpsert(updatedStep);
          dbg.agentSession(
            'Captured session ID for step %s: %s',
            stepId,
            event.sessionId,
          );
        } else {
          dbg.agentSession(
            'Session ID already set for step %s (%s), ignoring new value: %s',
            stepId,
            existing.sessionId,
            event.sessionId,
          );
        }
        break;
      }

      case 'entry': {
        try {
          await AgentMessageRepository.create({
            taskId,
            stepId,
            messageIndex: session.messageIndex++,
            entry: event.entry,
            rawMessageId: event.rawMessageId,
          });
        } catch (error) {
          dbg.agent('Failed to persist entry: %O', error);
        }
        this.emitEvent(taskId, stepId, { type: 'entry', entry: event.entry });
        break;
      }

      case 'entry-update': {
        try {
          await AgentMessageRepository.updateEntry({
            taskId,
            entry: event.entry,
          });
        } catch (error) {
          dbg.agent('Failed to update entry: %O', error);
        }
        this.emitEvent(taskId, stepId, {
          type: 'entry-update',
          entry: event.entry,
        });
        break;
      }

      case 'tool-result': {
        try {
          await AgentMessageRepository.updateToolResult({
            taskId,
            toolId: event.toolId,
            result: event.result,
            isError: event.isError,
            durationMs: event.durationMs,
          });
        } catch (error) {
          dbg.agent('Failed to update tool result: %O', error);
        }
        this.emitEvent(taskId, stepId, {
          type: 'tool-result',
          toolId: event.toolId,
          result: event.result,
          isError: event.isError,
          durationMs: event.durationMs,
        });
        break;
      }

      case 'result-update': {
        const result = event.result;
        if (result.usage || result.cost) {
          const sourceId = `agent-result-update:${session.sdkSessionId ?? session.runHandle?.runId ?? stepId}`;
          this.enqueueResultUpdateUsage(sourceId, {
            context: {
              feature: session.usageFeature,
              projectId: session.projectId,
              taskId,
              stepId,
            },
            backend: session.backendType,
            model: result.model ?? session.currentModel,
            usage: result.usage ?? {},
            allowEmptyUsage: !result.usage,
            cost: result.cost,
            sourceId,
          });
        }
        break;
      }

      case 'permission-request': {
        const request = event.request;
        const shouldEmit = session.pendingRequests.length === 0;
        session.pendingRequests.push({
          requestId: request.requestId,
          type: 'permission',
          permissionRequest: request,
        });
        if (this.autoAcceptSteps.has(stepId)) {
          dbg.agentPermission(
            'Auto-accepting request %s for step %s (session auto-accept)',
            request.requestId,
            stepId,
          );
          void this.autoAcceptRequest(stepId, session, request.requestId);
          break;
        }
        if (shouldEmit) {
          await this.emitPendingRequest(session, session.pendingRequests[0]);
        }
        break;
      }

      case 'question': {
        await this.enqueueQuestionRequest(
          stepId,
          session,
          event.request,
          'backend',
        );
        break;
      }

      case 'complete': {
        const result = event.result;
        dbg.agentSession(
          'Step %s received result (isError: %s, queued: %d)',
          stepId,
          result.isError,
          session.queuedPrompts.length,
        );

        if (result.isError && session.hasTerminalError) {
          dbg.agentSession(
            'Skipping duplicate errored completion for step %s after terminal error',
            stepId,
          );
          break;
        }
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;

        await this.emitTurnEditEntry(stepId, session);

        const resultEntryId = nanoid();

        const resultModel = result.model ?? session.currentModel;

        if (result.usage || result.cost) {
          aiUsageTrackingService.recordUsageSafe({
            context: {
              feature: session.usageFeature,
              projectId: session.projectId,
              taskId,
              stepId,
            },
            backend: session.backendType,
            model: resultModel,
            usage: result.usage ?? {},
            allowEmptyUsage: !result.usage,
            cost: result.cost,
            sourceId: `agent-message:${resultEntryId}`,
          });
        }

        // Sync provider-reported session tools back to the current step.
        const sessionAllowedToolsCapability =
          session.provider.capabilities.agent.sessionAllowedTools;
        if (sessionAllowedToolsCapability.supported && session.runHandle) {
          const tools = sessionAllowedToolsCapability.implementation.list({
            handle: session.runHandle,
          });
          if (tools.length > 0) {
            await stepPermissionService.syncSessionAllowedTools({ stepId, tools });
          }
        }

        // Keep the fallback fresh so later prompt captures (including the
        // post-result drain path) attribute the right previous result.
        session.previousResultFallback =
          result.text ?? session.previousResultFallback;

        // Check for queued prompts
        const nextPrompt = session.queuedPrompts.shift();
        if (nextPrompt && result.isError) {
          queuedPromptParts.delete(nextPrompt.id);
          queuedPromptCaptures.delete(nextPrompt.id);
          tombstoneQueuedPromptSubmissionIds(session, nextPrompt.id);
        }
        if (nextPrompt && !result.isError) {
          dbg.agentSession('Step %s processing next queued prompt', stepId);
          this.emitEvent(taskId, stepId, {
            type: 'queue-update',
            queuedPrompts: session.queuedPrompts,
          });
          // Recursively process next queued prompt
          const queuedParts =
            queuedPromptParts.get(nextPrompt.id) ??
            textPrompt(nextPrompt.content);
          const capture = queuedPromptCaptures.get(nextPrompt.id);
          queuedPromptParts.delete(nextPrompt.id);
          queuedPromptCaptures.delete(nextPrompt.id);
          tombstoneQueuedPromptSubmissionIds(session, nextPrompt.id);
          if (capture && session.agentMemoryCaptureEligible) {
            void captureAgentMemoryPromptSubmissionSafe({
              source: 'queued-prompt',
              sourceId: `queued-prompt:${nextPrompt.id}`,
              projectId: session.projectId,
              taskId,
              stepId,
              userText: capture.userText,
              previousAgentResult: result.text ?? null,
              reviews: capture.reviews,
            });
          }
          return await this.runBackend(stepId, queuedParts, session);
        }

        // No more queued prompts - finalize
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;
        let autoStartStepIds: string[] = [];
        if (result.isError) {
          await StepService.errorStep(stepId);
        } else {
          autoStartStepIds = await StepService.completeStep(stepId);
        }
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;

        await this.persistAndEmitSyntheticEntry(taskId, session, {
          id: resultEntryId,
          date: new Date().toISOString(),
          model: resultModel ?? undefined,
          isSynthetic: true,
          type: 'result',
          value: result.text,
          isError: result.isError,
          durationMs: result.durationMs,
          cost: result.cost?.costUsd,
          apiCost: result.cost?.apiCostUsd,
          usage: result.usage,
          contextUsage: result.contextUsage,
        });
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;

        const status = result.isError ? 'errored' : 'completed';
        this.clearPendingRequests(session);

        // Mark as unread BEFORE emitting the status event so the feed
        // re-fetch (triggered by the event) reads the updated value.
        await this.markTaskUnreadIfBackground(taskId);
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;

        this.emitEvent(taskId, stepId, { type: 'status', status });
        // Background subagents may still stream on this run handle; any further
        // activity flips the step back to running.
        session.turnFinalized = true;
        session.lastTerminalStatus = status;

        // Auto-start dependent steps whose dependencies are now satisfied
        for (const autoStepId of autoStartStepIds) {
          dbg.agent(
            'Auto-starting dependent step %s (task %s)',
            autoStepId,
            taskId,
          );
          startAgentWithPrReviewLifecycle(
            autoStepId,
            (authoritativeStepId) => this.start(authoritativeStepId),
            {
              findStepById: TaskStepRepository.findById,
              findTaskById: TaskRepository.findById,
            },
          ).catch((err) => {
            void this.handleAutoStartFailure(autoStepId, err);
          });
        }

        await this.notifyTaskEvent({
          taskId,
          stepId,
          event: status === 'completed' ? 'completed' : 'errored',
          notificationId: `${taskId}:complete`,
          title: status === 'completed' ? 'Task Completed' : 'Task Failed',
          body:
            status === 'completed'
              ? 'Task "{taskName}" finished successfully'
              : 'Task "{taskName}" encountered an error',
          guard: () =>
            this.sessions.get(stepId) === session && !session.stopRequested,
        });
        break;
      }

      case 'error': {
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;
        dbg.agent('Backend error for step %s: %s', stepId, event.error);
        session.hasTerminalError = true;
        this.clearPendingRequests(session);

        await this.emitTurnEditEntry(stepId, session);

        // Emit a synthetic error entry so the user sees the error in the timeline
        await this.persistAndEmitSyntheticEntry(taskId, session, {
          id: nanoid(),
          date: new Date().toISOString(),
          isSynthetic: true,
          type: 'result',
          value: event.error,
          isError: true,
        });
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;

        if (event.interrupted) {
          await StepService.interruptStep(stepId);
        } else {
          await StepService.errorStep(stepId);
        }
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;
        await this.markTaskUnreadIfBackground(taskId);
        if (await this.shouldAbortTerminalHandling(stepId, session)) break;
        this.emitEvent(taskId, stepId, {
          type: 'status',
          status: event.interrupted ? 'interrupted' : 'errored',
          error: event.error,
        });
        await this.notifyTaskEvent({
          taskId,
          stepId,
          event: 'errored',
          notificationId: `${taskId}:error`,
          title: 'Task Failed',
          body: 'Task "{taskName}" encountered an error',
          guard: () =>
            this.sessions.get(stepId) === session && !session.stopRequested,
        });
        break;
      }

      case 'rate-limit': {
        const message =
          event.message || 'Rate limit reached — retrying automatically';
        dbg.agent(
          'Rate limit for task %s: %s (retryAfterMs: %s)',
          taskId,
          message,
          event.retryAfterMs,
        );

        // Emit a non-terminal assistant entry so the user sees the retry state
        // without closing the current prompt group.
        await this.persistAndEmitSyntheticEntry(taskId, session, {
          id: nanoid(),
          date: new Date().toISOString(),
          isSynthetic: true,
          type: 'assistant-message',
          value: message,
        });
        break;
      }

      case 'mode-change': {
        const step = await TaskStepRepository.findById(stepId);
        if (step && isPrReviewChatStepMeta(step.meta)) {
          if (event.mode !== 'ask') {
            const modeCapability =
              session.provider.capabilities.agent.runtimeModeSwitch;
            if (!modeCapability.supported || !session.runHandle) {
              throw new Error(
                'PR review chat backend changed mode and cannot restore read-only mode',
              );
            }
            await modeCapability.implementation.setMode({
              handle: session.runHandle,
              mode: 'ask',
            });
          }
          break;
        }
        const updatedStep = await TaskStepRepository.update(stepId, {
          interactionMode: event.mode,
        });
        emitStepUpsert(updatedStep);
        break;
      }

      default:
        // Other event types (session-updated, tool-state-update, etc.)
        // are logged but not actively handled yet
        dbg.agent('Unhandled event type for step %s: %s', stepId, event.type);
        break;
    }
  }

  // --- Public API ---

  async start(stepId: string): Promise<void> {
    const completeRegistration = this.admitSessionRegistration(stepId, 'ignore');
    if (!completeRegistration) return;
    const pendingStop = this.stepStopPromises.get(stepId);
    if (pendingStop) {
      await pendingStop;
    }

    // Check if already running
    if (this.sessions.has(stepId)) {
      dbg.agentSession('Ignoring duplicate start for running step %s', stepId);
      completeRegistration();
      return;
    }

    // Prevent concurrent starts for the same step while start() is still
    // resolving prompt/dependencies and creating the in-memory session.
    if (this.startingSteps.has(stepId)) {
      dbg.agentSession('Ignoring duplicate start for pending step %s', stepId);
      completeRegistration();
      return;
    }

    this.startingSteps.add(stepId);
    let finishStart!: () => void;
    const startPromise = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    this.stepStartPromises.set(stepId, startPromise);

    let session: ActiveSession | null = null;
    let runningStep: Awaited<ReturnType<typeof TaskStepRepository.findById>>;

    try {
      await this.waitForPreviousBackendRun(stepId);
      runningStep = await TaskStepRepository.findById(stepId);
      if (!runningStep) {
        throw new Error(`Step ${stepId} not found`);
      }

      const preflightTask = await TaskRepository.findById(runningStep.taskId);
      if (!preflightTask) {
        throw new Error(`Task ${runningStep.taskId} not found`);
      }
      const preflightBackend = (runningStep.agentBackend ??
        'claude-code') as AgentBackendType;
      const preflightProvider = getAgentBackendProvider(preflightBackend);
      if (!preflightProvider) {
        throw new Error(`Unknown agent backend: "${preflightBackend}"`);
      }
      assertPrReviewAgentRunAllowed({
        task: preflightTask,
        step: runningStep,
        provider: preflightProvider,
      });

      // Surface work immediately while continue-summary synthesis runs.
      await StepService.update(stepId, { status: 'running' });
      await StepService.syncTaskStatus(runningStep.taskId);

      // Create session before prompt resolution so synthetic summary entries can
      // appear in timeline while {{summary(step.*)}} resolves.
      session = await this.createSession(stepId);
      completeRegistration();
      this.emitEvent(session.taskId, stepId, {
        type: 'status',
        status: 'running',
      });

      // Resolve prompt and validate dependencies
      const promptResolutionStartedAt = Date.now();
      dbg.agentSession('Resolving startup prompt for step %s', stepId);
      const { resolvedPrompt, step } = await StepService.resolveAndValidate(
        stepId,
        {
          onSummaryLifecycle: {
            onStart: async (summaryStep, prompt) => {
              if (!session) return;
              await this.persistAndEmitSyntheticEntry(session.taskId, session, {
                id: nanoid(),
                date: new Date().toISOString(),
                isSynthetic: true,
                type: 'user-prompt',
                value: prompt,
                isSDKSynthetic: true,
              });
            },
            onResolved: async (summaryStep, summary) => {
              if (!session) return;
              await this.persistAndEmitSyntheticEntry(session.taskId, session, {
                id: nanoid(),
                date: new Date().toISOString(),
                isSynthetic: true,
                type: 'assistant-message',
                value: `Summary for "${summaryStep.name}":\n\n${summary}`,
              });
            },
          },
        },
      );
      dbg.agentSession(
        'Resolved startup prompt for step %s in %dms (length=%d)',
        stepId,
        Date.now() - promptResolutionStartedAt,
        resolvedPrompt.length,
      );

      // Build prompt parts from resolved prompt + any pending image attachments
      const pendingImages = this.pendingImageAttachments.get(session.taskId);
      this.pendingImageAttachments.delete(session.taskId);

      // For review steps, build the review prompt from reviewer configs
      let effectivePrompt = resolvedPrompt;
      if (step.type === 'review') {
        const task = await TaskRepository.findById(step.taskId);
        const meta = step.meta as ReviewStepMeta;
        effectivePrompt = buildReviewPrompt({
          basePrompt: resolvedPrompt,
          meta,
          startCommitHash: task?.startCommitHash ?? null,
          workItemContext: meta.workItemContext,
        });
      }

      const parts: PromptPart[] = textPrompt(effectivePrompt);
      // Include images persisted on the step
      if (step.images && step.images.length > 0) {
        parts.push(...step.images);
      }
      // Include transient pending images (from initial task creation)
      if (pendingImages && pendingImages.length > 0) {
        parts.push(...pendingImages);
      }

      // Only generate the task name on the first step (sortOrder 0).
      // Subsequent steps should not overwrite an already-generated name.
      const isFirstStep = step.sortOrder === 0;

      dbg.agentSession('Starting agent for step %s', stepId);
      const activeSession = session;
      let markRunStarting!: () => void;
      const runStarting = new Promise<void>((resolve) => {
        markRunStarting = resolve;
      });
      this.trackBackendRun(stepId, () =>
        this.runBackend(stepId, parts, activeSession, {
          generateNameOnInit: isFirstStep,
          initialPrompt: step.promptTemplate,
          isInitialPrompt: true,
          onRunStarting: markRunStarting,
        })
          .catch(async (error: unknown) => {
            const isCurrentSession = () =>
              this.sessions.get(stepId) === activeSession;
            if (!isCurrentSession()) {
              dbg.agent(
                'Ignoring stale start failure for replaced step %s: %O',
                stepId,
                error,
              );
              return;
            }
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          dbg.agent('Step %s start failed: %s', stepId, errorMessage);

          // Emit a synthetic error entry so the user sees the error in the timeline
          await this.persistAndEmitSyntheticEntry(activeSession.taskId, activeSession, {
            id: nanoid(),
            date: new Date().toISOString(),
            isSynthetic: true,
            type: 'result',
            value: errorMessage,
            isError: true,
          });
          if (!isCurrentSession()) return;

          await StepService.errorStep(stepId);
          if (!isCurrentSession()) return;
          this.emitEvent(activeSession.taskId, stepId, {
            type: 'status',
            status: 'errored',
            error: errorMessage,
          });
          if (!isCurrentSession()) return;
          await this.notifyTaskEvent({
            taskId: activeSession.taskId,
            stepId,
            event: 'errored',
            notificationId: `${activeSession.taskId}:start-error:${stepId}`,
            title: 'Task Failed',
            body: 'Task "{taskName}" encountered an error',
          });
          })
          .finally(() => {
            markRunStarting();
            this.deleteSession(stepId, activeSession);
          }),
      );
      await runStarting;
    } catch (error) {
      if (!session) {
        throw error;
      }
      const isCurrentSession = () => this.sessions.get(stepId) === session;
      if (!isCurrentSession()) {
        dbg.agent(
          'Ignoring stale startup failure for replaced step %s: %O',
          stepId,
          error,
        );
        return;
      }

      if (session.stopRequested) return;

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      dbg.agent('Step %s startup failed: %s', stepId, errorMessage);

      await this.persistAndEmitSyntheticEntry(session.taskId, session, {
        id: nanoid(),
        date: new Date().toISOString(),
        isSynthetic: true,
        type: 'result',
        value: errorMessage,
        isError: true,
      });
      if (!isCurrentSession()) return;

      await StepService.errorStep(stepId);
      if (!isCurrentSession()) return;
      this.emitEvent(session.taskId, stepId, {
        type: 'status',
        status: 'errored',
        error: errorMessage,
      });
      if (!isCurrentSession()) return;
      await this.notifyTaskEvent({
        taskId: session.taskId,
        stepId,
        event: 'errored',
        notificationId: `${session.taskId}:startup-error:${stepId}`,
        title: 'Task Failed',
        body: 'Task "{taskName}" encountered an error',
      });
      this.deleteSession(stepId, session);
    } finally {
      completeRegistration();
      if (this.stepStartPromises.get(stepId) === startPromise) {
        this.startingSteps.delete(stepId);
        this.stepStartPromises.delete(stepId);
      }
      finishStart();
    }
  }

  async stop(
    stepId: string,
    options: { reason?: 'user' | 'shutdown' } = {},
  ): Promise<void> {
    const existingStop = this.stepStopPromises.get(stepId);
    if (existingStop) {
      const backendRun = this.backendRunCompletions.get(stepId);
      if (
        backendRun &&
        this.backendRunContext.getStore() === backendRun.owner
      ) {
        return;
      }
      await existingStop;
      return;
    }

    const stopPromise = this.performStop(stepId, options).finally(() => {
      if (this.stepStopPromises.get(stepId) === stopPromise) {
        this.stepStopPromises.delete(stepId);
      }
    });
    this.stepStopPromises.set(stepId, stopPromise);
    await stopPromise;
  }

  private async performStop(
    stepId: string,
    options: { reason?: 'user' | 'shutdown' },
  ): Promise<void> {
    dbg.agentSession('Stopping step %s', stepId);

    let session = this.sessions.get(stepId);
    if (!session) {
      await this.stepStartPromises.get(stepId);
      session = this.sessions.get(stepId);
    }

    const backendRun = this.backendRunCompletions.get(stepId);
    if (!session) {
      await this.waitForBackendRun(stepId, backendRun);
      dbg.agentSession('No session found for step %s, nothing to stop', stepId);
      return;
    }

    session.stopRequested = true;

    const { taskId } = session;

    // Clear queued prompts and their stored parts
    tombstoneAllQueuedPromptSubmissionIds(session);
    for (const prompt of session.queuedPrompts) {
      queuedPromptParts.delete(prompt.id);
      queuedPromptCaptures.delete(prompt.id);
    }
    session.queuedPrompts = [];
    this.emitEvent(taskId, stepId, {
      type: 'queue-update',
      queuedPrompts: [],
    });

    this.questionBroker.cancelSession(stepId, 'Agent session stopped');
    await this.jcMcpBridgeService.unregisterStep(stepId);

    this.clearPendingRequests(session);

    session.abortController.abort();

    // Stop the provider run even if stop races with backend startup completing.
    await this.stopCurrentRunHandle(stepId, session);
    if (!this.stopAllActive) {
      await this.waitForBackendRun(stepId, backendRun);
    }
    await agentResourceMonitorService.stop(stepId);

    if (options.reason !== 'shutdown') {
      await this.persistAndEmitSyntheticEntry(taskId, session, {
        id: nanoid(),
        date: new Date().toISOString(),
        isSynthetic: true,
        type: 'result',
        value: 'Task interrupted by user',
        isError: true,
      });
    }

    await StepService.interruptStep(stepId);
    this.emitEvent(taskId, stepId, {
      type: 'status',
      status: 'interrupted',
      error:
        options.reason === 'shutdown'
          ? 'Stopped by app shutdown'
          : 'Stopped by user',
    });
    this.deleteSession(stepId, session);
    dbg.agentSession('Step %s stopped and session cleaned up', stepId);
  }

  stopAll(options: { reason?: 'user' | 'shutdown' } = {}): Promise<void> {
    if (this.stopAllPromise) return this.stopAllPromise;

    this.stopAllActive = true;
    const operation = this.performStopAll(options);
    const sharedOperation = operation.finally(() => {
      if (this.stopAllPromise === sharedOperation) {
        this.stopAllPromise = null;
        this.stopAllActive = false;
      }
    });
    this.stopAllPromise = sharedOperation;
    return sharedOperation;
  }

  private async performStopAll(options: {
    reason?: 'user' | 'shutdown';
  }): Promise<void> {
    await Promise.all([...this.pendingSessionRegistrations]);
    const stepIds = [...this.sessions.keys()];
    dbg.agentSession('Stopping all active agent sessions (%d)', stepIds.length);
    const results = await Promise.allSettled(
      stepIds.map((stepId) => this.stop(stepId, options)),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      dbg.agentSession(
        'Failed to stop %d active agent sessions during stopAll',
        failures.length,
      );
      throw new Error(
        `Failed to stop ${failures.length} active agent sessions`,
      );
    }
    dbg.agentSession('All active agent sessions stopped');
  }

  async respond(
    stepId: string,
    requestId: string,
    response: PermissionResponse | QuestionResponse,
  ): Promise<void> {
    const responseKey = `${stepId}:${requestId}`;
    let responsePromise = this.requestResponsePromises.get(responseKey);
    if (!responsePromise) {
      responsePromise = this.respondOnce(stepId, requestId, response);
      this.requestResponsePromises.set(responseKey, responsePromise);
    }

    try {
      await responsePromise;
    } finally {
      if (this.requestResponsePromises.get(responseKey) === responsePromise) {
        this.requestResponsePromises.delete(responseKey);
      }
    }
  }

  private async respondOnce(
    stepId: string,
    requestId: string,
    response: PermissionResponse | QuestionResponse,
  ): Promise<void> {
    dbg.agentPermission(
      'Responding to request %s for step %s',
      requestId,
      stepId,
    );
    const session = this.sessions.get(stepId);
    if (!session) {
      dbg.agentSession(
        'No active session for step %s, marking as interrupted',
        stepId,
      );
      const step = await TaskStepRepository.findById(stepId);
      if (step) {
        await StepService.update(stepId, { status: 'interrupted' });
        await StepService.syncTaskStatus(step.taskId);
        this.emitEvent(step.taskId, stepId, {
          type: 'status',
          status: 'interrupted',
          error: 'Session is no longer active',
        });
      }
      return;
    }

    const { taskId } = session;

    // Find the pending request. Keep it in place until provider response
    // succeeds so unsupported capabilities or transient failures can be retried.
    const requestIndex = session.pendingRequests.findIndex(
      (r) => r.requestId === requestId,
    );
    if (requestIndex === -1) {
      throw new Error(`No pending request with ID ${requestId}`);
    }

    const request = session.pendingRequests[requestIndex];

    // Forward to the backend
    if (request.type === 'permission') {
      const permResponse = response as PermissionResponse;
      if (!session.runHandle) {
        throw new Error(`No active run handle for step ${stepId}`);
      }
      const runHandle = session.runHandle;
      const permissionCapability = requireCapability(
        session.provider.id,
        'agent.permissions',
        session.provider.capabilities.agent.permissions,
      );

      let allowedDirectory: string | undefined;
      if (permResponse.allowedDirectory) {
        if (permResponse.behavior !== 'allow') {
          throw new Error('Directory access can only accompany an allow response');
        }
        const directoryAccess = request.permissionRequest?.directoryAccess;
        if (!directoryAccess) {
          throw new Error('Permission request does not support directory access');
        }
        allowedDirectory = validateAllowedDirectory(
          directoryAccess,
          permResponse.allowedDirectory,
        );
      }

      // Compute toolsToAllow from the pending request's tool name and input
      // so backends can update their in-memory session state.
      // If the response includes an explicit toolsToAllow override (e.g., from
      // "Allow All" buttons), use that instead of deriving from the request.
      let toolsToAllow: string[] | undefined;
      if (permResponse.behavior === 'allow') {
        if (allowedDirectory) {
          toolsToAllow = undefined;
        } else if (permResponse.toolsToAllow) {
          toolsToAllow = permResponse.toolsToAllow;
        } else if (request.permissionRequest) {
          const { toolName, input } = request.permissionRequest;
          const { tool, matchValue } = normalizeToolRequest(toolName, input);
          toolsToAllow = [matchValue ? `${tool}:${matchValue}` : tool];
        }
      }

      const respondToProvider = () =>
        permissionCapability.respond({
          handle: runHandle,
          requestId,
          response: {
            behavior: permResponse.behavior,
            updatedInput: permResponse.updatedInput,
            message: permResponse.message,
            allowMode: permResponse.allowMode,
            toolsToAllow,
            allowedDirectory,
          },
        });

      if (allowedDirectory) {
        await respondToProvider();
        try {
          const step = await TaskStepRepository.findById(stepId);
          if (!step) throw new Error(`Step ${stepId} not found`);
          const sessionRules = { ...(step.sessionRules ?? {}) };
          sessionRules.external_directory = buildToolPermissionConfig({
            existing: sessionRules.external_directory,
            matchValue: toDirectoryPermissionPattern(allowedDirectory),
          });
          const updatedStep = await TaskStepRepository.update(stepId, {
            sessionRules,
          });
          emitStepUpsert(updatedStep);
          // Keep the live session's rule snapshot in step with the DB, like
          // every other sessionRules write.
          emitPermissionsChanged({ scope: 'session', stepId });
        } catch (error) {
          // Provider already resumed; keep request resolved rather than showing
          // a stale card that cannot be answered again.
          dbg.agentPermission(
            'Directory allowed for current provider session but failed to persist for step %s: %O',
            stepId,
            error,
          );
        }
      } else {
        await respondToProvider();
      }
    } else {
      const questionResponse = response as QuestionResponse;
      if (!request.questionRequest) {
        throw new QuestionResponseValidationError(requestId);
      }
      const canonicalResponse = canonicalizeQuestionResponse({
        request: request.questionRequest,
        response: questionResponse,
      });
      if (request.source === 'jc-mcp') {
        this.questionBroker.answerRequest(requestId, canonicalResponse.answers);
      } else {
        if (!session.runHandle) {
          throw new Error(`No active run handle for step ${stepId}`);
        }
        const questionCapability = requireCapability(
          session.provider.id,
          'agent.questions',
          session.provider.capabilities.agent.questions,
        );
        await questionCapability.respond({
          handle: session.runHandle,
          requestId,
          answer: canonicalResponse.answers,
          metadata: {
            wasFreeform: questionResponse.wasFreeform,
            wasFreeformByQuestion: questionResponse.wasFreeformByQuestion,
            questionKeys: canonicalResponse.questionKeys,
          },
        });
      }

      if (session.agentMemoryCaptureEligible) {
        const createdAt = new Date().toISOString();
        for (const detail of canonicalResponse.memoryDetails) {
          // "Decide for me" is an explicit deferral, not a stated preference.
          // It still has to reach the agent, so it stays in the delivered
          // answer, but recording it would teach memory a preference the user
          // never expressed.
          const capturedCustomAnswer =
            detail.customAnswer === DECIDE_FOR_ME ? null : detail.customAnswer;
          const text = [
            ...detail.selectedLabels,
            capturedCustomAnswer,
            detail.notes,
          ]
            .filter((value): value is string => Boolean(value))
            .join('\n');
          if (!text) continue;
          void captureAgentMemoryEventSafe({
            source: 'question-answer',
            sourceId: `question:${requestId}:${detail.questionKey}`,
            projectId: session.projectId,
            taskId,
            stepId,
            text,
            context: {
              question: detail.question,
              selectedLabels: detail.selectedLabels,
              customAnswer: capturedCustomAnswer,
              notes: detail.notes,
            },
            createdAt,
          });
        }
      }
    }

    const resolvedRequestIndex = session.pendingRequests.indexOf(request);
    if (
      this.sessions.get(stepId) !== session ||
      session.stopRequested ||
      resolvedRequestIndex === -1
    ) {
      dbg.agentPermission(
        'Skipping stale response finalization for request %s on step %s',
        requestId,
        stepId,
      );
      return;
    }
    session.pendingRequests.splice(resolvedRequestIndex, 1);
    if (request.type === 'permission') {
      // The renderer clears its own banner when the user answers, but nothing
      // does so when main resolves a request on its own (auto-accept).
      this.emitEvent(taskId, stepId, {
        type: 'permission-resolved',
        requestId,
      });
    }
    dbg.agentPermission(
      'Resolved %s request (remaining pending: %d)',
      request.type,
      session.pendingRequests.length,
    );
    notificationService.close(`${taskId}:${request.type}`);

    // If there are more pending requests, emit the next one
    if (session.pendingRequests.length > 0) {
      const task = await TaskRepository.update(taskId, { status: 'waiting' });
      emitTaskUpsert(task);
      this.emitEvent(taskId, stepId, { type: 'status', status: 'waiting' });

      const next = session.pendingRequests[0];
      if (next.type === 'question' && next.questionRequest) {
        this.emitQuestionRequest(taskId, stepId, next.questionRequest);
      } else if (next.type === 'permission' && next.permissionRequest) {
        this.emitEvent(taskId, stepId, {
          type: 'permission',
          ...next.permissionRequest,
        });
      }
      return;
    }

    // Resume running status (step was already 'running', update task-level)
    const task = await TaskRepository.update(taskId, { status: 'running' });
    emitTaskUpsert(task);
    this.emitEvent(taskId, stepId, { type: 'status', status: 'running' });
  }

  async beginSendMessage(
    stepId: string,
    parts: PromptPart[],
    capture?: AgentMemoryFollowUpCapture,
  ): Promise<{ started: Promise<void>; completion: Promise<void> }> {
    const completeRegistration = this.admitSessionRegistration(stepId, 'reject');
    if (!completeRegistration) {
      throw new Error(`Failed to register session for step ${stepId}`);
    }

    // Agent Memory capture context is resolved before the session is replaced:
    // the previous result must be read against the OLD session state.
    const admittedCapture = capture
      ? {
          ...admitAgentMemoryPromptCapture({
            capture,
            content: getPromptText(parts),
            source: 'immediate',
            stepId,
          }),
          submissionId: capture.submissionId,
        }
      : undefined;
    const activeSession = this.sessions.get(stepId);
    const previousResultFallback = activeSession?.previousResultFallback ?? null;
    let previousResultSnapshot: Promise<string | null> | undefined;
    if (
      admittedCapture &&
      (!activeSession || activeSession.agentMemoryCaptureEligible)
    ) {
      try {
        previousResultSnapshot = Promise.resolve(
          AgentMessageRepository.findLatestResultByStepId(stepId),
        ).catch((error) => {
          dbg.agent(
            'Failed to load previous Agent Memory context for step %s: %O',
            stepId,
            error,
          );
          return null;
        });
      } catch (error) {
        dbg.agent(
          'Failed to load previous Agent Memory context for step %s: %O',
          stepId,
          error,
        );
        previousResultSnapshot = Promise.resolve(null);
      }
    }
    const captureContext = admittedCapture
      ? {
          admittedCapture,
          previousResultFallback,
          previousResultSnapshot,
        }
      : undefined;
    try {
      if (this.isRunningOrStarting(stepId)) {
        await this.stop(stepId);
      }

      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      this.startingSteps.add(stepId);
      this.stepStartPromises.set(stepId, started);
      await this.waitForPreviousBackendRun(stepId);
      const completion = this.trackBackendRun(stepId, () =>
        this.performSendMessage(
          stepId,
          parts,
          markStarted,
          completeRegistration,
          captureContext,
        ).finally(() => {
          completeRegistration();
          markStarted();
          if (this.stepStartPromises.get(stepId) === started) {
            this.startingSteps.delete(stepId);
            this.stepStartPromises.delete(stepId);
          }
        }),
      );
      return { started, completion };
    } catch (error) {
      completeRegistration();
      throw error;
    }
  }

  async sendMessage(
    stepId: string,
    parts: PromptPart[],
    capture?: AgentMemoryFollowUpCapture,
  ): Promise<void> {
    const { completion } = await this.beginSendMessage(stepId, parts, capture);
    await completion;
  }

  private async performSendMessage(
    stepId: string,
    parts: PromptPart[],
    markStarted: () => void,
    completeRegistration: () => void,
    captureContext?: {
      admittedCapture: ReturnType<typeof admitAgentMemoryPromptCapture> & {
        submissionId: string;
      };
      previousResultFallback: string | null;
      previousResultSnapshot?: Promise<string | null>;
    },
  ): Promise<void> {
    let session: ActiveSession | null = null;
    try {
      // Create new session (will pick up existing sessionId for resume)
      session = await this.createSession(stepId);
      const { taskId } = session;

      // Update step status to running (stop() above sets it to 'interrupted')
      await StepService.update(stepId, { status: 'running' });
      await StepService.syncTaskStatus(taskId);
      this.emitEvent(taskId, stepId, { type: 'status', status: 'running' });
      completeRegistration();

      if (captureContext && session.agentMemoryCaptureEligible) {
        const {
          admittedCapture,
          previousResultFallback,
          previousResultSnapshot,
        } = captureContext;
        const captureProjectId = session.projectId;
        const capturedSession = session;
        void (previousResultSnapshot ?? Promise.resolve(null)).then(
          (previousAgentResult) =>
            captureAgentMemoryPromptSubmissionSafe({
              source: 'follow-up-prompt',
              sourceId: `follow-up-prompt:${admittedCapture.submissionId}`,
              projectId: captureProjectId,
              taskId,
              stepId,
              userText: admittedCapture.userText,
              previousAgentResult:
                previousAgentResult ??
                previousResultFallback ??
                capturedSession.previousResultFallback ??
                null,
              reviews: admittedCapture.reviews,
            }),
        );
      }

      dbg.agentSession('Sending follow-up message for step %s', stepId);
      await this.runBackend(stepId, parts, session, {
        onRunStarting: markStarted,
      });
    } catch (error) {
      if (!session) throw error;
      if (session.stopRequested) return;
      const { taskId } = session;
      const isCurrentSession = () => this.sessions.get(stepId) === session;
      if (!isCurrentSession()) {
        dbg.agent(
          'Ignoring stale follow-up failure for replaced step %s: %O',
          stepId,
          error,
        );
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      dbg.agent('Step %s sendMessage failed: %s', stepId, errorMessage);

      // Emit a synthetic error entry so the user sees the error in the timeline
      await this.persistAndEmitSyntheticEntry(taskId, session, {
        id: nanoid(),
        date: new Date().toISOString(),
        isSynthetic: true,
        type: 'result',
        value: errorMessage,
        isError: true,
      });
      if (!isCurrentSession()) return;

      await StepService.errorStep(stepId);
      if (!isCurrentSession()) return;
      this.emitEvent(taskId, stepId, {
        type: 'status',
        status: 'errored',
        error: errorMessage,
      });
      if (!isCurrentSession()) return;
      await this.notifyTaskEvent({
        taskId,
        stepId,
        event: 'errored',
        notificationId: `${taskId}:send-error:${stepId}`,
        title: 'Task Failed',
        body: 'Task "{taskName}" encountered an error',
      });
    } finally {
      completeRegistration();
      if (session) this.deleteSession(stepId, session);
    }
  }

  /**
   * Queue a prompt to be sent after the current agent work completes.
   */
  queuePrompt(
    stepId: string,
    parts: PromptPart[],
    capture?: AgentMemoryQueuedPromptCapture,
  ): { promptId: string } {
    const session = this.sessions.get(stepId);
    if (!session) {
      throw new Error(`No active session for step ${stepId}`);
    }

    if (capture) {
      const pendingPromptId = session.queuedPromptIdsBySubmissionId.get(
        capture.submissionId,
      );
      const tombstoneKey = queuedPromptTombstoneKey(
        stepId,
        capture.submissionId,
      );
      const tombstonedPromptId =
        queuedPromptSubmissionTombstones.get(tombstoneKey);
      const retriedPromptId = pendingPromptId ?? tombstonedPromptId;
      if (retriedPromptId) {
        if (tombstonedPromptId) {
          queuedPromptSubmissionTombstones.delete(tombstoneKey);
          queuedPromptSubmissionTombstones.set(
            tombstoneKey,
            tombstonedPromptId,
          );
        }
        dbg.agent('Deduplicated queued prompt submission: %O', {
          event: 'agent-memory-queue-submission-deduplicated',
          stepId,
          promptId: retriedPromptId,
          submissionIdHash: diagnosticIdHash(capture.submissionId),
        });
        return { promptId: retriedPromptId };
      }
    }

    const admittedCapture = capture
      ? admitAgentMemoryPromptCapture({
          capture,
          content: getPromptText(parts),
          source: 'queued',
          stepId,
        })
      : undefined;

    const existingPrompt = session.queuedPrompts[0];
    if (existingPrompt) {
      const existingParts =
        queuedPromptParts.get(existingPrompt.id) ??
        textPrompt(existingPrompt.content);
      const combinedParts = appendPromptParts(existingParts, parts);
      existingPrompt.content = getPromptText(combinedParts);
      queuedPromptParts.set(existingPrompt.id, combinedParts);
      if (admittedCapture && session.agentMemoryCaptureEligible) {
        const existingCapture = queuedPromptCaptures.get(existingPrompt.id);
        const reviews = [
          ...(existingCapture?.reviews ?? []),
          ...(admittedCapture.reviews ?? []),
        ];
        queuedPromptCaptures.set(existingPrompt.id, {
          userText: [existingCapture?.userText, admittedCapture.userText]
            .filter((text): text is string => !!text?.trim())
            .join('\n\n'),
          reviews: [
            ...new Map(reviews.map((review) => [review.commentId, review])).values(),
          ],
        });
        existingPrompt.agentMemoryCapture = queuedPromptCaptures.get(
          existingPrompt.id,
        );
      }
      if (capture) {
        rememberPendingQueuedPromptSubmission(
          session,
          capture.submissionId,
          existingPrompt.id,
        );
      }

      this.emitEvent(session.taskId, stepId, {
        type: 'queue-update',
        queuedPrompts: session.queuedPrompts,
      });

      dbg.agent(
        'Coalesced queued prompt %s for step %s',
        existingPrompt.id,
        stepId,
      );
      return { promptId: existingPrompt.id };
    }

    const id = nanoid();
    queuedPromptParts.set(id, parts);
    if (admittedCapture && session.agentMemoryCaptureEligible) {
      queuedPromptCaptures.set(id, admittedCapture);
    }

    const queuedPrompt: QueuedPrompt = {
      id,
      content: getPromptText(parts),
      createdAt: Date.now(),
      agentMemoryCapture:
        admittedCapture && session.agentMemoryCaptureEligible
          ? admittedCapture
          : undefined,
    };

    session.queuedPrompts.push(queuedPrompt);
    if (capture) {
      rememberPendingQueuedPromptSubmission(session, capture.submissionId, id);
    }
    this.emitEvent(session.taskId, stepId, {
      type: 'queue-update',
      queuedPrompts: session.queuedPrompts,
    });

    dbg.agent('Queued prompt %s for step %s', queuedPrompt.id, stepId);
    return { promptId: queuedPrompt.id };
  }

  /**
   * Update a queued prompt before it is sent.
   */
  updateQueuedPrompt(
    stepId: string,
    promptId: string,
    content: string,
    nextCapture?: AgentMemoryPromptCapture,
  ): void {
    const session = this.sessions.get(stepId);
    if (!session) {
      throw new Error(`No active session for step ${stepId}`);
    }

    const queuedPrompt = session.queuedPrompts.find((p) => p.id === promptId);
    if (!queuedPrompt) {
      throw new Error(`Queued prompt ${promptId} not found`);
    }

    const existingParts =
      queuedPromptParts.get(promptId) ?? textPrompt(queuedPrompt.content);
    const updatedParts = replacePromptText(existingParts, content);

    queuedPrompt.content = content;
    queuedPromptParts.set(promptId, updatedParts);
    const previousCapture =
      queuedPromptCaptures.get(promptId) ?? queuedPrompt.agentMemoryCapture;
    const reconciliation = previousCapture
      ? reconcileAgentMemoryPromptCaptureWithDiagnostics(
          previousCapture,
          content,
        )
      : undefined;
    const capture = reconciliation?.capture;
    const authoritativeReviewCount = previousCapture?.reviews?.length ?? 0;
    if (
      reconciliation &&
      authoritativeReviewCount > 0 &&
      !reconciliation.diagnostics.hasReviewXml
    ) {
      dbg.agent('Agent Memory queued review XML missing: %O', {
        event: 'agent-memory-queue-review-xml-missing',
        stepId,
        promptId,
        authoritativeReviewCount,
      });
    }
    if (
      reconciliation &&
      (reconciliation.diagnostics.rejectedCommentIds.length > 0 ||
        reconciliation.diagnostics.rejectedCommentsWithoutId > 0)
    ) {
      dbg.agent('Agent Memory queued review IDs rejected: %O', {
        event: 'agent-memory-queue-review-ids-rejected',
        stepId,
        promptId,
        rejectedCommentIdHashes:
          reconciliation.diagnostics.rejectedCommentIds.map(diagnosticIdHash),
        rejectedCommentCount:
          reconciliation.diagnostics.rejectedCommentIds.length,
        rejectedCommentsWithoutId:
          reconciliation.diagnostics.rejectedCommentsWithoutId,
      });
    }
    if (
      (previousCapture && !nextCapture) ||
      (nextCapture && (!capture || !capturesMatch(nextCapture, capture)))
    ) {
      dbg.agent('Agent Memory queued renderer metadata mismatch: %O', {
        event: 'agent-memory-queue-renderer-mismatch',
        stepId,
        promptId,
        rendererMetadataProvided: !!nextCapture,
        rendererReviewIdHashes: (nextCapture?.reviews ?? []).map(
          (review) => diagnosticIdHash(review.commentId),
        ),
        authoritativeReviewIdHashes: (capture?.reviews ?? []).map(
          (review) => diagnosticIdHash(review.commentId),
        ),
        rendererUserTextMatchesContent: nextCapture
          ? nextCapture.userText === content
          : null,
      });
    }
    if (session.agentMemoryCaptureEligible && capture) {
      queuedPromptCaptures.set(promptId, capture);
      queuedPrompt.agentMemoryCapture = capture;
    } else {
      queuedPromptCaptures.delete(promptId);
      delete queuedPrompt.agentMemoryCapture;
    }
    this.emitEvent(session.taskId, stepId, {
      type: 'queue-update',
      queuedPrompts: session.queuedPrompts,
    });

    dbg.agent('Updated queued prompt %s for step %s', promptId, stepId);
  }

  /**
   * Cancel a specific queued prompt.
   */
  cancelQueuedPrompt(stepId: string, promptId: string): void {
    const session = this.sessions.get(stepId);
    if (!session) {
      throw new Error(`No active session for step ${stepId}`);
    }

    const index = session.queuedPrompts.findIndex((p) => p.id === promptId);
    if (index === -1) {
      throw new Error(`Queued prompt ${promptId} not found`);
    }

    queuedPromptParts.delete(promptId);
    queuedPromptCaptures.delete(promptId);
    tombstoneQueuedPromptSubmissionIds(session, promptId);
    session.queuedPrompts.splice(index, 1);
    this.emitEvent(session.taskId, stepId, {
      type: 'queue-update',
      queuedPrompts: session.queuedPrompts,
    });

    dbg.agent('Cancelled queued prompt %s for step %s', promptId, stepId);
  }

  /**
   * Get current queued prompts for a step.
   */
  getQueuedPrompts(stepId: string): QueuedPrompt[] {
    const session = this.sessions.get(stepId);
    return session?.queuedPrompts ?? [];
  }

  /**
   * Get the current pending request for a step (permission or question).
   * Returns null if no pending request exists.
   */
  getPendingRequest(stepId: string):
    | {
        type: 'permission';
        data: NormalizedPermissionRequest & {
          taskId: string;
          stepId: string;
        };
      }
    | {
        type: 'question';
        data: {
          taskId: string;
          stepId: string;
          requestId: string;
          contextReminder?: string;
          questions: AgentQuestion[];
        };
      }
    | null {
    const session = this.sessions.get(stepId);
    if (!session || session.pendingRequests.length === 0) {
      return null;
    }

    const { taskId } = session;
    const request = session.pendingRequests[0];
    if (request.type === 'question' && request.questionRequest) {
      return {
        type: 'question',
        data: {
          taskId,
          stepId,
          requestId: request.requestId,
          ...(request.questionRequest.contextReminder
            ? { contextReminder: request.questionRequest.contextReminder }
            : {}),
          questions: this.toAgentQuestions(request.questionRequest.questions),
        },
      };
    }

    if (request.type === 'permission' && request.permissionRequest) {
      return {
        type: 'permission',
        data: {
          taskId,
          stepId,
          ...request.permissionRequest,
        },
      };
    }

    return null;
  }

  isAutoAcceptEnabled(stepId: string): boolean {
    return this.autoAcceptSteps.has(stepId);
  }

  /**
   * Allow a request on the user's behalf. `toolsToAllow: []` keeps the grant
   * scoped to this one call: without it `respondOnce` would derive a rule and
   * the backend would stop prompting for that tool even after auto-accept is
   * switched back off.
   *
   * If the response fails the request stays queued and was never emitted, which
   * would block every later request, so surface it to the user instead.
   */
  private async autoAcceptRequest(
    stepId: string,
    session: ActiveSession,
    requestId: string,
  ): Promise<void> {
    try {
      await this.respond(stepId, requestId, {
        behavior: 'allow',
        toolsToAllow: [],
      });
    } catch (error) {
      dbg.agentPermission(
        'Auto-accept failed for request %s: %o',
        requestId,
        error,
      );
      await this.emitQueueHeadRequest(session);
    }
  }

  /** Emit the queued request the user is waiting on, if there is one. */
  private async emitQueueHeadRequest(session: ActiveSession): Promise<void> {
    const head = session.pendingRequests[0];
    if (!head) return;
    await this.emitPendingRequest(session, head);
  }

  /**
   * Toggle per-session auto-accept for a step. Nothing is persisted: the flag
   * lives for the lifetime of the app process. Enabling it drains any requests
   * already waiting for the user.
   */
  async setAutoAccept(stepId: string, enabled: boolean): Promise<void> {
    const session = this.sessions.get(stepId);
    if (!enabled) {
      this.autoAcceptSteps.delete(stepId);
      // Requests that arrived while auto-accept was on were queued but never
      // emitted, so re-surface whatever the run is now blocked on.
      if (session) await this.emitQueueHeadRequest(session);
      return;
    }
    this.autoAcceptSteps.add(stepId);

    if (!session) return;
    const pendingPermissions = session.pendingRequests.filter(
      (request) => request.type === 'permission',
    );
    for (const request of pendingPermissions) {
      await this.autoAcceptRequest(stepId, session, request.requestId);
    }
  }

  async setMode(stepId: string, mode: InteractionMode): Promise<void> {
    const session = this.sessions.get(stepId);
    const step = await TaskStepRepository.findById(stepId);
    if (!step) return;
    if (isPrReviewChatStepMeta(step.meta)) {
      throw new Error('PR review chat steps are read-only and cannot change mode');
    }

    const backend = session?.backendType ?? step.agentBackend ?? 'claude-code';
    const normalizedMode = normalizeInteractionModeForBackend({
      backend,
      mode,
    });

    dbg.agentSession('Setting mode for step %s to %s', stepId, normalizedMode);

    if (session?.runHandle) {
      const modeCapability =
        session.provider.capabilities.agent.runtimeModeSwitch;
      if (modeCapability.supported) {
        await modeCapability.implementation.setMode({
          handle: session.runHandle,
          mode: normalizedMode,
        });
        dbg.agentSession('Updated backend permission mode for active session');
      }
    }
    const updatedStep = await TaskStepRepository.update(stepId, {
      interactionMode: normalizedMode,
    });
    emitStepUpsert(updatedStep);
  }

  isRunning(stepId: string): boolean {
    return this.sessions.has(stepId);
  }

  isRunningOrStarting(stepId: string): boolean {
    return this.sessions.has(stepId) || this.startingSteps.has(stepId);
  }

  async getMessages(stepId: string): Promise<NormalizedEntry[]> {
    return AgentMessageRepository.findByStepId(stepId);
  }

  async getMessageCount(stepId: string): Promise<number> {
    return AgentMessageRepository.getMessageCountByStepId(stepId);
  }

  async compactRawMessages(taskId: string): Promise<void> {
    try {
      // Group steps by backend and run the appropriate compactor for each
      const steps = await TaskStepRepository.findByTaskId(taskId);
      const backends = new Set(
        steps.map((s) => s.agentBackend ?? 'claude-code'),
      );

      for (const backendType of backends) {
        switch (backendType) {
          case 'claude-code':
            await ClaudeCodeBackend.compactRawMessagesForTask(taskId);
            break;
          case 'opencode':
            await OpenCodeBackend.compactRawMessagesForTask(taskId);
            break;
          case 'codex':
          case 'vibe':
            dbg.agent(
              'Skipping raw message compaction for unsupported backend %s',
              backendType,
            );
            break;
          case 'copilot':
            await CopilotBackend.compactRawMessagesForTask(taskId);
            break;
          default: {
            const _exhaustive: never = backendType;
            throw new Error(`Unknown agent backend: "${_exhaustive}"`);
          }
        }
      }
    } catch (error) {
      dbg.agent(
        'Failed compacting raw messages for task %s: %O',
        taskId,
        error,
      );
    }
  }

  async getMessagesWithRawData(taskId: string, stepId: string) {
    const rows = await AgentMessageRepository.findWithRawDataByTaskId({
      taskId,
      stepId,
    });
    return rows.map((row) => ({
      messageIndex: row.messageIndex,
      rawData: row.rawData ? JSON.parse(row.rawData) : null,
      rawFormat: row.rawFormat,
      backendSessionId: row.backendSessionId,
      normalizedData: row.normalizedData
        ? JSON.parse(row.normalizedData)
        : null,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Re-process normalization for all raw messages of a task.
   * Deletes existing normalized messages and re-creates them from raw data.
   * Returns the count of newly created normalized messages.
   */
  async reprocessNormalization(taskId: string): Promise<number> {
    return AgentMessageRepository.reprocessNormalization(taskId);
  }

  /**
   * Recover tasks and steps that were left in 'running' or 'waiting' state
   * from a previous app session. These were interrupted by app shutdown/crash
   * and should be marked as 'interrupted'.
   * Should be called on app startup before the main window is shown.
   */
  async recoverStaleTasks(): Promise<void> {
    // PR workspaces are containers that remain available after restart. Generic
    // agent tasks represent an interrupted run when their process disappears.
    // Only live states are stale on startup. Already-'interrupted' tasks are in
    // their terminal recovered state — touching them bumps updatedAt and (for
    // pr-review) flips them back to 'waiting' on every restart.
    const staleTasks = await TaskRepository.findByStatuses(['running', 'waiting']);

    let recoveredTaskCount = 0;
    for (const task of staleTasks) {
      try {
        const nextStatus = task.type === 'pr-review' ? 'waiting' : 'interrupted';
        if (task.status === nextStatus) {
          continue;
        }
        recoveredTaskCount++;
        const updatedTask = await TaskRepository.update(task.id, {
          status: nextStatus,
        });
        emitTaskUpsert(updatedTask);
      } catch (error) {
        dbg.agent('Failed to recover stale task %s: %O', task.id, error);
      }
    }

    if (recoveredTaskCount > 0) {
      dbg.agent('Recovered %d stale task(s) on startup', recoveredTaskCount);
    }

    // Recover stale steps — find ALL steps with 'running' status across all tasks
    // (not just staleTasks) to handle orphaned running steps under non-running tasks.
    // Write a synthetic interrupted message scoped to each step so the timeline shows it.
    const allRunningSteps = await TaskStepRepository.findByStatus('running');
    let staleStepCount = 0;
    // Resolve pr-review-ness from the task row itself (not from staleTasks) so a
    // pr-review workspace whose task row is already 'interrupted' still gets
    // restored to 'waiting'.
    const prReviewCache = new Map<string, boolean>();
    const isPrReviewTask = async (taskId: string): Promise<boolean> => {
      const cached = prReviewCache.get(taskId);
      if (cached !== undefined) {
        return cached;
      }
      const task = await TaskRepository.findById(taskId);
      const isPrReview = task?.type === 'pr-review';
      prReviewCache.set(taskId, isPrReview);
      return isPrReview;
    };
    for (const step of allRunningSteps) {
      try {
        const messageCount =
          await AgentMessageRepository.getMessageCountByStepId(step.id);

        await AgentMessageRepository.create({
          taskId: step.taskId,
          stepId: step.id,
          messageIndex: messageCount,
          entry: {
            id: nanoid(),
            date: new Date().toISOString(),
            isSynthetic: true,
            type: 'result',
            value: 'Task interrupted',
            isError: true,
          },
          rawMessageId: null,
        });

        const updatedStep = await TaskStepRepository.update(step.id, {
          status: 'interrupted',
        });
        emitStepUpsert(updatedStep);
        if (await isPrReviewTask(step.taskId)) {
          const updatedTask = await TaskRepository.update(step.taskId, {
            status: 'waiting',
          });
          emitTaskUpsert(updatedTask);
        } else {
          await StepService.syncTaskStatus(step.taskId);
        }
        staleStepCount++;
      } catch (error) {
        dbg.agent('Failed to recover stale step %s: %O', step.id, error);
        // Best-effort: still mark the step as interrupted
        try {
          const updatedStep = await TaskStepRepository.update(step.id, {
            status: 'interrupted',
          });
          emitStepUpsert(updatedStep);
          if (await isPrReviewTask(step.taskId)) {
            const updatedTask = await TaskRepository.update(step.taskId, {
              status: 'waiting',
            });
            emitTaskUpsert(updatedTask);
          } else {
            await StepService.syncTaskStatus(step.taskId);
          }
        } catch {
          dbg.agent('Failed to update status for stale step %s', step.id);
        }
      }
    }

    if (staleStepCount > 0) {
      dbg.agent('Recovered %d stale step(s) on startup', staleStepCount);
    }
  }
}

export const agentService = new AgentService();
