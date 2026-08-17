import { createHash } from 'node:crypto';

import {
  deriveAgentMemoryPromptCaptureFromSubmittedContent,
  deriveAgentMemoryTaskReviewsFromSubmittedContent,
} from '@shared/agent-memory-review-reconciliation';
import type {
  AgentMemoryPromptCapture,
} from '@shared/agent-memory-types';
import type { Task } from '@shared/types';

import {
  captureAgentMemoryPromptSubmissionSafe,
  captureInitialTaskPromptSafe,
} from '../services/agent-memory-capture-service';
import { AgentMessageRepository } from '../database/repositories';
import { dbg } from '../lib/debug';
import { TaskStepRepository } from '../database/repositories/task-steps';

type CaptureTask = Pick<Task, 'id' | 'projectId' | 'type'>;

function diagnosticIdHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

export function captureCreatedTaskPromptBoundary({
  task,
  stepId,
  originalUserText,
  submittedPrompt,
  createdAt,
}: {
  task: CaptureTask;
  stepId: string;
  originalUserText: string | undefined;
  submittedPrompt: string;
  createdAt: string;
}): void {
  if (task.type !== 'agent') return;
  const trimmedOriginal = originalUserText?.trim();
  const userText =
    trimmedOriginal && submittedPrompt.includes(trimmedOriginal)
      ? originalUserText!
      : '';
  const reviews = deriveAgentMemoryTaskReviewsFromSubmittedContent(submittedPrompt);
  if (!userText && reviews.length === 0) return;
  void captureInitialTaskPromptSafe({
    projectId: task.projectId,
    taskId: task.id,
    stepId,
    userText,
    reviews,
    createdAt,
  });
}

export function captureCreatedStepPromptBoundary({
  task,
  stepId,
  capture,
  submittedPrompt,
  createdAt,
}: {
  task: CaptureTask;
  stepId: string;
  capture:
    | (AgentMemoryPromptCapture & { contextStepId?: string | null })
      | undefined;
  submittedPrompt: string;
  createdAt: string;
}): void {
  if (task.type !== 'agent' || !capture) return;
  const admission = deriveAgentMemoryPromptCaptureFromSubmittedContent(
    capture,
    submittedPrompt,
  );
  const diagnostics = admission.diagnostics;
  if (
    diagnostics.rejectedCommentIds.length > 0 ||
    diagnostics.rejectedCommentsWithoutId > 0 ||
    diagnostics.metadataMismatchCommentIds.length > 0 ||
    diagnostics.unrepresentedRendererCommentIds.length > 0
  ) {
    dbg.agent('Agent Memory new-step admission metadata mismatch: %O', {
      event: 'agent-memory-prompt-admission-mismatch',
      source: 'new-step',
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
  const contextStepId = capture.contextStepId;
  const contextPromise = (async (): Promise<string | null> => {
    if (!contextStepId) return null;
    const contextTaskId = await TaskStepRepository.findTaskIdById(
      contextStepId,
    ).catch(() => undefined);
    if (contextTaskId !== task.id) {
      dbg.agent(
        'Agent Memory context step rejected taskId=%s stepId=%s contextStepId=%s',
        task.id,
        stepId,
        contextStepId,
      );
      return null;
    }
    const latestResult = await AgentMessageRepository.findLatestResultByStepId(
      contextStepId,
    ).catch((error) => {
      dbg.agent(
        'Failed to load Agent Memory result context for step %s: %O',
        contextStepId,
        error,
      );
      return null;
    });
    if (latestResult !== null) return latestResult;
    const output = await TaskStepRepository.findOutputByIdAndTaskId(
      contextStepId,
      task.id,
    ).catch(() => undefined);
    return output ?? null;
  })();

  void contextPromise
    .then((previousAgentResult) =>
      captureAgentMemoryPromptSubmissionSafe({
        source: 'new-step-prompt',
        sourceId: `step:${stepId}:prompt`,
        projectId: task.projectId,
        taskId: task.id,
        stepId,
        userText: admission.capture.userText,
        previousAgentResult,
        reviews: admission.capture.reviews,
        createdAt,
      }),
    )
    .catch((error) => {
      dbg.agent('Failed to capture new-step Agent Memory: %O', error);
    });
}
