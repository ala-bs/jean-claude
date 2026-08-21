import { describe, expect, it, vi } from 'vitest';

import {
  createSendMessageForStep,
  RENDERER_SEND_MESSAGE_OPTIONS,
} from './send-message-for-step';

const PARTS = [{ type: 'text' as const, text: 'follow up' }];

/**
 * Wires the REAL `sendMessageWithPrReviewLifecycle` to a follow-up whose turn
 * outlives the call, so these tests describe when the IPC promise settles --
 * which is exactly when the renderer clears the composer.
 */
function setup() {
  let finishTurn!: () => void;
  let turnFinished = false;
  const completion = new Promise<void>((resolve) => {
    finishTurn = () => {
      turnFinished = true;
      resolve();
    };
  });

  const sendMessageForStep = createSendMessageForStep({
    beginSendMessage: vi
      .fn()
      .mockResolvedValue({ started: Promise.resolve(), completion }),
    findStepById: vi.fn().mockResolvedValue({ id: 'step-1', taskId: 'task-1' }),
    // Non-PR task: skips the PR lifecycle, like a normal agent task.
    findTaskById: vi
      .fn()
      .mockResolvedValue({ id: 'task-1', type: 'agent', pullRequestId: null }),
  });

  return {
    sendMessageForStep,
    finishTurn,
    isTurnFinished: () => turnFinished,
  };
}

describe('sendMessageForStep', () => {
  it('settles on acceptance for the renderer path, before the turn completes', async () => {
    const { sendMessageForStep, finishTurn, isTurnFinished } = setup();

    await sendMessageForStep(
      'step-1',
      PARTS,
      undefined,
      RENDERER_SEND_MESSAGE_OPTIONS,
    );

    // The composer clears at exactly this moment.
    expect(isTurnFinished()).toBe(false);

    finishTurn();
  });

  it('waits for the whole turn when no options are given', async () => {
    const { sendMessageForStep, finishTurn, isTurnFinished } = setup();

    let settled = false;
    const pending = sendMessageForStep('step-1', PARTS).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    // The PR-review chat continuation depends on this: it chains off turn end.
    expect(settled).toBe(false);

    finishTurn();
    await pending;
    expect(settled).toBe(true);
    expect(isTurnFinished()).toBe(true);
  });
});
