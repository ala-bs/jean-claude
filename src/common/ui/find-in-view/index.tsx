import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';

export { useFindInView } from './use-find-in-view';

export const FindInViewBar = forwardRef<
  { focus: () => void },
  {
    query: string;
    onQueryChange: (query: string) => void;
    currentMatch: number;
    totalMatches: number;
    onNext: () => void;
    onPrevious: () => void;
    onClose: () => void;
    placeholder?: string;
    className?: string;
  }
>(function FindInViewBar(
  {
    query,
    onQueryChange,
    currentMatch,
    totalMatches,
    onNext,
    onPrevious,
    onClose,
    placeholder = 'Find in page...',
    className,
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }));

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) onPrevious();
        else onNext();
      }
    },
    [onClose, onNext, onPrevious],
  );

  return (
    <div
      data-find-in-view-ignore
      className={`border-glass-border bg-bg-1 flex items-center gap-1 rounded-md border px-2 py-1 shadow-lg ${className ?? ''}`}
    >
      <Input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        size="sm"
        className="w-40 border-none bg-transparent p-0 focus:border-none"
      />

      <span className="text-ink-2 min-w-[4rem] text-center text-xs">
        {query ? (
          totalMatches > 0 ? (
            `${currentMatch} of ${totalMatches}`
          ) : (
            'No results'
          )
        ) : (
          <>&nbsp;</>
        )}
      </span>

      <IconButton
        onClick={onPrevious}
        disabled={totalMatches === 0}
        icon={<ChevronUp />}
        size="sm"
        variant="ghost"
        aria-label="Previous match"
      />
      <IconButton
        onClick={onNext}
        disabled={totalMatches === 0}
        icon={<ChevronDown />}
        size="sm"
        variant="ghost"
        aria-label="Next match"
      />
      <IconButton
        onClick={onClose}
        icon={<X />}
        size="sm"
        variant="ghost"
        aria-label="Close search"
      />
    </div>
  );
});
