/**
 * Caret math for dropping an image placeholder into a prompt draft.
 *
 * Split out from the component so the tricky part — where the marker lands
 * relative to the line the user is typing, and where the caret ends up after —
 * is testable without mounting a textarea.
 */

/** Caret span an insert should replace. Collapsed when start === end. */
export type CaretRange = { start: number; end: number };

export function buildImagePlaceholderInsertion({
  value,
  caret,
  placeholder,
}: {
  value: string;
  caret: CaretRange;
  placeholder: string;
}): { value: string; caret: CaretRange } {
  // Clamp: a caret captured before an async image decode can outlive the text
  // it pointed into (the user kept typing, or deleted a chunk).
  const start = Math.max(0, Math.min(caret.start, value.length));
  const end = Math.max(start, Math.min(caret.end, value.length));

  const before = value.slice(0, start);
  const after = value.slice(end);

  // Keep the marker on its own line so it never splits a sentence or a list
  // item mid-word — the whole point is that it reads as attached to one item.
  const prefix = !before || before.endsWith('\n') ? '' : '\n';
  const suffix = !after || after.startsWith('\n') ? '' : '\n';
  const insertion = `${prefix}${placeholder}${suffix}`;

  // Caret lands after the marker but before the trailing newline, so typing
  // continues on the marker's line rather than pushing the next item down.
  const cursor = start + prefix.length + placeholder.length;

  return {
    value: `${before}${insertion}${after}`,
    caret: { start: cursor, end: cursor },
  };
}
