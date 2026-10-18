import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AGENT_MEMORY_MAX_ID_CHARS,
  agentMemoryQuestionResponseDetailInputSchema,
} from './agent-memory-types';
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

describe('getStableQuestionKeys length cap', () => {
  const longQuestion = `Which deployment strategy should we use? ${'x'.repeat(500)}`;

  it('keeps text-derived keys within the memory ID cap', () => {
    const [key] = getStableQuestionKeys([{ question: longQuestion }]);
    expect(key.length).toBeLessThanOrEqual(AGENT_MEMORY_MAX_ID_CHARS);
    expect(
      agentMemoryQuestionResponseDetailInputSchema.safeParse({
        questionKey: key,
        selectedLabels: [],
        customAnswer: 'yes',
        notes: null,
      }).success,
    ).toBe(true);
  });

  it('keeps two long questions sharing a prefix distinct', () => {
    const [first, second] = getStableQuestionKeys([
      { question: `${longQuestion}A` },
      { question: `${longQuestion}B` },
    ]);
    expect(first).not.toEqual(second);
  });

  it('is deterministic across derivations', () => {
    expect(getStableQuestionKeys([{ question: longQuestion }])).toEqual(
      getStableQuestionKeys([{ question: longQuestion }]),
    );
  });
});
