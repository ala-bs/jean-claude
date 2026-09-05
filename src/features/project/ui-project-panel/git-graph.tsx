import clsx from 'clsx';

import type { ProjectGitGraphRow, ProjectGitRef } from '@shared/types';
import { formatRelativeTime } from '@/lib/time';

/** Rendering the whole history would blow up the DOM; git already caps the log. */
const MAX_RENDERED_ROWS = 200;

function RefBadge({ gitRef }: { gitRef: ProjectGitRef }) {
  return (
    <span
      className={clsx(
        'rounded px-1 py-px text-[10px] leading-4 whitespace-nowrap',
        gitRef.kind === 'tag' && 'bg-amber-400/10 text-amber-300',
        gitRef.kind === 'remote' && 'bg-glass-medium text-ink-2',
        gitRef.kind === 'branch' && 'bg-acc/15 text-acc-ink',
        gitRef.kind === 'other' && 'bg-glass-medium text-ink-3',
        gitRef.isHead && 'ring-acc/40 ring-1',
      )}
      title={gitRef.isHead ? `${gitRef.name} (current branch)` : gitRef.name}
    >
      {gitRef.name}
    </span>
  );
}

export function GitGraph({
  rows,
  isLoading,
}: {
  rows: ProjectGitGraphRow[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return <p className="text-ink-3 px-3 py-2 text-xs">Loading history…</p>;
  }

  if (rows.length === 0) {
    return <p className="text-ink-3 px-3 py-2 text-xs">No commits yet.</p>;
  }

  const visibleRows = rows.slice(0, MAX_RENDERED_ROWS);

  // Trailing lane padding is stripped when parsing, so rows have ragged widths.
  // Pinning the lane column to the widest row keeps the commit columns aligned
  // instead of stair-stepping with the graph.
  const graphColumnWidth = visibleRows.reduce(
    (widest, row) => Math.max(widest, row.graph.length),
    0,
  );

  return (
    <div className="border-line-soft max-h-[420px] overflow-auto rounded-lg border">
      <ul className="min-w-max">
        {visibleRows.map((row, index) => (
          <li
            key={`${index}-${row.commit?.hash ?? 'connector'}`}
            className={clsx(
              'flex items-baseline gap-2 px-3 leading-5',
              row.commit ? 'hover:bg-glass-light py-1' : 'py-0',
            )}
          >
            <span
              className="text-ink-3 shrink-0 font-mono text-xs whitespace-pre"
              style={{ width: `${graphColumnWidth}ch` }}
            >
              {row.graph}
            </span>

            {row.commit && (
              <>
                <span className="text-acc-ink shrink-0 font-mono text-xs">
                  {row.commit.shortHash}
                </span>

                {row.commit.refs.length > 0 && (
                  <span className="flex shrink-0 items-center gap-1">
                    {row.commit.refs.map((gitRef) => (
                      <RefBadge
                        key={`${gitRef.kind}:${gitRef.name}`}
                        gitRef={gitRef}
                      />
                    ))}
                  </span>
                )}

                <span className="text-ink-1 min-w-0 flex-1 truncate text-xs">
                  {row.commit.subject}
                </span>
                <span className="text-ink-3 shrink-0 text-[11px]">
                  {row.commit.author}
                </span>
                <span className="text-ink-3 shrink-0 text-[11px]">
                  {formatRelativeTime(row.commit.date)}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
