/**
 * A paste larger than `MAX_INLINE_PASTED_PROMPT_LENGTH` is written to a temp
 * file and attached instead of being inlined, which used to lose two things:
 * *where* in the prompt that content belonged, and — when several big chunks
 * were pasted for different reasons — *which chunk was which* (every file was
 * called `pasted-content.md`).
 *
 * So each paste now gets a numbered name and a readable marker dropped at the
 * caret:
 *
 *     here are the logs
 *     [pasted: paste-1.md]
 *     and the config it ran with:
 *     [pasted: paste-2.md]
 *
 * The marker is plain text, so every backend and every text surface carries it
 * as-is; the `<attached_files>` block already shipped with the prompt maps the
 * name to its absolute path (see `buildAttachedFilesXml`).
 */

/** Numbered name given to pasted-content attachments. */
const PASTED_FILENAME_RE = /^paste-(\d+)\.md$/;

export function isPastedPromptFilename(filename: string): boolean {
  return PASTED_FILENAME_RE.test(filename);
}

export function buildPastedPromptPlaceholder(filename: string): string {
  return `[pasted: ${filename}]`;
}

function placeholderSource(filename: string): string {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return `\\[pasted: ${escaped}\\]`;
}

/**
 * Drop one paste's marker from a draft when its chip is removed, collapsing the
 * line it owned so the surrounding sentences do not end up with a hole.
 */
export function removePastedPromptPlaceholder(
  text: string,
  filename: string,
): string {
  const placeholder = placeholderSource(filename);
  return (
    text
      .replace(new RegExp(`\\n[ \\t]*${placeholder}[ \\t]*(?=\\n|$)`, 'g'), '')
      .replace(new RegExp(`^[ \\t]*${placeholder}[ \\t]*\\n`), '')
      .replace(new RegExp(placeholder, 'g'), '')
  );
}

/**
 * Reserve the next `paste-N.md` for a draft, advancing a caller-held counter.
 *
 * Numbering continues past the highest name seen rather than filling gaps, so
 * a name never refers to two different chunks within one prompt — removing
 * paste-1 then pasting again yields paste-3, not a second paste-1 whose marker
 * may still be in the text.
 *
 * Deriving the number from the attached `files` alone is not enough: a file is
 * only attached after an async IPC write, so two pastes inside that window
 * would both read the same list and mint the same name. The counter reserves
 * the name synchronously at paste time; `files` and any markers still in the
 * draft text only re-seed it, so a restored or copied-in draft does not
 * restart at 1.
 */
export function reservePastedPromptFilename({
  counter,
  files,
  text,
}: {
  counter: { current: number };
  files?: readonly { filename: string }[];
  /** Draft text, so markers inherited from another prompt are not reused. */
  text?: string;
}): string {
  let highest = counter.current;
  for (const file of files ?? []) {
    const match = PASTED_FILENAME_RE.exec(file.filename);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  for (const [, n] of (text ?? '').matchAll(/\[pasted: paste-(\d+)\.md\]/g)) {
    highest = Math.max(highest, Number(n));
  }
  counter.current = highest + 1;
  return `paste-${counter.current}.md`;
}
