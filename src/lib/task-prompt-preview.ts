import { stripPromptImagePlaceholders } from '@shared/prompt-image-placeholders';

/**
 * The first meaningful line of a raw task prompt, for use anywhere a task is
 * labelled before name generation has produced a `task.name`.
 *
 * A prompt that opens with a pasted image starts with a `jc-image://` marker on
 * its own line, so the naive `prompt.split('\n')[0]` used to render the task as
 * a dead markdown link. Always route raw `task.prompt` through this.
 */
export function getTaskPromptPreview(prompt: string): string {
  const lines = stripPromptImagePlaceholders(prompt).split('\n');
  return lines.find((line) => line.trim()) ?? lines[0] ?? '';
}
