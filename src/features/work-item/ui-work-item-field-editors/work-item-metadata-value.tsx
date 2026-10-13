import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  beginMetadataEdit,
  beginMetadataSave,
  cancelMetadataEdit,
  finishMetadataSave,
} from '@/features/work-item/ui-work-item-preview/query-policy';

/**
 * Click-to-edit inline value used for Story points, Priority and Title.
 * Fully controlled by props — the caller supplies `onSave`, so no hook is
 * fetched or mutated here. `options` switches the editor to a native select.
 */
export function WorkItemMetadataValue({
  value,
  label,
  emptyLabel = label,
  options,
  className = 'text-ink-1 hover:text-acc-ink rounded px-1 py-0.5 text-xs',
  fullWidth = false,
  displayValue,
  validate,
  onSave,
}: {
  value: string;
  label: string;
  emptyLabel?: string;
  options?: string[];
  className?: string;
  fullWidth?: boolean;
  displayValue?: ReactNode;
  validate?: (value: string) => string | null;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const lifecycleRef = useRef({
    generation: 0,
    cancelled: false,
    inFlight: false,
  });
  const selectCommitRef = useRef(false);

  const save = async (nextValue = draft) => {
    const generation = beginMetadataSave(lifecycleRef.current);
    if (generation === null) return;
    const normalized = nextValue.trim();
    if (normalized === value) {
      if (finishMetadataSave(lifecycleRef.current, generation)) setEditing(false);
      return;
    }
    const validationError = validate?.(normalized);
    if (validationError) {
      if (finishMetadataSave(lifecycleRef.current, generation)) {
        setError(validationError);
      }
      return;
    }
    try {
      await onSave(normalized);
      if (finishMetadataSave(lifecycleRef.current, generation)) {
        setError(null);
        setEditing(false);
      }
    } catch (saveError) {
      if (finishMetadataSave(lifecycleRef.current, generation)) {
        setError(saveError instanceof Error ? saveError.message : 'Save failed');
      }
    }
  };

  const cancel = () => {
    cancelMetadataEdit(lifecycleRef.current);
    setDraft(value);
    setError(null);
    setEditing(false);
  };

  if (!editing) {
    const beginEdit = () => {
      beginMetadataEdit(lifecycleRef.current);
      setDraft(value);
      setError(null);
      setEditing(true);
    };
    return (
      <button type="button" className={className} onClick={beginEdit}>
        {displayValue ? displayValue : value || emptyLabel}
      </button>
    );
  }

  const inputClassName = `bg-bg-2 text-ink-1 min-w-0 rounded border border-white/10 px-1.5 py-1 text-xs outline-none${
    fullWidth ? ' w-full' : ''
  }`;

  return (
    <span
      className={`inline-flex min-w-0 flex-col${fullWidth ? ' flex-1' : ''}`}
    >
      {options ? (
        <select
          autoFocus
          aria-label={label}
          aria-invalid={!!error}
          value={draft}
          className={inputClassName}
          onChange={(event) => {
            selectCommitRef.current = true;
            setDraft(event.target.value);
            void save(event.target.value).finally(() => {
              selectCommitRef.current = false;
            });
          }}
          onBlur={() => {
            if (!selectCommitRef.current) setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              cancel();
            }
          }}
        >
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          autoFocus
          aria-label={label}
          aria-invalid={!!error}
          value={draft}
          className={inputClassName}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              event.stopPropagation();
              cancel();
            }
          }}
        />
      )}
      {error && (
        <span role="alert" className="mt-0.5 text-[10px] leading-tight text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
