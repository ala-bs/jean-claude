import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AGENT_MEMORY_EVENT_SOURCES,
  AGENT_MEMORY_ITEM_CATEGORIES,
  AGENT_MEMORY_ITEM_KINDS,
  AGENT_MEMORY_ITEM_SCOPES,
  AGENT_MEMORY_ITEM_STATUSES,
  AGENT_MEMORY_MAX_CONTEXT_CHARS,
  AGENT_MEMORY_MAX_PROPOSAL_ITEMS,
  AGENT_MEMORY_MAX_QUESTION_LABELS,
  AGENT_MEMORY_MAX_QUESTION_RESPONSE_CHARS,
  AGENT_MEMORY_MAX_QUOTE_CHARS,
  AGENT_MEMORY_MAX_STATEMENT_CHARS,
  AGENT_MEMORY_MAX_SUBJECT_CHARS,
  type AgentMemoryDashboard,
  type AgentMemoryEvent,
  agentMemoryEventSchema,
  agentMemoryExtractionRunSchema,
  agentMemoryExtractionStateSchema,
  agentMemoryItemSchema,
  agentMemoryNominationSchema,
  agentMemoryQuestionResponseDetailInputSchema,
  agentMemoryQuestionResponseDetailSchema,
  type GlobalAgentMemoryProposal,
  globalAgentMemoryProposalSchema,
  hasUniqueAgentMemoryEvidenceIds,
  normalizeAgentMemoryEvent,
  type ProjectAgentMemoryProposal,
  projectAgentMemoryProposalSchema,
} from './agent-memory-types';

const baseEvent = {
  schemaVersion: 1 as const,
  id: 'event-1',
  sourceId: 'source-1',
  projectId: 'project-1',
  taskId: 'task-1',
  stepId: 'step-1',
  text: 'Use focused tests.',
  createdAt: '2026-07-18T12:00:00.000Z',
  redactions: [],
};

