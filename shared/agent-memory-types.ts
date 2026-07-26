import { z } from 'zod';

export const AGENT_MEMORY_SCHEMA_VERSION = 1 as const;
export const AGENT_MEMORY_MAX_STATEMENT_CHARS = 500;
export const AGENT_MEMORY_MAX_SUBJECT_CHARS = 200;
export const AGENT_MEMORY_MAX_QUOTE_CHARS = 500;
export const AGENT_MEMORY_MIN_QUOTE_CHARS = 8;
export const AGENT_MEMORY_MAX_PROPOSAL_ITEMS = 100;
export const AGENT_MEMORY_MAX_EVENT_TEXT_CHARS = 50_000;
export const AGENT_MEMORY_MAX_CONTEXT_CHARS = 20_000;
export const AGENT_MEMORY_MAX_CONTEXT_FIELD_CHARS = 10_000;
export const AGENT_MEMORY_MAX_QUESTION_CHARS = 2_000;
export const AGENT_MEMORY_MAX_QUESTION_LABEL_CHARS = 200;
export const AGENT_MEMORY_MAX_QUESTION_LABELS = 20;
export const AGENT_MEMORY_MAX_QUESTION_RESPONSE_CHARS = 5_000;
export const AGENT_MEMORY_MAX_FILE_PATH_CHARS = 2_000;
export const AGENT_MEMORY_MAX_PRESETS = 20;
export const AGENT_MEMORY_MAX_PRESET_CHARS = 100;
export const AGENT_MEMORY_MAX_ID_CHARS = 256;
export const AGENT_MEMORY_MAX_CANONICAL_ITEMS = 1_000;
export const AGENT_MEMORY_MAX_CANONICAL_INPUT_BYTES = 5_000_000;
export const AGENT_MEMORY_MAX_LEGACY_PROFILE_BYTES = 20_000_000;
export const AGENT_MEMORY_MAX_GLOBAL_SUMMARY_CHARS = 160;
export const AGENT_MEMORY_MAX_GLOBAL_SUBJECT_CHARS = 80;

export const AGENT_MEMORY_EVENT_SOURCES = [
  'initial-task-prompt',
  'follow-up-prompt',
  'queued-prompt',
  'new-step-prompt',
  'question-answer',
  'task-review',
  'pr-comment',
  'pr-reply',
] as const;

export const AGENT_MEMORY_ITEM_CATEGORIES = [
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
] as const;

export const AGENT_MEMORY_ITEM_KINDS = [
  'explicit-preference',
  'inferred-preference',
  'project-decision',
  'project-constraint',
  'project-guideline',
  'project-priority',
] as const;

export const AGENT_MEMORY_ITEM_SCOPES = ['task', 'project', 'global'] as const;
export const AGENT_MEMORY_ITEM_STATUSES = [
  'candidate',
  'confirmed',
  'superseded',
] as const;
export const AGENT_MEMORY_EXTRACTION_STATUSES = [
  'running',
  'succeeded',
  'failed',
] as const;

export type AgentMemoryEventSource = (typeof AGENT_MEMORY_EVENT_SOURCES)[number];
export type AgentMemoryItemCategory =
  (typeof AGENT_MEMORY_ITEM_CATEGORIES)[number];
export type AgentMemoryItemKind = (typeof AGENT_MEMORY_ITEM_KINDS)[number];
export type AgentMemoryItemScope = (typeof AGENT_MEMORY_ITEM_SCOPES)[number];
export type AgentMemoryItemStatus =
  (typeof AGENT_MEMORY_ITEM_STATUSES)[number];
export type AgentMemoryExtractionStatus =
  (typeof AGENT_MEMORY_EXTRACTION_STATUSES)[number];

export const agentMemoryRedactionMarkerSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum([
      'bearer-token',
      'credential-assignment',
      'private-key',
      'credential-url',
      'provider-token',
      'jwt',
      'azure-devops-pat',
    ]),
    count: z.number().int().positive(),
  })
  .strict();

