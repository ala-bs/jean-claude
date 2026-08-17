import type {
  AgentQuestion,
  QuestionResponse,
} from '@shared/agent-types';
import type { AgentMemoryQuestionResponseDetail } from '@shared/agent-memory-types';

export type QuestionInputMode = 'text' | 'single-choice' | 'multi-choice';

export function getQuestionInputMode(
  question: AgentQuestion,
): QuestionInputMode {
  // Order matters: the main process (agent-service questionMemoryAnswerFromDetail)
  // tests multi-select BEFORE text. A question like
  // `{ type: undefined, options: [], multiSelect: true }` must classify the same
  // on both sides or the delivered answer is rejected and the step never resumes.
  if (question.type === 'multi_choice' || question.multiSelect) {
    return 'multi-choice';
  }
  if (question.type === 'text') return 'text';
  if (!question.type && question.options.length === 0) return 'text';
  return 'single-choice';
}

export function getSelectedLabels(value: string): string[] {
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

export function getQuestionKey(question: AgentQuestion): string {
  return question.key;
}

function combineAnswerParts(parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(', ');
}

export function buildQuestionResponse({
  questions,
  answers,
  customAnswers,
  notes,
  wasFreeformByQuestion,
}: {
  questions: AgentQuestion[];
  answers: Record<string, string>;
  customAnswers: Record<string, string>;
  notes: Record<string, string>;
  wasFreeformByQuestion: Record<string, boolean>;
}): QuestionResponse {
  const responseAnswers: Record<string, string> = {};
  const memoryDetails: AgentMemoryQuestionResponseDetail[] = [];

  for (const question of questions) {
    const questionKey = getQuestionKey(question);
    const value = answers[questionKey];
    const customValue = customAnswers[questionKey]?.trim() || null;
    const note = notes[questionKey]?.trim() || null;
    const mode = getQuestionInputMode(question);
    let selectedLabels: string[] = [];
    let customAnswer = customValue;

    if (mode === 'multi-choice') {
      const selected = value === undefined ? [] : getSelectedLabels(value);
      const optionLabels = new Set(question.options.map((option) => option.label));
      selectedLabels = selected.filter((label) => optionLabels.has(label));
      customAnswer =
        combineAnswerParts([
          ...selected.filter((label) => !optionLabels.has(label)),
          customValue ?? undefined,
        ]) || null;
      // Must mirror the main-process canonicalization exactly
      // (agent-service questionMemoryAnswerFromDetail): valid option labels
      // first, then the combined free-form answer, then notes. Any divergence
      // is rejected as a forged response and leaves the step waiting.
      const combined = [
        ...selectedLabels,
        customAnswer,
        note ? `Notes: ${note}` : null,
      ]
        .map((part) => part?.trim())
        .filter((part): part is string => Boolean(part));
      if (combined.length > 0) {
        responseAnswers[questionKey] = JSON.stringify(combined);
      }
    } else {
      if (mode === 'single-choice') {
        const selected = question.options.find(
          (option) => option.label === value,
        )?.label;
        if (selected && !wasFreeformByQuestion[questionKey]) {
          selectedLabels = [selected];
          // A picked option and a free-form answer cannot coexist: the caller
          // marks the question free-form whenever `customAnswers` is set, so
          // this branch never carries one. Keep it null so the main process
          // does not reject the detail as an invalid single-choice.
          customAnswer = null;
        } else {
          customAnswer =
            combineAnswerParts([value, customValue ?? undefined]) || null;
        }
      } else {
        customAnswer = combineAnswerParts([value, customValue ?? undefined]) || null;
      }

      // Same canonical ordering as the main process.
      const combined = combineAnswerParts([
        selectedLabels[0],
        customAnswer ?? undefined,
        note ? `Notes: ${note}` : undefined,
      ]);
      if (combined) responseAnswers[questionKey] = combined;
    }

    // The delivered answer is built from trimmed parts, so a blank-after-trim
    // label must not count toward the detail either — otherwise the renderer
    // emits a detail with no matching answer and the main process rejects it.
    selectedLabels = selectedLabels.filter((label) => label.trim().length > 0);

    if (selectedLabels.length > 0 || customAnswer || note) {
      memoryDetails.push({
        questionKey,
        selectedLabels,
        customAnswer,
        notes: note,
      });
    }
  }

  return {
    answers: responseAnswers,
    wasFreeform: Object.values(wasFreeformByQuestion).some(Boolean),
    wasFreeformByQuestion,
    memoryDetails,
  };
}
