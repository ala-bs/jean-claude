import { Search, X } from 'lucide-react';
import clsx from 'clsx';
import { forwardRef } from 'react';

import { Kbd } from '@/common/ui/kbd';

/**
 * Search field for the history pane.
 *
 * The query is resolved by git rather than filtered in the renderer, so `count`
 * is the number of matches across the whole repository — not just the pages
 * that happen to be loaded.
 *
 * Ref-forwarded so the pane's ⌘F binding can focus it without reaching into the
 * DOM by id.
 */
export const CommitSearch = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    /** Matches across the repository, or undefined while the count is loading. */
    count: number | undefined;
    isCounting: boolean;
  }
>(function CommitSearch({ value, onChange, count, isCounting }, ref) {
  const isActive = value.trim().length > 0;

  return (
    <div
      className={clsx(
        'flex h-[26px] max-w-[244px] min-w-[108px] flex-1 items-center gap-[7px] rounded-md border pr-2 pl-[9px] transition-colors',
        isActive ? 'border-acc-line bg-bg-2' : 'border-line bg-bg-2',
      )}
    >
      <Search
        size={12}
        className={clsx('shrink-0', isActive ? 'text-acc-ink' : 'text-ink-4')}
      />
      <input
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Stopped here so Escape clears the query instead of bubbling up to
            // whatever the surrounding scope binds it to.
            event.stopPropagation();
            onChange('');
            event.currentTarget.blur();
          }
        }}
        placeholder="Search commits"
        spellCheck={false}
        className="text-ink-0 placeholder:text-ink-4 min-w-0 flex-1 border-none bg-transparent text-[12.5px] outline-none"
      />
      {isActive ? (
        <>
          <span className="text-ink-4 font-mono text-[10.5px] tabular-nums whitespace-nowrap">
            {isCounting ? '…' : (count?.toLocaleString() ?? '')}
          </span>
          <button
            type="button"
            onClick={() => onChange('')}
            title="Clear search"
            className="text-ink-3 hover:text-ink-0 flex shrink-0 rounded p-0.5 transition-colors"
          >
            <X size={11} />
          </button>
        </>
      ) : (
        <Kbd shortcut="cmd+f" />
      )}
    </div>
  );
});