export type AgentMemoryRedactionMarker = z.infer<
  typeof agentMemoryRedactionMarkerSchema
>;

const eventBaseSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MEMORY_SCHEMA_VERSION),
    id: z.string().min(1),
    sourceId: z.string().min(1),
    projectId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    stepId: z.string().min(1).optional(),
    text: z.string(),
    textTruncated: z.boolean().optional(),
    contextTruncated: z.boolean().optional(),
    createdAt: z.string().datetime(),
    redactions: z.array(agentMemoryRedactionMarkerSchema),
  })
  .strict();

const priorResultContextSchema = z
  .object({
    previousAgentResult: z
      .string()
      .max(AGENT_MEMORY_MAX_CONTEXT_CHARS)
      .nullable(),
  })
  .strict();
export const agentMemoryQuestionResponseDetailSchema = z
  .object({
    questionKey: z.string().min(1).max(AGENT_MEMORY_MAX_ID_CHARS),
    selectedLabels: z
      .array(z.string().min(1).max(AGENT_MEMORY_MAX_QUESTION_LABEL_CHARS))
      .max(AGENT_MEMORY_MAX_QUESTION_LABELS)
      .refine((labels) => new Set(labels).size === labels.length, {
        message: 'Selected labels must be unique',
      }),
    customAnswer: z
      .string()
      .min(1)
      .max(AGENT_MEMORY_MAX_QUESTION_RESPONSE_CHARS)
      .nullable(),
    notes: z
      .string()
      .min(1)
      .max(AGENT_MEMORY_MAX_QUESTION_RESPONSE_CHARS)
      .nullable(),
  })
  .strict();
export type AgentMemoryQuestionResponseDetail = z.infer<
  typeof agentMemoryQuestionResponseDetailSchema
>;
/**
 * Shape-only variant used to validate a renderer question response *before the
 * answer is delivered to the agent*.
 *
 * Deliberately drops the size caps above. Those bound what gets persisted to
 * memory and are already applied on the capture path by
 * `normalizeAgentMemoryEvent`. Enforcing them here instead would let a long but
 * perfectly legitimate answer (a >5000-char pasted note, a question with 21+
 * selected options) fail validation and leave the step waiting forever — a
 * memory-storage limit must never block an agent response.
 *
 * `questionKey` keeps its cap: it is backend-generated and used to build event
 * source ids, not user input.
 */
export const agentMemoryQuestionResponseDetailInputSchema = z
  .object({
    questionKey: z.string().min(1).max(AGENT_MEMORY_MAX_ID_CHARS),
    selectedLabels: z
      .array(z.string().min(1))
      .refine((labels) => new Set(labels).size === labels.length, {
        message: 'Selected labels must be unique',
      }),
    customAnswer: z.string().min(1).nullable(),
    notes: z.string().min(1).nullable(),
  })
  .strict();
export const agentMemoryQuestionAnswerContextSchema =
  agentMemoryQuestionResponseDetailSchema.omit({ questionKey: true }).extend({
    question: z.string().min(1).max(AGENT_MEMORY_MAX_QUESTION_CHARS),
  });
const taskReviewContextSchema = z
  .object({
    selectedText: z.string().max(AGENT_MEMORY_MAX_CONTEXT_FIELD_CHARS).nullable(),
    filePath: z.string().max(AGENT_MEMORY_MAX_FILE_PATH_CHARS).nullable(),
    lineStart: z.number().int().positive().nullable(),
    lineEnd: z.number().int().positive().nullable(),
    presets: z
      .array(z.string().min(1).max(AGENT_MEMORY_MAX_PRESET_CHARS))
      .max(AGENT_MEMORY_MAX_PRESETS),
  })
  .strict()
  .superRefine((context, refinement) => {
    if ((context.lineStart === null) !== (context.lineEnd === null)) {
      refinement.addIssue({
        code: 'custom',
        message: 'Task review line range requires both endpoints',
      });
    }
    if (
      context.lineStart !== null &&
      context.lineEnd !== null &&
      context.lineEnd < context.lineStart
    ) {
      refinement.addIssue({
        code: 'custom',
        message: 'Task review line range is reversed',
      });
    }
  });
