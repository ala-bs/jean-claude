import { randomUUID } from 'crypto';

import type {
  NormalizedQuestion,
  NormalizedQuestionRequest,
} from '@shared/agent-backend-types';

export type QuestionType = 'single_choice' | 'multi_choice' | 'text';

export interface QuestionOptionSpec {
  id?: string;
  label: string;
  description?: string;
}

interface BaseQuestionSpec {
  id: string;
  label: string;
  header?: string;
  required?: boolean;
}

export type QuestionSpec =
  | (BaseQuestionSpec & {
      type: 'single_choice';
      options?: QuestionOptionSpec[];
    })
  | (BaseQuestionSpec & {
      type: 'multi_choice';
      options?: QuestionOptionSpec[];
    })
  | (BaseQuestionSpec & {
      type: 'text';
      options?: QuestionOptionSpec[];
    });

export type QuestionAnswers = Record<string, string>;

interface ResolvedQuestionAnswer {
  value: AnswerValue;
  normalizedValues: string[];
}

type AnswerValue = string | undefined;

export class QuestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionValidationError';
  }
}

export class QuestionRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`No pending question request: ${requestId}`);
    this.name = 'QuestionRequestNotFoundError';
  }
}

export class QuestionRequestCancelledError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly reason: string,
  ) {
    super(`Question request ${requestId} cancelled: ${reason}`);
    this.name = 'QuestionRequestCancelledError';
  }
}

interface PendingQuestionRequest {
  taskId: string;
  stepId: string;
  questions: QuestionSpec[];
  request: NormalizedQuestionRequest;
  resolve: (summary: string) => void;
  reject: (error: QuestionRequestCancelledError) => void;
}

export interface BrokerQuestionRequest {
  taskId: string;
  stepId: string;
  request: NormalizedQuestionRequest;
  result: Promise<string>;
}

export function validateQuestionSpecs(questions: QuestionSpec[]): void {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new QuestionValidationError('At least one question is required');
  }

  const ids = new Set<string>();
  for (const question of questions) {
    if (!isQuestionSpec(question)) {
      throw new QuestionValidationError('Invalid question shape');
    }

    if (!question.id) {
      throw new QuestionValidationError('Question id is required');
    }

    if (question.id !== question.id.trim()) {
      throw new QuestionValidationError(
        `Question ${question.id} id must not contain leading or trailing whitespace`,
      );
    }

    if (ids.has(question.id)) {
      throw new QuestionValidationError(`Duplicate question id: ${question.id}`);
    }
    ids.add(question.id);

    if (!question.label.trim()) {
      throw new QuestionValidationError(`Question ${question.id} label is required`);
    }

    validateQuestionMetadata(question);

    if (question.type === 'text') {
      validateOptionsArray(question);
      continue;
    }

    const options = validateOptionsArray(question);
    for (const option of options) {
      if (!isQuestionOptionSpec(option)) {
        throw new QuestionValidationError(
          `Question ${question.id} has an invalid option`,
        );
      }
      if (option.id !== undefined && option.id !== option.id.trim()) {
        throw new QuestionValidationError(
          `Question ${question.id} option id must not contain leading or trailing whitespace`,
        );
      }
      if (option.id !== undefined && option.id.length === 0) {
        throw new QuestionValidationError(
          `Question ${question.id} option id is required when provided`,
        );
      }
    }
  }
}

export function toNormalizedQuestionRequest({
  requestId,
  questions,
}: {
  requestId: string;
  questions: QuestionSpec[];
}): NormalizedQuestionRequest {
  validateQuestionSpecs(questions);

  return {
    requestId,
    questions: questions.map(toNormalizedQuestion),
  };
}

export function formatAnswerSummary({
  questions,
  answers,
}: {
  questions: QuestionSpec[];
  answers: QuestionAnswers;
}): string {
  validateQuestionSpecs(questions);
  validateAnswers({ questions, answers });

  return questions
    .flatMap((question) => {
      const answer = resolveQuestionAnswer({ answers, question });
      const value = answer.value;
      if (isEmptyAnswer(value)) {
        if (question.required === false) {
          return [];
        }
        return [`${question.label}: `];
      }

      return [`${question.label}: ${answer.normalizedValues.join(', ')}`];
    })
    .join('\n');
}

export function validateAnswers({
  questions,
  answers,
}: {
  questions: QuestionSpec[];
  answers: QuestionAnswers;
}): void {
  validateQuestionSpecs(questions);

  for (const question of questions) {
    const answer = resolveQuestionAnswer({ answers, question });
    const isRequired = question.required ?? true;
    if (answer.normalizedValues.length === 0) {
      if (isRequired) {
        throw new QuestionValidationError(
          `Question ${question.id} requires an answer`,
        );
      }
      continue;
    }

    if (question.type === 'text') {
      continue;
    }
  }
}

