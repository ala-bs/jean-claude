/* eslint-disable sort-imports */
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { TaskStep, TaskStepStatus } from '@shared/types';


import { MarkdownContent } from '@/features/agent/ui-markdown-content';
import {
  COMMENT_ACCENT,
  InlineCommentComposer,
} from '@/features/common/ui-inline-comments';
import type { NormalizedEntry } from '@shared/normalized-message-v2';


type ChatEntry = Extract<
  NormalizedEntry,
  { type: 'user-prompt' | 'assistant-message' | 'result' }
>;

type ChatTurn = {
  id: string;
  prompt: ChatEntry;
  response: ChatEntry | null;
};

const STATUS_LABELS: Record<TaskStepStatus, string> = {
  pending: 'Pending',
  ready: 'Ready',
  running: 'Running',
  completed: 'Done',
  errored: 'Error',
  interrupted: 'Interrupted',
};

const STATUS_CLASSES: Record<TaskStepStatus, string> = {
  pending: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
  ready: 'border-sky-400/20 bg-sky-400/10 text-sky-300',
  running: 'border-acc/25 bg-acc/10 text-acc-ink',
  completed: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  errored: 'border-red-400/25 bg-red-400/10 text-red-300',
  interrupted: 'border-ink-4/25 bg-bg-3 text-ink-3',
};

function getEntryContent(entry: ChatEntry) {
  if (entry.type === 'result') {
    return entry.value?.trim() ?? '';
  }

  return entry.value.trim();
}

function isChatEntry(entry: NormalizedEntry): entry is ChatEntry {
  if (
    entry.type !== 'user-prompt' &&
    entry.type !== 'assistant-message' &&
    entry.type !== 'result'
  ) {
    return false;
  }

  return Boolean(getEntryContent(entry));
}

function isSdkSyntheticPrompt(entry: ChatEntry) {
  return entry.type === 'user-prompt' && Boolean(entry.isSDKSynthetic);
}

function getChatTurns(messages: NormalizedEntry[]) {
  const turns: ChatTurn[] = [];
  let currentTurn: ChatTurn | null = null;

  for (const entry of messages) {
    if (!isChatEntry(entry)) continue;

    if (entry.type === 'user-prompt') {
      if (
        currentTurn &&
        !currentTurn.response &&
        getEntryContent(currentTurn.prompt) === getEntryContent(entry)
      ) {
        if (isSdkSyntheticPrompt(currentTurn.prompt) && !entry.isSDKSynthetic) {
          currentTurn.prompt = entry;
        }
        continue;
      }

      currentTurn = {
        id: entry.id,
        prompt: entry,
        response: null,
      };
      turns.push(currentTurn);
      continue;
    }

    if (!currentTurn) continue;
    currentTurn.response = entry;
  }

  return turns;
}

function getLatestResponse(messages: NormalizedEntry[]):
  | { type: 'answer'; content: string }
  | { type: 'error'; content: string }
  | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry.type !== 'assistant-message' && entry.type !== 'result') {
      continue;
    }

    const content = getEntryContent(entry);
    if (!content) continue;

    return entry.type === 'result' && entry.isError
      ? { type: 'error', content }
      : { type: 'answer', content };
  }

  return null;
}

export function submitPrReviewAgentChatFollowUp({
  question,
  isDisabled,
  onFollowUp,
}: {
  question: string;
  isDisabled: boolean;
  onFollowUp: (question: string) => Promise<void> | void;
}) {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion || isDisabled) return Promise.resolve(false);

  try {
    return Promise.resolve(onFollowUp(trimmedQuestion)).then(() => true);
  } catch (error) {
    return Promise.reject(error);
  }
}