const pullRequestContextSchema = z
  .object({
    pullRequestId: z.string().min(1).max(AGENT_MEMORY_MAX_ID_CHARS),
    filePath: z.string().max(AGENT_MEMORY_MAX_FILE_PATH_CHARS).nullable(),
    lineStart: z.number().int().positive().nullable(),
    lineEnd: z.number().int().positive().nullable(),
    selectedLines: z.string().max(AGENT_MEMORY_MAX_CONTEXT_FIELD_CHARS).nullable(),
    threadContext: z.string().max(AGENT_MEMORY_MAX_CONTEXT_CHARS).nullable(),
  })
  .strict();

export const agentMemoryEventSchema = z.discriminatedUnion('source', [
  eventBaseSchema.extend({
    source: z.literal('initial-task-prompt'),
    context: z.null(),
  }),
  eventBaseSchema.extend({
    source: z.literal('follow-up-prompt'),
    context: priorResultContextSchema,
  }),
  eventBaseSchema.extend({
    source: z.literal('queued-prompt'),
    context: priorResultContextSchema,
  }),
  eventBaseSchema.extend({
    source: z.literal('new-step-prompt'),
    context: priorResultContextSchema,
  }),
  eventBaseSchema.extend({
    source: z.literal('question-answer'),
    context: agentMemoryQuestionAnswerContextSchema,
  }),
  eventBaseSchema.extend({
    source: z.literal('task-review'),
    context: taskReviewContextSchema,
  }),
  eventBaseSchema.extend({
    source: z.literal('pr-comment'),
    context: pullRequestContextSchema,
  }),
  eventBaseSchema.extend({
    source: z.literal('pr-reply'),
    context: pullRequestContextSchema.extend({
      threadId: z.string().min(1).max(AGENT_MEMORY_MAX_ID_CHARS),
    }),
  }),
]);

export type AgentMemoryEvent = z.infer<typeof agentMemoryEventSchema>;

function boundedString(
  value: unknown,
  max: number,
  tail = false,
): { value: unknown; truncated: boolean } {
  if (typeof value !== 'string' || value.length <= max) {
    return { value, truncated: false };
  }
  return {
    value: tail ? value.slice(-max) : value.slice(0, max),
    truncated: true,
  };
}

