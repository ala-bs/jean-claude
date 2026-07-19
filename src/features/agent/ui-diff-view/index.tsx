import {
  AlignJustify,
  ChevronDown,
  ChevronRight,
  Columns2,
  FileText,
  MessageSquarePlus,
} from 'lucide-react';
import { codeToTokens, type ThemedToken } from 'shiki';
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import type { ReactNode } from 'react';



import { useUISetting, useUIStore } from '@/stores/ui';

import { computeDiff, type DiffLine } from './diff-utils';
import {
  type LineRangeSelectionPosition,
  useLineRangeSelection,
} from './use-line-range-selection';
import {
  renderTokensWithHighlights,
  renderWithHighlights,
} from './utils-search-highlight';
import { type SearchMatch, useDiffSearch } from './use-diff-search';
import { ChangeNavigatorOverlay } from './change-navigator';
import { CurrentStateTable } from './current-state-table';
import { DiffMinimapOverlay } from './diff-minimap';
import { DiffSearchBar } from './diff-search-bar';
import { getLanguageFromPath } from './language-utils';
import { SideBySideDiffTable } from './side-by-side-table';
import { useCodeFolding } from './use-code-folding';



interface DiffState {
  lines: DiffLine[];
  oldTokens: ThemedToken[][];
  newTokens: ThemedToken[][];
}

const EMPTY_SEARCH_MATCHES: SearchMatch[] = [];
export type LineAnchorSide = 'old' | 'new';
export type CommentedLines = Set<string>;

export function lineAnchorKey(side: LineAnchorSide | undefined, line: number) {
  return `${side ?? 'new'}:${line}`;
}

export interface InlineComment {
  id?: string;
  line: number;
  side?: 'old' | 'new';
  content: ReactNode;
}

export interface LineRange {
  start: number;
  end: number;
  side?: 'old' | 'new';
}

export function lineRangeKey(range: LineRange) {
  return `${range.side ?? 'new'}:${range.start}:${range.end}`;
}

export interface CommentFormEntry {
  lineRange: LineRange;
  form: ReactNode;
}