export class QuestionBrokerService {
  private readonly pendingRequests = new Map<string, PendingQuestionRequest>();

  createRequest({
    taskId,
    stepId,
    questions,
  }: {
    taskId: string;
    stepId: string;
    questions: QuestionSpec[];
  }): BrokerQuestionRequest {
    const requestId = randomUUID();
    const request = toNormalizedQuestionRequest({ requestId, questions });
    let resolveResult: (summary: string) => void = () => {};
    let rejectResult: (error: QuestionRequestCancelledError) => void = () => {};
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.pendingRequests.set(requestId, {
      taskId,
      stepId,
      questions,
      request,
      resolve: resolveResult,
      reject: rejectResult,
    });

    return {
      taskId,
      stepId,
      request,
      result,
    };
  }

  answerRequest(requestId: string, answers: QuestionAnswers): string {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      throw new QuestionRequestNotFoundError(requestId);
    }

    const summary = formatAnswerSummary({
      questions: pending.questions,
      answers,
    });
    this.pendingRequests.delete(requestId);
    pending.resolve(summary);
    return summary;
  }

  cancelRequest(requestId: string, reason: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);
    pending.reject(new QuestionRequestCancelledError(requestId, reason));
  }

  cancelSession(stepId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (pending.stepId === stepId) {
        this.cancelRequest(requestId, reason);
      }
    }
  }

  getRequest(requestId: string): NormalizedQuestionRequest | null {
    return this.pendingRequests.get(requestId)?.request ?? null;
  }

  getPendingRequestsForStep(stepId: string): NormalizedQuestionRequest[] {
    return Array.from(this.pendingRequests.values())
      .filter((pending) => pending.stepId === stepId)
      .map((pending) => pending.request);
  }
}

function toNormalizedQuestion(question: QuestionSpec): NormalizedQuestion {
  return {
    id: question.id,
    type: question.type,
    question: question.label,
    header: question.header ?? '',
    options:
      question.type === 'text'
        ? []
        : (question.options ?? []).map((option) => ({
            ...(option.id !== undefined ? { id: option.id } : {}),
            label: option.label,
            description: option.description ?? '',
          })),
    multiSelect: question.type === 'multi_choice',
    required: question.required ?? true,
  };
}

function isQuestionSpec(value: unknown): value is QuestionSpec {
  if (!value || typeof value !== 'object') return false;
  const question = value as Partial<QuestionSpec>;
  return (
    typeof question.id === 'string' &&
    typeof question.label === 'string' &&
    (question.type === 'single_choice' ||
      question.type === 'multi_choice' ||
      question.type === 'text')
  );
}

function isQuestionOptionSpec(value: unknown): value is QuestionOptionSpec {
  if (!value || typeof value !== 'object') return false;
  const option = value as Partial<QuestionOptionSpec>;
  return (
    (option.id === undefined || typeof option.id === 'string') &&
    typeof option.label === 'string' &&
    option.label.trim().length > 0
  );
}

function validateOptionsArray(question: QuestionSpec): QuestionOptionSpec[] {
  if (question.options === undefined) {
    return [];
  }

  if (!Array.isArray(question.options)) {
    throw new QuestionValidationError(
      `Question ${question.id} options must be an array`,
    );
  }

  return question.options;
}

function resolveQuestionAnswer({
  answers,
  question,
}: {
  answers: QuestionAnswers;
  question: QuestionSpec;
}): ResolvedQuestionAnswer {
  const value = getAnswerValue({ answers, question });
  return {
    value,
    normalizedValues: normalizeAnswerValues({ question, value }),
  };
}

function getAnswerValue({
  answers,
  question,
}: {
  answers: QuestionAnswers;
  question: QuestionSpec;
}): AnswerValue {
  if (Object.hasOwn(answers, question.id)) {
    return answers[question.id];
  }

  return answers[question.label];
}

function normalizeAnswerValues({
  question,
  value,
}: {
  question: QuestionSpec;
  value: AnswerValue;
}): string[] {
  if (value === undefined) return [];

  if (question.type === 'multi_choice') {
    const jsonValues = parseJsonStringArray(value);
    if (jsonValues) return jsonValues;

    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function parseJsonStringArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((item) => typeof item === 'string')) return null;
    return parsed.map((item) => item.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function isEmptyAnswer(
  value: AnswerValue,
): value is undefined | '' {
  if (value === undefined) return true;
  return value.trim().length === 0;
}

function validateQuestionMetadata(question: QuestionSpec): void {
  if (
    Object.hasOwn(question, 'required') &&
    typeof question.required !== 'boolean'
  ) {
    throw new QuestionValidationError(
      `Question ${question.id} required must be boolean`,
    );
  }
}
