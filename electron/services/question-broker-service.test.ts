import { describe, expect, it } from 'vitest';

import {
  formatAnswerSummary,
  QuestionBrokerService,
  QuestionRequestCancelledError,
  QuestionRequestNotFoundError,
  type QuestionSpec,
  QuestionValidationError,
  toNormalizedQuestionRequest,
  validateAnswers,
  validateQuestionSpecs,
} from './question-broker-service';

const questions: QuestionSpec[] = [
  {
    id: 'approach',
    type: 'single_choice',
    label: 'Which approach?',
    header: 'Approach',
      options: [
        {
          id: 'small',
          label: 'Small change',
          description: 'Keep the change scoped',
        },
        { label: 'Rewrite', description: 'Replace the flow' },
      ],
  },
  {
    id: 'constraints',
    type: 'multi_choice',
    label: 'Which constraints matter?',
    options: [{ label: 'Fast' }, { label: 'Compatible' }],
  },
  {
    id: 'notes',
    type: 'text',
    label: 'Any notes?',
    required: false,
    options: [{ label: 'Ignored by text questions' }],
  },
];

describe('question-broker-service', () => {
  describe('validateQuestionSpecs', () => {
    it('requires at least one question', () => {
      expect(() => validateQuestionSpecs([])).toThrow(QuestionValidationError);
      expect(() => validateQuestionSpecs([])).toThrow(
        'At least one question is required',
      );
    });

    it('requires unique question ids', () => {
      expect(() =>
        validateQuestionSpecs([
          {
            id: 'duplicate',
            type: 'text',
            label: 'First',
          },
          {
            id: 'duplicate',
            type: 'text',
            label: 'Second',
          },
        ]),
      ).toThrow('Duplicate question id: duplicate');
    });

    it('rejects question ids with leading or trailing whitespace', () => {
      expect(() =>
        validateQuestionSpecs([
          {
            id: ' spaced',
            type: 'text',
            label: 'Question',
          },
        ]),
      ).toThrow(
        'Question  spaced id must not contain leading or trailing whitespace',
      );
    });

    it('allows choice questions without options', () => {
      expect(() =>
        validateQuestionSpecs([
          {
            id: 'choice',
            type: 'single_choice',
            label: 'Pick one',
          },
        ]),
      ).not.toThrow();
    });

    it('rejects malformed required metadata', () => {
      expect(() =>
        validateQuestionSpecs([
          {
            id: 'choice',
            type: 'single_choice',
            label: 'Pick one',
            options: [{ label: 'A' }],
            required: 'yes',
          } as unknown as QuestionSpec,
        ]),
      ).toThrow('Question choice required must be boolean');
    });

    it('rejects malformed non-array options', () => {
      expect(() =>
        validateQuestionSpecs([
          {
            id: 'choice',
            type: 'single_choice',
            label: 'Pick one',
            options: 'invalid',
          } as unknown as QuestionSpec,
        ]),
      ).toThrow('Question choice options must be an array');

      expect(() =>
        validateQuestionSpecs([
          {
            id: 'text',
            type: 'text',
            label: 'Free text',
            options: 'invalid',
          } as unknown as QuestionSpec,
        ]),
      ).toThrow('Question text options must be an array');
    });

    it('rejects option ids with leading or trailing whitespace', () => {
      expect(() =>
        validateQuestionSpecs([
          {
            id: 'choice',
            type: 'single_choice',
            label: 'Pick one',
            options: [{ id: ' small ', label: 'Small' }],
          },
        ]),
      ).toThrow(
        'Question choice option id must not contain leading or trailing whitespace',
      );
    });

    it('ignores options on text questions', () => {
      expect(() =>
        validateQuestionSpecs([
          {
            id: 'text',
            type: 'text',
            label: 'Free text',
            options: [],
          },
        ]),
      ).not.toThrow();
    });
  });

  it('converts question specs to the shared normalized request shape', () => {
    expect(
      toNormalizedQuestionRequest({
        requestId: 'question-request-1',
        contextReminder: '**Current constraint:** keep the change scoped.',
        questions,
      }),
    ).toEqual({
      requestId: 'question-request-1',
      contextReminder: '**Current constraint:** keep the change scoped.',
      questions: [
        {
          id: 'approach',
          type: 'single_choice',
          question: 'Which approach?',
          header: 'Approach',
          options: [
            {
              id: 'small',
              label: 'Small change',
              description: 'Keep the change scoped',
            },
            { label: 'Rewrite', description: 'Replace the flow' },
          ],
          multiSelect: false,
          required: true,
        },
        {
          id: 'constraints',
          type: 'multi_choice',
          question: 'Which constraints matter?',
          header: '',
          options: [
            { label: 'Fast', description: '' },
            { label: 'Compatible', description: '' },
          ],
          multiSelect: true,
          required: true,
        },
        {
          id: 'notes',
          type: 'text',
          question: 'Any notes?',
          header: '',
          options: [],
          multiSelect: false,
          required: false,
        },
      ],
    });
  });

  it('formats answers as a plain text summary', () => {
    expect(
      formatAnswerSummary({
        questions,
        answers: {
          approach: 'Small change',
          constraints: 'Fast, Compatible',
          notes: '',
        },
      }),
    ).toBe(
      [
        'Which approach?: Small change',
        'Which constraints matter?: Fast, Compatible',
      ].join('\n'),
    );
  });

  it('omits optional unanswered choice questions from plain text summary', () => {
    expect(
      formatAnswerSummary({
        questions: [
          {
            id: 'scope',
            type: 'single_choice',
            label: 'Scope',
            required: false,
            options: [{ label: 'Small' }],
          },
          {
            id: 'notes',
            type: 'text',
            label: 'Notes',
          },
        ],
        answers: { notes: 'Ship it' },
      }),
    ).toBe('Notes: Ship it');
  });

  it('accepts JSON-array multi-choice answers without splitting commas in labels', () => {
    expect(
      formatAnswerSummary({
        questions: [
          {
            id: 'targets',
            type: 'multi_choice',
            label: 'Targets',
            options: [{ label: 'Paris, France' }, { label: 'Berlin' }],
          },
        ],
        answers: {
          targets: JSON.stringify(['Paris, France', 'Berlin']),
        },
      }),
    ).toBe('Targets: Paris, France, Berlin');
  });

  it('formats comma-separated string answers for multi-choice questions', () => {
    expect(
      formatAnswerSummary({
        questions,
        answers: {
          approach: 'Small change',
          constraints: 'Fast, Compatible',
          notes: '',
        },
      }),
    ).toBe(
      [
        'Which approach?: Small change',
        'Which constraints matter?: Fast, Compatible',
      ].join('\n'),
    );
  });

  it('formats answers keyed by normalized question text', () => {
    expect(
      formatAnswerSummary({
        questions,
        answers: {
          'Which approach?': 'Small change',
          'Which constraints matter?': 'Fast, Compatible',
          'Any notes?': '',
        },
      }),
    ).toBe(
      [
        'Which approach?: Small change',
        'Which constraints matter?: Fast, Compatible',
      ].join('\n'),
    );
  });

  it('prefers stable id answers over normalized question text answers', () => {
    expect(
      formatAnswerSummary({
        questions,
        answers: {
          approach: 'Rewrite',
          'Which approach?': 'Small change',
          constraints: 'Compatible',
          'Which constraints matter?': 'Fast',
        },
      }),
    ).toBe(
      [
        'Which approach?: Rewrite',
        'Which constraints matter?: Compatible',
      ].join('\n'),
    );
  });

  describe('validateAnswers', () => {
    it('requires answers for required questions', () => {
      expect(() =>
        validateAnswers({
          questions,
          answers: {
            approach: '',
            constraints: 'Fast',
          },
        }),
      ).toThrow('Question approach requires an answer');
    });

    it('allows custom single-choice answers', () => {
      expect(() =>
        validateAnswers({
          questions,
          answers: {
            approach: 'Something else',
            constraints: 'Fast',
          },
        }),
      ).not.toThrow();
    });

    it('allows custom multi-choice answers', () => {
      expect(() =>
        validateAnswers({
          questions,
          answers: {
            approach: 'Small change',
            constraints: 'Fast, Unexpected',
          },
        }),
      ).not.toThrow();
    });

    it('allows optional empty text answers to be omitted', () => {
      expect(() =>
        validateAnswers({
          questions,
          answers: {
            approach: 'Small change',
            constraints: 'Fast',
          },
        }),
      ).not.toThrow();
    });
  });

  it('resolves the request promise when answered', async () => {
    const broker = new QuestionBrokerService();
    const created = broker.createRequest({
      taskId: 'task-1',
      stepId: 'step-1',
      questions,
    });

    const summary = broker.answerRequest(created.request.requestId, {
      approach: 'Rewrite',
      constraints: 'Compatible',
      notes: 'Need migration safety',
    });

    expect(summary).toBe(
      [
        'Which approach?: Rewrite',
        'Which constraints matter?: Compatible',
        'Any notes?: Need migration safety',
      ].join('\n'),
    );
    await expect(created.result).resolves.toBe(summary);
    expect(broker.getRequest(created.request.requestId)).toBeNull();
  });

  it('resolves requests answered with normalized question text keys', async () => {
    const broker = new QuestionBrokerService();
    const created = broker.createRequest({
      taskId: 'task-1',
      stepId: 'step-1',
      questions,
    });

    const summary = broker.answerRequest(created.request.requestId, {
      'Which approach?': 'Small change',
      'Which constraints matter?': 'Fast',
      'Any notes?': 'From current UI shape',
    });

    expect(summary).toBe(
      [
        'Which approach?: Small change',
        'Which constraints matter?: Fast',
        'Any notes?: From current UI shape',
      ].join('\n'),
    );
    await expect(created.result).resolves.toBe(summary);
  });

  it('does not resolve or remove a request when answers are invalid', async () => {
    const broker = new QuestionBrokerService();
    const created = broker.createRequest({
      taskId: 'task-1',
      stepId: 'step-1',
      questions,
    });

    expect(() =>
      broker.answerRequest(created.request.requestId, {
        approach: '',
        constraints: 'Fast',
      }),
    ).toThrow('Question approach requires an answer');
    expect(broker.getRequest(created.request.requestId)).toBe(created.request);

    broker.cancelRequest(created.request.requestId, 'test cleanup');
    await expect(created.result).rejects.toMatchObject({
      requestId: created.request.requestId,
      reason: 'test cleanup',
    });
  });

  it('throws when answering a missing request', () => {
    const broker = new QuestionBrokerService();

    expect(() => broker.answerRequest('missing', {})).toThrow(
      QuestionRequestNotFoundError,
    );
  });

  it('rejects the request promise when cancelled', async () => {
    const broker = new QuestionBrokerService();
    const created = broker.createRequest({
      taskId: 'task-1',
      stepId: 'step-1',
      questions,
    });

    broker.cancelRequest(created.request.requestId, 'agent stopped');

    await expect(created.result).rejects.toEqual(
      new QuestionRequestCancelledError(
        created.request.requestId,
        'agent stopped',
      ),
    );
    expect(broker.getRequest(created.request.requestId)).toBeNull();
  });

  it('cancels only pending requests for the given step', async () => {
    const broker = new QuestionBrokerService();
    const stepOne = broker.createRequest({
      taskId: 'task-1',
      stepId: 'step-1',
      questions,
    });
    const stepTwo = broker.createRequest({
      taskId: 'task-1',
      stepId: 'step-2',
      questions,
    });

    broker.cancelSession('step-1', 'session ended');

    await expect(stepOne.result).rejects.toMatchObject({
      requestId: stepOne.request.requestId,
      reason: 'session ended',
    });
    expect(broker.getRequest(stepOne.request.requestId)).toBeNull();
    expect(broker.getRequest(stepTwo.request.requestId)).toBe(stepTwo.request);

    broker.answerRequest(stepTwo.request.requestId, {
      approach: 'Small change',
      constraints: 'Fast',
    });
    await expect(stepTwo.result).resolves.toBe(
      [
        'Which approach?: Small change',
        'Which constraints matter?: Fast',
      ].join('\n'),
    );
  });
});