export function DiffView({
  filePath,
  oldString,
  newString,
  withMinimap,
  onAddCommentClick,
  inlineComments,
  commentedLines,
  commentForms,
  scrollToLine,
}: {
  filePath: string;
  oldString: string;
  newString: string;
  maxHeight?: string;
  withMinimap?: boolean;
  /** Called when user selects lines to comment on */
  onAddCommentClick?: (
    lineRange: LineRange,
    position: LineRangeSelectionPosition,
  ) => void;
  /** Inline comments to render below specific lines */
  inlineComments?: InlineComment[];
  /** Set of side-aware line keys that have comments (for line highlighting). */
  commentedLines?: CommentedLines;
  /** Comment forms to render inline at specific line ranges */
  commentForms?: CommentFormEntry[];
  /** New-file line to scroll into view after render */
  scrollToLine?: number;
}) {
  const [state, setState] = useState<DiffState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const viewMode = useUISetting('diffViewMode');
  const setSetting = useUIStore((s) => s.setSetting);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const language = getLanguageFromPath(filePath);

  useEffect(() => {
    if (!state || !scrollToLine || !scrollContainerRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      const row = scrollContainerRef.current?.querySelector(
        `[data-new-line="${scrollToLine}"]`,
      );
      row?.scrollIntoView({ block: 'center' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [state, scrollToLine, viewMode]);

  useEffect(() => {
    startTransition(() => setIsLoading(true));

    // Compute diff
    const lines = computeDiff(oldString, newString);

    // Get syntax tokens for both strings (use space for empty to avoid Shiki errors)
    Promise.all([
      codeToTokens(oldString || ' ', {
        lang: language,
        theme: 'github-dark',
      }).catch(() =>
        codeToTokens(oldString || ' ', { lang: 'text', theme: 'github-dark' }),
      ),
      codeToTokens(newString || ' ', {
        lang: language,
        theme: 'github-dark',
      }).catch(() =>
        codeToTokens(newString || ' ', { lang: 'text', theme: 'github-dark' }),
      ),
    ])
      .then(([oldResult, newResult]) => {
        setState({
          lines,
          oldTokens: oldResult.tokens,
          newTokens: newResult.tokens,
        });
      })
      .catch(() => {
        // Fallback: no syntax highlighting
        setState({
          lines,
          oldTokens: [],
          newTokens: [],
        });
      })
      .finally(() => setIsLoading(false));
  }, [oldString, newString, language]);

  // Search functionality
  const {
    isSearchOpen,
    searchQuery,
    setSearchQuery,
    matches,
    currentMatchIndex,
    totalMatches,
    searchBarRef,
    closeSearch,
    goToNextMatch,
    goToPreviousMatch,
  } = useDiffSearch({
    lines: state?.lines ?? [],
    scrollContainerRef,
  });

  // Code folding based on new file content (tree-sitter in main process)
  const folding = useCodeFolding(newString, language, filePath);
  const hasChanges = state?.lines.some((line) => line.type !== 'context') ?? false;

  if (isLoading || !state) {
    return (
      <div className="flex items-center justify-center rounded bg-black/30 p-2">
        <span className="text-ink-3 text-xs">Loading diff…</span>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden">
      {/* Search bar and toggle mode button */}
      <div className="absolute top-2 right-4 z-10 flex items-center gap-2">
        {isSearchOpen && (
          <DiffSearchBar
            ref={searchBarRef}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            currentMatch={totalMatches > 0 ? currentMatchIndex + 1 : 0}
            totalMatches={totalMatches}
            onNext={goToNextMatch}
            onPrevious={goToPreviousMatch}
            onClose={closeSearch}
          />
        )}
        <div
          className="bg-glass-medium/70 flex items-center rounded p-0.5"
          role="radiogroup"
          aria-label="Diff view mode"
        >
          <button
            onClick={() => setSetting('diffViewMode', 'inline')}
            className={clsx(
              'rounded p-1 transition-colors',
              viewMode === 'inline'
                ? 'bg-bg-3 text-ink-0'
                : 'text-ink-3 hover:text-ink-1',
            )}
            aria-label="Inline diff"
            aria-checked={viewMode === 'inline'}
            role="radio"
          >
            <AlignJustify className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            onClick={() => setSetting('diffViewMode', 'side-by-side')}
            className={clsx(
              'rounded p-1 transition-colors',
              viewMode === 'side-by-side'
                ? 'bg-bg-3 text-ink-0'
                : 'text-ink-3 hover:text-ink-1',
            )}
            aria-label="Side-by-side diff"
            aria-checked={viewMode === 'side-by-side'}
            role="radio"
          >
            <Columns2 className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            onClick={() => setSetting('diffViewMode', 'current-state')}
            className={clsx(
              'rounded p-1 transition-colors',
              viewMode === 'current-state'
                ? 'bg-bg-3 text-ink-0'
                : 'text-ink-3 hover:text-ink-1',
            )}
            aria-label="Current state"
            aria-checked={viewMode === 'current-state'}
            role="radio"
          >
            <FileText className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className={clsx(
          'h-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-black/30 pb-2 font-mono text-xs [overflow-wrap:anywhere]',
          hasChanges ? 'pt-12' : 'pt-2',
          {
            'no-scrollbar': !!withMinimap,
          },
        )}
      >
        {viewMode === 'inline' ? (
          <InlineDiffTable
            lines={state.lines}
            oldTokens={state.oldTokens}
            newTokens={state.newTokens}
            onAddCommentClick={onAddCommentClick}
            inlineComments={inlineComments}
            commentedLines={commentedLines}
            commentForms={commentForms}
            searchMatches={matches}
            currentMatchIndex={currentMatchIndex}
            folding={folding}
          />
        ) : viewMode === 'side-by-side' ? (
          <SideBySideDiffTable
            oldString={oldString}
            newString={newString}
            oldTokens={state.oldTokens}
            newTokens={state.newTokens}
            onAddCommentClick={onAddCommentClick}
            inlineComments={inlineComments}
            commentedLines={commentedLines}
            commentForms={commentForms}
            searchMatches={matches}
            currentMatchIndex={currentMatchIndex}
            folding={folding}
          />
        ) : (
          <CurrentStateTable
            oldString={oldString}
            newString={newString}
            diffLines={state.lines}
            newTokens={state.newTokens}
            onAddCommentClick={onAddCommentClick}
            inlineComments={inlineComments}
            commentedLines={commentedLines}
            commentForms={commentForms}
            searchMatches={matches}
            currentMatchIndex={currentMatchIndex}
            folding={folding}
          />
        )}
      </div>
      {!!withMinimap && (
        <DiffMinimapOverlay
          lines={state.lines}
          scrollContainerRef={scrollContainerRef}
          commentedLines={commentedLines}
        />
      )}
      <ChangeNavigatorOverlay
        lines={state.lines}
        scrollContainerRef={scrollContainerRef}
        viewMode={viewMode}
        oldString={oldString}
        newString={newString}
      />
    </div>
  );
}

export interface CodeFoldingState {
  isLineHidden: (lineNumber: number) => boolean;
  isFoldStart: (lineNumber: number) => boolean;
  isFoldCollapsed: (lineNumber: number) => boolean;
  toggleFold: (lineNumber: number) => void;
  getFoldRange: (
    lineNumber: number,
  ) => { startLine: number; endLine: number } | undefined;
}

/**
 * Find the nearest newLineNumber by scanning in the given direction.
 * Used to determine if a deletion line (which has no newLineNumber)
 * falls inside a collapsed fold.
 */
function findNearestNewLineNumber(
  lines: DiffLine[],
  fromIndex: number,
  direction: -1 | 1,
): number | null {
  for (
    let j = fromIndex + direction;
    j >= 0 && j < lines.length;
    j += direction
  ) {
    if (lines[j].newLineNumber !== undefined) {
      return lines[j].newLineNumber!;
    }
  }
  return null;
}

function InlineDiffTable({
  lines,
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
  lines: DiffLine[];
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

  const searchMatchesByLineIndex = useMemo(() => {
    const map = new Map<number, SearchMatch[]>();
    for (const match of searchMatches) {
      const matches = map.get(match.lineIndex);
      if (matches) {
        matches.push(match);
      } else {
        map.set(match.lineIndex, [match]);
      }
    }
    return map;
  }, [searchMatches]);

  // Check if a line is in any comment form range
  const isLineInCommentRange = useCallback(
    (lineNumber: number, side: LineAnchorSide = 'new') => {
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
      className="w-full border-collapse"
      onMouseDown={lineRangeSelection.onMouseDown}
      onMouseOver={lineRangeSelection.onMouseOver}
      onMouseUp={lineRangeSelection.onMouseUp}
      onMouseLeave={lineRangeSelection.onMouseLeave}
    >
      <tbody>
        {lines.map((line, i) => {
          const lineNumber = line.newLineNumber;
          const oldLineNumber = line.oldLineNumber;
          const selectableLineNumber = lineNumber ?? oldLineNumber;

          // Check if this line is hidden by a collapsed fold.
          // For deletion lines (no newLineNumber), check if the surrounding
          // context lines are hidden — meaning this deletion is inside a collapsed scope.
          if (lineNumber && folding.isLineHidden(lineNumber)) {
            return null;
          }
          if (line.type === 'deletion' && lineNumber === undefined) {
            // Find the nearest context/addition line's newLineNumber
            // by looking at the previous and next non-deletion lines
            const prevNewLine = findNearestNewLineNumber(lines, i, -1);
            const nextNewLine = findNearestNewLineNumber(lines, i, 1);
            const isInsideCollapsedFold =
              (prevNewLine !== null && folding.isLineHidden(prevNewLine)) ||
              (nextNewLine !== null && folding.isLineHidden(nextNewLine));
            if (isInsideCollapsedFold) {
              return null;
            }
          }

          const lineComments = [
            ...(lineNumber ? (inlineCommentsByLine.get(`new:${lineNumber}`) ?? []) : []),
            ...(oldLineNumber
              ? (inlineCommentsByLine.get(`old:${oldLineNumber}`) ?? [])
              : []),
          ];

          const formsForLine = [
            ...(lineNumber
              ? (commentFormsByEndLine.get(`new:${lineNumber}`) ?? [])
              : []),
            ...(oldLineNumber
              ? (commentFormsByEndLine.get(`old:${oldLineNumber}`) ?? [])
              : []),
          ];

          const isInCommentRange = lineNumber
            ? isLineInCommentRange(lineNumber, 'new')
            : oldLineNumber
              ? isLineInCommentRange(oldLineNumber, 'old')
            : false;

          // Find search matches for this line
          const lineMatches =
            searchMatchesByLineIndex.get(i) ?? EMPTY_SEARCH_MATCHES;
          const isCurrentMatchLine =
            searchMatches[currentMatchIndex]?.lineIndex === i;
          const currentMatchInLine = isCurrentMatchLine
            ? searchMatches[currentMatchIndex]
            : null;

          // Code folding state
          const isFoldable = lineNumber
            ? folding.isFoldStart(lineNumber)
            : false;
          const isCollapsed = lineNumber
            ? folding.isFoldCollapsed(lineNumber)
            : false;
          const foldRange = lineNumber
            ? folding.getFoldRange(lineNumber)
            : undefined;

          return (
            <DiffLineRow
              key={i}
              lineIndex={i}
              line={line}
              oldTokens={oldTokens}
              newTokens={newTokens}
              canComment={!!onAddCommentClick && lineNumber !== undefined}
              canSelect={!!onAddCommentClick && selectableLineNumber !== undefined}
              isInCommentRange={isInCommentRange}
              hasComment={
                (!!lineNumber &&
                  !!commentedLines?.has(lineAnchorKey('new', lineNumber))) ||
                (!!oldLineNumber &&
                  !!commentedLines?.has(lineAnchorKey('old', oldLineNumber)))
              }
              inlineComments={lineComments.length > 0 ? lineComments : undefined}
              commentForms={formsForLine.length > 0 ? formsForLine : undefined}
              searchMatches={lineMatches}
              currentMatch={currentMatchInLine}
              isFoldable={isFoldable}
              isFoldCollapsed={isCollapsed}
              foldRange={foldRange}
              onToggleFold={lineNumber ? folding.toggleFold : undefined}
            />
          );
        })}
      </tbody>
    </table>
  );
}

const DiffLineRow = memo(function DiffLineRow({
  lineIndex,
  line,
  oldTokens,
  newTokens,
  canComment,
  canSelect,
  isInCommentRange,
  hasComment,
  inlineComments,
  commentForms,
  searchMatches,
  currentMatch,
  isFoldable,
  isFoldCollapsed,
  foldRange,
  onToggleFold,
}: {
  lineIndex: number;
  line: DiffLine;
  oldTokens: ThemedToken[][];
  newTokens: ThemedToken[][];
  canComment: boolean;
  canSelect: boolean;
  isInCommentRange: boolean;
  hasComment: boolean;
  inlineComments?: InlineComment[];
  commentForms?: CommentFormEntry[];
  searchMatches: SearchMatch[];
  currentMatch: SearchMatch | null;
  isFoldable?: boolean;
  isFoldCollapsed?: boolean;
  foldRange?: { startLine: number; endLine: number };
  onToggleFold?: (lineNumber: number) => void;
}) {
  // Get tokens for this line based on type
  // For deletions, use old tokens; for additions, use new tokens; for context, prefer new
  const tokenLineIndex =
    line.type === 'deletion'
      ? (line.oldLineNumber ?? 1) - 1
      : (line.newLineNumber ?? 1) - 1;

  const tokens =
    line.type === 'deletion'
      ? oldTokens[tokenLineIndex] || []
      : newTokens[tokenLineIndex] || [];

  // Render content with search highlights
  const renderedContent =
    tokens.length > 0 ? (
      renderTokensWithHighlights({
        tokens,
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

  return (
    <>
      <tr
        data-line-index={lineIndex}
        data-new-line={line.newLineNumber ?? undefined}
        data-old-line={line.oldLineNumber}
        data-line-side={line.newLineNumber === undefined ? 'old' : 'new'}
        className={clsx('group', {
          'bg-blue-500/10': isInCommentRange,
          'bg-green-500/20':
            !isInCommentRange && line.type === 'addition',
          'bg-red-500/20':
            !isInCommentRange && line.type === 'deletion',
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
                onToggleFold?.(line.newLineNumber!);
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
        {/* Add comment button / Old line number */}
        <td
          data-line-side="old"
          className={clsx(
            'relative w-8 pr-1 text-right align-top select-none',
            hasComment && !isInCommentRange
              ? 'text-acc-ink'
              : line.type === 'deletion'
                ? 'text-status-fail'
                : 'text-ink-4',
          )}
          style={
            hasComment && !isInCommentRange
              ? { borderLeft: '2px solid oklch(0.78 0.18 295 / 0.5)' }
              : undefined
          }
        >
          <span className={clsx(canComment && 'group-hover:invisible')}>
            {line.oldLineNumber ?? ''}
          </span>
          {canComment && (
            <span className="text-acc-ink absolute inset-0 hidden items-center justify-center group-hover:flex">
              <MessageSquarePlus className="h-3 w-3" aria-hidden />
            </span>
          )}
        </td>
        {/* New line number */}
        <td
          data-line-side="new"
          className={clsx(
            'w-8 pr-1 text-right align-top select-none',
            line.type === 'addition' ? 'text-status-done' : 'text-ink-4',
          )}
        >
          {line.newLineNumber ?? ''}
        </td>
        {/* Prefix (+/-/space) */}
        <td
          data-line-side={line.newLineNumber === undefined ? 'old' : 'new'}
          className={clsx('w-4 text-center align-top select-none', {
            'text-status-done': line.type === 'addition',
            'text-status-fail': line.type === 'deletion',
            'text-ink-4': line.type === 'context',
          })}
        >
          {line.type === 'addition'
            ? '+'
            : line.type === 'deletion'
              ? '-'
              : ' '}
        </td>
        {/* Content with syntax highlighting and search highlights */}
        <td
          data-line-side={line.newLineNumber === undefined ? 'old' : 'new'}
          className={clsx('pr-2 whitespace-pre-wrap', {
            'select-none': canComment,
          })}
        >
          {renderedContent}
          {isFoldCollapsed && foldRange && (
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
      </tr>

      {/* Inline comments for this line */}
      {inlineComments && inlineComments.length > 0 && (
        <tr>
          <td colSpan={5} className="p-0">
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
            <td colSpan={5} className="p-0">
              {cf.form}
            </td>
          </tr>
        ))}
    </>
  );
});
