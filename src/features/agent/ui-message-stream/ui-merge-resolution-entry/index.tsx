import clsx from 'clsx';
import { GitMerge } from 'lucide-react';
import { useState } from 'react';

import type { ToolUseByName } from '@shared/normalized-message-v2';

import { DiffView } from '../../ui-diff-view';

type MergeFile = ToolUseByName<'merge-resolution'>['input']['files'][number];
type MergeSide = NonNullable<MergeFile['unavailable']>[number];

/**
 * Which pair of the three-way merge is being diffed.
 *
 * `resolution` is the default because it is the only one the agent authored;
 * the other two exist to explain *why* there was a conflict at all.
 */
type Side = 'resolution' | 'ours' | 'theirs';

const SIDES: { id: Side; label: string; hint: string }[] = [
  {
    id: 'resolution',
    label: 'Resolution',
    hint: 'What the agent changed relative to this branch',
  },
  { id: 'ours', label: 'Our change', hint: 'This branch vs the common ancestor' },
  {
    id: 'theirs',
    label: 'Their change',
    hint: 'Incoming branch vs the common ancestor',
  },
];

function basename(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

/**
 * Resolves the two contents to diff for a side, or null when either is missing.
 *
 * Returning null matters: a side whose blob was too large or binary to capture
 * is `undefined`, and coercing that to `''` would render as "the whole file was
 * added" or "nothing changed" — both confident lies about code the reviewer is
 * trying to check.
 */
function getSideContents(
  file: MergeFile,
  side: Side,
): { oldString: string; newString: string } | null {
  const pair: {
    old: MergeSide;
    new: MergeSide;
    oldString?: string;
    newString?: string;
  } =
    side === 'resolution'
      ? {
          old: 'ours',
          new: 'resolved',
          oldString: file.ours,
          newString: file.resolved,
        }
      : side === 'ours'
        ? { old: 'base', new: 'ours', oldString: file.base, newString: file.ours }
        : {
            old: 'base',
            new: 'theirs',
            oldString: file.base,
            newString: file.theirs,
          };

  // Only the two sides this view actually diffs matter. Bailing whenever *any*
  // side of the file was unavailable would hide the resolution diff because the
  // incoming side happened to be an oversized lockfile.
  const unavailable = file.unavailable ?? [];
  if (unavailable.includes(pair.old) || unavailable.includes(pair.new)) {
    return null;
  }

  // A genuinely absent side (no common ancestor in an add/add conflict, or a
  // deletion) is legitimately empty, but both absent means we captured nothing.
  if (pair.oldString === undefined && pair.newString === undefined) return null;
  return { oldString: pair.oldString ?? '', newString: pair.newString ?? '' };
}

function MergeFileRow({ file }: { file: MergeFile }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [side, setSide] = useState<Side>('resolution');
  const contents = getSideContents(file, side);
  // Driven by the tracker's explicit flag, not by absent content — an unreadable
  // 400 KB lockfile is not a deleted one.
  const wasDeleted = file.deleted === true;
  const isUnavailable = (file.unavailable?.length ?? 0) > 0;

  return (
    <div className="border-ink-3/15 border-t first:border-t-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
        onClick={() => setIsExpanded((current) => !current)}
      >
        <span className="text-ink-1 truncate font-mono text-xs">
          {basename(file.filePath)}
        </span>
        <span className="text-ink-3 truncate font-mono text-[10px]">
          {file.filePath}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px]">
          {wasDeleted ? (
            <span className="text-status-fail">deleted</span>
          ) : isUnavailable ? (
            <span className="text-ink-3">not shown</span>
          ) : (
            <>
              <span className="text-status-pass">+{file.additions ?? 0}</span>{' '}
              <span className="text-status-fail">-{file.deletions ?? 0}</span>
            </>
          )}
        </span>
      </button>

      {isExpanded && (
        <div className="px-3 pb-2">
          <div className="mb-2 flex gap-1">
            {SIDES.map((option) => (
              <button
                key={option.id}
                type="button"
                title={option.hint}
                className={clsx(
                  'rounded px-2 py-0.5 text-[11px]',
                  side === option.id
                    ? 'bg-acc/20 text-ink-1'
                    : 'text-ink-3 hover:bg-white/5',
                )}
                onClick={() => setSide(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {contents ? (
            <DiffView
              filePath={file.filePath}
              oldString={contents.oldString}
              newString={contents.newString}
            />
          ) : (
            <p className="text-ink-3 text-xs">
              Content unavailable (binary or too large to capture).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders how merge conflicts were resolved during a turn.
 *
 * Emitted separately from the turn summary: a `git merge` can bring in hundreds
 * of files, and only the few that actually conflicted required a human-style
 * judgement call worth reviewing.
 */
export function MergeResolutionEntry({
  toolUse,
}: {
  toolUse: ToolUseByName<'merge-resolution'>;
}) {
  const { oursSha, theirsSha, theirsLabel, truncated } = toolUse.input;
  const files = toolUse.input.files ?? [];
  const [isExpanded, setIsExpanded] = useState(false);

  if (files.length === 0) return null;

  const count = files.length;

  return (
    <div className="relative pl-6">
      <div className="bg-status-run absolute top-2.5 -left-1 h-2 w-2 rounded-full" />
      <div className="py-1.5 pr-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => setIsExpanded((current) => !current)}
        >
          <GitMerge className="text-status-run h-3.5 w-3.5 shrink-0" />
          <span className="text-ink-1 text-xs">
            Resolved {count} merge conflict{count === 1 ? '' : 's'}
          </span>
          <span className="text-ink-3 truncate font-mono text-[10px]">
            {oursSha} ← {theirsSha}
            {theirsLabel ? ` · ${theirsLabel}` : ''}
          </span>
        </button>

        {truncated && (
          <p className="text-ink-3 mt-1 text-[10px]">
            Only the first {count} conflicted files are shown.
          </p>
        )}

        {isExpanded && (
          <div className="border-ink-3/20 mt-2 overflow-hidden rounded border">
            {files.map((file) => (
              <MergeFileRow key={file.filePath} file={file} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