export function normalizeAgentMemoryEvent(value: unknown): AgentMemoryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return agentMemoryEventSchema.parse(value);
  }
  const event = { ...(value as Record<string, unknown>) };
  if (!event.context || typeof event.context !== 'object' || Array.isArray(event.context)) {
    return agentMemoryEventSchema.parse(event);
  }
  const context = { ...(event.context as Record<string, unknown>) };
  let truncated = false;
  const limits: Record<string, { max: number; tail?: boolean }> = {
    previousAgentResult: { max: AGENT_MEMORY_MAX_CONTEXT_CHARS, tail: true },
    question: { max: AGENT_MEMORY_MAX_QUESTION_CHARS },
    customAnswer: { max: AGENT_MEMORY_MAX_QUESTION_RESPONSE_CHARS },
    notes: { max: AGENT_MEMORY_MAX_QUESTION_RESPONSE_CHARS },
    selectedText: { max: AGENT_MEMORY_MAX_CONTEXT_FIELD_CHARS },
    selectedLines: { max: AGENT_MEMORY_MAX_CONTEXT_FIELD_CHARS },
    threadContext: { max: AGENT_MEMORY_MAX_CONTEXT_CHARS, tail: true },
    filePath: { max: AGENT_MEMORY_MAX_FILE_PATH_CHARS },
    pullRequestId: { max: AGENT_MEMORY_MAX_ID_CHARS },
    threadId: { max: AGENT_MEMORY_MAX_ID_CHARS },
  };
  for (const [key, limit] of Object.entries(limits)) {
    if (!(key in context)) continue;
    const bounded = boundedString(context[key], limit.max, limit.tail);
    context[key] = bounded.value;
    truncated ||= bounded.truncated;
  }
  for (const [key, count, max] of [
    ['selectedLabels', AGENT_MEMORY_MAX_QUESTION_LABELS, AGENT_MEMORY_MAX_QUESTION_LABEL_CHARS],
    ['presets', AGENT_MEMORY_MAX_PRESETS, AGENT_MEMORY_MAX_PRESET_CHARS],
  ] as const) {
    if (!Array.isArray(context[key])) continue;
    const original = context[key] as unknown[];
    const bounded = original.slice(0, count).map((entry) => {
      const result = boundedString(entry, max);
      truncated ||= result.truncated;
      return result.value;
    });
    truncated ||= bounded.length !== original.length;
    context[key] = bounded;
  }

  let remaining = AGENT_MEMORY_MAX_CONTEXT_CHARS;
  for (const key of Object.keys(context)) {
    if (typeof context[key] === 'string') {
      const original = context[key] as string;
      const tail = key === 'previousAgentResult' || key === 'threadContext';
      const bounded = boundedString(original, remaining, tail);
      context[key] = bounded.value;
      truncated ||= bounded.truncated;
      remaining -= (bounded.value as string).length;
      continue;
    }
    if (Array.isArray(context[key])) {
      context[key] = (context[key] as unknown[]).map((entry) => {
        if (typeof entry !== 'string') return entry;
        const bounded = boundedString(entry, remaining);
        truncated ||= bounded.truncated;
        remaining -= (bounded.value as string).length;
        return bounded.value;
      });
    }
  }
  return agentMemoryEventSchema.parse({
    ...event,
    context,
    ...(truncated ? { contextTruncated: true } : {}),
  });
}

export type AgentMemoryTaskReviewCapture = {
  commentId: string;
  body: string;
  selectedText: string | null;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  presets: string[];
};

export type AgentMemoryPromptCapture = {
  userText: string;
  reviews?: AgentMemoryTaskReviewCapture[];
};

export type AgentMemoryFollowUpCapture = AgentMemoryPromptCapture & {
  submissionId: string;
};

export type AgentMemoryQueuedPromptCapture = AgentMemoryPromptCapture & {
  submissionId: string;
};

export type AgentMemoryCaptureWarning = {
  source: AgentMemoryEventSource;
  projectId: string;
  taskId?: string;
  stepId?: string;
  message: string;
};

const uniqueStringArray = z
  .array(z.string().refine((value) => value.trim().length > 0))
  .refine((values) => new Set(values).size === values.length, {
    message: 'Values must be unique',
  });
const confidenceSchema = z.number().finite().min(0).max(1);

