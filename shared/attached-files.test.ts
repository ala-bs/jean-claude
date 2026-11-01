import {
  buildAskQuestionElicitationSchema,
  JEAN_CLAUDE_ANSWER_FILES_FIELD,
} from './attached-files';
import { describe, expect, it } from 'vitest';

describe('buildAskQuestionElicitationSchema', () => {
  // codex-cli parses `requestedSchema` into a strict struct: an extra root key
  // made it cancel every ask_question form in ~0ms, so the user never saw the
  // prompt and the agent was told the question was cancelled.
  it('emits no root keys beyond type, properties and required', () => {
    const schema = buildAskQuestionElicitationSchema({
      questions: [
        { id: 'scope', label: 'Scope?', type: 'single_choice', options: [{ label: 'a' }] },
        { id: 'notes', label: 'Notes?', type: 'text', required: false },
        { id: 'many', label: 'Many?', type: 'multi_choice', options: [{ label: 'b' }] },
      ],
    });

    expect(Object.keys(schema).sort()).toEqual([
      'properties',
      'required',
      'type',
    ]);
    expect(schema.required).toEqual(['scope', 'many']);
  });

  it('marks the form as ours by the reserved answer-files property', () => {
    const schema = buildAskQuestionElicitationSchema({
      questions: [{ id: 'notes', label: 'Notes?', type: 'text' }],
    });

    expect(schema.properties[JEAN_CLAUDE_ANSWER_FILES_FIELD]).toEqual({
      type: 'string',
      title: 'Attached answer files',
    });
    expect(schema.properties.notes).toEqual({
      type: 'string',
      title: 'Notes?',
    });
  });
});
