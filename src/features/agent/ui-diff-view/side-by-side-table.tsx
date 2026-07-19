import { ChevronDown, ChevronRight, MessageSquarePlus } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import clsx from 'clsx';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { ThemedToken } from 'shiki';



import {
  computeDiff,
  computeSideBySideDiff,
  type DiffLine,
  type SideBySideRow,
} from './diff-utils';
import {
  type LineRangeSelectionPosition,
  useLineRangeSelection,
} from './use-line-range-selection';
import {
  renderTokensWithHighlights,
  renderWithHighlights,
} from './utils-search-highlight';
import type { SearchMatch } from './use-diff-search';
import { useDividerResize } from './use-divider-resize';


import type {
  CodeFoldingState,
  CommentedLines,
  CommentFormEntry,
  InlineComment,
  LineRange,
} from './index';
import { lineAnchorKey, lineRangeKey } from './index';

const EMPTY_SEARCH_MATCHES: SearchMatch[] = [];

export function SideBySideDiffTable({
  oldString,
  newString,
  oldTokens,
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
  oldTokens: ThemedToken[][];
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

  // Compute both the flat lines (for mapping search matches) and side-by-side rows
  const { rows, lineToRowMapping } = useMemo(() => {
    const lines = computeDiff(oldString, newString);
    const sbsRows = computeSideBySideDiff(oldString, newString);

    // Build a mapping from line index to { rowIndex, side }
    const mapping = new Map<
      number,
      { rowIndex: number; side: 'left' | 'right' }
    >();

    let lineIndex = 0;
    let rowIndex = 0;

    while (lineIndex < lines.length && rowIndex < sbsRows.length) {
      const line = lines[lineIndex];
      const row = sbsRows[rowIndex];

      if (line.type === 'context') {
        // Context lines appear in both sides, map to 'right' for consistency
        mapping.set(lineIndex, { rowIndex, side: 'right' });
        lineIndex++;
        rowIndex++;
      } else if (line.type === 'deletion') {
        // Find this deletion in current row's left side
        if (row.left && row.left.oldLineNumber === line.oldLineNumber) {
          mapping.set(lineIndex, { rowIndex, side: 'left' });
          lineIndex++;
          // Only advance row if there's no addition to pair with
          if (!row.right || lines[lineIndex]?.type !== 'addition') {
            rowIndex++;
          }
        } else {
          rowIndex++;
        }
      } else if (line.type === 'addition') {
        // Find this addition in current row's right side
        if (row.right && row.right.newLineNumber === line.newLineNumber) {
          mapping.set(lineIndex, { rowIndex, side: 'right' });
          lineIndex++;
          rowIndex++;
        } else {
          rowIndex++;
        }
      }
    }

    return { rows: sbsRows, lineToRowMapping: mapping };
  }, [oldString, newString]);

  // Group search matches by row and side
  const matchesByRowAndSide = useMemo(() => {
    const result = new Map<string, SearchMatch[]>();

    searchMatches.forEach((match) => {
      const mapping = lineToRowMapping.get(match.lineIndex);
      if (mapping) {
        const key = `${mapping.rowIndex}-${mapping.side}`;
        if (!result.has(key)) {
          result.set(key, []);
        }
        result.get(key)!.push(match);
      }
    });

    return result;
  }, [searchMatches, lineToRowMapping]);

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

  const { tableRef, leftFraction, isDragging, handleDividerMouseDown } =
    useDividerResize();

  // Calculate percentage widths for left and right content columns
  const leftPct = `${leftFraction * 100}%`;
  const rightPct = `${(1 - leftFraction) * 100}%`;

  const isLineInCommentRange = useCallback(
    (lineNumber: number, side: 'old' | 'new' = 'new') => {
      if (!commentForms || commentForms.length === 0) return false;
      return commentForms.some(
        (cf) =>
          (cf.lineRange.side ?? 'new') === side &&
          lineNumber >= cf.lineRange.start && lineNumber <= cf.lineRange.end,
      );
    },
    [commentForms],
  );

  return (
    <table
      ref={tableRef}
      className={`w-full table-fixed border-collapse ${isDragging ? 'select-none' : ''}`}
      onMouseDown={lineRangeSelection.onMouseDown}
      onMouseOver={lineRangeSelection.onMouseOver}
      onMouseUp={lineRangeSelection.onMouseUp}
      onMouseLeave={lineRangeSelection.onMouseLeave}
    >
      <colgroup>
        {/* Fold gutter */}
        <col style={{ width: 16 }} />
        {/* Left line number */}
        <col style={{ width: 32 }} />
        {/* Left content */}
        <col style={{ width: leftPct }} />
        {/* Divider */}
        <col style={{ width: 8 }} />
        {/* Right line number */}
        <col style={{ width: 32 }} />
        {/* Right content */}
        <col style={{ width: rightPct }} />
      </colgroup>
      <tbody>
        {rows.map((row, rowIndex) => {
          const newLineNumber = row.right?.newLineNumber ?? row.left?.newLineNumber;
          const oldLineNumber = row.left?.oldLineNumber;
          const selectableLineNumber = newLineNumber ?? oldLineNumber;

          // Check if this line is hidden by a collapsed fold
          if (newLineNumber && folding.isLineHidden(newLineNumber)) {
            return null;
          }

          const lineComments = [
            ...(newLineNumber
              ? (inlineCommentsByLine.get(`new:${newLineNumber}`) ?? [])
              : []),
            ...(oldLineNumber
              ? (inlineCommentsByLine.get(`old:${oldLineNumber}`) ?? [])
              : []),
          ];

          const formsForLine = [
            ...(newLineNumber
              ? (commentFormsByEndLine.get(`new:${newLineNumber}`) ?? [])
              : []),
            ...(oldLineNumber
              ? (commentFormsByEndLine.get(`old:${oldLineNumber}`) ?? [])
              : []),
          ];

          const isInCommentRange = newLineNumber
            ? isLineInCommentRange(newLineNumber, 'new')
            : oldLineNumber
              ? isLineInCommentRange(oldLineNumber, 'old')
            : false;

          const canComment = !!onAddCommentClick && newLineNumber !== undefined;
          const canSelect =
            !!onAddCommentClick && selectableLineNumber !== undefined;

          // Code folding state
          const isFoldable = newLineNumber
            ? folding.isFoldStart(newLineNumber)
            : false;
          const isFoldCollapsed = newLineNumber
            ? folding.isFoldCollapsed(newLineNumber)
            : false;
          const foldRange = newLineNumber
            ? folding.getFoldRange(newLineNumber)
            : undefined;

          return (
            <SideBySideRowComponent
              key={rowIndex}
              row={row}
              rowIndex={rowIndex}
              oldTokens={oldTokens}
              newTokens={newTokens}
              leftMatches={
                matchesByRowAndSide.get(`${rowIndex}-left`) ??
                EMPTY_SEARCH_MATCHES
              }
              rightMatches={
                matchesByRowAndSide.get(`${rowIndex}-right`) ??
                EMPTY_SEARCH_MATCHES
              }
              currentMatch={currentMatch}
              onDividerMouseDown={handleDividerMouseDown}
              isDragging={isDragging}
              canComment={canComment}
              canSelect={canSelect}
              isInCommentRange={isInCommentRange}
              hasComment={
                (!!newLineNumber &&
                  !!commentedLines?.has(lineAnchorKey('new', newLineNumber))) ||
                (!!oldLineNumber &&
                  !!commentedLines?.has(lineAnchorKey('old', oldLineNumber)))
              }
              inlineComments={lineComments.length > 0 ? lineComments : undefined}
              commentForms={formsForLine.length > 0 ? formsForLine : undefined}
              newLineNumber={newLineNumber}
              oldLineNumber={oldLineNumber}
              isFoldable={isFoldable}
              isFoldCollapsed={isFoldCollapsed}
              foldRange={foldRange}
              onToggleFold={newLineNumber ? folding.toggleFold : undefined}
            />
          );
        })}
      </tbody>
    </table>
  );
}

const SideBySideRowComponent = memo(function SideBySideRowComponent({
  row,
  rowIndex,
  oldTokens,
  newTokens,
  leftMatches,
  rightMatches,
  currentMatch,
  onDividerMouseDown,
  isDragging,
  canComment,
  canSelect,
  isInCommentRange,
  hasComment,
  inlineComments,
  commentForms,
  newLineNumber,
  oldLineNumber,
  isFoldable,
  isFoldCollapsed,
  foldRange,
  onToggleFold,
}: {
  row: SideBySideRow;
  rowIndex: number;
  oldTokens: ThemedToken[][];
  newTokens: ThemedToken[][];
  leftMatches: SearchMatch[];
  rightMatches: SearchMatch[];
  currentMatch: SearchMatch | null;
  onDividerMouseDown: (e: ReactMouseEvent) => void;
  isDragging: boolean;
  canComment: boolean;
  canSelect: boolean;
  isInCommentRange: boolean;
  hasComment: boolean;
  inlineComments?: InlineComment[];
  commentForms?: CommentFormEntry[];
  newLineNumber?: number;
  oldLineNumber?: number;
  isFoldable?: boolean;
  isFoldCollapsed?: boolean;
  foldRange?: { startLine: number; endLine: number };
  onToggleFold?: (lineNumber: number) => void;
}) {
  return (
    <>
      <tr
        data-line-index={rowIndex}
        data-new-line={newLineNumber}
        data-old-line={oldLineNumber}
        data-line-side={newLineNumber === undefined ? 'old' : 'new'}
        className={clsx('group', {
          'bg-blue-500/10': isInCommentRange,
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
                onToggleFold?.(newLineNumber!);
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
        {/* Left side (old/deletions) */}
        <SideBySideCell
          line={row.left}
          tokens={oldTokens}
          side="left"
          searchMatches={leftMatches}
          currentMatch={currentMatch}
          canComment={canComment}
          isInCommentRange={isInCommentRange}
          hasComment={hasComment}
        />
        {/* Divider / drag handle */}
        <td
          className="group relative cursor-col-resize select-none"
          onMouseDown={(event) => {
            event.stopPropagation();
            onDividerMouseDown(event);
          }}
        >
          {/* Visible divider line */}
          <div
            className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-all ${
              isDragging
                ? 'bg-acc w-0.5'
                : 'group-hover:bg-acc/50 bg-white/[0.06] group-hover:w-0.5'
            }`}
          />
        </td>
        {/* Right side (new/additions) */}
        <SideBySideCell
          line={row.right}
          tokens={newTokens}
          side="right"
          searchMatches={rightMatches}
          currentMatch={currentMatch}
          canComment={canComment}
          isInCommentRange={isInCommentRange}
          hasComment={hasComment}
          isFoldCollapsed={isFoldCollapsed}
          foldRange={foldRange}
          onToggleFold={onToggleFold}
        />
      </tr>

      {/* Inline comments for this line */}
      {inlineComments && inlineComments.length > 0 && (
        <tr>
          <td colSpan={6} className="p-0">
            <div>
              {inlineComments.map((comment, i) => (
                <div key={comment.id ?? i}>{comment.content}</div>
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
            <td colSpan={6} className="p-0">
              {cf.form}
            </td>
          </tr>
        ))}
    </>
  );
});

const SideBySideCell = memo(function SideBySideCell({
  line,
  tokens,
  side,
  searchMatches,
  currentMatch,
  canComment,
  isInCommentRange,
  hasComment,
  isFoldCollapsed,
  foldRange,
  onToggleFold,
}: {
  line: DiffLine | null;
  tokens: ThemedToken[][];
  side: 'left' | 'right';
  searchMatches: SearchMatch[];
  currentMatch: SearchMatch | null;
  canComment: boolean;
  isInCommentRange: boolean;
  hasComment: boolean;
  isFoldCollapsed?: boolean;
  foldRange?: { startLine: number; endLine: number };
  onToggleFold?: (lineNumber: number) => void;
}) {
  // Gap cell (no line on this side)
  if (!line) {
    return (
      <>
        <td className="bg-bg-1/50 text-ink-4 pr-1 text-right align-top select-none" />
        <td className="bg-bg-1/50 overflow-hidden pr-2 whitespace-pre-wrap [overflow-wrap:anywhere]" />
      </>
    );
  }

  // Determine background and text colors based on line type and selection state
  const bgClass = isInCommentRange
      ? '' // Row-level comment range handles bg
      : line.type === 'deletion'
        ? 'bg-red-500/20'
        : line.type === 'addition'
          ? 'bg-green-500/20'
          : '';

  const lineNumClass =
    hasComment && !isInCommentRange
      ? 'text-acc-ink'
      : line.type === 'deletion'
        ? 'text-status-fail'
        : line.type === 'addition'
          ? 'text-status-done'
          : 'text-ink-4';

  // Get line number for this side
  const lineNumber = side === 'left' ? line.oldLineNumber : line.newLineNumber;

  // Get tokens for syntax highlighting
  const lineIndex = (lineNumber ?? 1) - 1;
  const lineTokens = tokens[lineIndex] || [];

  // Render content with search highlights
  const renderedContent =
    lineTokens.length > 0 ? (
      renderTokensWithHighlights({
        tokens: lineTokens,
        content: line.content,
        searchMatches,
        currentMatch,
      })
    ) : searchMatches.length > 0 ? (
      renderWithHighlights({
        text: line.content,
        searchMatches,
        currentMatch,
      })
    ) : (
      <span className="text-ink-1">{line.content}</span>
    );

  // Show comment icon on the left side's line number column when hovered
  const showCommentIcon = canComment && side === 'left';

  return (
    <>
      {/* Line number */}
      <td
        data-line-side={side === 'left' ? 'old' : 'new'}
        className={clsx(
          'relative pr-1 text-right align-top select-none whitespace-nowrap',
          lineNumClass,
          bgClass,
        )}
        style={
          hasComment && !isInCommentRange && side === 'left'
            ? { borderLeft: '2px solid oklch(0.78 0.18 295 / 0.5)' }
            : undefined
        }
      >
        <span className={clsx(showCommentIcon && 'group-hover:invisible')}>
          {lineNumber ?? ''}
        </span>
        {showCommentIcon && (
          <span className="text-acc-ink absolute inset-0 hidden items-center justify-center group-hover:flex">
            <MessageSquarePlus className="h-3 w-3" aria-hidden />
          </span>
        )}
      </td>
      {/* Content */}
      <td
        data-line-side={side === 'left' ? 'old' : 'new'}
        className={clsx(
          'overflow-hidden pr-2 whitespace-pre-wrap [overflow-wrap:anywhere]',
          bgClass,
          {
            'select-none': canComment,
          },
        )}
      >
        {renderedContent}
        {side === 'right' && isFoldCollapsed && foldRange && (
          <span
            className="text-ink-4 bg-bg-2 ml-2 inline-block cursor-pointer rounded px-1.5 py-0 text-[10px] leading-4"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFold?.(line.newLineNumber!);
            }}
          >
            {foldRange.endLine - foldRange.startLine} lines
          </span>
        )}
      </td>
    </>
  );
});
