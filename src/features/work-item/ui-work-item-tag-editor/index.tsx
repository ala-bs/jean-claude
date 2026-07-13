import { Loader2, X } from 'lucide-react';
import {
  normalizeAzureWorkItemTags,
  parseAzureWorkItemTags,
  serializeAzureWorkItemTags,
} from '@/features/work-item/ui-work-item-board/utils';
import {
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useDropdownPosition } from '@/common/hooks/use-dropdown-position';
import { useRegisterOverlay } from '@/common/context/overlay';

export function WorkItemTagEditor({
  value,
  suggestions,
  onSave,
}: {
  value: string;
  suggestions: string[];
  onSave: (value: string) => Promise<unknown>;
}) {
  const id = useId();
  const listboxId = `work-item-tags-${id}`;
  const [tags, setTags] = useState(() =>
    normalizeAzureWorkItemTags(parseAzureWorkItemTags(value)),
  );
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const position = useDropdownPosition({
    isOpen,
    triggerRef,
    side: 'bottom',
    align: 'left',
    preferredMaxHeight: 220,
  });
  const selectedKeys = useMemo(
    () => new Set(tags.map((tag) => tag.toLocaleLowerCase())),
    [tags],
  );
  const filteredSuggestions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizeAzureWorkItemTags(suggestions).filter(
      (suggestion) =>
        !selectedKeys.has(suggestion.toLocaleLowerCase()) &&
        (!normalizedQuery || suggestion.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [query, selectedKeys, suggestions]);
  const activeFocusedIndex = Math.min(
    focusedIndex,
    Math.max(filteredSuggestions.length - 1, 0),
  );
  const showSuggestions = isOpen && filteredSuggestions.length > 0;

  const close = () => {
    setIsOpen(false);
    setFocusedIndex(0);
  };

  useRegisterOverlay({
    id: `work-item-tag-editor-${id}`,
    refs: [triggerRef, popupRef],
    onClose: close,
    enabled: isOpen,
  });

  const saveTags = async (nextTags: string[]) => {
    if (isSaving) return;
    const normalizedTags = normalizeAzureWorkItemTags(nextTags);
    if (serializeAzureWorkItemTags(normalizedTags) === serializeAzureWorkItemTags(tags)) {
      setQuery('');
      return;
    }

    const previousTags = tags;
    const previousQuery = query;
    setTags(normalizedTags);
    setQuery('');
    setError(null);
    setIsSaving(true);
    try {
      await onSave(serializeAzureWorkItemTags(normalizedTags));
    } catch (saveError) {
      setTags(previousTags);
      setQuery(previousQuery);
      setError(saveError instanceof Error ? saveError.message : 'Failed to save tags');
    } finally {
      setIsSaving(false);
      inputRef.current?.focus();
    }
  };

  const addTag = (tag: string) => {
    void saveTags([...tags, ...tag.split(/[;,]/)]);
  };

  return (
    <div className="relative min-w-0">
      <div
        ref={triggerRef}
        className="border-line bg-bg-0 flex min-h-8 min-w-0 flex-wrap items-center gap-1 border px-2 py-1"
      >
        <span className="text-ink-3 mr-0.5 text-[11px]">Tags</span>
        {tags.map((tag) => (
          <span
            key={tag.toLocaleLowerCase()}
            className="bg-bg-3 text-ink-1 inline-flex min-w-0 items-center gap-1 px-1.5 py-0.5 text-[10px]"
            title={tag}
          >
            <span className="max-w-32 truncate">{tag}</span>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => void saveTags(tags.filter((item) => item !== tag))}
              className="text-ink-3 hover:text-ink-0 disabled:opacity-40"
              aria-label={`Remove ${tag} tag`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Add tag"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? listboxId : undefined}
          aria-activedescendant={
            showSuggestions ? `${listboxId}-option-${activeFocusedIndex}` : undefined
          }
          aria-autocomplete="list"
          disabled={isSaving}
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setFocusedIndex(0);
            setIsOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && filteredSuggestions.length > 0) {
              event.preventDefault();
              setFocusedIndex((index) => (index + 1) % filteredSuggestions.length);
            } else if (event.key === 'ArrowUp' && filteredSuggestions.length > 0) {
              event.preventDefault();
              setFocusedIndex((index) =>
                index <= 0 ? filteredSuggestions.length - 1 : index - 1,
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const suggestion = filteredSuggestions[activeFocusedIndex];
              if (suggestion) addTag(suggestion);
              else if (query.trim()) addTag(query);
            } else if (event.key === ',' || event.key === ';') {
              event.preventDefault();
              if (query.trim()) addTag(query);
            } else if (event.key === 'Backspace' && !query && tags.length > 0) {
              event.preventDefault();
              void saveTags(tags.slice(0, -1));
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
          placeholder={tags.length === 0 ? 'Add tag...' : '+'}
          className="text-ink-1 placeholder:text-ink-3 min-w-12 flex-1 bg-transparent text-[11px] outline-none disabled:cursor-wait"
        />
        {isSaving && <Loader2 className="text-ink-3 h-3 w-3 animate-spin" />}
      </div>
      {error && (
        <span role="alert" className="text-status-fail absolute top-full left-0 z-10 mt-1 text-[10px]">
          {error}
        </span>
      )}
      {showSuggestions && position && createPortal(
        <div
          ref={popupRef}
          id={listboxId}
          role="listbox"
          aria-label="Existing tags"
          className="bg-bg-1 border-line fixed z-[70] overflow-y-auto border py-1 shadow-xl"
          style={{
            top: position.actualSide === 'bottom' ? position.top : undefined,
            bottom: position.actualSide === 'top' ? window.innerHeight - position.top : undefined,
            left: position.actualAlign === 'left' ? position.left : undefined,
            right: position.actualAlign === 'right' ? window.innerWidth - position.left : undefined,
            width: Math.max(position.width, 180),
            maxHeight: position.maxHeight,
            maxWidth: position.maxWidth,
          }}
        >
          {filteredSuggestions.map((suggestion, index) => (
            <button
              key={suggestion.toLocaleLowerCase()}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeFocusedIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setFocusedIndex(index)}
              onClick={() => addTag(suggestion)}
              className={`text-ink-1 block w-full truncate px-2.5 py-1.5 text-left text-xs ${
                index === activeFocusedIndex ? 'bg-bg-3' : 'hover:bg-bg-2'
              }`}
            >
              {suggestion}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
