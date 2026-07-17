import { Check, Plus, Sparkles } from 'lucide-react';
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useState,
} from 'react';

import type { AgentQuestion, QuestionResponse } from '@shared/agent-types';
import { Kbd } from '@/common/ui/kbd';
import { MarkdownContent } from '@/features/agent/ui-markdown-content';
import { Textarea } from '@/common/ui/textarea';
import { useCommands } from '@/common/hooks/use-commands';

type QuestionInputMode = 'text' | 'single-choice' | 'multi-choice';

const DECIDE_FOR_ME = 'Decide for me';

function RecommendedBadge() {
  return (
    <span className="rounded border border-teal-400/30 bg-teal-400/10 px-1 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wide text-teal-300">
      Recommended
    </span>
  );
}

function getQuestionInputMode(question: AgentQuestion): QuestionInputMode {
  if (question.type === 'text') return 'text';
  if (!question.type && question.options.length === 0) return 'text';
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
      // Fall back to legacy comma-separated format.
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

function combineAnswerParts(parts: Array<string | undefined>) {
  return parts.map((part) => part?.trim()).filter(Boolean).join(', ');
}

function isQuestionAnswered({
  question,
  value,
  other,
}: {
  question: AgentQuestion;
  value: string | undefined;
  other: string | undefined;
}) {
  if (question.required === false) return true;
  if (other?.trim()) return true;
  if (value === undefined) return false;
  if (getQuestionInputMode(question) === 'multi-choice') {
    return getSelectedLabels(value).length > 0;
  }
  return value.trim().length > 0;
}

function QuestionNotes({
  question,
  questionIndex,
  value,
  isOpen,
  onOpen,
  onClose,
  onChange,
}: {
  question: AgentQuestion;
  questionIndex: number;
  value: string;
  isOpen: boolean;
  onOpen: (questionIndex: number) => void;
  onClose: (questionIndex: number) => void;
  onChange: (params: { questionIndex: number; value: string }) => void;
}) {
  if (!isOpen && !value.trim()) {
    return (
      <button
        type="button"
        onClick={() => onOpen(questionIndex)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onOpen(questionIndex);
          }
        }}
        className="inline-flex items-center gap-1 px-0.5 py-0.5 text-xs font-medium text-ink-3 transition-colors hover:text-ink-2"
      >
        <Plus className="h-3 w-3" />
        Add note
      </button>
    );
  }

  return (
    <Textarea
      value={value}
      aria-label={`${question.question} notes`}
      onChange={(event) =>
        onChange({ questionIndex, value: event.currentTarget.value })
      }
      placeholder="Add context, constraints, edge cases..."
      size="sm"
      rows={2}
      onBlur={() => {
        if (!value.trim()) onClose(questionIndex);
      }}
      className="border-white/10 bg-white/[0.04] text-[13px] text-ink-0 placeholder:text-ink-3 focus-visible:border-teal-400/50"
      autoFocus={isOpen && !value}
    />
  );
}

