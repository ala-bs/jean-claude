import { describe, expect, it, vi } from 'vitest';

import type { PromptPart } from '@shared/agent-backend-types';

import {
  formatPromptSubmitError,
  runPromptSubmission,
} from './utils-prompt-submit-error';

const textPart = (text: string): PromptPart => ({ type: 'text', text });

function setup({
  submit,
  comments = [],
}: {
  submit: (finalParts: PromptPart[], comments: { id: string }[]) => Promise<unknown>;
  comments?: { id: string }[];
}) {
  const onSuccess = vi.fn();
  const onError = vi.fn();
  return {
    onSuccess,
    onError,
    run: () =>
      runPromptSubmission({
        parts: [textPart('follow up')],
        openReviewComments: comments,
        synthesizeReviewParts: (list) =>
          list.length > 0 ? [textPart(`reviews:${list.length}`)] : null,
        submit,
        onSuccess,
        onError,
        fallbackMessage: 'Failed to send follow-up message',
      }),
  };
}

describe('runPromptSubmission', () => {
  it('commits draft/comment cleanup only after the prompt is accepted', async () => {
    const comments = [{ id: 'c1' }, { id: 'c2' }];
    const { run, onSuccess, onError } = setup({
      submit: vi.fn().mockResolvedValue(undefined),
      comments,
    });

    await run();

    expect(onSuccess).toHaveBeenCalledWith(comments);
    expect(onError).not.toHaveBeenCalled();
  });

  it('rethrows on failure so the composer keeps the text and attachments', async () => {
    // The original bug: the rejection was swallowed, MessageInput fell through
    // to setValue('') and the follow-up vanished with no feedback.
    const { run, onSuccess, onError } = setup({
      submit: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(run()).rejects.toThrow('boom');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('boom');
  });

  it('does not resolve review comments when the prompt fails', async () => {
    const comments = [{ id: 'c1' }];
    const { run, onSuccess } = setup({
      submit: vi.fn().mockRejectedValue(new Error('no active worktree')),
      comments,
    });

    await expect(run()).rejects.toThrow();
    // Resolving here would destroy the pending review comments permanently.
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('appends synthesized review parts to the submitted prompt', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { run } = setup({ submit, comments: [{ id: 'c1' }] });

    await run();

    expect(submit).toHaveBeenCalledWith(
      [textPart('follow up'), textPart('reviews:1')],
      [{ id: 'c1' }],
    );
  });

  it('acts on the comments captured at submit time, not later mutations', async () => {
    const comments = [{ id: 'c1' }];
    const { run, onSuccess } = setup({
      submit: vi.fn().mockImplementation(async () => {
        comments.push({ id: 'c2' });
      }),
      comments,
    });

    await run();

    expect(onSuccess).toHaveBeenCalledWith([{ id: 'c1' }]);
  });
});

describe('formatPromptSubmitError', () => {
  it('unwraps the Electron IPC remote-method envelope', () => {
    const error = new Error(
      "Error invoking remote method 'agent:sendMessage': Error: PR review task abc has no active worktree",
    );
    expect(formatPromptSubmitError(error, 'fallback')).toBe(
      'PR review task abc has no active worktree',
    );
  });

  it('strips a bare Error prefix', () => {
    expect(formatPromptSubmitError(new Error('Error: nope'), 'fallback')).toBe(
      'nope',
    );
  });

  it('passes through an already-clean message', () => {
    expect(formatPromptSubmitError(new Error('nope'), 'fallback')).toBe('nope');
  });

  it('falls back for non-Error throws and empty messages', () => {
    expect(formatPromptSubmitError('a string', 'fallback')).toBe('fallback');
    expect(formatPromptSubmitError(new Error('   '), 'fallback')).toBe(
      'fallback',
    );
    expect(formatPromptSubmitError(new Error('Error: '), 'fallback')).toBe(
      'fallback',
    );
  });
});
