import type { PromptPart } from '@shared/agent-backend-types';

/**
 * Electron wraps errors thrown inside `ipcMain.handle` as
 * `Error invoking remote method 'agent:sendMessage': Error: <real message>`.
 * Toasting that verbatim buries the useful part in transport noise, so strip
 * the wrapper (and any repeated `Error:` prefixes) before showing it.
 */
export function formatPromptSubmitError(
  error: unknown,
  fallbackMessage: string,
): string {
  const raw = error instanceof Error ? error.message : '';
  const unwrapped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Error:\s*)+/, '')
    .trim();
  return unwrapped.length > 0 ? unwrapped : fallbackMessage;
}

/**
 * Runs a prompt submission, ordering side effects so that anything which
 * destroys user input happens ONLY after the prompt is actually accepted.
 *
 * On failure it reports the error and rethrows, because `MessageInput` relies
 * on a rejected `onSend` to skip clearing its text, images and attachments.
 * Swallowing the error would clear the composer and lose the prompt silently.
 */
export async function runPromptSubmission<Comment extends { id: string }>({
  parts,
  openReviewComments,
  synthesizeReviewParts,
  submit,
  onSuccess,
  onError,
  fallbackMessage,
}: {
  parts: PromptPart[];
  openReviewComments: Comment[];
  synthesizeReviewParts: (comments: Comment[]) => PromptPart[] | null;
  submit: (finalParts: PromptPart[], comments: Comment[]) => Promise<unknown>;
  onSuccess: (comments: Comment[]) => void;
  onError: (message: string) => void;
  fallbackMessage: string;
}): Promise<void> {
  // Snapshot the comments so success/failure act on exactly what was sent,
  // even if the store changes while the submission is in flight.
  const submittedComments = [...openReviewComments];

  let finalParts = parts;
  if (submittedComments.length > 0) {
    const reviewParts = synthesizeReviewParts(submittedComments);
    if (reviewParts) {
      finalParts = [...parts, ...reviewParts];
    }
  }

  try {
    await submit(finalParts, submittedComments);
  } catch (error) {
    onError(formatPromptSubmitError(error, fallbackMessage));
    throw error;
  }

  onSuccess(submittedComments);
}
