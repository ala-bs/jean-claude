import { ChevronDown, ChevronRight, MessageSquarePlus } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import clsx from 'clsx';
import type { ThemedToken } from 'shiki';



import { computeCurrentStateLines, type DiffLine } from './diff-utils';
import {
  type LineRangeSelectionPosition,
  useLineRangeSelection,
} from './use-line-range-selection';
import {
  renderTokensWithHighlights,
  renderWithHighlights,
} from './utils-search-highlight';
import type { SearchMatch } from './use-diff-search';


import type {
  CodeFoldingState,
  CommentedLines,
  CommentFormEntry,
  InlineComment,
  LineRange,
} from './index';
import { lineAnchorKey, lineRangeKey } from './index';

const EMPTY_SEARCH_MATCHES: SearchMatch[] = [];
type CurrentStateDisplayLine = {
  lineNumber: number;
  content: string;
  isChanged: boolean;
  side: 'old' | 'new';
};

export function CurrentStateTable({
  oldString,
  newString,
  diffLines,
  newTokens,
  onAddCommentClick,
  inlineComments,
  commentedLines,
  commentForms,
  searchMatches,
  currentMatchIndex,
  folding,
}: {
  oldString: string;
  newString: string;
  diffLines: DiffLine[];
  newTokens: ThemedToken[][];
  onAddCommentClick?: (
    lineRange: LineRange,
    position: LineRangeSelectionPosition,
  ) => void;
  inlineComments?: InlineComment[];
  commentedLines?: CommentedLines;
  commentForms?: CommentFormEntry[];
  searchMatches: SearchMatch[];
  currentMatchIndex: number;
  folding: CodeFoldingState;
}) {
  const lineRangeSelection = useLineRangeSelection({ onAddCommentClick });

  const lines = useMemo<CurrentStateDisplayLine[]>(() => {
    const currentLines = computeCurrentStateLines(oldString, newString).map(
      (line) => ({ ...line, side: 'new' as const }),
    );
    if (currentLines.length > 0) return currentLines;

    return diffLines
      .filter((line) => line.type === 'deletion' && line.oldLineNumber !== undefined)
      .map((line) => ({
        lineNumber: line.oldLineNumber!,
        content: line.content,
        isChanged: true,
        side: 'old' as const,
      }));
  }, [diffLines, oldString, newString]);

  // Build reverse map: newLineNumber → DiffLine indices (for search match mapping)
  const newLineToMatchIndices = useMemo(() => {
    const map = new Map<number, number[]>();
    diffLines.forEach((line, idx) => {
      if (line.newLineNumber !== undefined) {
        const existing = map.get(line.newLineNumber);
        if (existing) {
          existing.push(idx);
        } else {
          map.set(line.newLineNumber, [idx]);
        }
      }
    });
    return map;
  }, [diffLines]);

  // Group search matches by their DiffLine index for fast lookup
  const matchesByDiffLineIndex = useMemo(() => {
    const map = new Map<number, SearchMatch[]>();
    for (const match of searchMatches) {
      const existing = map.get(match.lineIndex);
      if (existing) {
        existing.push(match);
      } else {
        map.set(match.lineIndex, [match]);
      }
    }
    return map;
  }, [searchMatches]);

  const currentMatch = searchMatches[currentMatchIndex] ?? null;

  const inlineCommentsByLine = useMemo(() => {
    const map = new Map<string, InlineComment[]>();
    for (const comment of inlineComments ?? []) {
      const key = `${comment.side ?? 'new'}:${comment.line}`;
      const comments = map.get(key);
      if (comments) {
        comments.push(comment);
      } else {
        map.set(key, [comment]);
      }
    }
    return map;
  }, [inlineComments]);

  const commentFormsByEndLine = useMemo(() => {
    const map = new Map<string, CommentFormEntry[]>();
    for (const form of commentForms ?? []) {
      const key = `${form.lineRange.side ?? 'new'}:${form.lineRange.end}`;
      const forms = map.get(key);
      if (forms) {
        forms.push(form);
      } else {
        map.set(key, [form]);
      }
    }
    return map;
  }, [commentForms]);

  const isLineInCommentRange = useCallback(
    (lineNumber: number) => {
      if (!commentForms || commentForms.length === 0) return false;
      return commentForms.some(
        (cf) =>
          lineNumber >= cf.lineRange.start && lineNumber <= cf.lineRange.end,
      );
    },
    [commentForms],
  );

  return (
    <table
      className="w-full border-collapse"
      onMouseDown={lineRangeSelection.onMouseDown}
      onMouseOver={lineRangeSelection.onMouseOver}
      onMouseUp={lineRangeSelection.onMouseUp}
      onMouseLeave={lineRangeSelection.onMouseLeave}
    >
      <tbody>
        {lines.map((line, i) => {
          const lineNumber = line.lineNumber;

          // Check if this line is hidden by a collapsed fold
          if (folding.isLineHidden(lineNumber)) {
            return null;
          }

          const tokenLineIndex = line.lineNumber - 1;
          const tokens = line.side === 'new' ? newTokens[tokenLineIndex] || [] : [];

          // Map search matches: find DiffLine indices for this newLineNumber,
          // then collect all search matches referencing those DiffLine indices
          const diffIndices = newLineToMatchIndices.get(line.lineNumber) ?? [];
          let lineMatches: SearchMatch[] = EMPTY_SEARCH_MATCHES;
          for (const diffIdx of diffIndices) {
            const matches = matchesByDiffLineIndex.get(diffIdx);
            if (matches) {
              lineMatches =
                lineMatches === EMPTY_SEARCH_MATCHES
                  ? matches
                  : [...lineMatches, ...matches];
            }
          }

          const canSelect = !!onAddCommentClick;
          const canComment = canSelect && line.side === 'new';
          const isInCommentRange = isLineInCommentRange(lineNumber);

          const lineComments = inlineCommentsByLine.get(
            `${line.side}:${lineNumber}`,
          );

          const formsForLine = commentFormsByEndLine.get(
            `${line.side}:${lineNumber}`,
          );

          // Code folding state
          const isFoldable = folding.isFoldStart(lineNumber);
          const isFoldCollapsed = folding.isFoldCollapsed(lineNumber);
          const foldRange = folding.getFoldRange(lineNumber);

          return (
            <CurrentStateRow
              key={i}
              lineIndex={i}
              lineNumber={lineNumber}
              side={line.side}
              content={line.content}
              tokens={tokens}
              searchMatches={lineMatches}
              currentMatch={
                currentMatch && lineMatches.includes(currentMatch)
                  ? currentMatch
                  : null
              }
              isChanged={line.isChanged}
              canComment={canComment}
              canSelect={canSelect}
              isInCommentRange={isInCommentRange}
              hasComment={!!commentedLines?.has(lineAnchorKey(line.side, lineNumber))}
              inlineComments={lineComments}
              commentForms={formsForLine}
              isFoldable={isFoldable}
              isFoldCollapsed={isFoldCollapsed}
              foldRange={foldRange}
              onToggleFold={folding.toggleFold}
            />
          );
        })}
      </tbody>
    </table>
  );
}

