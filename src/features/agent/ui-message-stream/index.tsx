import {
  addBashToPermissionsItem,
  copyToClipboardItem,
  copyToolInputItem,
  copyToolResultItem,
  showRawMessageItem,
  useMessageContextMenu,
} from './ui-message-context-menu';
import type {
  AgentQuestion,
  PermissionResponse,
  QuestionResponse,
  QueuedPrompt,
} from '@shared/agent-types';
import { CompactingEntry, TimelineEntry } from './ui-timeline-entry';
import {
  memo,
  type MouseEvent,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  MessageStreamProcessingCache,
  StreamMessage,
} from './message-merger';
import type {
  NormalizedEntry,
  NormalizedPermissionRequest,
  NormalizedToolUse,
} from '@shared/normalized-message-v2';
import type { AgentMemoryPromptCapture } from '@shared/agent-memory-types';
import type { ContextMenuItem } from './ui-message-context-menu';
import type { InteractionMode } from '@shared/types';
import { PermissionBar } from '../ui-permission-bar';
import { processMessageStream } from './message-merger';
import { PromptGroupEntry } from './ui-prompt-group-entry';
import { PromptSidebar } from './ui-prompt-sidebar';
import { QuestionOptions } from '../ui-question-options';
import { QueuedPromptEntry } from './ui-queued-prompt-entry';
import { SkillEntry } from './ui-skill-entry';
import { SubagentEntry } from './ui-subagent-entry';
import type { ToolUseByName } from '@shared/normalized-message-v2';
import {
  clearStepScrollPosition,
  getStepScrollPosition,
  setStepScrollPosition,
} from '@/stores/task-messages';

// Threshold in pixels - if user is within this distance from bottom, auto-scroll
const SCROLL_THRESHOLD = 10;
// How long the content may stall (stop growing) before we give up restoring
const RESTORE_IDLE_MS = 750;

function addToolCopyItems(
  items: ContextMenuItem[],
  toolUse: NormalizedToolUse,
): void {
  const copyInputItem = copyToolInputItem(toolUse);
  if (copyInputItem) items.push(copyInputItem);
  const copyResultItem = copyToolResultItem(toolUse);
  if (copyResultItem) items.push(copyResultItem);
}

export interface PermissionBannerProps {
  request: NormalizedPermissionRequest & { taskId: string };
  onRespond: (
    requestId: string,
    response: PermissionResponse,
  ) => void | Promise<void>;
  onAllowForSession?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  onAllowForProject?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  onAllowForProjectWorktrees?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  onAllowGlobally?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  onSetMode?: (mode: InteractionMode) => void;
  onAutoAcceptAll?: () => void | Promise<void>;
  worktreePath?: string | null;
}

export interface QuestionBannerProps {
  request: {
    taskId: string;
    requestId: string;
    contextReminder?: string;
    questions: AgentQuestion[];
  };
  onRespond: (
    requestId: string,
    response: QuestionResponse,
  ) => void | Promise<void | boolean>;
}

