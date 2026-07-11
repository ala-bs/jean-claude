import { useCallback, useState } from 'react';
import clsx from 'clsx';


import {
  COMMENT_ACCENT,
  InlineCommentComposer,
} from '@/features/common/ui-inline-comments';
import { REVIEW_PRESETS, type ReviewPresetId } from '@/stores/review-comments';
import type { PromptImagePart } from '@shared/agent-backend-types';



function PresetChips({
  selectedPresets,
  onToggle,
}: {
  selectedPresets: ReviewPresetId[];
  onToggle: (id: ReviewPresetId) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {REVIEW_PRESETS.map((p) => (
        <button
          key={p.id}
          onClick={() => onToggle(p.id)}
          className={clsx(
            'rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-colors',
            selectedPresets.includes(p.id)
              ? 'border-acc-line bg-acc-soft text-acc-ink'
              : 'border-line bg-bg-1 text-ink-2 hover:bg-bg-2',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function ReviewCommentComposer({
  lineStart,
  lineEnd,
  onSubmit,
  onCancel,
  initialBody,
  onBodyChange,
  onSubmitAsPrComment,
  onAskAgent,
}: {
  lineStart: number;
  lineEnd?: number;
  onSubmit: (
    body: string,
    presets: ReviewPresetId[],
    images: PromptImagePart[],
  ) => void;
  onCancel: () => void;
  initialBody?: string;
  onBodyChange?: (body: string) => void;
  onSubmitAsPrComment?: (
    body: string,
    images: PromptImagePart[],
  ) => Promise<void> | void;
  onAskAgent?: (question: string) => Promise<void> | void;
}) {
  const [selectedPresets, setSelectedPresets] = useState<ReviewPresetId[]>([]);
  const [isSubmittingPrComment, setIsSubmittingPrComment] = useState(false);
  const [isAskingAgent, setIsAskingAgent] = useState(false);
  const [prCommentError, setPrCommentError] = useState<string | null>(null);

  const togglePreset = useCallback((id: ReviewPresetId) => {
    setSelectedPresets((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }, []);

  const handleSubmit = useCallback(
    (body: string, images: PromptImagePart[]) => {
      onSubmit(body, selectedPresets, images);
    },
    [onSubmit, selectedPresets],
  );

  const handleSubmitAsPrComment = useCallback(
    async (body: string, images: PromptImagePart[]) => {
      if (!onSubmitAsPrComment || isSubmittingPrComment) return;
      setPrCommentError(null);
      setIsSubmittingPrComment(true);
      try {
        await onSubmitAsPrComment(body, images);
      } catch (error) {
        setPrCommentError(
          error instanceof Error ? error.message : 'Failed to post PR comment',
        );
      } finally {
        setIsSubmittingPrComment(false);
      }
    },
    [isSubmittingPrComment, onSubmitAsPrComment],
  );

  const handleAskAgent = useCallback(
    async (body: string) => {
      if (!onAskAgent || isAskingAgent) return;
      const question = body.trim();
      if (!question) return;
      setPrCommentError(null);
      setIsAskingAgent(true);
      try {
        await onAskAgent(question);
      } catch (error) {
        setPrCommentError(
          error instanceof Error ? error.message : 'Failed to ask agent',
        );
      } finally {
        setIsAskingAgent(false);
      }
    },
    [isAskingAgent, onAskAgent],
  );

  return (
    <div
      style={{
        background: COMMENT_ACCENT.bgLight,
        borderTop: `1px solid ${COMMENT_ACCENT.borderStrong}`,
        borderBottom: `1px solid ${COMMENT_ACCENT.borderStrong}`,
      }}
    >
      <div className="px-3 py-2.5">
        <InlineCommentComposer
          lineStart={lineStart}
          lineEnd={lineEnd}
          onSubmit={handleSubmit}
          onCancel={onCancel}
          initialBody={initialBody}
          onBodyChange={onBodyChange}
          canSubmitEmpty={selectedPresets.length > 0}
          placeholder="Leave an instruction for this line..."
          renderBeforeTextarea={
            <PresetChips
              selectedPresets={selectedPresets}
              onToggle={togglePreset}
            />
          }
          renderAfterActions={({ body, images, isDisabled }) => (
            <>
              {onAskAgent && (
                <button
                  type="button"
                  className="border-glass-border/70 text-ink-2 hover:text-ink-0 rounded border px-2 py-1 text-xs disabled:opacity-50"
                  onClick={() => void handleAskAgent(body)}
                  disabled={isDisabled || isAskingAgent || !body.trim()}
                >
                  {isAskingAgent ? 'Asking...' : 'Ask Agent'}
                </button>
              )}
              {onSubmitAsPrComment && (
                <button
                  type="button"
                  className="border-glass-border/70 text-ink-2 hover:text-ink-0 rounded border px-2 py-1 text-xs disabled:opacity-50"
                  onClick={() => void handleSubmitAsPrComment(body, images)}
                  disabled={isDisabled || isSubmittingPrComment}
                >
                  {isSubmittingPrComment ? 'Posting...' : 'Post to PR'}
                </button>
              )}
              <span className="text-ink-4 ml-auto text-[10.5px]">
                {"Won't be sent until you submit the review."}
              </span>
            </>
          )}
        />
        {prCommentError && (
          <p className="text-status-fail mt-2 text-xs">{prCommentError}</p>
        )}
      </div>
    </div>
  );
}