export const agentMemoryItemSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MEMORY_SCHEMA_VERSION),
    id: z.string().min(1),
    statement: z.string().min(1).max(AGENT_MEMORY_MAX_STATEMENT_CHARS),
    semanticSubject: z.string().min(1).max(AGENT_MEMORY_MAX_SUBJECT_CHARS).optional(),
    category: z.enum(AGENT_MEMORY_ITEM_CATEGORIES),
    kind: z.enum(AGENT_MEMORY_ITEM_KINDS),
    scope: z.enum(AGENT_MEMORY_ITEM_SCOPES),
    projectId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    status: z.enum(AGENT_MEMORY_ITEM_STATUSES),
    confidence: confidenceSchema,
    evidenceIds: uniqueStringArray.min(1),
    sourceTaskIds: uniqueStringArray.optional(),
    sourceProjectIds: uniqueStringArray.optional(),
    taskCount: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    supersededById: z.string().min(1).optional(),
    supersessionReason: z.enum(['contradiction', 'promotion']).optional(),
    reviewBlocker: z.literal('uncited-global-nomination').optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.scope === 'task' && (!item.taskId || !item.projectId)) {
      context.addIssue({
        code: 'custom',
        message: 'Task-scoped items require taskId and projectId',
      });
    }
    if (item.scope === 'project' && !item.projectId) {
      context.addIssue({
        code: 'custom',
        message: 'Project-scoped items require projectId',
      });
    }
    if (item.scope === 'global' && (item.projectId || item.taskId)) {
      context.addIssue({
        code: 'custom',
        message: 'Global items cannot carry projectId or taskId',
      });
    }
    if ((item.status === 'superseded') !== !!item.supersededById) {
      context.addIssue({
        code: 'custom',
        message: 'Superseded status and supersededById must be set together',
      });
    }
    if (item.status !== 'superseded' && item.supersessionReason) {
      context.addIssue({
        code: 'custom',
        message: 'Only superseded items can carry a supersession reason',
      });
    }
    if (item.status !== 'candidate' && item.reviewBlocker) {
      context.addIssue({
        code: 'custom',
        message: 'Only candidate items can carry a review blocker',
      });
    }
  });

export type AgentMemoryItem = z.infer<typeof agentMemoryItemSchema>;

export const agentMemoryEvidenceQuotesSchema = z
  .array(
    z
      .object({
        evidenceId: z.string().min(1),
        quote: z
          .string()
          .min(AGENT_MEMORY_MIN_QUOTE_CHARS)
          .max(AGENT_MEMORY_MAX_QUOTE_CHARS)
          .refine((value) => value.trim().length > 0, {
            message: 'Evidence quote cannot be blank',
          }),
      })
      .strict(),
  )
  .min(1)
  .max(AGENT_MEMORY_MAX_PROPOSAL_ITEMS)
  .refine(
    (quotes) =>
      new Set(quotes.map((quote) => quote.evidenceId)).size === quotes.length,
    { message: 'Evidence quotes must use unique event IDs' },
  );

export const agentMemoryItemProposalSchema = z
  .object({
    statement: z.string().min(1).max(AGENT_MEMORY_MAX_STATEMENT_CHARS),
    semanticSubject: z.string().min(1).max(AGENT_MEMORY_MAX_SUBJECT_CHARS),
    category: z.enum(AGENT_MEMORY_ITEM_CATEGORIES),
    kind: z.enum(AGENT_MEMORY_ITEM_KINDS),
    scope: z.enum(AGENT_MEMORY_ITEM_SCOPES),
    confidence: confidenceSchema,
    evidenceIds: uniqueStringArray.min(1),
    taskIds: uniqueStringArray,
    projectIds: uniqueStringArray,
    supersedesItemId: z.string().min(1).optional(),
    contradictionEvidenceIds: uniqueStringArray.min(1).optional(),
    promotesItemIds: uniqueStringArray.optional(),
  })
  .strict();

export type AgentMemoryItemProposal = z.infer<
  typeof agentMemoryItemProposalSchema
>;

export const projectAgentMemoryItemProposalSchema =
  agentMemoryItemProposalSchema.extend({
    scope: z.enum(['task', 'project']),
    evidenceQuotes: agentMemoryEvidenceQuotesSchema,
  });

export const globalAgentMemoryItemProposalSchema =
  agentMemoryItemProposalSchema.extend({
    scope: z.literal('global'),
  });

export const agentMemoryNominationSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MEMORY_SCHEMA_VERSION),
    id: z.string().min(1),
    projectId: z.string().min(1),
    statement: z.string().min(1).max(AGENT_MEMORY_MAX_GLOBAL_SUMMARY_CHARS),
    semanticSubject: z
      .string()
      .min(1)
      .max(AGENT_MEMORY_MAX_GLOBAL_SUBJECT_CHARS),
    category: z.enum(AGENT_MEMORY_ITEM_CATEGORIES),
    kind: z.enum(AGENT_MEMORY_ITEM_KINDS),
    confidence: confidenceSchema,
    evidenceIds: uniqueStringArray.min(1),
    taskIds: uniqueStringArray,
    createdAt: z.string().datetime(),
  })
  .strict();