const CurrentStateRow = memo(function CurrentStateRow({
  lineIndex,
  lineNumber,
  side,
  content,
  tokens,
  searchMatches,
  currentMatch,
  isChanged,
  canComment,
  canSelect,
  isInCommentRange,
  hasComment,
  inlineComments,
  commentForms,
  isFoldable,
  isFoldCollapsed,
  foldRange,
  onToggleFold,
}: {
  lineIndex: number;
  lineNumber: number;
  side: 'old' | 'new';
  content: string;
  tokens: ThemedToken[];
  searchMatches: SearchMatch[];
  currentMatch: SearchMatch | null;
  isChanged: boolean;
  canComment: boolean;
  canSelect: boolean;
  isInCommentRange: boolean;
  hasComment: boolean;
  inlineComments?: InlineComment[];
  commentForms?: CommentFormEntry[];
  isFoldable?: boolean;
  isFoldCollapsed?: boolean;
  foldRange?: { startLine: number; endLine: number };
  onToggleFold?: (lineNumber: number) => void;
}) {
  const renderedContent =
    tokens.length > 0 ? (
      renderTokensWithHighlights({
        tokens,
        content,
        searchMatches,
        currentMatch,
      })
    ) : searchMatches.length > 0 ? (
      renderWithHighlights({
        text: content,
        searchMatches,
        currentMatch,
      })
    ) : (
      <span className="text-ink-1">{content}</span>
    );

  return (
    <>
      <tr
        data-line-index={lineIndex}
        data-new-line={side === 'new' ? lineNumber : undefined}
        data-old-line={side === 'old' ? lineNumber : undefined}
        data-line-side={side}
        className={clsx('group', {
          'bg-blue-500/10': isInCommentRange,
          'bg-green-500/15': !isInCommentRange && isChanged,
        })}
        style={{
          cursor: canSelect ? 'pointer' : undefined,
          ...(hasComment && !isInCommentRange
            ? {
                background:
                  'color-mix(in oklch, oklch(0.78 0.18 295) 8%, transparent)',
              }
            : {}),
        }}
      >
        {/* Fold gutter */}
        <td className="w-4 align-top select-none">
          {isFoldable && (
            <button
              className="text-ink-4 hover:text-ink-1 flex h-full w-full items-center justify-center transition-colors"
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFold?.(lineNumber);
              }}
              aria-label={isFoldCollapsed ? 'Expand scope' : 'Collapse scope'}
              aria-expanded={!isFoldCollapsed}
            >
              {isFoldCollapsed ? (
                <ChevronRight className="h-3 w-3" aria-hidden />
              ) : (
                <ChevronDown className="h-3 w-3" aria-hidden />
              )}
            </button>
          )}
        </td>
        {/* Line number */}
        <td
          data-line-side={side}
          className={clsx(
            'relative w-8 pr-1 text-right align-top select-none whitespace-nowrap',
            hasComment && !isInCommentRange
              ? 'text-acc-ink'
              : isChanged
                ? 'text-status-done'
                : 'text-ink-4',
          )}
          style={
            hasComment && !isInCommentRange
              ? { borderLeft: '2px solid oklch(0.78 0.18 295 / 0.5)' }
              : undefined
          }
        >
          <span className={clsx(canComment && 'group-hover:invisible')}>
            {lineNumber}
          </span>
          {canComment && (
            <span className="text-acc-ink absolute inset-0 hidden items-center justify-center group-hover:flex">
              <MessageSquarePlus className="h-3 w-3" aria-hidden />
            </span>
          )}
        </td>
        {/* Change indicator */}
        <td
          data-line-side={side}
          className={clsx(
            'w-4 text-center align-top select-none',
            isChanged ? 'text-status-done' : 'text-ink-4',
          )}
        >
          {isChanged ? '│' : ' '}
        </td>
        {/* Content */}
        <td
          data-line-side={side}
          className={clsx('pr-2 whitespace-pre-wrap', {
            'select-none': canSelect,
          })}
        >
          {renderedContent}
          {isFoldCollapsed && foldRange && (
            <span
              className="text-ink-4 bg-bg-2 ml-2 inline-block cursor-pointer rounded px-1.5 py-0 text-[10px] leading-4"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFold?.(lineNumber);
              }}
            >
              {foldRange.endLine - foldRange.startLine} lines
            </span>
          )}
        </td>
      </tr>

      {/* Inline comments for this line */}
      {inlineComments && inlineComments.length > 0 && (
        <tr>
          <td colSpan={4} className="p-0">
            <div>
              {inlineComments.map((comment, ci) => (
                <div key={comment.id ?? ci}>{comment.content}</div>
              ))}
            </div>
          </td>
        </tr>
      )}

      {/* Comment forms for this line */}
      {commentForms &&
        commentForms.length > 0 &&
        commentForms.map((cf) => (
          <tr key={`form-${lineRangeKey(cf.lineRange)}`}>
            <td colSpan={4} className="p-0">
              {cf.form}
            </td>
          </tr>
        ))}
    </>
  );
});
