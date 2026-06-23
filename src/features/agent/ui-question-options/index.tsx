import { Check, HelpCircle, Send } from 'lucide-react';
import { startTransition, useCallback, useEffect, useState } from 'react';

import type { AgentQuestion, QuestionResponse } from '@shared/agent-types';
import { Button } from '@/common/ui/button';
import { Kbd } from '@/common/ui/kbd';
import { Textarea } from '@/common/ui/textarea';
import { useCommands } from '@/common/hooks/use-commands';

type QuestionInputMode = 'text' | 'single-choice' | 'multi-choice';

function getQuestionInputMode(question: AgentQuestion): QuestionInputMode {
  if (question.type === 'text') {
    return 'text';
  }

  if (!question.type && question.options.length === 0) {
    return 'text';
  }

  if (question.type === 'multi_choice' || question.multiSelect) {
    return 'multi-choice';
  }

  return 'single-choice';
}

function getSelectedLabels(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === 'string')
          .map((label) => label.trim())
          .filter(Boolean);
      }
    } catch {
      // Fall back to the legacy comma-separated format below.
    }
  }

  return value
    .split(', ')
    .map((label) => label.trim())
    .filter(Boolean);
}

function getQuestionKey(question: AgentQuestion) {
  return question.id ?? question.question;
}

function allowsOther(question: AgentQuestion) {
  return question.allowOther !== false;
}

function isQuestionAnswered(question: AgentQuestion, value: string | undefined) {
  if (question.required === false) return true;
  if (value === undefined) return false;
  if (getQuestionInputMode(question) === 'multi-choice') {
    return getSelectedLabels(value).length > 0;
  }
  return value.trim().length > 0;
}

