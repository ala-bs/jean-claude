import { MessageSquare, MessageSquarePlus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';


import {
  COMMENT_ACCENT,
  InlineCommentComposer,
} from '@/features/common/ui-inline-comments';
import {
  useReviewComments,
  useReviewCommentsStore,
} from '@/stores/review-comments';
import type { PromptImagePart } from '@shared/agent-backend-types';
import { useReviewContext } from '@/common/context/review-context';
import {
  COMMENTABLE_CONTENT_ATTRIBUTE,
  CommentableTargetProvider,
  type CommentableTargetValue,
} from '@/common/context/commentable-target';



import { MarkdownContent } from '../../ui-markdown-content';

// ---------------------------------------------------------------------------
// Text offset utilities — map between character offsets and DOM Ranges
// ---------------------------------------------------------------------------

interface TextNodeEntry {
  node: Text;
  start: number;
  end: number;
}

/** Walk all text nodes in a container and build a combined-text offset map. */
function buildTextNodeMap(container: Node): {
  combined: string;
  nodeMap: TextNodeEntry[];
} {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodeMap: TextNodeEntry[] = [];
  let combined = '';
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const start = combined.length;
    combined += node.textContent ?? '';
    nodeMap.push({ node, start, end: combined.length });
  }
  return { combined, nodeMap };
}

/**
 * Length of a Range within the container's combined text.
 *
 * NOT the same as `Selection.toString().length`: the browser inserts separators
 * (tabs between table cells, newlines between blocks) into a Selection's string
 * that do not exist in the concatenated text nodes. Using the string length to
 * size a highlight makes it overshoot by one character per crossed boundary.
 */
function getRangeCharLength(container: Node, range: Range): number {
  const { nodeMap } = buildTextNodeMap(container);
  let length = 0;
  for (const nm of nodeMap) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(nm.node);
    // Overlap of this text node with the selection.
    const startsAfter =
      range.compareBoundaryPoints(Range.END_TO_START, nodeRange) >= 0;
    const endsBefore =
      range.compareBoundaryPoints(Range.START_TO_END, nodeRange) <= 0;
    if (startsAfter || endsBefore) continue;

    const nodeLength = nm.end - nm.start;
    const from = nm.node === range.startContainer ? range.startOffset : 0;
    const to = nm.node === range.endContainer ? range.endOffset : nodeLength;
    length += Math.max(0, to - from);
  }
  return length;
}

/** Compute the character offset of a Range's start within a container's text. */
function getRangeCharOffset(container: Node, range: Range): number {
  const { nodeMap } = buildTextNodeMap(container);
  for (const nm of nodeMap) {
    if (nm.node === range.startContainer) {
      return nm.start + range.startOffset;
    }
    // If startContainer is an element, the offset refers to child index
    if (
      range.startOffset < range.startContainer.childNodes.length &&
      range.startContainer.childNodes[range.startOffset] === nm.node
    ) {
      return nm.start;
    }
  }
  return -1;
}

/** Create a Range from a character offset + length within a container's text. */
function createRangeFromOffset(
  container: Node,
  charOffset: number,
  length: number,
): Range | null {
  if (charOffset < 0 || length <= 0) return null;

  const { nodeMap } = buildTextNodeMap(container);
  const matchEnd = charOffset + length;
  const range = document.createRange();
  let foundStart = false;
  let foundEnd = false;

  for (const nm of nodeMap) {
    if (!foundStart && nm.start <= charOffset && nm.end > charOffset) {
      range.setStart(nm.node, charOffset - nm.start);
      foundStart = true;
    }
    if (!foundEnd && nm.start < matchEnd && nm.end >= matchEnd) {
      range.setEnd(nm.node, matchEnd - nm.start);
      foundEnd = true;
    }
    if (foundStart && foundEnd) break;
  }

  return foundStart && foundEnd ? range : null;
}

/**
 * Compare DOM text against a stored selection ignoring whitespace, since
 * `Range.toString()` concatenates raw text nodes while the stored string came
 * from `Selection.toString()`, which adds cell/block separators.
 */
