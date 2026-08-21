import type { PromptPart } from '@shared/agent-backend-types';
import type { AgentMemoryFollowUpCapture } from '@shared/agent-memory-types';
import type { Task, TaskStep } from '@shared/types';

import { sendMessageWithPrReviewLifecycle } from '../services/pr-review-task-service';

/**
 * Shared entry point for follow-up prompts, so the renderer path and the
 * internal PR-review chat continuation can't drift apart on `waitForCompletion`.
 */
export function createSendMessageForStep({
  beginSendMessage,
  findStepById,
  findTaskById,
}: {
  beginSendMessage: (
    stepId: string,
    parts: PromptPart[],
    capture?: AgentMemoryFollowUpCapture,
  ) => Promise<{ started: Promise<void>; completion: Promise<void> }>;
  findStepById: (stepId: string) => Promise<TaskStep | undefined>;
  findTaskById: (taskId: string) => Promise<Task | undefined>;
}) {
  return function sendMessageForStep(
    stepId: string,
    parts: PromptPart[],
    capture?: AgentMemoryFollowUpCapture,
    options?: { waitForCompletion?: boolean },
  ): Promise<void> {
    return sendMessageWithPrReviewLifecycle(
      stepId,
      (authoritativeStepId) =>
        beginSendMessage(authoritativeStepId, parts, capture),
      {
        findStepById,
        findTaskById,
        waitForCompletion: options?.waitForCompletion,
      },
    );
  };
}

/**
 * Options the renderer-facing `agent:sendMessage` handler must use.
 *
 * Exported as a constant so a test can assert the handler resolves on prompt
 * ACCEPTANCE: the composer stays populated until this promise settles, so
 * awaiting the whole agent turn would pin the sent prompt in the input box for
 * the entire run (and strand it completely if the turn errored).
 */
export const RENDERER_SEND_MESSAGE_OPTIONS = {
  waitForCompletion: false,
} as const;
