import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/common/ui/button';
import { Modal } from '@/common/ui/modal';

type JsonValue = unknown;

const INITIAL_EXPANDED_DEPTH = 2;
/** Entries rendered per node before a "show more" step, to bound huge arrays. */
const ENTRY_PAGE_SIZE = 200;

function isExpandable(
  value: JsonValue,
): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function entriesOf(value: Record<string, unknown> | unknown[]) {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
}

function summaryOf(value: Record<string, unknown> | unknown[]) {
  const count = Array.isArray(value)
    ? value.length
    : Object.keys(value).length;
  return Array.isArray(value) ? `[ ${count} ]` : `{ ${count} }`;
}

function ScalarValue({ value }: { value: JsonValue }) {
  if (typeof value === 'string') {
    return <span className="text-emerald-300">&quot;{value}&quot;</span>;
  }
  if (typeof value === 'number') {
    return <span className="text-amber-300">{value}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-sky-300">{String(value)}</span>;
  }
  return <span className="text-ink-3">null</span>;
}

function JsonNode({
  name,
  value,
  depth,
}: {
  name: string | null;
  value: JsonValue;
  depth: number;
}) {
  const [isExpanded, setIsExpanded] = useState(depth < INITIAL_EXPANDED_DEPTH);
  const [visibleCount, setVisibleCount] = useState(ENTRY_PAGE_SIZE);
  const toggle = useCallback(() => setIsExpanded((open) => !open), []);
  const showMore = useCallback(
    () => setVisibleCount((count) => count + ENTRY_PAGE_SIZE),
    [],
  );

  if (!isExpandable(value)) {
    return (
      <div className="flex gap-1.5 py-px pl-4">
        {name !== null ? <span className="text-violet-300">{name}:</span> : null}
        <ScalarValue value={value} />
      </div>
    );
  }

  const entries = entriesOf(value);

  return (
    <div className="py-px">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isExpanded}
        className="hover:bg-surface-container-high flex w-full items-center gap-1 rounded px-0.5 text-left"
      >
        {isExpanded ? (
          <ChevronDown className="text-ink-3 size-3 shrink-0" />
        ) : (
          <ChevronRight className="text-ink-3 size-3 shrink-0" />
        )}
        {name !== null ? <span className="text-violet-300">{name}:</span> : null}
        <span className="text-ink-3">{summaryOf(value)}</span>
      </button>
      {isExpanded ? (
        <div className="border-line-soft ml-[7px] border-l pl-2">
          {entries.length === 0 ? (
            <div className="text-ink-3 py-px pl-4">empty</div>
          ) : (
            <>
              {entries.slice(0, visibleCount).map(([key, child]) => (
                <JsonNode key={key} name={key} value={child} depth={depth + 1} />
              ))}
              {entries.length > visibleCount ? (
                <button
                  type="button"
                  onClick={showMore}
                  className="text-ink-3 hover:text-ink-1 py-px pl-4 text-left underline"
                >
                  Show {entries.length - visibleCount} more…
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Collapsible JSON tree. `value` is already-parsed JSON. */
export function JsonViewer({ value }: { value: JsonValue }) {
  return (
    <div className="text-ink-1 font-mono text-xs leading-relaxed">
      <JsonNode name={null} value={value} depth={0} />
    </div>
  );
}

/** Modal wrapper with a tree/raw toggle and copy-to-clipboard. */
export function JsonViewerModal({
  isOpen,
  onClose,
  json,
  title = 'JSON',
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Raw JSON text. */
  json: string;
  title?: string;
}) {
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => window.clearTimeout(copyTimeoutRef.current);
  }, []);

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(json) as JsonValue };
    } catch {
      return { ok: false as const, value: undefined };
    }
  }, [json]);

  // Stored JSON is compact; pretty-print it for the raw view.
  const rawText = useMemo(
    () => (parsed.ok ? JSON.stringify(parsed.value, null, 2) : json),
    [json, parsed],
  );

  const handleCopy = useCallback(() => {
    const flash = (state: 'copied' | 'failed') => {
      setCopyState(state);
      window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(
        () => setCopyState('idle'),
        1500,
      );
    };

    navigator.clipboard.writeText(rawText).then(
      () => flash('copied'),
      () => flash('failed'),
    );
  }, [rawText]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
      <div className="flex items-center gap-2 pb-3">
        <Button
          size="sm"
          variant={mode === 'tree' ? 'primary' : 'ghost'}
          onClick={() => setMode('tree')}
        >
          Tree
        </Button>
        <Button
          size="sm"
          variant={mode === 'raw' ? 'primary' : 'ghost'}
          onClick={() => setMode('raw')}
        >
          Raw
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={handleCopy}>
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy'}
        </Button>
      </div>

      <div className="bg-surface-container-lowest border-line-soft max-h-[60vh] overflow-auto rounded-md border p-3">
        {!parsed.ok ? (
          <div className="text-ink-3 text-sm">Invalid JSON</div>
        ) : mode === 'tree' ? (
          <JsonViewer value={parsed.value} />
        ) : (
          <pre className="text-ink-1 font-mono text-xs whitespace-pre">
            {rawText}
          </pre>
        )}
      </div>
    </Modal>
  );
}
