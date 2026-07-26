import { describe, expect, it } from 'vitest';

import type { AgentQuestion } from '@shared/agent-types';

import { buildQuestionResponse } from './question-response';

const questions: AgentQuestion[] = [
  {
    key: 'approach',
    id: 'approach',
    type: 'single_choice',
    question: 'Which approach?',
    header: 'Approach',
    options: [
      { id: 'small', label: 'Small change', description: 'Keep scope narrow' },
      { id: 'rewrite', label: 'Rewrite', description: 'Replace everything' },
    ],
    multiSelect: false,
  },
  {
    key: 'constraints',
    id: 'constraints',
    type: 'multi_choice',
    question: 'Which constraints matter?',
    header: 'Constraints',
    options: [
      { id: 'fast', label: 'Fast', description: 'Ship quickly' },
      { id: 'safe', label: 'Safe', description: 'Avoid regressions' },
      { id: 'cheap', label: 'Cheap', description: 'Minimize cost' },
    ],
    multiSelect: true,
  },
];

describe('buildQuestionResponse', () => {
  it('keeps flattened answers unchanged while adding selected labels and notes', () => {
    const response = buildQuestionResponse({
      questions,
      answers: {
        approach: 'Small change',
        constraints: JSON.stringify(['Fast', 'Safe']),
      },
      customAnswers: {},
      notes: { approach: 'Prefer incremental work' },
      wasFreeformByQuestion: {},
    });

    expect(response.answers).toEqual({
      approach: 'Small change, Notes: Prefer incremental work',
      constraints: JSON.stringify(['Fast', 'Safe']),
    });
    expect(response.memoryDetails).toEqual([
      {
        questionKey: 'approach',
        selectedLabels: ['Small change'],
        customAnswer: null,
        notes: 'Prefer incremental work',
      },
      {
        questionKey: 'constraints',
        selectedLabels: ['Fast', 'Safe'],
        customAnswer: null,
        notes: null,
      },
    ]);
  });

  it('separates custom choice and free-text answers from selected labels', () => {
    const response = buildQuestionResponse({
      questions: [
        questions[0],
        questions[1],
        {
          key: 'Anything else?',
          type: 'text',
          question: 'Anything else?',
          header: 'Context',
          options: [],
          multiSelect: false,
        },
      ],
      answers: {
        approach: 'Use a facade',
        constraints: JSON.stringify(['Safe']),
        'Anything else?': 'Preserve public APIs',
      },
      customAnswers: {
        constraints: 'Works offline',
        'Anything else?': 'No migration',
      },
      notes: { constraints: 'Required for launch' },
      wasFreeformByQuestion: {
        approach: true,
        constraints: true,
      },
    });

    expect(response.answers).toEqual({
      approach: 'Use a facade',
      constraints: JSON.stringify([
        'Safe',
        'Works offline',
        'Notes: Required for launch',
      ]),
      'Anything else?': 'Preserve public APIs, No migration',
    });
    expect(response.memoryDetails).toEqual([
      {
        questionKey: 'approach',
        selectedLabels: [],
        customAnswer: 'Use a facade',
        notes: null,
      },
      {
        questionKey: 'constraints',
        selectedLabels: ['Safe'],
        customAnswer: 'Works offline',
        notes: 'Required for launch',
      },
      {
        questionKey: 'Anything else?',
        selectedLabels: [],
        customAnswer: 'Preserve public APIs, No migration',
        notes: null,
      },
    ]);
  });

  it('omits unanswered optional questions and every unselected option field', () => {
    const response = buildQuestionResponse({
      questions: [
        questions[0],
        { ...questions[1], required: false },
      ],
      answers: { approach: 'Small change' },
      customAnswers: {},
      notes: {},
      wasFreeformByQuestion: {},
    });

    const serialized = JSON.stringify(response);
    expect(response.memoryDetails).toHaveLength(1);
    expect(serialized).not.toContain('Which approach?');
    expect(serialized).not.toContain('Rewrite');
    expect(serialized).not.toContain('Replace everything');
    expect(serialized).not.toContain('Cheap');
    expect(serialized).not.toContain('Minimize cost');
    expect(serialized).not.toContain('options');
    expect(serialized).not.toContain('id":"small');
  });

  it('captures non-option multi-choice values as custom answers', () => {
    const response = buildQuestionResponse({
      questions: [questions[1]],
      answers: { constraints: JSON.stringify(['Decide for me']) },
      customAnswers: {},
      notes: {},
      wasFreeformByQuestion: { constraints: true },
    });

    expect(response.answers).toEqual({
      constraints: JSON.stringify(['Decide for me']),
    });
    expect(response.memoryDetails).toEqual([
      {
        questionKey: 'constraints',
        selectedLabels: [],
        customAnswer: 'Decide for me',
        notes: null,
      },
    ]);
  });

  it('keeps duplicate question text isolated by server-assigned keys', () => {
    const duplicateQuestions: AgentQuestion[] = [
      {
        key: 'Choose one#1',
        question: 'Choose one',
        header: 'First',
        options: [{ label: 'A', description: '' }],
        multiSelect: false,
      },
      {
        key: 'Choose one#2',
        question: 'Choose one',
        header: 'Second',
        options: [{ label: 'B', description: '' }],
        multiSelect: false,
      },
    ];

    const response = buildQuestionResponse({
      questions: duplicateQuestions,
      answers: { 'Choose one#1': 'A', 'Choose one#2': 'B' },
      customAnswers: {},
      notes: {},
      wasFreeformByQuestion: {},
    });

    expect(response.answers).toEqual({
      'Choose one#1': 'A',
      'Choose one#2': 'B',
    });
    expect(response.memoryDetails.map((detail) => detail.questionKey)).toEqual([
      'Choose one#1',
      'Choose one#2',
    ]);
  });

  // The main process re-derives each delivered answer from memoryDetails and
  // rejects the whole response on any divergence, which would leave the step
  // stuck in `waiting`. These cases previously diverged.
  it('orders multi-select answers to match main-process canonicalization', () => {
    const response = buildQuestionResponse({
      questions,
      answers: {
        approach: 'Small change',
        // Free-form value selected before a real option label.
        constraints: JSON.stringify(['Portable', 'Fast']),
      },
      customAnswers: { constraints: 'Documented' },
      notes: { constraints: 'Only for v2' },
      wasFreeformByQuestion: { constraints: true },
    });

    const detail = response.memoryDetails.find(
      (item) => item.questionKey === 'constraints',
    );
    expect(detail).toMatchObject({
      selectedLabels: ['Fast'],
      customAnswer: 'Portable, Documented',
      notes: 'Only for v2',
    });
    // Valid option labels first, then free-form, then notes.
    expect(response.answers.constraints).toBe(
      JSON.stringify(['Fast', 'Portable, Documented', 'Notes: Only for v2']),
    );
  });

  // The main process classifies multi-select BEFORE text; the renderer must
  // agree or the delivered answer is rejected and the step never resumes.
  it('treats an option-less multiSelect question as multi-choice, not text', () => {
    const optionlessMulti: AgentQuestion[] = [
      {
        key: 'freeform',
        id: 'freeform',
        question: 'List the constraints',
        header: 'Constraints',
        options: [],
        multiSelect: true,
      },
    ];

    const response = buildQuestionResponse({
      questions: optionlessMulti,
      answers: { freeform: 'my answer' },
      customAnswers: {},
      notes: {},
      wasFreeformByQuestion: {},
    });

    expect(response.answers.freeform).toBe(JSON.stringify(['my answer']));
    expect(response.memoryDetails[0]).toMatchObject({
      selectedLabels: [],
      customAnswer: 'my answer',
    });
  });

  it('drops a blank-after-trim option label so answer and detail stay in sync', () => {
    const blankLabel: AgentQuestion[] = [
      {
        key: 'blank',
        id: 'blank',
        type: 'single_choice',
        question: 'Pick one',
        header: 'Blank',
        options: [{ id: 'blank', label: '   ', description: '' }],
        multiSelect: false,
      },
    ];

    const response = buildQuestionResponse({
      questions: blankLabel,
      answers: { blank: '   ' },
      customAnswers: {},
      notes: {},
      wasFreeformByQuestion: {},
    });

    expect(response.answers.blank).toBeUndefined();
    expect(response.memoryDetails).toEqual([]);
  });

  it('keeps a custom single-choice answer and its note in the delivered answer', () => {
    const response = buildQuestionResponse({
      questions,
      answers: { approach: 'Something else entirely' },
      customAnswers: { approach: 'and also this' },
      notes: { approach: 'context' },
      wasFreeformByQuestion: { approach: true },
    });

    const detail = response.memoryDetails.find(
      (item) => item.questionKey === 'approach',
    );
    expect(detail).toMatchObject({
      selectedLabels: [],
      customAnswer: 'Something else entirely, and also this',
      notes: 'context',
    });
    expect(response.answers.approach).toBe(
      'Something else entirely, and also this, Notes: context',
    );
  });
});
