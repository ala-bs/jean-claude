import { Check, ChevronDown, Search } from 'lucide-react';
import React, {
  startTransition,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';

import { type ComponentSize, sizeClasses } from '@/common/ui/styles';
import { Input } from '@/common/ui/input';
import { useDropdownPosition } from '@/common/hooks/use-dropdown-position';
import { useRegisterOverlay } from '@/common/context/overlay';



export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  /** Renders a sticky header when it differs from the previous option's. */
  group?: string;
  /**
   * Extra terms matched by the search box but not displayed. Use for facets a
   * user would reasonably type that are not in the label or description.
   */
  keywords?: string[];
}

export function Combobox({
  value,
  options,
  onChange,
  disabled,
  label,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  emptyLabel = 'No options found',
  size = 'md',
  className,
  contentClassName,
  renderOptionTrailing,
  onOpenChange,
}: {
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  size?: ComponentSize;
  className?: string;
  contentClassName?: string;
  /**
   * Optional trailing control rendered at the right edge of an option row
   * (e.g. a favorite toggle). Rendered as a SIBLING of the row button, not a
   * child: a nested button would be invalid HTML and would swallow the row's
   * own click. Return null for rows that should not have one.
   */
  renderOptionTrailing?: (option: ComboboxOption) => React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const id = useId();
  const listboxId = `combobox-listbox-${id}`;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const position = useDropdownPosition({
    isOpen,
    triggerRef,
    side: 'bottom',
    align: 'left',
  });

  const selectedOption = options.find((option) => option.value === value);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const s = sizeClasses[size];
  const chevronSize =
    size === 'xs' || size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const heightOrPy = s.height || s.py;

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return options;

    return options.filter((option) => {
      const haystack = [
        option.label,
        option.description,
        option.value,
        ...(option.keywords ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [options, query]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setFocusedIndex(0);
    onOpenChange?.(false);
    triggerRef.current?.focus();
  }, [onOpenChange]);

  const open = useCallback(() => {
    if (disabled) return;
    setIsOpen(true);
    setQuery('');
    setFocusedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    onOpenChange?.(true);
  }, [disabled, onOpenChange, selectedIndex]);

  function handleSelect(option: ComboboxOption) {
    onChange(option.value);
    close();
  }

  // Focus stays in the search input, so the highlight is purely visual and the
  // browser will not scroll it into view on its own.
  useEffect(() => {
    if (!isOpen) return;
    const options =
      contentRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    options?.[focusedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(timer);
  }, [isOpen]);

  useEffect(() => {
    if (focusedIndex >= filteredOptions.length) {
      startTransition(() => setFocusedIndex(Math.max(filteredOptions.length - 1, 0)));
    }
  }, [filteredOptions.length, focusedIndex]);

  useRegisterOverlay({
    id: `combobox-${id}`,
    refs: [triggerRef, contentRef],
    onClose: close,
    enabled: isOpen,
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={isOpen ? close : open}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-label={label}
        className={clsx(
          'bg-glass-light hover:bg-glass-medium text-ink-1 flex min-w-0 items-center transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          heightOrPy,
          s.text,
          s.px,
          s.radius,
          s.gap,
          className,
        )}
      >
        <span
          className={clsx(
            'truncate',
            selectedOption ? 'text-ink-1' : 'text-ink-3',
          )}
        >
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown className={chevronSize} aria-hidden />
      </button>

      {isOpen &&
        position &&
        createPortal(
          <div
            ref={contentRef}
            // Portaled outside any modal, so a focus lock must not reclaim the
            // search input this popover focuses on open.
            data-focus-portal="true"
            className={clsx(
              'bg-bg-1 border-glass-border fixed z-[70] overflow-hidden rounded-md border shadow-xl',
              contentClassName,
            )}
            style={{
              top: position.actualSide === 'bottom' ? position.top : undefined,
              bottom:
                position.actualSide === 'top'
                  ? window.innerHeight - position.top
                  : undefined,
              left: position.actualAlign === 'left' ? position.left : undefined,
              right:
                position.actualAlign === 'right'
                  ? window.innerWidth - position.left
                  : undefined,
              maxHeight: position.maxHeight,
              maxWidth: position.maxWidth,
            }}
          >
            <div className="border-line-soft border-b p-2">
              <Input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setFocusedIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setFocusedIndex((current) =>
                      filteredOptions.length === 0
                        ? 0
                        : (current + 1) % filteredOptions.length,
                    );
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setFocusedIndex((current) =>
                      filteredOptions.length === 0
                        ? 0
                        : current <= 0
                          ? filteredOptions.length - 1
                          : current - 1,
                    );
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    const option = filteredOptions[focusedIndex];
                    if (option) handleSelect(option);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    close();
                  }
                }}
                placeholder={searchPlaceholder}
                size="sm"
                icon={<Search />}
              />
            </div>
            <div
              id={listboxId}
              role="listbox"
              aria-orientation="vertical"
              aria-label={label}
              className="overflow-y-auto py-1"
              style={{ maxHeight: Math.max(position.maxHeight - 48, 80) }}
            >
              {filteredOptions.length === 0 ? (
                <p className="text-ink-3 px-3 py-2 text-sm">{emptyLabel}</p>
              ) : (
                filteredOptions.map((option, index) => {
                  // Headers compare against the previous FILTERED option, so a
                  // group whose only matches were filtered out shows no header.
                  const previousGroup =
                    index > 0 ? filteredOptions[index - 1].group : null;
                  const showGroupLabel =
                    option.group && option.group !== previousGroup;
                  const trailing = renderOptionTrailing?.(option) ?? null;

                  const optionButton = (
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.value === value}
                      onMouseEnter={() => setFocusedIndex(index)}
                      onClick={() => handleSelect(option)}
                      className={clsx(
                        'flex w-full items-center text-left transition-colors focus:outline-none',
                        s.text,
                        s.gap,
                        s.px,
                        s.py,
                        // Reserve room so the label never runs under the
                        // absolutely positioned trailing control.
                        trailing && 'pr-9',
                        // Clears the sticky group header when scrolled into view.
                        'scroll-mt-6',
                        index === focusedIndex && 'bg-glass-medium',
                        option.value === value ? 'text-ink-1' : 'text-ink-2',
                      )}
                    >
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                        {option.value === value && <Check className="h-3 w-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span
                          className={clsx(
                            'block truncate',
                            option.value === value
                              ? 'text-ink-1 font-medium'
                              : 'text-ink-1',
                          )}
                        >
                          {option.label}
                        </span>
                        {option.description && (
                          <span className="text-ink-3 block truncate text-xs">
                            {option.description}
                          </span>
                        )}
                      </div>
                    </button>
                  );

                  return (
                    <React.Fragment key={option.value}>
                      {showGroupLabel && (
                        <div
                          role="presentation"
                          className="text-ink-4 bg-bg-1 sticky -top-1 z-10 px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.14em] uppercase first:pt-1"
                        >
                          {option.group}
                        </div>
                      )}
                      {trailing ? (
                        <div
                          role="presentation"
                          className="relative"
                          // The trailing control overlays the row's right edge,
                          // so entering it directly never fires the button's
                          // own mouseenter. Without this, hovering a star and
                          // pressing Enter would select a different row.
                          onMouseEnter={() => setFocusedIndex(index)}
                        >
                          {optionButton}
                          <span className="absolute top-1/2 right-1 -translate-y-1/2">
                            {trailing}
                          </span>
                        </div>
                      ) : (
                        optionButton
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
