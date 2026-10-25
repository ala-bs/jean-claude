import type { PromptFilePart } from './agent-backend-types';

/** Optional field in Jean-Claude's own Codex MCP elicitation form schema. */
export const JEAN_CLAUDE_ANSWER_FILES_FIELD = '__jean_claude_answer_files';
export const JEAN_CLAUDE_ASK_QUESTION_SCHEMA_DESCRIPTION =
  'Jean-Claude ask_question form';

function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildAttachedFilesXml(files: PromptFilePart[]): string {
  if (files.length === 0) return '';
  const entries = files
    .map(
      (file) =>
        `  <file name="${escapeXmlAttr(file.filename)}" path="${escapeXmlAttr(file.filePath)}" />`,
    )
    .join('\n');
  return `\n\n<attached_files>\n${entries}\n</attached_files>`;
}