const QuestionInput = memo(function QuestionInput({
  question,
  questionIndex,
  value,
  otherValue,
  notesValue,
  isNotesOpen,
  isOtherOpen,
  onActivate,
  onSelectOption,
  onTextChange,
  onOtherChange,
  onCloseOther,
  onNotesChange,
  onOpenNotes,
  onCloseNotes,
}: {
  question: AgentQuestion;
  questionIndex: number;
  value: string;
  otherValue: string;
  notesValue: string;
  isNotesOpen: boolean;
  isOtherOpen: boolean;
  onActivate: (params: { questionIndex: number; optionIndex: number }) => void;
  onSelectOption: (params: {
    questionIndex: number;
    optionIndex: number;
  }) => void;
  onTextChange: (params: { questionIndex: number; value: string }) => void;
  onOtherChange: (params: { questionIndex: number; value: string }) => void;
  onCloseOther: (questionIndex: number) => void;
  onNotesChange: (params: { questionIndex: number; value: string }) => void;
  onOpenNotes: (questionIndex: number) => void;
  onCloseNotes: (questionIndex: number) => void;
}) {
  const mode = getQuestionInputMode(question);
  const selectedLabels = getSelectedLabels(value);
  const allowsFreeform = question.allowFreeform ?? true;
  const decideForMeIndex = question.options.length;
  const otherOptionIndex = decideForMeIndex + 1;
  const isFreeformOpen = allowsFreeform && isOtherOpen;
  const isDecideForMeSelected = value === DECIDE_FOR_ME;
  const otherPlaceholder =
    mode === 'text' ? 'Add another answer...' : 'Add other answer...';

  if (mode === 'text') {
    return (
      <div className="space-y-1.5">
        <Textarea
          value={isDecideForMeSelected ? '' : value}
          onFocus={() => onActivate({ questionIndex, optionIndex: 0 })}
          onChange={(event) =>
            onTextChange({ questionIndex, value: event.currentTarget.value })
          }
          placeholder="Enter your answer..."
          size="sm"
          rows={3}
          className="border-white/10 bg-white/[0.04] text-[13px] text-ink-0 placeholder:text-ink-3 focus-visible:border-teal-400/50"
        />
        <button
          type="button"
          aria-pressed={isDecideForMeSelected}
          onFocus={() => onActivate({ questionIndex, optionIndex: 0 })}
          onClick={() => {
            onActivate({ questionIndex, optionIndex: 0 });
            onSelectOption({ questionIndex, optionIndex: 0 });
          }}
          className={`flex items-center gap-2 rounded-lg border p-2 text-left text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none ${
            isDecideForMeSelected
              ? 'border-teal-400/70 bg-teal-400/15 text-teal-50 ring-1 ring-teal-400/40'
              : 'border-white/10 bg-white/[0.04] text-ink-1 hover:border-white/15 hover:bg-white/[0.07]'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Decide for me
        </button>
        {allowsFreeform ? (
          <Textarea
            value={otherValue}
            aria-label={`${question.question} other answer`}
            onChange={(event) =>
              onOtherChange({
                questionIndex,
                value: event.currentTarget.value,
              })
            }
            placeholder={otherPlaceholder}
            size="sm"
            rows={2}
            className="border-white/10 bg-white/[0.04] text-[13px] text-ink-0 placeholder:text-ink-3 focus-visible:border-teal-400/50"
          />
        ) : null}
        <QuestionNotes
          question={question}
          questionIndex={questionIndex}
          value={notesValue}
          isOpen={isNotesOpen}
          onOpen={onOpenNotes}
          onClose={onCloseNotes}
          onChange={onNotesChange}
        />
      </div>
    );
  }

  if (mode === 'multi-choice') {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-1">
          {question.options.map((option, index) => {
            const isSelected = selectedLabels.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                aria-pressed={isSelected}
                onFocus={() => onActivate({ questionIndex, optionIndex: index })}
                onClick={() => {
                  onActivate({ questionIndex, optionIndex: index });
                  onSelectOption({ questionIndex, optionIndex: index });
                }}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none ${
                  isSelected
                    ? 'border-teal-400/70 bg-teal-400/15 text-teal-50 ring-1 ring-teal-400/40'
                    : 'border-white/10 bg-white/[0.04] text-ink-1 hover:border-white/15 hover:bg-white/[0.07]'
                }`}
                title={option.description}
              >
                {isSelected ? (
                  <span className="grid h-3 w-3 place-items-center rounded-full bg-teal-300 text-bg-0">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                ) : null}
                <span className="flex flex-col items-start gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span>{option.label}</span>
                    {option.recommended ? <RecommendedBadge /> : null}
                  </span>
                  {option.description ? (
                    <span className="text-[11px] leading-tight text-current/70">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={isDecideForMeSelected}
            onFocus={() =>
              onActivate({ questionIndex, optionIndex: decideForMeIndex })
            }
            onClick={() => {
              onActivate({ questionIndex, optionIndex: decideForMeIndex });
              onSelectOption({ questionIndex, optionIndex: decideForMeIndex });
            }}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none ${
              isDecideForMeSelected
                ? 'border-teal-400/70 bg-teal-400/15 text-teal-50 ring-1 ring-teal-400/40'
                : 'border-white/10 bg-white/[0.04] text-ink-1 hover:border-white/15 hover:bg-white/[0.07]'
            }`}
          >
            <Sparkles className="h-3 w-3" />
            Decide for me
          </button>
        </div>
        {allowsFreeform ? (
          <Textarea
            value={otherValue}
            aria-label={`${question.question} other answer`}
            onChange={(event) =>
              onOtherChange({
                questionIndex,
                value: event.currentTarget.value,
              })
            }
            placeholder={otherPlaceholder}
            size="sm"
            rows={2}
            className="border-white/10 bg-white/[0.04] text-[13px] text-ink-0 placeholder:text-ink-3 focus-visible:border-teal-400/50"
          />
        ) : null}
        <QuestionNotes
          question={question}
          questionIndex={questionIndex}
          value={notesValue}
          isOpen={isNotesOpen}
          onOpen={onOpenNotes}
          onClose={onCloseNotes}
          onChange={onNotesChange}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {question.options.map((option, index) => {
          const isSelected = value === option.label && !isFreeformOpen;
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={isSelected}
              onFocus={() => onActivate({ questionIndex, optionIndex: index })}
              onClick={() => {
                onActivate({ questionIndex, optionIndex: index });
                onSelectOption({ questionIndex, optionIndex: index });
              }}
              className={`group flex items-start gap-2 rounded-lg border p-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none ${
                isSelected
                  ? 'border-teal-400/70 bg-teal-400/15 text-teal-50 ring-1 ring-teal-400/40'
                  : 'border-white/10 bg-white/[0.04] text-ink-1 hover:border-white/15 hover:bg-white/[0.07]'
              }`}
              title={option.description}
            >
              <span
                className={`mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${
                  isSelected
                    ? 'border-teal-300 bg-teal-300 text-bg-0'
                    : 'border-white/15 text-transparent group-hover:border-white/25'
                }`}
              >
                <Check className="h-2.5 w-2.5" />
              </span>
              <span className="min-w-0 space-y-0.5">
                <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold leading-tight text-ink-0">
                  <span>{option.label}</span>
                  {option.recommended ? <RecommendedBadge /> : null}
                </span>
                {option.description ? (
                  <span className="block text-xs leading-snug text-ink-2">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={isDecideForMeSelected}
          onFocus={() =>
            onActivate({ questionIndex, optionIndex: decideForMeIndex })
          }
          onClick={() => {
            onActivate({ questionIndex, optionIndex: decideForMeIndex });
            onSelectOption({ questionIndex, optionIndex: decideForMeIndex });
          }}
          className={`flex items-start gap-2 rounded-lg border p-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none ${
            isDecideForMeSelected
              ? 'border-teal-400/70 bg-teal-400/15 text-teal-50 ring-1 ring-teal-400/40'
              : 'border-white/10 bg-white/[0.04] text-ink-1 hover:border-white/15 hover:bg-white/[0.07]'
          }`}
        >
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="block text-[13px] font-semibold leading-tight text-ink-0">
            Decide for me
          </span>
        </button>
        {allowsFreeform ? (
          isFreeformOpen ? (
            <Textarea
              value={value}
              aria-label={`${question.question} custom answer`}
              onFocus={() =>
                onActivate({ questionIndex, optionIndex: otherOptionIndex })
              }
              onChange={(event) =>
                onOtherChange({ questionIndex, value: event.currentTarget.value })
              }
              onBlur={() => {
                if (!value.trim()) onCloseOther(questionIndex);
              }}
              placeholder="Add another answer..."
              size="sm"
              rows={2}
              className="border-teal-400/50 bg-teal-400/10 text-[13px] text-ink-0 placeholder:text-ink-3 focus-visible:border-teal-400/70 sm:col-span-2 xl:col-span-3 2xl:col-span-4"
              autoFocus
            />
          ) : (
            <button
              type="button"
              aria-pressed={isOtherOpen}
              onFocus={() =>
                onActivate({ questionIndex, optionIndex: otherOptionIndex })
              }
              onClick={() => {
                onActivate({ questionIndex, optionIndex: otherOptionIndex });
                onSelectOption({ questionIndex, optionIndex: otherOptionIndex });
              }}
              className={`flex items-center gap-2 rounded-lg border p-2 text-left text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none sm:col-span-2 xl:col-span-3 2xl:col-span-4 ${
                'border-white/10 bg-white/[0.04] text-ink-2 hover:border-white/15 hover:bg-white/[0.07]'
              }`}
            >
              <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-dashed border-white/20">
                <Plus className="h-3 w-3" />
              </span>
              Add another answer
            </button>
          )
        ) : null}
      </div>
      <QuestionNotes
        question={question}
        questionIndex={questionIndex}
        value={notesValue}
        isOpen={isNotesOpen}
        onOpen={onOpenNotes}
        onClose={onCloseNotes}
        onChange={onNotesChange}
      />
    </div>
  );
});

export function QuestionContextReminder({ content }: { content?: string }) {
  if (!content) return null;

  return (
    <aside className="rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2.5">
      <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-teal-300/80">
        Context
      </div>
      <MarkdownContent content={content} />
    </aside>
  );
}

export function QuestionOptions({
  request,
  onRespond,
}: {
  request: {
    taskId: string;
    requestId: string;
    contextReminder?: string;
    questions: AgentQuestion[];
  };
  onRespond: (
    requestId: string,
    response: QuestionResponse,
  ) => void | Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notesOpenByQuestion, setNotesOpenByQuestion] = useState<
    Record<string, boolean>
  >({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const [otherOpenByQuestion, setOtherOpenByQuestion] = useState<
    Record<string, boolean>
  >({});
  const [wasFreeformByQuestion, setWasFreeformByQuestion] = useState<
    Record<string, boolean>
  >({});
  const questionIdentity = request.questions
    .map(
      (question) =>
        `${question.question}:${question.allowFreeform === false ? 'fixed' : 'free'}`,
    )
    .join('|');

  useEffect(() => {
    startTransition(() => {
      setAnswers({});
      setOtherAnswers({});
      setNotes({});
      setNotesOpenByQuestion({});
      setOtherOpenByQuestion({});
      setWasFreeformByQuestion({});
      setActiveQuestionIndex(0);
      setActiveOptionIndex(0);
    });
  }, [request.requestId, questionIdentity]);

  useEffect(() => {
    if (request.questions.length === 0) {
      startTransition(() => setActiveQuestionIndex(0));
      startTransition(() => setActiveOptionIndex(0));
      return;
    }

    startTransition(() =>
      setActiveQuestionIndex((current) => {
        if (current < request.questions.length) return current;
        return 0;
      }),
    );
  }, [request.questions]);

  const getOptionCount = useCallback((question: AgentQuestion) => {
    const mode = getQuestionInputMode(question);
    if (mode === 'text') return 1;
    if (mode === 'multi-choice') return question.options.length + 1;
    return question.options.length + (question.allowFreeform === false ? 1 : 2);
  }, []);

  useEffect(() => {
    const question = request.questions[activeQuestionIndex];
    if (!question) return;
    const optionCount = getOptionCount(question);
    startTransition(() =>
      setActiveOptionIndex((current) => {
        if (optionCount === 0) return 0;
        if (current < optionCount) return current;
        return 0;
      }),
    );
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

      if (optionIndex === question.options.length) {
        setAnswers((prev) => ({ ...prev, [questionKey]: DECIDE_FOR_ME }));
        setOtherAnswers((prev) => ({ ...prev, [questionKey]: '' }));
        setOtherOpenByQuestion((prev) => ({ ...prev, [questionKey]: false }));
        setWasFreeformByQuestion((prev) => ({
          ...prev,
          [questionKey]: true,
        }));
        return true;
      }

      if (mode === 'text') return false;

      if (mode === 'multi-choice') {
        const label = question.options[optionIndex]?.label;
        if (!label) return false;
        setAnswers((prev) => {
          const selected = getSelectedLabels(prev[questionKey] ?? '').filter(
            (item) => item !== DECIDE_FOR_ME,
          );
          const next = selected.includes(label)
            ? selected.filter((item) => item !== label)
            : [...selected, label];
          return { ...prev, [questionKey]: JSON.stringify(next) };
        });
        setWasFreeformByQuestion((prev) => ({
          ...prev,
          [question.question]: false,
        }));
        return true;
      }

      const isOther =
        question.allowFreeform !== false &&
        optionIndex === question.options.length + 1;
      setOtherOpenByQuestion((prev) => ({ ...prev, [questionKey]: isOther }));

      if (isOther) {
        setWasFreeformByQuestion((prev) => ({
          ...prev,
          [questionKey]: true,
        }));
        setAnswers((prev) => {
          const current = prev[questionKey] ?? '';
          const matchesOption = question.options.some(
            (option) => option.label === current,
          );
          return matchesOption || current === DECIDE_FOR_ME
            ? { ...prev, [questionKey]: '' }
            : prev;
        });
        return true;
      }

      const label = question.options[optionIndex]?.label;
      if (!label) return false;
      setAnswers((prev) => ({ ...prev, [questionKey]: label }));
      setWasFreeformByQuestion((prev) => ({
        ...prev,
        [questionKey]: false,
      }));
      return true;
    },
    [request.questions],
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
      if (!question || question.allowFreeform === false) return;
      const questionKey = getQuestionKey(question);
      const mode = getQuestionInputMode(question);
      if (mode === 'text' || mode === 'multi-choice') {
        setOtherAnswers((prev) => ({ ...prev, [questionKey]: value }));
        if (value.trim()) {
          setAnswers((prev) =>
            prev[questionKey] === DECIDE_FOR_ME
              ? { ...prev, [questionKey]: '' }
              : prev,
          );
        }
        if (mode === 'multi-choice') {
          setWasFreeformByQuestion((prev) => ({
            ...prev,
            [questionKey]: value.trim().length > 0,
          }));
        }
        return;
      }

      setAnswers((prev) => ({ ...prev, [questionKey]: value }));
      setWasFreeformByQuestion((prev) => ({
        ...prev,
        [questionKey]: true,
      }));
      setOtherOpenByQuestion((prev) => ({ ...prev, [questionKey]: true }));
    },
    [request.questions],
  );

  const closeOtherAnswer = useCallback(
    (questionIndex: number) => {
      const question = request.questions[questionIndex];
      if (!question) return;
      const questionKey = getQuestionKey(question);
      setOtherOpenByQuestion((prev) => ({ ...prev, [questionKey]: false }));
      if (getQuestionInputMode(question) === 'single-choice') {
        setAnswers((prev) => ({ ...prev, [questionKey]: '' }));
        setWasFreeformByQuestion((prev) => ({
          ...prev,
          [questionKey]: false,
        }));
      }
    },
    [request.questions],
  );

  const updateNotes = useCallback(
    ({ questionIndex, value }: { questionIndex: number; value: string }) => {
      const question = request.questions[questionIndex];
      if (!question) return;
      setNotes((prev) => ({ ...prev, [getQuestionKey(question)]: value }));
    },
    [request.questions],
  );

  const openNotes = useCallback(
    (questionIndex: number) => {
      const question = request.questions[questionIndex];
      if (!question) return;
      setNotesOpenByQuestion((prev) => ({
        ...prev,
        [getQuestionKey(question)]: true,
      }));
    },
    [request.questions],
  );

  const closeNotes = useCallback(
    (questionIndex: number) => {
      const question = request.questions[questionIndex];
      if (!question) return;
      setNotesOpenByQuestion((prev) => ({
        ...prev,
        [getQuestionKey(question)]: false,
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

  const allAnswered = request.questions.every((question) => {
    const key = getQuestionKey(question);
    return isQuestionAnswered({
      question,
      value: answers[key],
      other: otherAnswers[key],
    });
  });
  const answeredCount = request.questions.filter((question) => {
    const key = getQuestionKey(question);
    return isQuestionAnswered({
      question,
      value: answers[key],
      other: otherAnswers[key],
    });
  }).length;

  const buildResponseAnswers = useCallback((): Record<string, string> => {
    const responseAnswers: Record<string, string> = {};
    for (const question of request.questions) {
      const key = getQuestionKey(question);
      const value = answers[key];
      const note = notes[key]?.trim() ? `Notes: ${notes[key].trim()}` : '';
      if (getQuestionInputMode(question) === 'multi-choice') {
        const selected = value === undefined ? [] : getSelectedLabels(value);
        const combined = [...selected, otherAnswers[key], note]
          .map((part) => part?.trim())
          .filter((part): part is string => Boolean(part));
        if (combined.length > 0) {
          responseAnswers[key] = JSON.stringify(combined);
        }
        continue;
      }

      const combined = combineAnswerParts([value, otherAnswers[key], note]);
      if (combined) responseAnswers[key] = combined;
    }
    return responseAnswers;
  }, [answers, notes, otherAnswers, request.questions]);

  const submitAnswers = useCallback(() => {
    if (!allAnswered) return;
    return onRespond(request.requestId, {
      answers: buildResponseAnswers(),
      wasFreeform: Object.values(wasFreeformByQuestion).some(Boolean),
      wasFreeformByQuestion,
    });
  }, [
    allAnswered,
    buildResponseAnswers,
    onRespond,
    request.requestId,
    wasFreeformByQuestion,
  ]);

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
    <div className="space-y-2">
      <QuestionContextReminder content={request.contextReminder} />
      <div className="overflow-hidden rounded-xl border border-white/10 bg-bg-2/95 shadow-[0_18px_50px_-30px_rgba(0,0,0,0.8)]">
      <div className="space-y-2.5 px-3 py-2.5">
        {request.questions.map((question, index) => {
          const questionKey = getQuestionKey(question);
          const isAnswered = isQuestionAnswered({
            question,
            value: answers[questionKey],
            other: otherAnswers[questionKey],
          });

          return (
            <section key={`${index}-${questionKey}`} className="space-y-1.5">
              <header className="flex items-center gap-1.5">
                <span
                  className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-none transition-colors ${
                    isAnswered
                      ? 'border-teal-400/50 bg-teal-400/10 text-teal-300'
                      : 'border-white/10 text-ink-3'
                  }`}
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3 className="text-[13px] font-semibold leading-tight text-ink-0">
                  {question.question}
                </h3>
              </header>
              <QuestionInput
                question={question}
                questionIndex={index}
                value={answers[questionKey] || ''}
                otherValue={otherAnswers[questionKey] || ''}
                notesValue={notes[questionKey] || ''}
                isNotesOpen={!!notesOpenByQuestion[questionKey]}
                isOtherOpen={!!otherOpenByQuestion[questionKey]}
                onActivate={activateOption}
                onSelectOption={selectOption}
                onTextChange={updateTextAnswer}
                onOtherChange={updateOtherAnswer}
                onCloseOther={closeOtherAnswer}
                onNotesChange={updateNotes}
                onOpenNotes={openNotes}
                onCloseNotes={closeNotes}
              />
            </section>
          );
        })}
      </div>
      <div className="flex items-center gap-2.5 border-t border-white/10 px-3 py-2.5">
        <button
          type="button"
          onClick={submitAnswers}
          disabled={!allAnswered}
          className="rounded-lg bg-teal-300 px-3 py-1.5 text-[13px] font-bold text-bg-0 transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-ink-3 disabled:hover:brightness-100"
        >
          Submit answers
        </button>
        <span className="text-xs text-ink-3">
          {request.questions.length} questions · {answeredCount} answered ·{' '}
          <Kbd shortcut="cmd+enter" />
        </span>
      </div>
      </div>
    </div>
  );
}
