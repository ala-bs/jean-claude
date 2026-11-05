import type { PromptFilePart } from './agent-backend-types';

/**
 * Optional field in Jean-Claude's own Codex MCP elicitation form schema.
 *
 * Its presence in `requestedSchema.properties` is the *only* marker that a form
 * elicitation came from Jean-Claude's `ask_question`. A root-level `description`
 * was used before, but codex-cli 0.155 rejects (and silently cancels) any form
 * elicitation whose root schema carries unknown fields.
 * @see buildAskQuestionElicitationSchema
 */
export const JEAN_CLAUDE_ANSWER_FILES_FIELD = '__jean_claude_answer_files';

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

/**
 * Root schema of Jean-Claude's `ask_question` form elicitation.
 *
 * codex-cli deserializes `requestedSchema` into a strict struct, so any extra
 * root key (a `description` marker, for one) makes it answer the elicitation
 * with `{action:'cancel'}` in ~0ms — the question never reaches the UI and the
 * agent is told the user cancelled. Keep this to `type`/`properties`/`required`.
 */
export function buildAskQuestionElicitationSchema(input: {
  questions: Array<{
    id: string;
    label: string;
    type: 'single_choice' | 'multi_choice' | 'text';
    options?: Array<{ label: string }>;
    required?: boolean;
  }>;
}): {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
} {
  const properties: Record<string, Record<string, unknown>> =
    Object.fromEntries(
      input.questions.map((question) => {
        const options = question.options ?? [];
        if (question.type === 'multi_choice') {
          return [
            question.id,
            {
              type: 'array',
              title: question.label,
              items: {
                type: 'string',
                enum: options.map((option) => option.label),
              },
            },
          ];
        }
        return [
          question.id,
          {
            type: 'string',
            title: question.label,
            ...(options.length > 0
              ? { enum: [...options.map((option) => option.label), ''] }
              : {}),
          },
        ];
      }),
    );
  properties[JEAN_CLAUDE_ANSWER_FILES_FIELD] = {
    type: 'string',
    title: 'Attached answer files',
  };
  return {
    type: 'object',
    properties,
    required: input.questions
      .filter((question) => question.required !== false)
      .map((question) => question.id),
  };
}