function textMatchesLoosely(a: string, b: string): boolean {
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

// Register the CSS highlight style once
const HIGHLIGHT_NAME = 'commentable-highlight';
let styleInjected = false;
function ensureHighlightStyle() {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: oklch(0.78 0.18 295 / 0.3); border-radius: 2px; }`;
  document.head.appendChild(style);
  styleInjected = true;
}

/**
 * `CSS.highlights` is a global registry keyed by name, so several mounted
 * wrappers (a message in the stream plus the same content re-rendered in a
 * modal) would otherwise overwrite — and on unmount delete — each other's
 * ranges. Each instance publishes under its own id and the union is set.
 */
const highlightRanges = new Map<string, Range[]>();
function publishHighlightRanges(instanceId: string, ranges: Range[]) {
  if (ranges.length > 0) {
    highlightRanges.set(instanceId, ranges);
  } else {
    highlightRanges.delete(instanceId);
  }

  if (!CSS.highlights) return;

  const all = Array.from(highlightRanges.values()).flat();
  if (all.length > 0) {
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...all));
  } else {
    CSS.highlights.delete(HIGHLIGHT_NAME);
  }
}

// ---------------------------------------------------------------------------
// CommentableWrapper — generic text-selection comment layer
// ---------------------------------------------------------------------------

/**
 * Wraps any children and enables text-selection-based commenting.
 * Select text → floating "Comment" button → inline composer → review pill.
 *
 * The selection stays highlighted while the composer is open, and the
 * composer floats directly below the selected text. Commented text ranges
 * are visually highlighted in the rendered content using precise character
 * offsets stored at comment-creation time.
 */
export function CommentableWrapper({
  entryId,
  taskId,
  children,
  charOffsetBase,
}: {
  entryId: string;
  taskId: string;
  children: ReactNode;
  /**
   * Offset of this container's text within the full message, for wrappers that
   * only cover a fragment of it (see `CommentableTargetValue`). Defaults to 0.
   */
  charOffsetBase?: () => number;
}) {
  const reviewContext = useReviewContext();
  const instanceId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [selectedCharOffset, setSelectedCharOffset] = useState<number>(-1);
  const [selectedCharLength, setSelectedCharLength] = useState<number>(-1);
  const [floatingPos, setFloatingPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerSelectedText, setComposerSelectedText] = useState('');
  const [composerCharOffset, setComposerCharOffset] = useState(-1);
  const [composerCharLength, setComposerCharLength] = useState(-1);
  const [composerPos, setComposerPos] = useState<{ top: number } | null>(null);
  const [composerIsEmpty, setComposerIsEmpty] = useState(true);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [commentPositions, setCommentPositions] = useState<
    Record<string, { top: number; left: number }>
  >({});
  const updateComment = useReviewCommentsStore((s) => s.updateComment);

  // Get existing comments for this message entry from review store
  const allComments = useReviewComments(taskId);
  const messageFilePath = `__message__:${entryId}`;
  const messageComments = useMemo(
    () => allComments.filter((c) => c.anchor.filePath === messageFilePath),
    [allComments, messageFilePath],
  );

  // Build highlight data from comments with stored offsets
  const highlightSpans = useMemo(
    () =>
      messageComments
        .filter(
          (c) =>
            c.anchor.charOffset != null &&
            c.anchor.charOffset >= 0 &&
            c.anchor.selectedText,
        )
        .map((c) => ({
          offset: c.anchor.charOffset!,
          // charLength is the DOM-accurate span; older comments only have the
          // selection string, which overshoots across cell/block boundaries.
          length: c.anchor.charLength ?? c.anchor.selectedText!.length,
          text: c.anchor.selectedText!,
        })),
    [messageComments],
  );

  const isFragment = charOffsetBase != null;
  const resolveOffsetBase = useCallback(
    () => charOffsetBase?.() ?? 0,
    [charOffsetBase],
  );

  useEffect(() => {
    if (!contentRef.current || highlightSpans.length === 0) {
      publishHighlightRanges(instanceId, []);
      return;
    }

    ensureHighlightStyle();

    const base = resolveOffsetBase();
    const ranges: Range[] = [];
    for (const span of highlightSpans) {
      // Stored offsets are message-relative; this container may only cover a
      // fragment of it. Offsets outside the fragment simply yield no range.
      const range = createRangeFromOffset(
        contentRef.current,
        span.offset - base,
        span.length,
      );
      if (!range) continue;
      // See updateCommentPositions: rebasing can make a foreign anchor land
      // inside the fragment, so verify the text before highlighting it.
      if (isFragment && !textMatchesLoosely(range.toString(), span.text)) {
        continue;
      }
      ranges.push(range);
    }

    publishHighlightRanges(instanceId, ranges);

    return () => publishHighlightRanges(instanceId, []);
  }, [highlightSpans, instanceId, isFragment, resolveOffsetBase]);

  const updateCommentPositions = useCallback(() => {
    if (!contentRef.current || !containerRef.current) {
      setCommentPositions({});
      return;
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const positions: Record<string, { top: number; left: number }> = {};
    const contentRect = contentRef.current.getBoundingClientRect();
    const base = resolveOffsetBase();

    for (const comment of messageComments) {
      const charOffset =
        comment.anchor.charOffset == null
          ? comment.anchor.charOffset
          : comment.anchor.charOffset - base;
      const selectedText = comment.anchor.selectedText;
      if (charOffset == null || charOffset < 0 || !selectedText) {
        // A fragment wrapper only covers part of the message, so an unresolved
        // anchor means "not mine" — pinning it to the corner would duplicate
        // pills that the full-message wrapper already renders.
        if (isFragment) continue;
        positions[comment.id] = {
          top: contentRect.top - containerRect.top,
          left: contentRect.right - containerRect.left + 6,
        };
        continue;
      }

      const range = createRangeFromOffset(
        contentRef.current,
        charOffset,
        comment.anchor.charLength ?? selectedText.length,
      );
      // In fragment mode a resolvable offset is not proof of ownership: an
      // anchor past the fragment can still land inside it after rebasing, so
      // confirm the text matches (ignoring the separators Selection adds).
      if (!range) continue;
      if (isFragment && !textMatchesLoosely(range.toString(), selectedText)) {
        continue;
      }

      const rects = Array.from(range.getClientRects());
      const rect = rects.at(-1) ?? range.getBoundingClientRect();
      positions[comment.id] = {
        top: rect.top - containerRect.top,
        left: rect.right - containerRect.left + 6,
      };
    }

    setCommentPositions(positions);
  }, [messageComments, isFragment, resolveOffsetBase]);

  useLayoutEffect(() => {
    updateCommentPositions();
  }, [updateCommentPositions]);

  useEffect(() => {
    window.addEventListener('resize', updateCommentPositions);
    return () => window.removeEventListener('resize', updateCommentPositions);
  }, [updateCommentPositions]);

  // Detect text selection within the container
  const handleMouseUp = useCallback(() => {
    if (composerOpen) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !containerRef.current) {
      setSelectedText(null);
      setFloatingPos(null);
      return;
    }

    const range = selection.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) {
      setSelectedText(null);
      setFloatingPos(null);
      return;
    }

    const rawText = selection.toString();
    const text = rawText.trim();
    if (!text) {
      setSelectedText(null);
      setFloatingPos(null);
      return;
    }

    // Compute character offset of the selection within the content container,
    // adjusted for leading whitespace that gets trimmed from the stored text.
    const rawOffset = contentRef.current
      ? getRangeCharOffset(contentRef.current, range)
      : -1;
    const leadingWs = rawText.length - rawText.trimStart().length;
    const charOffset =
      rawOffset >= 0 ? rawOffset + leadingWs + resolveOffsetBase() : -1;
    const trailingWs = rawText.length - rawText.trimEnd().length;
    const rawLength = contentRef.current
      ? getRangeCharLength(contentRef.current, range)
      : -1;
    const charLength =
      rawLength >= 0 ? Math.max(0, rawLength - leadingWs - trailingWs) : -1;

    const rect = range.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    setSelectedText(text);
    setSelectedCharOffset(charOffset);
    setSelectedCharLength(charLength);
    setFloatingPos({
      top: rect.bottom - containerRect.top + 4,
      left: rect.right - containerRect.left,
    });
  }, [composerOpen, resolveOffsetBase]);

  // Clear floating button when selection collapses or moves outside
  // but NOT when composer is open (we want to keep the highlight)
  useEffect(() => {
    const handleSelectionChange = () => {
      if (composerOpen) return;
      const selection = window.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        !containerRef.current?.contains(selection.anchorNode as Node | null)
      ) {
        setSelectedText(null);
        setFloatingPos(null);
      }
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', handleSelectionChange);
  }, [composerOpen]);

  const handleOpenComposer = useCallback(() => {
    if (!selectedText || !floatingPos) return;
    setComposerSelectedText(selectedText);
    setComposerCharOffset(selectedCharOffset);
    setComposerCharLength(selectedCharLength);
    setComposerPos({ top: floatingPos.top });
    setComposerIsEmpty(true);
    setComposerOpen(true);
    setSelectedText(null);
    setFloatingPos(null);
  }, [selectedText, selectedCharOffset, selectedCharLength, floatingPos]);

  const handleComposerSubmit = useCallback(
    (body: string, images: PromptImagePart[]) => {
      if (!reviewContext) return;
      reviewContext.addComment({
        kind: 'message',
        stepLabel: '',
        entryId,
        anchorLabel: 'msg',
        selectedText: composerSelectedText || undefined,
        charOffset: composerCharOffset >= 0 ? composerCharOffset : undefined,
        charLength: composerCharLength > 0 ? composerCharLength : undefined,
        body,
        presets: [],
        images: images.length > 0 ? images : undefined,
      });
      setComposerOpen(false);
      setComposerSelectedText('');
      setComposerCharOffset(-1);
    setComposerCharLength(-1);
      setComposerPos(null);
      setComposerIsEmpty(true);
      setActiveCommentId(null);
      window.getSelection()?.removeAllRanges();
    },
    [
      reviewContext,
      entryId,
      composerSelectedText,
      composerCharOffset,
      composerCharLength,
    ],
  );

  const handleComposerCancel = useCallback(() => {
    setComposerOpen(false);
    setComposerSelectedText('');
    setComposerCharOffset(-1);
    setComposerCharLength(-1);
    setComposerPos(null);
    setComposerIsEmpty(true);
    setActiveCommentId(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    if (!composerOpen || !composerIsEmpty) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || composerRef.current?.contains(target)) return;
      handleComposerCancel();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [composerOpen, composerIsEmpty, handleComposerCancel]);

  // Escape should dismiss the composer, not whatever is behind it. When the
  // wrapper lives inside a Modal (the expanded table), the Modal's own
  // document-capture Escape handler would otherwise close the modal and take
  // the in-progress draft with it. Capturing on `window` runs one step earlier
  // in the capture path, so stopPropagation here keeps the event off document.
  useEffect(() => {
    if (!composerOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      handleComposerCancel();
    };

    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [composerOpen, handleComposerCancel]);

  const handleEditComment = useCallback(
    (commentId: string, body: string, images: PromptImagePart[]) => {
      updateComment(taskId, commentId, {
        body,
        images: images.length > 0 ? images : undefined,
      });
    },
    [taskId, updateComment],
  );

  // Lets message fragments re-rendered in a portal (e.g. the table modal) mount
  // their own commentable layer against this same entry. Nested wrappers get a
  // rebased offset so their comments stay message-relative.
  const targetValue = useMemo<CommentableTargetValue>(
    () => ({
      entryId,
      taskId,
      CommentableFragment: ({ children: fragment, charOffsetBase: base }) => (
        <CommentableWrapper
          entryId={entryId}
          taskId={taskId}
          charOffsetBase={base}
        >
          {fragment}
        </CommentableWrapper>
      ),
    }),
    [entryId, taskId],
  );

  const handleRemoveComment = useCallback(
    (commentId: string) => {
      reviewContext?.removeComment(commentId);
      setActiveCommentId(null);
    },
    [reviewContext],
  );

  // No review context — render children as-is
  if (!reviewContext?.enabled) {
    return <>{children}</>;
  }

  return (
    <div className="relative" ref={containerRef}>
      {/* Children with mouse-up listener for selection detection */}
      <div
        ref={contentRef}
        onMouseUp={handleMouseUp}
        {...{ [COMMENTABLE_CONTENT_ATTRIBUTE]: '' }}
      >
        <CommentableTargetProvider value={targetValue}>
          {children}
        </CommentableTargetProvider>
      </div>

      {/* Floating comment button on text selection */}
      {floatingPos && selectedText && (
        <button
          type="button"
          className="absolute z-30 flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium shadow-lg"
          style={{
            top: floatingPos.top,
            left: Math.min(floatingPos.left, 200),
            background: 'oklch(0.22 0.02 295)',
            color: COMMENT_ACCENT.chipText,
            border: `1px solid ${COMMENT_ACCENT.borderStrong}`,
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleOpenComposer}
        >
          <MessageSquarePlus className="h-3 w-3" />
          Comment
        </button>
      )}

      {/* Floating comment composer — positioned near the selection */}
      {composerOpen && composerPos && (
        <div
          ref={composerRef}
          className="absolute right-0 left-0 z-30 rounded-md px-3 py-2.5"
          style={{
            top: composerPos.top,
            background: 'oklch(0.18 0.02 295)',
            border: `1px solid ${COMMENT_ACCENT.borderStrong}`,
          }}
        >
          {composerSelectedText && (
            <div
              className="text-ink-2 mb-2 border-l-2 pl-2 font-mono text-[10px] italic"
              style={{ borderColor: COMMENT_ACCENT.barSoft }}
            >
              <span className="line-clamp-3">{composerSelectedText}</span>
            </div>
          )}
          <InlineCommentComposer
            lineStart={0}
            onSubmit={handleComposerSubmit}
            onCancel={handleComposerCancel}
            onEmptyChange={setComposerIsEmpty}
          />
        </div>
      )}

      {messageComments.map((comment) => {
        const position = commentPositions[comment.id];
        if (!position) return null;
        const isActive = activeCommentId === comment.id;

        return (
          <div key={comment.id}>
            <button
              type="button"
              aria-label="Open comment"
              className="absolute z-10 flex h-5 w-5 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105"
              style={{
                top: position.top,
                left: position.left,
                background: isActive
                  ? COMMENT_ACCENT.chipText
                  : COMMENT_ACCENT.chipBg,
                color: isActive
                  ? 'oklch(0.16 0.02 295)'
                  : COMMENT_ACCENT.chipText,
                border: `1px solid ${COMMENT_ACCENT.borderStrong}`,
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                setActiveCommentId((activeId) =>
                  activeId === comment.id ? null : comment.id,
                )
              }
            >
              <MessageSquare className="h-3 w-3" />
            </button>

            {isActive && (
              <div
                className="absolute right-0 left-0 z-20 rounded-md px-3 py-2.5 shadow-xl"
                style={{
                  top: position.top + 24,
                  background: 'oklch(0.18 0.02 295)',
                  border: `1px solid ${COMMENT_ACCENT.borderStrong}`,
                }}
              >
                {comment.anchor.selectedText && (
                  <div
                    className="text-ink-2 mb-2 border-l-2 pl-2 font-mono text-[10px] italic"
                    style={{ borderColor: COMMENT_ACCENT.barSoft }}
                  >
                    <span className="line-clamp-3">
                      {comment.anchor.selectedText}
                    </span>
                  </div>
                )}
                <InlineCommentComposer
                  lineStart={comment.anchor.lineStart}
                  lineEnd={comment.anchor.lineEnd}
                  initialBody={comment.body}
                  initialImages={comment.images}
                  submitLabel="Save comment"
                  onSubmit={(body, images) => {
                    handleEditComment(comment.id, body, images);
                    setActiveCommentId(null);
                  }}
                  onCancel={() => setActiveCommentId(null)}
                  renderAfterActions={
                    <button
                      type="button"
                      className="text-ink-3 hover:text-danger ml-auto rounded px-2 py-1 text-xs"
                      onClick={() => handleRemoveComment(comment.id)}
                    >
                      Delete
                    </button>
                  }
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentableTextEntry — assistant message with text-selection commenting
// ---------------------------------------------------------------------------

/**
 * Renders an assistant message with full markdown formatting intact.
 * Users can select text to add inline comments via a floating button.
 */
export function CommentableTextEntry({
  text,
  entryId,
  taskId,
  onFilePathClick,
}: {
  text: string;
  entryId: string;
  taskId: string;
  onFilePathClick?: (
    filePath: string,
    lineStart?: number,
    lineEnd?: number,
  ) => void;
}) {
  return (
    <div className="relative pl-6">
      <div className="bg-ink-3 absolute top-2.5 -left-1 h-2 w-2 rounded-full" />
      <div className="py-1.5 pr-3">
        <CommentableWrapper entryId={entryId} taskId={taskId}>
          <div className="text-ink-1 text-xs">
            <MarkdownContent content={text} onFilePathClick={onFilePathClick} />
          </div>
        </CommentableWrapper>
      </div>
    </div>
  );
}