function QuestionInput({
  question,
  questionIndex,
  value,
  isOtherOpen,
  isActive,
  activeOptionIndex,
  onActivate,
  onSelectOption,
  onTextChange,
  onOtherChange,
}: {
  question: AgentQuestion;
  questionIndex: number;
  value: string;
  isOtherOpen: boolean;
  isActive: boolean;
  activeOptionIndex: number;
  onActivate: (params: { questionIndex: number; optionIndex: number }) => void;
  onSelectOption: (params: {
    questionIndex: number;
    optionIndex: number;
  }) => void;
  onTextChange: (params: { questionIndex: number; value: string }) => void;
  onOtherChange: (params: { questionIndex: number; value: string }) => void;
}) {
  const mode = getQuestionInputMode(question);
  const selectedLabels = getSelectedLabels(value);
  const canAnswerOther = allowsOther(question);
  const optionCount =
    question.options.length +
    (mode === 'single-choice' && canAnswerOther ? 1 : 0) +
    (mode === 'multi-choice' && question.allowOther ? 1 : 0);

  if (mode === 'text') {
    return (
      <Textarea
        value={value}
        onFocus={() => {
          onActivate({ questionIndex, optionIndex: 0 });
        }}
        onChange={(e) =>
          onTextChange({ questionIndex, value: e.currentTarget.value })
        }
        placeholder="Enter your answer..."
        size="sm"
        rows={3}
      />
    );
  }

  if (mode === 'multi-choice') {
    const otherValue = selectedLabels
      .find(
        (label) => !question.options.some((option) => option.label === label),
      )
      ?? '';
    const otherIndex = question.options.length;

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {question.options.map((option, index) => {
            const isSelected = selectedLabels.includes(option.label);
            return (
              <Button
                key={option.label}
                variant="unstyled"
                aria-pressed={isSelected}
                onFocus={() => {
                  onActivate({ questionIndex, optionIndex: index });
                }}
                onClick={() => {
                  onActivate({ questionIndex, optionIndex: index });
                  onSelectOption({ questionIndex, optionIndex: index });
                }}
                className={`focus-visible:ring-acc rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${
                  isSelected
                    ? 'border-teal-400/80 bg-teal-500/25 text-teal-50 ring-1 ring-teal-400/60'
                    : isActive && activeOptionIndex === index
                      ? 'border-acc bg-acc/20 text-ink-0 ring-acc ring-2'
                      : 'border-glass-border bg-glass-medium text-ink-1 hover:bg-bg-3'
                }`}
                title={option.description}
              >
                <div className="flex flex-col items-start gap-0.5">
                  <div className="flex items-center gap-1.5 font-medium">
                    {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                    {option.label}
                  </div>
                  {option.description ? (
                    <div className="text-xs leading-tight text-current/80">
                      {option.description}
                    </div>
                  ) : null}
                </div>
              </Button>
            );
          })}
          {question.allowOther ? (
            <Button
              variant="unstyled"
              aria-pressed={isOtherOpen}
              onFocus={() => {
                onActivate({ questionIndex, optionIndex: otherIndex });
              }}
              onClick={() => {
                onActivate({ questionIndex, optionIndex: otherIndex });
                onSelectOption({ questionIndex, optionIndex: otherIndex });
              }}
              className={`focus-visible:ring-acc rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${
                isOtherOpen
                  ? 'border-teal-400/80 bg-teal-500/25 text-teal-50 ring-1 ring-teal-400/60'
                  : isActive && activeOptionIndex === otherIndex
                    ? 'border-acc bg-acc/20 text-ink-0 ring-acc ring-2'
                    : 'border-glass-border bg-glass-medium text-ink-1 hover:bg-bg-3'
              }`}
            >
              <div className="flex flex-col items-start gap-0.5">
                <div className="flex items-center gap-1.5 font-medium">
                  {isOtherOpen ? <Check className="h-3.5 w-3.5" /> : null}
                  Other
                </div>
                <div className="text-xs leading-tight text-current/80">
                  Enter a custom answer
                </div>
              </div>
            </Button>
          ) : null}
        </div>
        {question.allowOther && isOtherOpen ? (
          <Textarea
            value={otherValue}
            onFocus={() => {
              onActivate({ questionIndex, optionIndex: otherIndex });
            }}
            onChange={(e) =>
              onOtherChange({ questionIndex, value: e.currentTarget.value })
            }
            placeholder="Enter your answer..."
            size="sm"
            rows={3}
            autoFocus
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {question.options.map((option, index) => (
          <Button
            key={option.label}
            variant="unstyled"
            aria-pressed={value === option.label && !isOtherOpen}
            onFocus={() => {
              onActivate({ questionIndex, optionIndex: index });
            }}
            onClick={() => {
              onActivate({ questionIndex, optionIndex: index });
              onSelectOption({ questionIndex, optionIndex: index });
            }}
            className={`focus-visible:ring-acc rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${
              value === option.label && !isOtherOpen
                ? 'border-teal-400/80 bg-teal-500/25 text-teal-50 ring-1 ring-teal-400/60'
                : isActive && activeOptionIndex === index
                  ? 'border-acc bg-acc/20 text-ink-0 ring-acc ring-2'
                  : 'border-glass-border bg-glass-medium text-ink-1 hover:bg-bg-3'
            }`}
            title={option.description}
          >
            <div className="flex flex-col items-start gap-0.5">
              <div className="flex items-center gap-1.5 font-medium">
                {value === option.label && !isOtherOpen ? (
                  <Check className="h-3.5 w-3.5" />
                ) : null}
                {option.label}
              </div>
              {option.description ? (
                <div className="text-xs leading-tight text-current/80">
                  {option.description}
                </div>
              ) : null}
            </div>
          </Button>
        ))}
        {canAnswerOther ? (
          <Button
            variant="unstyled"
            aria-pressed={isOtherOpen}
            onFocus={() => {
              onActivate({ questionIndex, optionIndex: optionCount - 1 });
            }}
            onClick={() => {
              onActivate({ questionIndex, optionIndex: optionCount - 1 });
              onSelectOption({ questionIndex, optionIndex: optionCount - 1 });
            }}
            className={`focus-visible:ring-acc rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${
              isOtherOpen
                ? 'border-teal-400/80 bg-teal-500/25 text-teal-50 ring-1 ring-teal-400/60'
                : isActive && activeOptionIndex === optionCount - 1
                  ? 'border-acc bg-acc/20 text-ink-0 ring-acc ring-2'
                  : 'border-glass-border bg-glass-medium text-ink-1 hover:bg-bg-3'
            }`}
          >
            <div className="flex flex-col items-start gap-0.5">
              <div className="flex items-center gap-1.5 font-medium">
                {isOtherOpen ? <Check className="h-3.5 w-3.5" /> : null}
                Other
              </div>
              <div className="text-xs leading-tight text-current/80">
                Enter a custom answer
              </div>
            </div>
          </Button>
        ) : null}
      </div>
      {canAnswerOther && isOtherOpen ? (
        <Textarea
          value={value}
          onFocus={() => {
            onActivate({ questionIndex, optionIndex: optionCount - 1 });
          }}
          onChange={(e) =>
            onOtherChange({ questionIndex, value: e.currentTarget.value })
          }
          placeholder="Enter your answer..."
          size="sm"
          rows={3}
          autoFocus
        />
      ) : null}
    </div>
  );
}

export function QuestionOptions({
  request,
  onRespond,
}: {
  request: {
    taskId: string;
    requestId: string;
    questions: AgentQuestion[];
  };
  onRespond: (
    requestId: string,
    response: QuestionResponse,
  ) => void | Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const [otherOpenByQuestion, setOtherOpenByQuestion] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    if (request.questions.length === 0) {
      startTransition(() => setActiveQuestionIndex(0));
      startTransition(() => setActiveOptionIndex(0));
      return;
    }

    startTransition(() => setActiveQuestionIndex((current) => {
      if (current < request.questions.length) {
        return current;
      }
      return 0;
    }));
  }, [request.questions]);

  const getOptionCount = useCallback((question: AgentQuestion) => {
    const mode = getQuestionInputMode(question);
    if (mode === 'text') return 0;
    return (
      question.options.length +
      (mode === 'single-choice' && allowsOther(question) ? 1 : 0) +
      (mode === 'multi-choice' && question.allowOther ? 1 : 0)
    );
  }, []);

  useEffect(() => {
    const question = request.questions[activeQuestionIndex];
    if (!question) return;
    const optionCount = getOptionCount(question);
    startTransition(() => setActiveOptionIndex((current) => {
      if (optionCount === 0) return 0;
      if (current < optionCount) return current;
      return 0;
    }));
  }, [activeQuestionIndex, getOptionCount, request.questions]);

  const activateOption = useCallback(
    ({
      questionIndex,
      optionIndex,
    }: {
      questionIndex: number;
      optionIndex: number;
    }) => {
      setActiveQuestionIndex(questionIndex);
      setActiveOptionIndex(optionIndex);
    },
    [],
  );

  const selectOption = useCallback(
    ({
      questionIndex,
      optionIndex,
    }: {
      questionIndex: number;
      optionIndex: number;
    }) => {
      const question = request.questions[questionIndex];
      if (!question) return false;
      const questionKey = getQuestionKey(question);

      const mode = getQuestionInputMode(question);

      if (mode === 'text') {
        return false;
      }

      if (mode === 'multi-choice') {
        const isOther =
          question.allowOther && optionIndex === question.options.length;
        if (isOther) {
          setOtherOpenByQuestion((prev) => ({
            ...prev,
            [questionKey]: !(prev[questionKey] ?? false),
          }));
          setAnswers((prev) => {
            if (!(otherOpenByQuestion[questionKey] ?? false)) {
              return prev;
            }

            const selectedOptionLabels = getSelectedLabels(
              prev[questionKey] ?? '',
            ).filter((label) =>
              question.options.some((option) => option.label === label),
            );
            return {
              ...prev,
              [questionKey]: JSON.stringify(selectedOptionLabels),
            };
          });
          return true;
        }

        const label = question.options[optionIndex]?.label;
        if (!label) return false;
        const current = answers[questionKey] ?? '';
        const selected = getSelectedLabels(current);
        const next = selected.includes(label)
          ? selected.filter((item) => item !== label)
          : [...selected, label];
        setAnswers((prev) => ({
          ...prev,
          [questionKey]: JSON.stringify(next),
        }));
        return true;
      }

      const isOther = optionIndex === question.options.length;
      if (isOther && !allowsOther(question)) {
        return false;
      }

      setOtherOpenByQuestion((prev) => ({
        ...prev,
        [questionKey]: isOther,
      }));

      if (isOther) {
        const current = answers[questionKey] ?? '';
        const matchesOption = question.options.some(
          (option) => option.label === current,
        );
        if (matchesOption) {
          setAnswers((prev) => ({ ...prev, [questionKey]: '' }));
        }
        return true;
      }

      const label = question.options[optionIndex]?.label;
      if (!label) return false;
      setAnswers((prev) => ({ ...prev, [questionKey]: label }));
      return true;
    },
    [answers, otherOpenByQuestion, request.questions],
  );

  const updateTextAnswer = useCallback(
    ({ questionIndex, value }: { questionIndex: number; value: string }) => {
      const question = request.questions[questionIndex];
      if (!question) return;
      setAnswers((prev) => ({ ...prev, [getQuestionKey(question)]: value }));
    },
    [request.questions],
  );

  const updateOtherAnswer = useCallback(
    ({ questionIndex, value }: { questionIndex: number; value: string }) => {
      const question = request.questions[questionIndex];
      if (!question) return;
      const questionKey = getQuestionKey(question);
      const mode = getQuestionInputMode(question);
      setAnswers((prev) => {
        if (mode !== 'multi-choice') {
          return { ...prev, [questionKey]: value };
        }

        const selectedOptionLabels = getSelectedLabels(
          prev[questionKey] ?? '',
        ).filter((label) =>
          question.options.some((option) => option.label === label),
        );
        const nextLabels = value.trim()
          ? [...selectedOptionLabels, value]
          : selectedOptionLabels;
        return { ...prev, [questionKey]: JSON.stringify(nextLabels) };
      });
      setOtherOpenByQuestion((prev) => ({
        ...prev,
        [questionKey]: true,
      }));
    },
    [request.questions],
  );

  const moveActiveOption = useCallback(
    (offset: 1 | -1) => {
      const question = request.questions[activeQuestionIndex];
      if (!question) return false;
      const optionCount = getOptionCount(question);
      if (optionCount === 0) return false;

      setActiveOptionIndex((current) => {
        return (current + offset + optionCount) % optionCount;
      });
      return true;
    },
    [activeQuestionIndex, getOptionCount, request.questions],
  );

  const activateCurrentOption = useCallback(() => {
    return selectOption({
      questionIndex: activeQuestionIndex,
      optionIndex: activeOptionIndex,
    });
  }, [activeOptionIndex, activeQuestionIndex, selectOption]);

  const allAnswered = request.questions.every((question) =>
    isQuestionAnswered(question, answers[getQuestionKey(question)]),
  );

  const buildResponseAnswers = useCallback((): Record<string, string> => {
    const responseAnswers: Record<string, string> = {};
    for (const question of request.questions) {
      const key = getQuestionKey(question);
      const value = answers[key];
      if (value === undefined) continue;
      responseAnswers[key] =
        question.type === 'multi_choice'
          ? JSON.stringify(getSelectedLabels(value))
          : value;
    }
    return responseAnswers;
  }, [answers, request.questions]);

  const submitAnswers = useCallback(() => {
    if (!allAnswered) return;
    return onRespond(request.requestId, { answers: buildResponseAnswers() });
  }, [allAnswered, onRespond, request.requestId, buildResponseAnswers]);

  const handleSubmit = useCallback(() => {
    if (!allAnswered) return false;
    void submitAnswers();
    return true;
  }, [allAnswered, submitAnswers]);

  useCommands('question-options', [
    {
      label: 'Select Previous Question Option',
      shortcut: ['left', 'up'],
      hideInCommandPalette: true,
      ignoreIfInput: true,
      handler: () => moveActiveOption(-1),
    },
    {
      label: 'Select Next Question Option',
      shortcut: ['right', 'down'],
      hideInCommandPalette: true,
      ignoreIfInput: true,
      handler: () => moveActiveOption(1),
    },
    {
      label: 'Activate Question Option',
      shortcut: 'enter',
      hideInCommandPalette: true,
      ignoreIfInput: true,
      handler: activateCurrentOption,
    },
    {
      label: 'Submit Question Answers',
      shortcut: 'cmd+enter',
      hideInCommandPalette: true,
      handler: handleSubmit,
    },
  ]);

  return (
    <div className="border border-teal-700/50 bg-teal-900/20 px-4 py-3">
      <div className="space-y-4">
        {request.questions.map((question, index) => {
          const questionKey = getQuestionKey(question);

          return (
            <div key={`${index}-${questionKey}`} className="space-y-2">
              <div className="flex items-start gap-2">
                <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-teal-400" />
                <div className="text-sm font-medium text-teal-300">
                  {request.questions.length > 1 ? `${index + 1}. ` : ''}
                  {question.question}
                </div>
              </div>
              <div className="pl-6">
                <QuestionInput
                  question={question}
                  questionIndex={index}
                  value={answers[questionKey] || ''}
                  isOtherOpen={otherOpenByQuestion[questionKey] ?? false}
                  isActive={activeQuestionIndex === index}
                  activeOptionIndex={
                    activeQuestionIndex === index ? activeOptionIndex : 0
                  }
                  onActivate={activateOption}
                  onSelectOption={selectOption}
                  onTextChange={updateTextAnswer}
                  onOtherChange={updateOtherAnswer}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          onClick={submitAnswers}
          disabled={!allAnswered}
          variant="primary"
          size="md"
          icon={<Send />}
          className="bg-teal-600 hover:bg-teal-500"
        >
          Submit
          <Kbd shortcut="cmd+enter" />
        </Button>
      </div>
    </div>
  );
}
