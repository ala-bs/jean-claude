/**
 * Decides where the caret should land after Monaco inserts pasted content, so
 * the user continues typing on an empty line *below* the paste.
 *
 * Pure model math, kept separate from the editor component so it can be tested.
 */
export function computePasteCursorPlacement({
  endLineNumber,
  lineCount,
  endLineContent,
  nextLineContent,
}: {
  /** Last line touched by the paste (1-based). */
  endLineNumber: number;
  /** Total lines in the model after the paste. */
  lineCount: number;
  /** Full content of `endLineNumber`. */
  endLineContent: string;
  /** Full content of `endLineNumber + 1`, or null when it does not exist. */
  nextLineContent: string | null;
}):
  | { action: 'move'; lineNumber: number }
  | { action: 'insert-newline'; lineNumber: number } {
  // The paste already ended on a blank line (e.g. pasted text ending in "\n").
  if (endLineContent.trim() === '') {
    return { action: 'move', lineNumber: endLineNumber };
  }

  // A blank line already follows; reuse it instead of adding another.
  if (
    endLineNumber < lineCount &&
    nextLineContent !== null &&
    nextLineContent.trim() === ''
  ) {
    return { action: 'move', lineNumber: endLineNumber + 1 };
  }

  // Otherwise append a line break at the END of the pasted line. Inserting at
  // the paste's end column instead would split any text the user already had
  // after the caret.
  return { action: 'insert-newline', lineNumber: endLineNumber };
}