export const MessageStream = memo(function MessageStream({
  messages,
  isRunning,
  queuedPrompts = [],
  onFilePathClick,
  onToolDiffClick,
  onCancelQueuedPrompt,
  onUpdateQueuedPrompt,
  onShowRawMessage,
  bottomPadding = 0,
  pendingPermission,
  pendingQuestion,
  onAddBashToPermissions,
  rootPath,
  taskId,
  stepId,
  afterLastPromptGroup,
  onOpenFileInReview,
  onOpenFileInEditor,
}: {
  messages: NormalizedEntry[];
  isRunning?: boolean;
  queuedPrompts?: QueuedPrompt[];
  onFilePathClick?: (
    filePath: string,
    lineStart?: number,
    lineEnd?: number,
  ) => void;
  onToolDiffClick?: (
    filePath: string,
    oldString: string,
    newString: string,
  ) => void;
  onCancelQueuedPrompt?: (promptId: string) => void;
  onUpdateQueuedPrompt?: (
    promptId: string,
    content: string,
    capture?: AgentMemoryPromptCapture,
  ) => void;
  /** Callback when user wants to see a message's raw data in the debug pane */
  onShowRawMessage?: (entryId: string) => void;
  /** Extra bottom padding (px) so content can scroll behind a floating footer */
  bottomPadding?: number;
  /** Permission request to render inline at the bottom of the stream */
  pendingPermission?: PermissionBannerProps | null;
  /** Question request to render inline at the bottom of the stream */
  pendingQuestion?: QuestionBannerProps | null;
  /** Callback to open the "Add to permissions" modal (state managed by parent) */
  onAddBashToPermissions?: (command: string) => void;
  /** Root path (worktree or project) used to relativize file paths in diff modals */
  rootPath?: string | null;
  /** Task ID for comment anchoring in assistant messages */
  taskId?: string;
  /** Active step ID so task/step switches can reset scroll position */
  stepId?: string | null;
  /** Optional action rendered directly below the last prompt group */
  afterLastPromptGroup?: ReactNode;
  onOpenFileInReview?: (filePath: string) => void;
  onOpenFileInEditor?: (filePath: string) => void | Promise<void>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentObserverRef = useRef<ResizeObserver | null>(null);
  const isNearBottomRef = useRef(true);
  // Whether an automatic re-pin is still wanted. Set on focus/new message,
  // cleared as soon as the user scrolls away from the bottom.
  const shouldPinRef = useRef(true);
  // Step whose offset we are currently tracking
  const scrollKeyRef = useRef(stepId ?? null);
  // Offset we still want to land on while lazy content finishes mounting
  const pendingRestoreRef = useRef<number | null>(null);
  const restoreDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last scrollHeight seen while restoring, to detect "content stopped growing"
  const restoreHeightRef = useRef(0);
  const [processingCacheState, setProcessingCacheState] = useState<{
    key: string;
    cache: MessageStreamProcessingCache;
  } | null>(null);
  const processingCacheKey = `${taskId ?? ''}:${stepId ?? ''}`;
  const previousProcessingCache =
    processingCacheState?.key === processingCacheKey
      ? processingCacheState.cache
      : undefined;
  const processedStream = useMemo(
    () =>
      processMessageStream(
        messages,
        isRunning,
        previousProcessingCache,
      ),
    [messages, isRunning, previousProcessingCache],
  );

  useEffect(() => {
    if (
      processingCacheState?.key === processingCacheKey &&
      processingCacheState.cache === processedStream.cache
    ) {
      return;
    }

    startTransition(() => {
      setProcessingCacheState({
        key: processingCacheKey,
        cache: processedStream.cache,
      });
    });
  }, [processedStream.cache, processingCacheKey, processingCacheState]);

  const {
    streamMessages,
    promptIndexMap,
    promptNavigationItems,
    lastPromptGroupIndex,
  } = processedStream;

  // Check if scroll position is near bottom
  const checkIfNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return distanceFromBottom <= SCROLL_THRESHOLD;
  }, []);

  // Update near-bottom state on scroll, and remember the offset so refocusing
  // this task/step restores where the user left off.
  const handleScroll = useCallback(() => {
    const nearBottom = checkIfNearBottom();
    isNearBottomRef.current = nearBottom;
    if (!nearBottom) shouldPinRef.current = false;

    const container = scrollContainerRef.current;
    if (!container) return;
    // While a restore is in flight the offsets we see are our own (and are
    // clamped to a still-growing content box) — persisting them would
    // overwrite the real saved offset with a bogus one.
    if (pendingRestoreRef.current !== null) return;
    const key = scrollKeyRef.current;
    if (!key) return;
    if (nearBottom) {
      // Parked at the bottom is the default behaviour — nothing to restore.
      clearStepScrollPosition(key);
    } else {
      setStepScrollPosition(key, container.scrollTop);
    }
  }, [checkIfNearBottom]);

  // Scroll all the way down, including the padding reserved for the
  // floating composer. Using scrollTop (not scrollIntoView on a sentinel that
  // sits above the padding) guarantees we land at the true maximum offset.
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  // Leave restore mode. `reachedTarget` matters: when we give up short of the
  // target the container is clamped at the bottom, so re-arming the pin from
  // that position would auto-scroll to the true bottom on the next resize —
  // and that scroll event would then wipe the saved offset. Give-ups therefore
  // leave pinning off and the stored offset intact.
  const endPendingRestore = useCallback(
    ({ reachedTarget }: { reachedTarget: boolean }) => {
      if (restoreDeadlineRef.current !== null) {
        clearTimeout(restoreDeadlineRef.current);
        restoreDeadlineRef.current = null;
      }
      if (pendingRestoreRef.current === null) return;
      pendingRestoreRef.current = null;
      const nearBottom = checkIfNearBottom();
      isNearBottomRef.current = nearBottom;
      shouldPinRef.current = reachedTarget && nearBottom;
    },
    [checkIfNearBottom],
  );

  // Idle deadline: restore mode ends once the content stops growing for
  // RESTORE_IDLE_MS. Resize ticks are the only thing driving
  // applyPendingRestore, so if the content stalls short of the target (entries
  // re-collapsed, narrower window, fewer messages than when the offset was
  // saved) nothing else would ever end the restore — leaving saving and
  // auto-pin disabled, and yanking the user later if the stream grows again.
  const startRestoreDeadline = useCallback(() => {
    if (restoreDeadlineRef.current !== null) {
      clearTimeout(restoreDeadlineRef.current);
    }
    restoreDeadlineRef.current = setTimeout(() => {
      endPendingRestore({ reachedTarget: false });
    }, RESTORE_IDLE_MS);
  }, [endPendingRestore]);

  // Re-apply the saved offset until the content is tall enough to hold it.
  const applyPendingRestore = useCallback(() => {
    const target = pendingRestoreRef.current;
    if (target === null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollHeight } = container;
    const maxScroll = Math.max(scrollHeight - container.clientHeight, 0);
    container.scrollTop = Math.min(target, maxScroll);
    if (maxScroll >= target) {
      // The content can accommodate the target offset — restore succeeded
      endPendingRestore({ reachedTarget: true });
      return;
    }
    // Still growing: give lazy content another idle window to mount
    if (scrollHeight !== restoreHeightRef.current) {
      restoreHeightRef.current = scrollHeight;
      startRestoreDeadline();
    }
  }, [endPendingRestore, startRestoreDeadline]);

  // Any user intent to move the viewport wins over a pending restore
  const cancelPendingRestore = useCallback(() => {
    endPendingRestore({ reachedTarget: false });
  }, [endPendingRestore]);

  // Restore the previous offset when refocusing a task/step, otherwise land at
  // the bottom. The restore target is kept "pending" because content below the
  // fold mounts lazily: scrollHeight is usually too small on first commit, so
  // the ResizeObserver below re-applies it until it fits.
  useLayoutEffect(() => {
    const key = stepId ?? null;
    scrollKeyRef.current = key;
    const saved = key ? getStepScrollPosition(key) : undefined;
    if (saved === undefined) {
      cancelPendingRestore();
      scrollToBottom();
      isNearBottomRef.current = true;
      shouldPinRef.current = true;
      return;
    }
    pendingRestoreRef.current = saved;
    restoreHeightRef.current = 0;
    isNearBottomRef.current = false;
    shouldPinRef.current = false;
    startRestoreDeadline();
    applyPendingRestore();
  }, [
    taskId,
    stepId,
    scrollToBottom,
    applyPendingRestore,
    startRestoreDeadline,
    cancelPendingRestore,
  ]);

  // Never leave a restore timer running past unmount
  useEffect(() => cancelPendingRestore, [cancelPendingRestore]);

  // Content mounted below the fold (markdown, diffs, tool cards, images) can
  // grow *after* the initial scroll, and the floating composer's height is
  // measured asynchronously — both leave a gap at the bottom. Re-pin whenever
  // the content box or the reserved padding changes while we're near bottom.
  useLayoutEffect(() => {
    if (isNearBottomRef.current) scrollToBottom();
  }, [bottomPadding, scrollToBottom]);

  // Ref callback (not an effect) so the observer attaches whenever the content
  // node actually mounts — the stream renders a placeholder while messages are
  // still loading, so the node does not exist on first commit.
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentObserverRef.current?.disconnect();
      contentObserverRef.current = null;
      if (!node) return;
      const observer = new ResizeObserver(() => {
        if (pendingRestoreRef.current !== null) {
          applyPendingRestore();
          return;
        }
        // Only re-pin while the user is parked at the bottom *and* hasn't
        // scrolled away since the last focus/message — otherwise expanding a
        // collapsed entry would yank them back down.
        if (isNearBottomRef.current && shouldPinRef.current) scrollToBottom();
      });
      observer.observe(node);
      // The container itself resizes on window/split/sidebar changes, which
      // also opens a gap at the bottom.
      if (scrollContainerRef.current) {
        observer.observe(scrollContainerRef.current);
      }
      contentObserverRef.current = observer;
    },
    [scrollToBottom, applyPendingRestore],
  );

  useEffect(() => () => contentObserverRef.current?.disconnect(), []);

  // Derive a boolean so the effect only fires when a banner appears/disappears
  const hasPendingBanner = !!pendingPermission || !!pendingQuestion;

  // Auto-scroll to bottom when new messages arrive, prompts are queued,
  // or a permission/question banner appears — but only if user is near bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      // New content at the bottom re-arms automatic re-pinning so its
      // late-mounting children (markdown, diffs, images) stay in view.
      shouldPinRef.current = true;
      scrollToBottom();
    }
  }, [
    streamMessages.length,
    queuedPrompts.length,
    hasPendingBanner,
    scrollToBottom,
  ]);

  const { openMenu: openContextMenu, portal: contextMenuPortal } =
    useMessageContextMenu();

  // Build context menu items for a stream message
  const buildContextMenuItems = useCallback(
    (streamMessage: StreamMessage): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];

      // Prompt groups use their promptEntry id for context menu
      if (streamMessage.kind === 'prompt-group') {
        const copyItem = copyToClipboardItem(streamMessage.promptEntry);
        if (copyItem) items.push(copyItem);
        if (onShowRawMessage) {
          items.push(
            showRawMessageItem(onShowRawMessage, streamMessage.promptEntry.id),
          );
        }
        return items;
      }

      // "Copy to clipboard" for entries with copyable text
      if (streamMessage.kind === 'entry') {
        if (streamMessage.entry.type === 'tool-use') {
          addToolCopyItems(items, streamMessage.entry);
        } else {
          const copyItem = copyToClipboardItem(streamMessage.entry);
          if (copyItem) items.push(copyItem);
        }
      }

      if (streamMessage.kind === 'skill') {
        addToolCopyItems(items, streamMessage.skillToolUse);
      } else if (streamMessage.kind === 'subagent') {
        addToolCopyItems(items, streamMessage.toolUse);
      }

      // "Add to permissions" for bash tool entries
      if (
        onAddBashToPermissions &&
        streamMessage.kind === 'entry' &&
        streamMessage.entry.type === 'tool-use' &&
        streamMessage.entry.name === 'bash'
      ) {
        const command = (streamMessage.entry as ToolUseByName<'bash'>).input
          .command;
        items.push(addBashToPermissionsItem(onAddBashToPermissions, command));
      }

      // "Show in Raw Messages" for all entries
      if (onShowRawMessage) {
        let entryId: string | null = null;
        if (streamMessage.kind === 'entry') entryId = streamMessage.entry.id;
        else if (streamMessage.kind === 'skill')
          entryId = streamMessage.skillToolUse.toolId;
        else if (streamMessage.kind === 'subagent')
          entryId = streamMessage.toolUse.toolId;

        if (entryId) {
          items.push(showRawMessageItem(onShowRawMessage, entryId));
        }
      }

      return items;
    },
    [onAddBashToPermissions, onShowRawMessage],
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent, streamMessage: StreamMessage) => {
      const items = buildContextMenuItems(streamMessage);
      openContextMenu(e, items);
    },
    [buildContextMenuItems, openContextMenu],
  );

  const buildEntryContextMenuItems = useCallback(
    (entry: NormalizedEntry): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];

      if (entry.type === 'tool-use') {
        const copyInputItem = copyToolInputItem(entry);
        if (copyInputItem) items.push(copyInputItem);
        const copyResultItem = copyToolResultItem(entry);
        if (copyResultItem) items.push(copyResultItem);
      } else {
        const copyItem = copyToClipboardItem(entry);
        if (copyItem) items.push(copyItem);
      }

      if (
        onAddBashToPermissions &&
        entry.type === 'tool-use' &&
        entry.name === 'bash'
      ) {
        const command = (entry as ToolUseByName<'bash'>).input.command;
        items.push(addBashToPermissionsItem(onAddBashToPermissions, command));
      }

      if (onShowRawMessage && entry.id) {
        items.push(showRawMessageItem(onShowRawMessage, entry.id));
      }

      return items;
    },
    [onAddBashToPermissions, onShowRawMessage],
  );

  const buildToolUseContextMenuItems = useCallback(
    (toolUse: NormalizedToolUse): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];

      const copyInputItem = copyToolInputItem(toolUse);
      if (copyInputItem) items.push(copyInputItem);
      const copyResultItem = copyToolResultItem(toolUse);
      if (copyResultItem) items.push(copyResultItem);

      if (onAddBashToPermissions && toolUse.name === 'bash') {
        const command = (toolUse as ToolUseByName<'bash'>).input.command;
        items.push(addBashToPermissionsItem(onAddBashToPermissions, command));
      }

      if (onShowRawMessage && toolUse.toolId) {
        items.push(showRawMessageItem(onShowRawMessage, toolUse.toolId));
      }

      return items;
    },
    [onAddBashToPermissions, onShowRawMessage],
  );

  const handleEntryContextMenu = useCallback(
    (e: MouseEvent, entry: NormalizedEntry) => {
      openContextMenu(e, buildEntryContextMenuItems(entry));
    },
    [buildEntryContextMenuItems, openContextMenu],
  );

  const handleToolUseContextMenu = useCallback(
    (e: MouseEvent, toolUse: NormalizedToolUse) => {
      openContextMenu(e, buildToolUseContextMenuItems(toolUse));
    },
    [buildToolUseContextMenuItems, openContextMenu],
  );

  if (messages.length === 0) {
    return (
      <div className="text-ink-3 flex h-full items-center justify-center">
        <p>Agent session will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <PromptSidebar
        scrollContainerRef={scrollContainerRef}
        prompts={promptNavigationItems}
        taskId={taskId}
        bottomPadding={bottomPadding}
      />
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={cancelPendingRestore}
        onTouchMove={cancelPendingRestore}
        onMouseDown={cancelPendingRestore}
        onKeyDown={cancelPendingRestore}
        className="min-w-0 flex-1 overflow-auto"
        style={bottomPadding > 0 ? { paddingBottom: bottomPadding } : undefined}
      >
        {contextMenuPortal}
        <div ref={contentRef} className="relative">
          {streamMessages.map((streamMessage, index) => {
            // Prompt groups render as collapsible entries
            if (streamMessage.kind === 'prompt-group') {
              const promptIdx = promptIndexMap.get(index);
              const previousPromptDate = (() => {
                for (let i = index - 1; i >= 0; i--) {
                  const previousMessage = streamMessages[i];
                  if (previousMessage?.kind === 'prompt-group') {
                    return previousMessage.promptEntry.date;
                  }
                }
                return undefined;
              })();
              // Show separator before non-first prompt groups
              const showSeparator =
                index > 0 && streamMessages[index - 1]?.kind === 'prompt-group';
              return (
                <div
                  key={index}
                  {...(promptIdx !== undefined
                    ? { 'data-prompt-index': promptIdx }
                    : {})}
                >
                  {showSeparator && (
                    <div
                      className="mx-4 my-1"
                      style={{
                        height: '1px',
                        background:
                          'linear-gradient(to right, transparent, oklch(1 0 0 / 0.12), transparent)',
                      }}
                    />
                  )}
                  <PromptGroupEntry
                    group={streamMessage}
                    isLast={index === lastPromptGroupIndex}
                    isTaskRunning={
                      index === lastPromptGroupIndex && isRunning
                    }
                    previousPromptDate={previousPromptDate}
                    onFilePathClick={onFilePathClick}
                    onToolDiffClick={onToolDiffClick}
                    onPromptContextMenu={handleEntryContextMenu}
                    onEntryContextMenu={handleEntryContextMenu}
                    onToolUseContextMenu={handleToolUseContextMenu}
                    onResultContextMenu={handleEntryContextMenu}
                    rootPath={rootPath}
                    taskId={taskId}
                    onOpenFileInReview={onOpenFileInReview}
                    onOpenFileInEditor={onOpenFileInEditor}
                  />
                  {index === lastPromptGroupIndex && afterLastPromptGroup && (
                    <div className="mx-4 -mt-2 mb-5 flex justify-start">
                      {afterLastPromptGroup}
                    </div>
                  )}
                </div>
              );
            }

            // Standalone messages (before first prompt)
            if (streamMessage.kind === 'skill') {
              const promptIdx = promptIndexMap.get(index);
              return (
                <div
                  key={index}
                  onContextMenu={(e) => handleContextMenu(e, streamMessage)}
                  {...(promptIdx !== undefined
                    ? { 'data-prompt-index': promptIdx }
                    : {})}
                >
                  <SkillEntry
                    skillToolUse={streamMessage.skillToolUse}
                    promptEntry={streamMessage.promptEntry}
                    onFilePathClick={onFilePathClick}
                  />
                </div>
              );
            }
            if (streamMessage.kind === 'compacting') {
              return (
                <CompactingEntry
                  key={index}
                  isComplete={!!streamMessage.endEntry}
                />
              );
            }
            if (streamMessage.kind === 'subagent') {
              return (
                <div
                  key={index}
                  onContextMenu={(e) => handleContextMenu(e, streamMessage)}
                >
                  <SubagentEntry
                    toolUse={streamMessage.toolUse}
                    childEntries={streamMessage.childEntries}
                    onFilePathClick={onFilePathClick}
                    onToolDiffClick={onToolDiffClick}
                    onEntryContextMenu={handleEntryContextMenu}
                    taskId={taskId}
                  />
                </div>
              );
            }
            return (
              <div
                key={index}
                onContextMenu={(e) => handleContextMenu(e, streamMessage)}
              >
                <TimelineEntry
                  entry={streamMessage.entry}
                  onFilePathClick={onFilePathClick}
                  onToolDiffClick={onToolDiffClick}
                  taskId={taskId}
                />
              </div>
            );
          })}
          {/* Queued prompts */}
          {queuedPrompts.map((prompt) => (
            <QueuedPromptEntry
              key={prompt.id}
              prompt={prompt}
              onCancel={onCancelQueuedPrompt ?? (() => {})}
              onUpdate={onUpdateQueuedPrompt ?? (() => {})}
            />
          ))}
          {/* Permission request (in-stream banner) */}
          {pendingPermission && (
            <div className="my-2 mr-3 ml-2 overflow-hidden rounded-lg">
              <PermissionBar
                request={pendingPermission.request}
                onRespond={pendingPermission.onRespond}
                onAllowForSession={pendingPermission.onAllowForSession}
                onAllowForProject={pendingPermission.onAllowForProject}
                onAllowForProjectWorktrees={
                  pendingPermission.onAllowForProjectWorktrees
                }
                onAllowGlobally={pendingPermission.onAllowGlobally}
                onSetMode={pendingPermission.onSetMode}
                onAutoAcceptAll={pendingPermission.onAutoAcceptAll}
                worktreePath={pendingPermission.worktreePath}
              />
            </div>
          )}
          {/* Question (in-stream banner) */}
          {pendingQuestion && (
            <div className="my-2 mr-3 ml-2 overflow-hidden rounded-lg">
              <QuestionOptions
                key={pendingQuestion.request.requestId}
                request={pendingQuestion.request}
                onRespond={pendingQuestion.onRespond}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