function StatusPill({ status }: { status: TaskStepStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function PrReviewAgentChatCard({
  step,
  messages,
  onFollowUp,
  isSubmittingFollowUp,
  disabled = false,
  disableReason,
  defaultExpanded = false,
  loadError,
  onExpandedChange,
}: {
  step: TaskStep;
  messages: NormalizedEntry[];
  onFollowUp: (question: string) => Promise<void> | void;
  isSubmittingFollowUp: boolean;
  disabled?: boolean;
  disableReason?: string;
  defaultExpanded?: boolean;
  loadError?: string | null;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [followUpComposerKey, setFollowUpComposerKey] = useState(0);
  const chatBodyId = useId();
  const followUpErrorId = useId();
  const disableReasonId = useId();
  const chatTurns = useMemo(() => getChatTurns(messages), [messages]);
  const latestResponse = useMemo(() => getLatestResponse(messages), [messages]);
  const collapsedResponse = latestResponse ?? getStepOutputResponse(step);
  const isWaiting = step.status === 'pending' || step.status === 'running';
  const isComposerDisabled = disabled || isSubmittingFollowUp || isWaiting;
  const shouldDescribeTextarea = disabled && Boolean(disableReason);

  const handleSubmit = (question: string) => {
    setSubmitError(null);
    void submitPrReviewAgentChatFollowUp({
      question,
      isDisabled: isComposerDisabled,
      onFollowUp,
    }).then((didSubmit) => {
      if (didSubmit) setFollowUpComposerKey((current) => current + 1);
    }).catch((error: unknown) => {
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Failed to send follow-up. Please try again.',
      );
    });
  };

  const handleToggleExpanded = () => {
    setIsExpanded((current) => {
      const next = !current;
      onExpandedChange?.(next);
      return next;
    });
  };

  const handleAskMore = () => {
    setIsExpanded(true);
    onExpandedChange?.(true);
  };

  return (
    <section
      style={{
        background: COMMENT_ACCENT.bg,
        borderTop: `1px solid ${COMMENT_ACCENT.border}`,
        borderBottom: `1px solid ${COMMENT_ACCENT.border}`,
      }}
    >
      <div className="group/bubble flex items-start gap-2 px-3 py-1.5">
        <div
          className="mt-1 h-3 w-0.5 shrink-0 rounded-full"
          style={{ background: COMMENT_ACCENT.bar }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-ink-1 text-sm font-semibold">Ask Agent</span>
            <StatusPill status={step.status} />
            <div className="flex-1" />
            <button
              type="button"
              aria-label={isExpanded ? 'Collapse agent chat' : 'Expand agent chat'}
              aria-expanded={isExpanded}
              aria-controls={chatBodyId}
              className="text-ink-4 hover:text-ink-1 rounded p-1 transition-colors"
              onClick={handleToggleExpanded}
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          </div>

          <div id={chatBodyId} className="mt-1.5">
            {isExpanded ? (
              <div className="flex flex-col gap-3">
                {loadError ? (
                  <div
                    className="rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200"
                    role="alert"
                  >
                    <div className="mb-1 text-[10px] font-medium tracking-wide uppercase">
                      Message load error
                    </div>
                    {loadError}
                  </div>
                ) : null}
                <div className="flex flex-col gap-2">
                  {chatTurns.length > 0 ? (
                    chatTurns.map((turn) => (
                      <ChatTurnView key={turn.id} turn={turn} />
                    ))
                  ) : (
                    <p className="text-ink-4 text-sm">Thinking...</p>
                  )}
                </div>

                {!isWaiting && (
                  <div>
                    <InlineCommentComposer
                      key={followUpComposerKey}
                      lineStart={0}
                      onSubmit={(body) => handleSubmit(body)}
                      onCancel={() => undefined}
                      placeholder={disableReason ?? 'Ask a follow-up...'}
                      submitLabel={isSubmittingFollowUp ? 'Sending...' : 'Ask Agent'}
                      allowImages={false}
                      isSubmitting={isComposerDisabled}
                      showCancel={false}
                    />
                    <div className="mt-1 flex items-center justify-end gap-2">
                      {submitError ? (
                        <span
                          id={followUpErrorId}
                          className="text-xs text-red-300"
                          role="alert"
                        >
                          {submitError}
                        </span>
                      ) : null}
                      {disableReason && disabled ? (
                        <span id={disableReasonId} className="text-ink-4 text-xs">
                          {disableReason}
                        </span>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ) : isWaiting ? (
              <p className="text-ink-4 text-sm">Thinking...</p>
            ) : collapsedResponse ? (
              <div className="flex flex-col gap-2">
                <div
                  className={`max-h-28 overflow-hidden text-sm ${
                    collapsedResponse.type === 'error'
                      ? 'text-red-300'
                      : 'text-ink-2'
                  }`}
                  role={collapsedResponse.type === 'error' ? 'alert' : undefined}
                >
                  {collapsedResponse.type === 'error' ? (
                    <div className="mb-1 text-[10px] font-medium tracking-wide uppercase">
                      Agent error
                    </div>
                  ) : null}
                  <MarkdownContent
                    content={collapsedResponse.content}
                    truncateToChars={480}
                  />
                </div>
                <button
                  type="button"
                  className="w-fit rounded border border-line bg-bg-2 px-2 py-px text-[10px] text-ink-2 hover:bg-bg-3"
                  onClick={handleAskMore}
                >
                  ask more
                </button>
              </div>
            ) : (
              <p className="text-ink-4 text-sm">No response yet.</p>
            )}
          </div>
        </div>
      </div>
      {shouldDescribeTextarea ? (
        <span id={disableReasonId} className="sr-only">
          {disableReason}
        </span>
      ) : null}
    </section>
  );
}

function getStepOutputResponse(step: TaskStep):
  | { type: 'answer'; content: string }
  | { type: 'error'; content: string }
  | null {
  const output = step.output?.trim();
  if (!output) return null;

  return step.status === 'errored'
    ? { type: 'error', content: output }
    : { type: 'answer', content: output };
}

function ChatTurnView({ turn }: { turn: ChatTurn }) {
  return (
    <div className="flex flex-col gap-2">
      <ChatBubble entry={turn.prompt} />
      {turn.response ? <ChatBubble entry={turn.response} /> : null}
    </div>
  );
}

function ChatBubble({ entry }: { entry: ChatEntry }) {
  const isUser = entry.type === 'user-prompt';
  const isError = entry.type === 'result' && entry.isError;
  const content = getEntryContent(entry);

  return (
    <div
      className={`rounded-md border px-3 py-2 ${isUser ? 'text-xs' : 'text-sm'} ${
        isUser
          ? 'border-stroke-1 bg-bg-2 text-ink-2'
          : isError
            ? 'border-red-400/20 bg-red-400/10 text-red-200'
          : 'border-acc/15 bg-acc/5 text-ink-1'
      }`}
      role={isError ? 'alert' : undefined}
    >
      <div className="text-ink-4 mb-1 text-[10px] font-medium tracking-wide uppercase">
        {isUser ? 'You' : isError ? 'Agent error' : 'Agent'}
      </div>
      {isUser ? (
        <p className="whitespace-pre-wrap">{content}</p>
      ) : (
        <MarkdownContent content={content} />
      )}
    </div>
  );
}
