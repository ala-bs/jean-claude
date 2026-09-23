import { Check, ChevronDown, GitBranch, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import type { BranchInfo } from '@shared/types';
import { formatRelativeTime } from '@/lib/time';

/** Task branches are namespaced by the app; the prefix is noise in a list of them. */
function shortBranch(name: string): string {
  return name.replace(/^jean-claude\//, '');
}

function BranchOption({
  label,
  title,
  selected,
  onToggle,
  meta,
  isMono = true,
}: {
  label: string;
  title?: string;
  selected: boolean;
  onToggle: () => void;
  meta?: React.ReactNode;
  isMono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={clsx(
        'hover:bg-glass-light grid w-full grid-cols-[13px_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
        selected && 'bg-bg-2',
      )}
    >
      <span className={clsx('flex', selected ? 'text-acc-ink' : 'text-transparent')}>
        <Check size={12} />
      </span>
      <span
        title={title ?? label}
        className={clsx(
          'text-ink-1 truncate',
          isMono ? 'font-mono text-[11.5px]' : 'text-[12.5px]',
        )}
      >
        {label}
      </span>
      {meta && (
        <span className="text-ink-4 font-mono text-[10.5px] whitespace-nowrap">
          {meta}
        </span>
      )}
    </button>
  );
}

/**
 * Multi-select branch filter for the history pane.
 *
 * Selecting nothing means "every branch", which is what the unfiltered graph
 * already walks — so an empty selection and an explicit all-branches choice are
 * deliberately the same state rather than two that render identically.
 */
export function BranchFilter({
  branches,
  selected,
  onChange,
  currentBranch,
}: {
  branches: BranchInfo[];
  selected: string[];
  onChange: (branches: string[]) => void;
  currentBranch: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const container = useRef<HTMLDivElement>(null);

  // Closes on an outside click. Pointerdown rather than click so the popover
  // does not survive a drag that starts outside it.
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = branches.filter((branch) =>
      branch.name.toLowerCase().includes(needle),
    );
    const isTaskBranch = (branch: BranchInfo) =>
      branch.name.startsWith('jean-claude/');

    return [
      {
        label: 'Checked out',
        items: visible.filter((branch) => branch.name === currentBranch),
      },
      {
        label: 'Task branches',
        items: visible.filter(
          (branch) => branch.name !== currentBranch && isTaskBranch(branch),
        ),
      },
      {
        label: 'Other branches',
        items: visible.filter(
          (branch) => branch.name !== currentBranch && !isTaskBranch(branch),
        ),
      },
    ].filter((group) => group.items.length > 0);
  }, [branches, currentBranch, query]);

  const toggle = (name: string) => {
    onChange(
      selected.includes(name)
        ? selected.filter((entry) => entry !== name)
        : [...selected, name],
    );
  };

  const label =
    selected.length === 0
      ? 'All branches'
      : selected.length === 1
        ? shortBranch(selected[0])
        : `${selected.length} branches`;

  return (
    <div ref={container} className="relative min-w-0 shrink-0">
      <button
        type="button"
        onClick={() => {
          setIsOpen((open) => !open);
          setQuery('');
        }}
        title={selected.length > 0 ? selected.join('\n') : 'Filter history by branch'}
        className={clsx(
          'inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-md border pr-[7px] pl-2 transition-colors',
          selected.length > 0
            ? 'bg-acc-soft border-acc-line text-acc-ink'
            : 'border-line bg-bg-2 text-ink-1 hover:text-ink-0',
        )}
      >
        <GitBranch size={12} className="shrink-0 opacity-80" />
        <span
          className={clsx(
            'truncate',
            selected.length === 1 ? 'font-mono text-[11.5px]' : 'text-[12.5px]',
          )}
        >
          {label}
        </span>
        <ChevronDown size={11} className="shrink-0 opacity-70" />
      </button>

      {isOpen && (
        <div className="border-line bg-bg-1 absolute top-[30px] right-0 z-50 w-[320px] overflow-hidden rounded-lg border shadow-[0_18px_44px_-12px_rgba(0,0,0,0.6)]">
          <div className="border-line-soft flex items-center gap-[7px] border-b px-2.5 py-2">
            <Search size={12} className="text-ink-4 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setIsOpen(false);
                }
              }}
              placeholder="Filter branches"
              spellCheck={false}
              className="text-ink-0 placeholder:text-ink-4 min-w-0 flex-1 border-none bg-transparent text-[12.5px] outline-none"
            />
          </div>

          <div className="max-h-[330px] overflow-y-auto p-1.5">
            <BranchOption
              label="All branches"
              isMono={false}
              selected={selected.length === 0}
              onToggle={() => {
                onChange([]);
                setIsOpen(false);
              }}
            />

            {groups.map((group) => (
              <div key={group.label}>
                <div className="text-ink-4 px-2 pt-2 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
                  {group.label}
                </div>
                {group.items.map((branch) => (
                  <BranchOption
                    key={branch.name}
                    label={shortBranch(branch.name)}
                    title={branch.name}
                    selected={selected.includes(branch.name)}
                    onToggle={() => toggle(branch.name)}
                    meta={
                      branch.lastCommitDate
                        ? formatRelativeTime(branch.lastCommitDate)
                        : undefined
                    }
                  />
                ))}
              </div>
            ))}

            {groups.length === 0 && (
              <div className="text-ink-4 px-2 py-3.5 text-xs">
                No branch matches “{query}”
              </div>
            )}
          </div>

          {selected.length > 0 && (
            <div className="border-line-soft flex items-center justify-between border-t px-2.5 py-2">
              <span className="text-ink-4 font-mono text-[10.5px]">
                {selected.length} selected
              </span>
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-ink-2 hover:text-ink-0 text-[11.5px] transition-colors"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
