import { JEAN_CLAUDE_ANSWER_FILES_FIELD } from '@shared/attached-files';

export function formatElicitationResult(content: Record<string, unknown>): string {
  const answers = Object.entries(content)
    .filter(([key]) => key !== JEAN_CLAUDE_ANSWER_FILES_FIELD)
    .map(([key, value]) => {
      const leftEmpty = value === '' || (Array.isArray(value) && value.length === 0);
      const text = leftEmpty
        ? '[left empty]'
        : Array.isArray(value)
          ? value.join(', ')
          : String(value);
      return `${key}: ${text}`;
    })
    .join('\n');
  const files = content[JEAN_CLAUDE_ANSWER_FILES_FIELD];
  return typeof files === 'string' && files.trim()
    ? `${answers}\n\n${files.trim()}`
    : answers;
}