describe('agent memory contracts', () => {
  it('validates strict renderer question-memory details', () => {
    const detail = {
      questionKey: 'approach',
      selectedLabels: ['Small'],
      customAnswer: null,
      notes: 'Keep scope narrow',
    };

    expect(agentMemoryQuestionResponseDetailSchema.parse(detail)).toEqual(
      detail,
    );
    expect(() =>
      agentMemoryQuestionResponseDetailSchema.parse({
        ...detail,
        question: 'Renderer-owned text',
      }),
    ).toThrow();
    expect(() =>
      agentMemoryQuestionResponseDetailSchema.parse({
        ...detail,
        selectedLabels: ['Small', 'Small'],
      }),
    ).toThrow('Selected labels must be unique');
  });

  it('lists every supported user-authored event source', () => {
    expect(AGENT_MEMORY_EVENT_SOURCES).toEqual([
      'initial-task-prompt',
      'follow-up-prompt',
      'queued-prompt',
      'new-step-prompt',
      'question-answer',
      'task-review',
      'pr-comment',
      'pr-reply',
    ]);
  });

  it.each<AgentMemoryEvent>([
    { ...baseEvent, source: 'initial-task-prompt', context: null },
    {
      ...baseEvent,
      source: 'follow-up-prompt',
      context: { previousAgentResult: 'Prior result' },
    },
    {
      ...baseEvent,
      source: 'queued-prompt',
      context: { previousAgentResult: null },
    },
    {
      ...baseEvent,
      source: 'new-step-prompt',
      context: { previousAgentResult: 'Prior step result' },
    },
    {
      ...baseEvent,
      source: 'question-answer',
      context: {
        question: 'Which backend?',
        selectedLabels: ['OpenCode'],
        customAnswer: 'Use configured model',
        notes: 'Keep model choice local',
      },
    },
    {
      ...baseEvent,
      source: 'task-review',
      context: {
        selectedText: 'const value = 1;',
        filePath: 'src/app.ts',
        lineStart: 10,
        lineEnd: 12,
        presets: ['correctness', 'security'],
      },
    },
    {
      ...baseEvent,
      source: 'pr-comment',
      context: {
        pullRequestId: '42',
        filePath: 'src/app.ts',
        lineStart: 10,
        lineEnd: 10,
        selectedLines: 'const value = 1;',
        threadContext: null,
      },
    },
    {
      ...baseEvent,
      source: 'pr-reply',
      context: {
        pullRequestId: '42',
        threadId: 'thread-1',
        filePath: null,
        lineStart: null,
        lineEnd: null,
        selectedLines: null,
        threadContext: 'Earlier discussion',
      },
    },
  ])('validates source-specific context for $source', (event) => {
    expect(agentMemoryEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects context from a different source', () => {
    expect(
      agentMemoryEventSchema.safeParse({
        ...baseEvent,
        source: 'question-answer',
        context: { previousAgentResult: 'Not question context' },
      }).success,
    ).toBe(false);
  });

  it('defines canonical item categories, kinds, scopes, and statuses', () => {
    expect(AGENT_MEMORY_ITEM_CATEGORIES).toEqual([
      'communication',
      'engineering',
      'product',
      'quality',
      'design-ui-ux',
      'process-workflow',
      'decision',
      'constraint',
      'guideline',
      'recurring-priority',
    ]);
    expect(AGENT_MEMORY_ITEM_KINDS).toEqual([
      'explicit-preference',
      'inferred-preference',
      'project-decision',
      'project-constraint',
      'project-guideline',
      'project-priority',
    ]);
    expect(AGENT_MEMORY_ITEM_SCOPES).toEqual(['task', 'project', 'global']);
    expect(AGENT_MEMORY_ITEM_STATUSES).toEqual([
      'candidate',
      'confirmed',
      'superseded',
    ]);
  });

  it('requires unique evidence IDs and bounded finite confidence', () => {
    const item = {
      schemaVersion: 1,
      id: 'item-1',
      statement: 'Prefers focused tests.',
      category: 'quality',
      kind: 'explicit-preference',
      scope: 'global',
      status: 'confirmed',
      confidence: 0.9,
      evidenceIds: ['event-1', 'event-2'],
      taskCount: 2,
      projectCount: 2,
      firstSeenAt: baseEvent.createdAt,
      lastSeenAt: baseEvent.createdAt,
      updatedAt: baseEvent.createdAt,
    };

    expect(agentMemoryItemSchema.safeParse(item).success).toBe(true);
    expect(
      agentMemoryItemSchema.safeParse({
        ...item,
        evidenceIds: ['event-1', 'event-1'],
      }).success,
    ).toBe(false);
    expect(hasUniqueAgentMemoryEvidenceIds({ evidenceIds: [] })).toBe(false);
    expect(
      hasUniqueAgentMemoryEvidenceIds({ evidenceIds: ['event-1', '   '] }),
    ).toBe(false);
    expect(
      hasUniqueAgentMemoryEvidenceIds({ evidenceIds: ['event-1', 'event-1'] }),
    ).toBe(false);
    expect(
      hasUniqueAgentMemoryEvidenceIds({ evidenceIds: ['event-1', 'event-2'] }),
    ).toBe(true);
    for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        agentMemoryItemSchema.safeParse({ ...item, confidence }).success,
      ).toBe(false);
    }
  });

  it('enforces item scope and supersession consistency', () => {
    const item = {
      schemaVersion: 1,
      id: 'item-1',
      statement: 'Prefers focused tests.',
      category: 'quality',
      kind: 'explicit-preference',
      scope: 'global',
      status: 'confirmed',
      confidence: 0.9,
      evidenceIds: ['event-1'],
      taskCount: 1,
      projectCount: 1,
      firstSeenAt: baseEvent.createdAt,
      lastSeenAt: baseEvent.createdAt,
      updatedAt: baseEvent.createdAt,
    };

    expect(
      agentMemoryItemSchema.safeParse({ ...item, projectId: 'project-1' }).success,
    ).toBe(false);
    expect(
      agentMemoryItemSchema.safeParse({
        ...item,
        status: 'superseded',
      }).success,
    ).toBe(false);
    expect(
      agentMemoryItemSchema.safeParse({
        ...item,
        supersededById: 'item-2',
      }).success,
    ).toBe(false);
    expect(
      agentMemoryItemSchema.safeParse({
        ...item,
        status: 'superseded',
        supersededById: 'item-2',
        supersessionReason: 'contradiction',
      }).success,
    ).toBe(true);
    expect(
      agentMemoryItemSchema.safeParse({
        ...item,
        supersessionReason: 'promotion',
      }).success,
    ).toBe(false);
  });

  it('validates nominations and extraction run accounting', () => {
    expect(
      agentMemoryNominationSchema.safeParse({
        schemaVersion: 1,
        id: 'nomination-1',
        projectId: 'project-1',
        statement: 'Prefers focused tests.',
        semanticSubject: 'testing strategy',
        category: 'quality',
        kind: 'explicit-preference',
        confidence: 0.8,
        evidenceIds: ['event-1'],
        taskIds: ['task-1'],
        createdAt: baseEvent.createdAt,
      }).success,
    ).toBe(true);

    expect(
      agentMemoryExtractionStateSchema.safeParse({
        schemaVersion: 1,
        files: { '2026-07-18.jsonl': 100 },
        lastExtractedAt: null,
        projectionPending: false,
      }).success,
    ).toBe(true);

    expect(
      agentMemoryExtractionRunSchema.safeParse({
        schemaVersion: 1,
        id: 'run-1',
        scope: 'project',
        projectId: 'project-1',
        trigger: 'scheduled',
        backend: 'opencode',
        model: 'test-model',
        status: 'succeeded',
        eventRanges: [
          {
            fileName: '2026-07-18.jsonl',
            fromOffset: 0,
            toOffset: 100,
            eventCount: 2,
          },
        ],
        proposedItemCount: 2,
        acceptedItemCount: 1,
        startedAt: baseEvent.createdAt,
        completedAt: baseEvent.createdAt,
        durationMs: 25,
        error: null,
      }).success,
    ).toBe(true);
  });

  it('enforces extraction run scope and terminal-state consistency', () => {
    const run = {
      schemaVersion: 1,
      id: 'run-1',
      scope: 'global',
      trigger: 'manual',
      backend: 'opencode',
      model: 'test-model',
      status: 'succeeded',
      eventRanges: [],
      proposedItemCount: 1,
      acceptedItemCount: 1,
      startedAt: baseEvent.createdAt,
      completedAt: baseEvent.createdAt,
      durationMs: 25,
      error: null,
    };

    expect(
      agentMemoryExtractionRunSchema.safeParse({
        ...run,
        projectId: 'project-1',
      }).success,
    ).toBe(false);
    expect(
      agentMemoryExtractionRunSchema.safeParse({
        ...run,
        status: 'running',
      }).success,
    ).toBe(false);
    expect(
      agentMemoryExtractionRunSchema.safeParse({
        ...run,
        status: 'failed',
        error: null,
      }).success,
    ).toBe(false);
    expect(
      agentMemoryExtractionRunSchema.safeParse({
        ...run,
        status: 'failed',
        error: { message: 'model failed' },
      }).success,
    ).toBe(true);
  });

  it('exposes project/global proposals and paged dashboard payloads', () => {
    expectTypeOf<ProjectAgentMemoryProposal>().toHaveProperty('nominations');
    expectTypeOf<GlobalAgentMemoryProposal>().toHaveProperty('items');
    expectTypeOf<AgentMemoryDashboard>().toHaveProperty('evidence');
    expectTypeOf<AgentMemoryDashboard['evidence']>().toMatchTypeOf<{
      items: AgentMemoryEvent[];
      page: number;
      pageSize: number;
      total: number;
    }>();

    const proposalItem = {
      statement: 'Prefer focused tests.',
      category: 'quality',
      kind: 'explicit-preference',
      confidence: 0.8,
      evidenceIds: ['event-1'],
      taskIds: ['task-1'],
      projectIds: ['project-1'],
    };
    expect(
      projectAgentMemoryProposalSchema.safeParse({
        schemaVersion: 1,
        items: [{ ...proposalItem, scope: 'global' }],
        nominations: [],
      }).success,
    ).toBe(false);
    expect(
      globalAgentMemoryProposalSchema.safeParse({
        schemaVersion: 1,
        items: [{ ...proposalItem, scope: 'project' }],
      }).success,
    ).toBe(false);
  });

  it('bounds generated proposal counts and text fields', () => {
    const item = {
      statement: 'Prefer focused tests.',
      semanticSubject: 'testing strategy',
      category: 'quality' as const,
      kind: 'inferred-preference' as const,
      scope: 'project' as const,
      confidence: 0.8,
      evidenceIds: ['event-1'],
      evidenceQuotes: [{ evidenceId: 'event-1', quote: 'focused tests' }],
      taskIds: ['task-1'],
      projectIds: ['project-1'],
    };
    expect(
      projectAgentMemoryProposalSchema.safeParse({
        schemaVersion: 1,
        items: [item],
        nominations: [],
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...item, statement: 'x'.repeat(AGENT_MEMORY_MAX_STATEMENT_CHARS + 1) },
      {
        ...item,
        semanticSubject: 'x'.repeat(AGENT_MEMORY_MAX_SUBJECT_CHARS + 1),
      },
      {
        ...item,
        evidenceQuotes: [{
          evidenceId: 'event-1',
          quote: 'x'.repeat(AGENT_MEMORY_MAX_QUOTE_CHARS + 1),
        }],
      },
    ]) {
      expect(
        projectAgentMemoryProposalSchema.safeParse({
          schemaVersion: 1,
          items: [invalid],
          nominations: [],
        }).success,
      ).toBe(false);
    }
    expect(
      projectAgentMemoryProposalSchema.safeParse({
        schemaVersion: 1,
        items: Array.from(
          { length: AGENT_MEMORY_MAX_PROPOSAL_ITEMS + 1 },
          () => item,
        ),
        nominations: [],
      }).success,
    ).toBe(false);
  });

  it('bounds context fields/counts and normalizes aggregate migrated context', () => {
    expect(
      agentMemoryQuestionResponseDetailSchema.safeParse({
        questionKey: 'q',
        selectedLabels: Array.from(
          { length: AGENT_MEMORY_MAX_QUESTION_LABELS + 1 },
          (_, index) => `label-${index}`,
        ),
        customAnswer: null,
        notes: null,
      }).success,
    ).toBe(false);

    const normalized = normalizeAgentMemoryEvent({
      ...baseEvent,
      source: 'pr-reply',
      context: {
        pullRequestId: '42',
        threadId: 'thread-1',
        filePath: 'src/app.ts',
        lineStart: 1,
        lineEnd: 1,
        selectedLines: 'a'.repeat(15_000),
        threadContext: 'b'.repeat(30_000),
      },
    });
    const context = normalized.context!;
    const aggregate = Object.values(context).reduce<number>(
      (total, value) => total + (typeof value === 'string' ? value.length : 0),
      0,
    );

    expect(normalized.contextTruncated).toBe(true);
    expect(aggregate).toBeLessThanOrEqual(AGENT_MEMORY_MAX_CONTEXT_CHARS);
    expect(agentMemoryEventSchema.safeParse(normalized).success).toBe(true);
  });

  // Storage size caps must never gate answer delivery: the input schema is
  // shape-only, and truncation happens later at capture time.
  describe('agentMemoryQuestionResponseDetailInputSchema', () => {
    const oversized = 'x'.repeat(AGENT_MEMORY_MAX_QUESTION_RESPONSE_CHARS + 1);

    it('accepts answers that exceed the storage caps', () => {
      const detail = {
        questionKey: 'approach',
        selectedLabels: Array.from(
          { length: AGENT_MEMORY_MAX_QUESTION_LABELS + 1 },
          (_, index) => `label-${index}`,
        ),
        customAnswer: oversized,
        notes: oversized,
      };

      // The storage schema rejects it...
      expect(
        agentMemoryQuestionResponseDetailSchema.safeParse(detail).success,
      ).toBe(false);
      // ...but delivery validation must not.
      expect(
        agentMemoryQuestionResponseDetailInputSchema.safeParse(detail).success,
      ).toBe(true);
    });

    it('still rejects malformed shapes', () => {
      expect(
        agentMemoryQuestionResponseDetailInputSchema.safeParse({
          questionKey: 'approach',
          selectedLabels: ['dup', 'dup'],
          customAnswer: null,
          notes: null,
        }).success,
      ).toBe(false);
      expect(
        agentMemoryQuestionResponseDetailInputSchema.safeParse({
          questionKey: 'approach',
          selectedLabels: [],
          customAnswer: null,
          notes: null,
          unexpected: true,
        }).success,
      ).toBe(false);
    });

    it('truncates the oversized answer at capture time instead', () => {
      const normalized = normalizeAgentMemoryEvent({
        schemaVersion: 1,
        id: 'event-1',
        source: 'question-answer',
        sourceId: 'question:req:approach',
        projectId: 'project-1',
        taskId: 'task-1',
        stepId: 'step-1',
        text: 'answer',
        createdAt: new Date(0).toISOString(),
        redactions: [],
        context: {
          question: 'Which approach?',
          selectedLabels: Array.from(
            { length: AGENT_MEMORY_MAX_QUESTION_LABELS + 1 },
            (_, index) => `label-${index}`,
          ),
          customAnswer: oversized,
          notes: null,
        },
      });

      expect(normalized.contextTruncated).toBe(true);
      expect(agentMemoryEventSchema.safeParse(normalized).success).toBe(true);
    });
  });
});