export type AgentMemoryNomination = z.infer<
  typeof agentMemoryNominationSchema
>;

export const agentMemoryNominationProposalSchema = agentMemoryNominationSchema
  .extend({
    evidenceQuotes: agentMemoryEvidenceQuotesSchema,
  })
  .strict();

export type AgentMemoryNominationProposal = z.infer<
  typeof agentMemoryNominationProposalSchema
>;

export const projectAgentMemoryProposalSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MEMORY_SCHEMA_VERSION),
    items: z
      .array(projectAgentMemoryItemProposalSchema)
      .max(AGENT_MEMORY_MAX_PROPOSAL_ITEMS),
    nominations: z
      .array(agentMemoryNominationProposalSchema)
      .max(AGENT_MEMORY_MAX_PROPOSAL_ITEMS),
  })
  .strict();

export type ProjectAgentMemoryProposal = z.infer<
  typeof projectAgentMemoryProposalSchema
>;

export const globalAgentMemoryProposalSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MEMORY_SCHEMA_VERSION),
    items: z
      .array(globalAgentMemoryItemProposalSchema)
      .max(AGENT_MEMORY_MAX_PROPOSAL_ITEMS),
  })
  .strict();

export type GlobalAgentMemoryProposal = z.infer<
  typeof globalAgentMemoryProposalSchema
>;

export const agentMemoryEventRangeSchema = z
  .object({
    fileName: z.string().regex(/^\d{4}-\d{2}-\d{2}\.jsonl$/),
    fromOffset: z.number().int().nonnegative(),
    toOffset: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.toOffset >= range.fromOffset, {
    message: 'toOffset must not precede fromOffset',
  });

export type AgentMemoryEventRange = z.infer<
  typeof agentMemoryEventRangeSchema
>;

/**
 * Consecutive deterministic failures on the same pending range set before those
 * events are quarantined (skipped) so extraction can make progress again.
 *
 * Without this the cursor in `files` only advances on success, so one event
 * that reliably fails generation or grounding is retried on every sweep
 * forever, burning two LLM calls each time and blocking every later event.
 */
export const AGENT_MEMORY_MAX_RANGE_ATTEMPTS = 3;

export const agentMemoryExtractionStateSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MEMORY_SCHEMA_VERSION),
    files: z.record(z.string(), z.number().int().nonnegative()),
    lastExtractedAt: z.string().datetime().nullable(),
    projectionPending: z.boolean(),
    // Absent on states written before quarantine existed.
    failingRange: z
      .object({
        signature: z.string().min(1),
        attempts: z.number().int().positive(),
      })
      .nullable()
      .optional(),
  })
  .strict();

export type AgentMemoryExtractionState = z.infer<
  typeof agentMemoryExtractionStateSchema
>;

export const agentMemoryExtractionRunSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MEMORY_SCHEMA_VERSION),
    id: z.string().min(1),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    scope: z.enum(['project', 'global']),
    projectId: z.string().min(1).optional(),
    trigger: z.enum(['backlog', 'scheduled', 'manual']),
    backend: z.string().min(1),
    model: z.string().min(1),
    thinkingEffort: z.string().min(1).optional(),
    status: z.enum(AGENT_MEMORY_EXTRACTION_STATUSES),
    eventRanges: z.array(agentMemoryEventRangeSchema),
    proposedItemCount: z.number().int().nonnegative(),
    acceptedItemCount: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    durationMs: z.number().finite().nonnegative().nullable(),
    error: z
      .object({ message: z.string(), code: z.string().optional() })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.scope === 'project' && !run.projectId) {
      context.addIssue({
        code: 'custom',
        message: 'Project extraction runs require projectId',
      });
    }
    if (run.scope === 'global' && run.projectId) {
      context.addIssue({
        code: 'custom',
        message: 'Global extraction runs cannot carry projectId',
      });
    }
    if (run.acceptedItemCount > run.proposedItemCount) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted count cannot exceed proposed count',
      });
    }
    if (
      run.status === 'running' &&
      (run.completedAt !== null || run.durationMs !== null || run.error !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Running extraction runs cannot have terminal fields',
      });
    }
    if (
      run.status !== 'running' &&
      (run.completedAt === null || run.durationMs === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal extraction runs require completion fields',
      });
    }
    if (
      (run.status === 'failed' && run.error === null) ||
      (run.status !== 'failed' && run.error !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed extraction runs require an error',
      });
    }
  });

