import { Bot, Loader2, MessageSquarePlus, Send } from 'lucide-react';
import type { ComponentType, FormEvent, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';



import {
  type CommentFormEntry,
  DiffView,
  type InlineComment,
  lineAnchorKey,
  type LineRange,
  lineRangeKey,
} from '@/features/agent/ui-diff-view';
import {
  fileHasAnnotations,
  useAnnotationsAsInlineComments,
} from '@/features/agent/ui-diff-annotation';
import type { ReviewComment, ReviewPresetId } from '@/stores/review-comments';
import type { FileAnnotation } from '@/lib/api';
import { getSelectedTextForRange } from '@/stores/utils-comment-prompt';
import { isSvgPath } from '@shared/image-types';
import type { LineRangeSelectionPosition } from '@/features/agent/ui-diff-view/use-line-range-selection';
import { MarkdownContent } from '@/features/agent/ui-markdown-content';
import type { PromptImagePart } from '@shared/agent-backend-types';
import { ReviewCommentComposer } from '@/features/agent/ui-review-comments/review-comment-composer';
import { ReviewCommentThread } from '@/features/agent/ui-review-comments/review-comment-thread';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';



import type { CommentThread, DiffFile } from './types';
import { FileDiffHeader } from './file-diff-header';
import { Textarea } from '@/common/ui/textarea';


const EMPTY_INLINE_COMMENTS: InlineComment[] = [];
const SVG_PREVIEW_WIDTH = 192;
const SVG_PREVIEW_MIN_WIDTH = 140;
const SVG_PREVIEW_MAX_WIDTH = 360;
const SELECTION_POPOVER_OFFSET = 8;
const TRANSPARENCY_GRID_STYLE = {
  backgroundColor: '#f8fafc',
  backgroundImage:
    'linear-gradient(45deg, #cbd5e1 25%, transparent 25%), linear-gradient(-45deg, #cbd5e1 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #cbd5e1 75%), linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
  backgroundSize: '16px 16px',
};

export function FileDiffContent({
  file,
  oldContent,
  newContent,
  isLoading,
  isBinary,
  headerClassName,
  // Optional image support
  oldImageDataUrl,
  newImageDataUrl,
  // Optional comment support
  threads,
  renderThread,
  scrollToLine,
  onAddComment,
  isAddingComment,
  CommentForm,
  renderCommentForm,
  // Optional annotation support
  annotations,
  // Optional review comment support
  reviewComments,
  onAddReviewComment,
  onAddReviewCommentAsPrComment,
  onDeleteReviewComment,
  onEditReviewComment,
  showReviewStatus,
  onResolveReviewComment,
  defaultCommentFormLineRanges,
  onCommentFormClose,
  shouldKeepCommentFormRangeOnOpen,
  getReviewCommentDraftBody,
  onReviewCommentDraftBodyChange,
  onAskAgent,
  prReviewChatCards,
}: {
  file: DiffFile;
  oldContent: string;
  newContent: string;
  isLoading?: boolean;
  isBinary?: boolean;
  headerClassName?: string;
  oldImageDataUrl?: string | null;
  newImageDataUrl?: string | null;
  // Comment props - all optional
  threads?: CommentThread[];
  renderThread?: (thread: CommentThread) => ReactNode;
  scrollToLine?: number;
  onAddComment?: (params: {
    filePath: string;
    line: number;
    lineEnd?: number;
    content: string;
  }) => void;
  isAddingComment?: boolean;
  CommentForm?: ComponentType<{
    onSubmit: (content: string) => void;
    onCancel: () => void;
    lineStart: number;
    lineEnd?: number;
    isSubmitting?: boolean;
    placeholder?: string;
    onAskAgent?: (question: string) => Promise<void> | void;
  }>;
  renderCommentForm?: (props: {
    onSubmit: (content: string) => void;
    onCancel: () => void;
    lineStart: number;
    lineEnd?: number;
    isSubmitting?: boolean;
    placeholder?: string;
    onAskAgent?: (question: string) => Promise<void> | void;
  }) => ReactNode;
  /** Initial line ranges for comment forms (for draft restoration). */
  defaultCommentFormLineRanges?: LineRange[];
  /** Called when a comment form is closed (for draft cleanup). */
  onCommentFormClose?: (range: LineRange) => void;
  /** Decide which already-open forms stay when opening another form. */
  shouldKeepCommentFormRangeOnOpen?: (range: LineRange) => boolean;
  getReviewCommentDraftBody?: (lineStart: number, lineEnd?: number) => string;
  onReviewCommentDraftBodyChange?: (
    body: string,
    lineStart: number,
    lineEnd?: number,
  ) => void;
  onAskAgent?: (params: {
    filePath: string;
    lineStart: number;
    lineEnd?: number;
    side?: 'old' | 'new';
    selectedText: string;
    question: string;
  }) => Promise<void> | void;
  prReviewChatCards?: Array<{
    id: string;
    line: number;
    side?: 'old' | 'new';
    content: ReactNode;
    lineStart: number;
    lineEnd?: number;
  }>;
  // Annotation props - optional
  annotations?: FileAnnotation[];
  // Review comment props - optional
  reviewComments?: ReviewComment[];
  onAddReviewComment?: (params: {
    filePath: string;
    lineStart: number;
    lineEnd?: number;
    selectedText?: string;
    body: string;
    presets: ReviewPresetId[];
    images?: PromptImagePart[];
  }) => void;
  onAddReviewCommentAsPrComment?: (params: {
    filePath: string;
    line: number;
    lineEnd?: number;
    body: string;
    images: PromptImagePart[];
  }) => Promise<void>;
  onDeleteReviewComment?: (commentId: string) => void;
  onEditReviewComment?: (
    commentId: string,
    newBody: string,
    newImages: PromptImagePart[],
  ) => void;
  showReviewStatus?: boolean;
  onResolveReviewComment?: (commentId: string) => void;
}) {
  const [commentFormLineRanges, setCommentFormLineRanges] = useState<
    LineRange[]
  >(defaultCommentFormLineRanges ?? []);
  const [askAgentFormLineRange, setAskAgentFormLineRange] =
    useState<LineRange | null>(null);
  const [selectionPopover, setSelectionPopover] = useState<{
    range: LineRange;
    x: number;
    y: number;
  } | null>(null);
  const selectionPopoverRef = useRef<HTMLDivElement | null>(null);
  const [svgPreviewWidth, setSvgPreviewWidth] = useState(SVG_PREVIEW_WIDTH);

  useEffect(() => {
    if (!selectionPopover) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        selectionPopoverRef.current?.contains(event.target as Node | null)
      ) {
        return;
      }
      setSelectionPopover(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectionPopover(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectionPopover]);

  const removeRange = useCallback(
    (range: LineRange) => {
      setCommentFormLineRanges((prev) =>
        prev.filter((r) => lineRangeKey(r) !== lineRangeKey(range)),
      );
      onCommentFormClose?.(range);
    },
    [onCommentFormClose],
  );

  const hasCommentSupport =
    !!onAddComment && (!!CommentForm || !!renderCommentForm);
  const hasReviewSupport = !!onAddReviewComment;

  const handleAddCommentForRange = useCallback(
    (range: LineRange, content: string) => {
      if (!onAddComment) return;
      if (range.side === 'old') return;
      onAddComment({
        filePath: file.path,
        line: range.start,
        lineEnd: range.end !== range.start ? range.end : undefined,
        content,
      });
      removeRange(range);
    },
    [file.path, onAddComment, removeRange],
  );

  const handleAddCommentClick = useCallback(
    (lineRange: LineRange) => {
      setSelectionPopover(null);
      // Toggle: close if clicking same range
      const existing = commentFormLineRanges.find(
        (r) => lineRangeKey(r) === lineRangeKey(lineRange),
      );
      if (existing) {
        removeRange(lineRange);
      } else {
        const retainedRanges = shouldKeepCommentFormRangeOnOpen
          ? commentFormLineRanges.filter((range) =>
              shouldKeepCommentFormRangeOnOpen(range),
            )
          : commentFormLineRanges;

        setCommentFormLineRanges([...retainedRanges, lineRange]);

        if (shouldKeepCommentFormRangeOnOpen) {
          for (const range of commentFormLineRanges) {
            if (!shouldKeepCommentFormRangeOnOpen(range)) {
              onCommentFormClose?.(range);
            }
          }
        }
      }
    },
    [
      commentFormLineRanges,
      onCommentFormClose,
      removeRange,
      shouldKeepCommentFormRangeOnOpen,
    ],
  );

  const handleAskAgentClick = useCallback((range: LineRange) => {
    setSelectionPopover(null);
    setAskAgentFormLineRange((current) =>
      current && lineRangeKey(current) === lineRangeKey(range) ? null : range,
    );
  }, []);

  const handleLineRangeSelection = useCallback(
    (lineRange: LineRange, position: LineRangeSelectionPosition) => {
      if (lineRange.side !== 'old' && (hasReviewSupport || hasCommentSupport)) {
        handleAddCommentClick(lineRange);
        return;
      }
      if (onAskAgent && lineRange.side === 'old') {
        handleAskAgentClick(lineRange);
        return;
      }
      if (!onAskAgent) return;
      setSelectionPopover({
        range: lineRange,
        x: position.clientX,
        y: position.clientY,
      });
    },
    [
      handleAddCommentClick,
      handleAskAgentClick,
      hasCommentSupport,
      hasReviewSupport,
      onAskAgent,
    ],
  );

  const handleAskAgentSubmit = useCallback(
    async (range: LineRange, question: string) => {
      if (!onAskAgent) return;
      await onAskAgent({
        filePath: file.path,
        lineStart: range.start,
        lineEnd: range.end !== range.start ? range.end : undefined,
        side: range.side,
        selectedText:
          getSelectedTextForRange(
            file.status === 'deleted' || range.side === 'old'
              ? oldContent
              : newContent,
            range.start,
            range.end !== range.start ? range.end : undefined,
          ) ?? '',
        question,
      });
      setSelectionPopover(null);
      setAskAgentFormLineRange(null);
    },
    [file.path, file.status, newContent, oldContent, onAskAgent],
  );

  const handleAskAgentFromComment = useCallback(
    async (range: LineRange, question: string) => {
      await handleAskAgentSubmit(range, question);
      removeRange(range);
    },
    [handleAskAgentSubmit, removeRange],
  );

  // Filter threads for this file (only those with line numbers)
  const fileThreads = useMemo(
    () => threads?.filter((t) => t.line !== undefined) ?? [],
    [threads],
  );

  const isSvg = isSvgPath(file.path);
  const {
    containerRef: svgPreviewContainerRef,
    isDragging: isSvgPreviewDragging,
    handleMouseDown: handleSvgPreviewResizeMouseDown,
  } = useHorizontalResize({
    initialWidth: svgPreviewWidth,
    minWidth: SVG_PREVIEW_MIN_WIDTH,
    maxWidth: SVG_PREVIEW_MAX_WIDTH,
    direction: 'left',
    onWidthChange: setSvgPreviewWidth,
  });

  // Get annotation inline comments using the hook
  const { inlineComments: annotationComments } = useAnnotationsAsInlineComments(
    {
      annotations: annotations ?? [],
      filePath: file.path,
    },
  );

  // Check if file has annotations for the header badge
  const hasAnnotations = fileHasAnnotations(annotations ?? [], file.path);

  // Convert threads to inline comments for DiffView
  const threadComments: InlineComment[] = useMemo(() => {
    return fileThreads.map((thread) => ({
      id: `thread-${thread.id}`,
      line: thread.line!,
      content: renderThread ? (
        renderThread(thread)
      ) : (
        <div className="flex flex-col gap-2">
          {thread.comments.map((comment, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-ink-2 shrink-0 text-xs font-medium">
                {comment.author}:
              </span>
              <div className="text-ink-1 min-w-0 flex-1 text-xs">
                <MarkdownContent content={comment.content} />
              </div>
            </div>
          ))}
        </div>
      ),
    }));
  }, [fileThreads, renderThread]);

  // Convert review comments to inline comments for DiffView
  const reviewInlineComments: InlineComment[] = useMemo(() => {
    if (!reviewComments || reviewComments.length === 0)
      return EMPTY_INLINE_COMMENTS;
    return reviewComments.map((rc) => ({
      id: `review-${rc.id}`,
      // Anchor to the end line (or start if single-line) so thread appears after the range
      line: rc.anchor.lineEnd ?? rc.anchor.lineStart,
      content: (
        <ReviewCommentThread
          comment={rc}
          showStatus={showReviewStatus ?? false}
          onResolve={onResolveReviewComment}
          onDelete={onDeleteReviewComment}
          onEdit={onEditReviewComment}
        />
      ),
    }));
  }, [
    reviewComments,
    showReviewStatus,
    onResolveReviewComment,
    onDeleteReviewComment,
    onEditReviewComment,
  ]);

  const prReviewChatInlineComments: InlineComment[] = useMemo(() => {
    if (!prReviewChatCards || prReviewChatCards.length === 0) {
      return EMPTY_INLINE_COMMENTS;
    }

    return prReviewChatCards.map((card) => ({
      id: `pr-review-chat-${card.id}`,
      line: card.line,
      side: card.side,
      content: card.content,
    }));
  }, [prReviewChatCards]);

  // Merge thread comments, annotation comments, review comments, and PR review chats
  const inlineComments: InlineComment[] = useMemo(() => {
    return [
      ...threadComments,
      ...annotationComments,
      ...reviewInlineComments,
      ...prReviewChatInlineComments,
    ];
  }, [
    threadComments,
    annotationComments,
    reviewInlineComments,
    prReviewChatInlineComments,
  ]);

  // Build set of all lines covered by any comment anchor range
  const commentedLines = useMemo(() => {
    const set = new Set<string>();
    // From inline comments (thread + annotation) — single line each
    for (const c of threadComments) set.add(lineAnchorKey(c.side, c.line));
    for (const c of annotationComments) set.add(lineAnchorKey(c.side, c.line));
    // From review comments — full lineStart..lineEnd range
    if (reviewComments) {
      for (const rc of reviewComments) {
        const end = rc.anchor.lineEnd ?? rc.anchor.lineStart;
        for (let l = rc.anchor.lineStart; l <= end; l++) {
          set.add(lineAnchorKey('new', l));
        }
      }
    }
    if (prReviewChatCards) {
      for (const card of prReviewChatCards) {
        const end = card.lineEnd ?? card.lineStart;
        for (let l = card.lineStart; l <= end; l++) {
          set.add(lineAnchorKey(card.side, l));
        }
      }
    }
    return set;
  }, [threadComments, annotationComments, reviewComments, prReviewChatCards]);

  // Handle review comment submission for a specific range
  const handleAddReviewCommentForRange = useCallback(
    (
      range: LineRange,
      body: string,
      presets: ReviewPresetId[],
      images: PromptImagePart[],
    ) => {
      if (!onAddReviewComment) return;
      if (range.side === 'old') return;
      onAddReviewComment({
        filePath: file.path,
        lineStart: range.start,
        lineEnd: range.end !== range.start ? range.end : undefined,
        selectedText: getSelectedTextForRange(
          file.status === 'deleted' ? oldContent : newContent,
          range.start,
          range.end !== range.start ? range.end : undefined,
        ),
        body,
        presets,
        images: images.length > 0 ? images : undefined,
      });
      removeRange(range);
    },
    [
      file.path,
      file.status,
      oldContent,
      newContent,
      onAddReviewComment,
      removeRange,
    ],
  );

  const handleAddReviewCommentAsPrCommentForRange = useCallback(
    async (range: LineRange, body: string, images: PromptImagePart[]) => {
      if (!onAddReviewCommentAsPrComment) return;
      if (range.side === 'old') return;
      await onAddReviewCommentAsPrComment({
        filePath: file.path,
        line: range.start,
        lineEnd: range.end !== range.start ? range.end : undefined,
        body,
        images,
      });
      onReviewCommentDraftBodyChange?.(
        '',
        range.start,
        range.end !== range.start ? range.end : undefined,
      );
      removeRange(range);
    },
    [
      file.path,
      onAddReviewCommentAsPrComment,
      onReviewCommentDraftBodyChange,
      removeRange,
    ],
  );

  // Build comment form entries for all open ranges
  const commentFormEntries: CommentFormEntry[] = useMemo(() => {
    if (commentFormLineRanges.length === 0 && !askAgentFormLineRange) return [];

    const entries: CommentFormEntry[] = [];
    for (const range of commentFormLineRanges) {
      const lineEnd = range.end !== range.start ? range.end : undefined;

      if (hasReviewSupport) {
        entries.push({
          lineRange: range,
          form: (
            <ReviewCommentComposer
              lineStart={range.start}
              lineEnd={lineEnd}
              onSubmit={(body, presets, images) =>
                handleAddReviewCommentForRange(range, body, presets, images)
              }
              onCancel={() => removeRange(range)}
              initialBody={getReviewCommentDraftBody?.(range.start, lineEnd)}
              onBodyChange={(body) =>
                onReviewCommentDraftBodyChange?.(body, range.start, lineEnd)
              }
              onSubmitAsPrComment={
                onAddReviewCommentAsPrComment
                  ? (body, images) =>
                      handleAddReviewCommentAsPrCommentForRange(
                        range,
                        body,
                        images,
                      )
                  : undefined
              }
              onAskAgent={
                onAskAgent
                  ? (question) => handleAskAgentFromComment(range, question)
                  : undefined
              }
            />
          ),
        });
      } else if (hasCommentSupport && (CommentForm || renderCommentForm)) {
        const props = {
          onSubmit: (content: string) =>
            handleAddCommentForRange(range, content),
          onCancel: () => removeRange(range),
          lineStart: range.start,
          lineEnd,
          isSubmitting: isAddingComment,
          placeholder: 'Write a comment...',
          onAskAgent: onAskAgent
            ? (question: string) => handleAskAgentFromComment(range, question)
            : undefined,
        };
        if (renderCommentForm) {
          entries.push({
            lineRange: range,
            form: renderCommentForm(props),
          });
        } else if (CommentForm) {
          entries.push({
            lineRange: range,
            form: <CommentForm {...props} />,
          });
        }
      }
    }
    if (askAgentFormLineRange && onAskAgent) {
      const lineEnd =
        askAgentFormLineRange.end !== askAgentFormLineRange.start
          ? askAgentFormLineRange.end
          : undefined;
      entries.push({
        lineRange: askAgentFormLineRange,
        form: (
          <AskAgentComposer
            lineStart={askAgentFormLineRange.start}
            lineEnd={lineEnd}
            onSubmit={(question) =>
              handleAskAgentSubmit(askAgentFormLineRange, question)
            }
            onCancel={() => setAskAgentFormLineRange(null)}
          />
        ),
      });
    }
    return entries;
  }, [
    askAgentFormLineRange,
    commentFormLineRanges,
    hasReviewSupport,
    hasCommentSupport,
    CommentForm,
    renderCommentForm,
    handleAddCommentForRange,
    handleAddReviewCommentForRange,
    handleAddReviewCommentAsPrCommentForRange,
    handleAskAgentFromComment,
    handleAskAgentSubmit,
    getReviewCommentDraftBody,
    onAddReviewCommentAsPrComment,
    onAskAgent,
    onReviewCommentDraftBodyChange,
    removeRange,
    isAddingComment,
  ]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-ink-3 h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (isBinary) {
    // Show image preview if we have image data
    if (oldImageDataUrl || newImageDataUrl) {
      return (
        <div className="flex h-full flex-col overflow-hidden">
          <FileDiffHeader file={file} className={headerClassName} />
          <div className="flex min-h-0 flex-1 items-center justify-center gap-6 overflow-auto p-6">
            {oldImageDataUrl && newImageDataUrl ? (
              // Modified image: show old → new side by side
              <>
                <div className="flex flex-col items-center gap-2">
                  <span className="text-ink-3 text-xs font-medium tracking-wide uppercase">
                    Before
                  </span>
                  <div
                    className="border-red-6 overflow-hidden rounded-md border"
                    style={TRANSPARENCY_GRID_STYLE}
                  >
                    <img
                      src={oldImageDataUrl}
                      alt="Before"
                      className="max-h-[60vh] max-w-[40vw] object-contain"
                    />
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <span className="text-ink-3 text-xs font-medium tracking-wide uppercase">
                    After
                  </span>
                  <div
                    className="border-green-6 overflow-hidden rounded-md border"
                    style={TRANSPARENCY_GRID_STYLE}
                  >
                    <img
                      src={newImageDataUrl}
                      alt="After"
                      className="max-h-[60vh] max-w-[40vw] object-contain"
                    />
                  </div>
                </div>
              </>
            ) : (
              // Added or deleted image: show single image
              <div className="flex flex-col items-center gap-2">
                <span className="text-ink-3 text-xs font-medium tracking-wide uppercase">
                  {file.status === 'unchanged'
                    ? 'Preview'
                    : newImageDataUrl
                      ? 'Added'
                      : 'Deleted'}
                </span>
                <div
                  className={`overflow-hidden rounded-md border ${file.status === 'unchanged' ? 'border-line' : newImageDataUrl ? 'border-green-6' : 'border-red-6'}`}
                  style={TRANSPARENCY_GRID_STYLE}
                >
                  <img
                    src={(newImageDataUrl ?? oldImageDataUrl)!}
                    alt={
                      file.status === 'unchanged'
                        ? 'Preview'
                        : newImageDataUrl
                          ? 'Added'
                          : 'Deleted'
                    }
                    className="max-h-[70vh] max-w-[60vw] object-contain"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="text-ink-3 flex h-full flex-col items-center justify-center gap-2">
        <p>Binary file changed</p>
        <p className="text-xs">{file.path}</p>
      </div>
    );
  }

  if (isSvg) {
    const previewContent = file.status === 'deleted' ? oldContent : newContent;
    const previewDataUrl = previewContent
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewContent)}`
      : null;

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <FileDiffHeader
          file={file}
          className={headerClassName}
          commentCount={
            fileThreads.length +
            (reviewComments?.length ?? 0) +
            (prReviewChatCards?.length ?? 0)
          }
          hasAnnotations={hasAnnotations}
        />
        <div
          ref={svgPreviewContainerRef}
          className={`flex min-h-0 flex-1 ${isSvgPreviewDragging ? 'select-none' : ''}`}
        >
          <div className="min-w-0 flex-1 overflow-hidden">
            <DiffView
              filePath={file.path}
              oldString={oldContent}
              newString={newContent}
              withMinimap
              onAddCommentClick={
                hasReviewSupport || hasCommentSupport || onAskAgent
                  ? handleLineRangeSelection
                  : undefined
              }
              inlineComments={inlineComments}
              commentedLines={commentedLines}
              commentForms={commentFormEntries}
              scrollToLine={scrollToLine}
            />
            {selectionPopover && (
              <LineSelectionActionPopover
                popoverRef={selectionPopoverRef}
                range={selectionPopover.range}
                x={selectionPopover.x}
                y={selectionPopover.y}
                showComment={
                  selectionPopover.range.side !== 'old' &&
                  (hasReviewSupport || hasCommentSupport)
                }
                showAskAgent={!!onAskAgent}
                onComment={handleAddCommentClick}
                onAskAgent={handleAskAgentClick}
              />
            )}
          </div>
          <div
            onMouseDown={handleSvgPreviewResizeMouseDown}
            className="hover:bg-acc/30 w-1 shrink-0 cursor-col-resize border-l border-[var(--line)]"
          />
          <div
            className="bg-bg-0/80 shrink-0 p-3"
            style={{ width: svgPreviewWidth }}
          >
            <div className="flex flex-col gap-2">
              <div className="text-ink-3 font-mono text-[10px] tracking-wide uppercase">
                SVG Preview
              </div>
              <div
                className="border-line flex aspect-square items-center justify-center overflow-hidden rounded-md border p-3"
                style={TRANSPARENCY_GRID_STYLE}
              >
                {previewDataUrl ? (
                  <img
                    src={previewDataUrl}
                    alt="SVG preview"
                    className="max-h-full max-w-full"
                  />
                ) : (
                  <span className="text-ink-4 text-xs">No preview</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* File header */}
      <FileDiffHeader
        file={file}
        className={headerClassName}
        commentCount={
          fileThreads.length +
          (reviewComments?.length ?? 0) +
          (prReviewChatCards?.length ?? 0)
        }
        hasAnnotations={hasAnnotations}
      />

      {/* Diff view with inline comments */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <DiffView
          filePath={file.path}
          oldString={oldContent}
          newString={newContent}
          withMinimap
          onAddCommentClick={
            hasReviewSupport || hasCommentSupport || onAskAgent
              ? handleLineRangeSelection
              : undefined
          }
          inlineComments={inlineComments}
          commentedLines={commentedLines}
          commentForms={commentFormEntries}
          scrollToLine={scrollToLine}
        />
        {selectionPopover && (
          <LineSelectionActionPopover
            popoverRef={selectionPopoverRef}
            range={selectionPopover.range}
            x={selectionPopover.x}
            y={selectionPopover.y}
            showComment={
              selectionPopover.range.side !== 'old' &&
              (hasReviewSupport || hasCommentSupport)
            }
            showAskAgent={!!onAskAgent}
            onComment={handleAddCommentClick}
            onAskAgent={handleAskAgentClick}
          />
        )}
      </div>
    </div>
  );
}

function AskAgentComposer({
  lineStart,
  lineEnd,
  onSubmit,
  onCancel,
}: {
  lineStart: number;
  lineEnd?: number;
  onSubmit: (question: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    void Promise.resolve(onSubmit(trimmedQuestion))
      .catch((submitError: unknown) => {
        setError(
          submitError instanceof Error
            ? submitError.message
            : 'Failed to ask agent. Please try again.',
        );
      })
      .finally(() => setIsSubmitting(false));
  };

  return (
    <form
      className="border-stroke-1 bg-bg-1/95 flex flex-col gap-2 rounded-lg border p-3 shadow-sm"
      onSubmit={handleSubmit}
    >
      <div className="flex items-center gap-2">
        <Bot className="text-acc h-4 w-4" aria-hidden />
        <span className="text-ink-1 text-sm font-semibold">Ask Agent</span>
        <span className="text-ink-4 text-xs">
          L{lineStart}
          {lineEnd ? `-L${lineEnd}` : ''}
        </span>
      </div>
      <Textarea
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder="Ask agent about these lines..."
        aria-label="Ask agent about selected lines"
        rows={3}
        disabled={isSubmitting}
        className="min-h-[72px] text-sm"
      />
      <div className="flex items-center justify-end gap-2">
        {error ? (
          <span className="mr-auto text-xs text-red-300" role="alert">
            {error}
          </span>
        ) : null}
        <button
          type="button"
          className="text-ink-3 hover:text-ink-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="bg-acc text-acc-ink hover:bg-acc/90 disabled:bg-acc/50 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed"
          disabled={!question.trim() || isSubmitting}
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Send className="h-3.5 w-3.5" aria-hidden />
          )}
          {isSubmitting ? 'Asking...' : 'Ask Agent'}
        </button>
      </div>
    </form>
  );
}

function LineSelectionActionPopover({
  popoverRef,
  range,
  x,
  y,
  showComment,
  showAskAgent,
  onComment,
  onAskAgent,
}: {
  popoverRef: RefObject<HTMLDivElement | null>;
  range: LineRange;
  x: number;
  y: number;
  showComment: boolean;
  showAskAgent: boolean;
  onComment: (range: LineRange) => void;
  onAskAgent: (range: LineRange) => void;
}) {
  return (
    <div
      ref={popoverRef}
      className="border-glass-border bg-bg-1 fixed z-50 flex overflow-hidden rounded-lg border p-1 shadow-[0_12px_32px_oklch(0_0_0_/_0.35)]"
      style={{
        left: x,
        top: y + SELECTION_POPOVER_OFFSET,
      }}
      role="menu"
      aria-label="Line selection actions"
    >
      {showComment && (
        <button
          type="button"
          className="text-ink-2 hover:bg-glass-medium hover:text-ink-0 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
          onClick={() => onComment(range)}
          role="menuitem"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
          Comment
        </button>
      )}
      {showAskAgent && (
        <button
          type="button"
          className="text-ink-2 hover:bg-glass-medium hover:text-ink-0 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
          onClick={() => onAskAgent(range)}
          role="menuitem"
        >
          <Bot className="h-3.5 w-3.5" aria-hidden />
          Ask Agent
        </button>
      )}
    </div>
  );
}
