import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  getStableQuestionKeys,
  type QuestionResponseMetadata,
} from './agent-types';
import type { AgentBackend } from './agent-backend-types';

it('requires question response metadata in the backend contract', () => {
  expectTypeOf<Parameters<AgentBackend['respondToQuestion']>[3]>().toEqualTypeOf<QuestionResponseMetadata>();
});

describe('getStableQuestionKeys', () => {
  it('preserves unique explicit IDs and qualifies duplicate fallback text', () => {
    expect(
      getStableQuestionKeys([
        { id: 'explicit', question: 'Same' },
        { question: 'Same' },
        { question: 'Same' },
      ]),
    ).toEqual(['explicit', 'Same#2', 'Same#3']);
  });

  it('avoids collisions with unique request-owned keys', () => {
    expect(
      getStableQuestionKeys([
        { question: 'Same' },
        { question: 'Same' },
        { id: 'Same#1', question: 'Other' },
      ]),
    ).toEqual(['Same#1#', 'Same#2', 'Same#1']);
  });
});