export type AgentMemoryExtractionRun = z.infer<
  typeof agentMemoryExtractionRunSchema
>;

export interface AgentMemoryPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AgentMemoryItemGroup {
  category: AgentMemoryItem['category'];
  items: AgentMemoryItem[];
}

export type AgentMemoryPromotionBlocker = {
  kind: 'task-count' | 'project-count';
  current: number;
  required: number;
};

export interface AgentMemoryCandidate {
  item: AgentMemoryItem;
  blockers: AgentMemoryPromotionBlocker[];
}

export interface AgentMemoryDashboard {
  enabled: boolean;
  repairNotice?: string | null;
  globalProfile: AgentMemoryItemGroup[];
  projectMemory: AgentMemoryItemGroup[];
  candidates: AgentMemoryCandidate[];
  evidence: AgentMemoryPage<AgentMemoryEvent>;
  extractionRuns: AgentMemoryPage<AgentMemoryExtractionRun>;
  extractionState: AgentMemoryExtractionState | null;
}

export function isAgentMemoryEvent(value: unknown): value is AgentMemoryEvent {
  return agentMemoryEventSchema.safeParse(value).success;
}

export function parseAgentMemoryEvent(value: unknown): AgentMemoryEvent {
  return agentMemoryEventSchema.parse(value);
}

export function isAgentMemoryItem(value: unknown): value is AgentMemoryItem {
  return agentMemoryItemSchema.safeParse(value).success;
}

export function parseAgentMemoryItem(value: unknown): AgentMemoryItem {
  return agentMemoryItemSchema.parse(value);
}

export function isBoundedAgentMemoryConfidence(value: unknown): value is number {
  return confidenceSchema.safeParse(value).success;
}

export function hasUniqueAgentMemoryEvidenceIds({
  evidenceIds,
}: {
  evidenceIds: readonly string[];
}): boolean {
  return (
    evidenceIds.length > 0 &&
    evidenceIds.every((id) => id.trim().length > 0) &&
    new Set(evidenceIds).size === evidenceIds.length
  );
}

export function proposalUsesKnownEvidence({
  proposal,
  knownEvidenceIds,
}: {
  proposal: ProjectAgentMemoryProposal | GlobalAgentMemoryProposal;
  knownEvidenceIds: ReadonlySet<string>;
}): boolean {
  const itemEvidence = proposal.items.flatMap((item) => item.evidenceIds);
  const nominationEvidence =
    'nominations' in proposal
      ? proposal.nominations.flatMap((nomination) => nomination.evidenceIds)
      : [];
  return [...itemEvidence, ...nominationEvidence].every((id) =>
    knownEvidenceIds.has(id),
  );
}

export function parseProjectAgentMemoryProposal(
  value: unknown,
): ProjectAgentMemoryProposal {
  return projectAgentMemoryProposalSchema.parse(value);
}

export function parseGlobalAgentMemoryProposal(
  value: unknown,
): GlobalAgentMemoryProposal {
  return globalAgentMemoryProposalSchema.parse(value);
}

export function parseAgentMemoryExtractionRun(
  value: unknown,
): AgentMemoryExtractionRun {
  return agentMemoryExtractionRunSchema.parse(value);
}
