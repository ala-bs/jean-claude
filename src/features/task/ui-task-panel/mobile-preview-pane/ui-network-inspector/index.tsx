import { Ban, Check, ChevronRight, Copy, Funnel, Plus, X } from 'lucide-react';
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';

import {
  buildNetworkFilterSuggestions,
  formatCurlCommand,
  formatNetworkHeaders,
  formatNetworkPreview,
  getHeaderValue,
  getNetworkStatusClass,
  logNetworkFilterDebug,
  type NetworkDetailTab,
  type NetworkFilterContextMenuState,
  type NetworkFilterKey,
  type NetworkFilterSuggestion,
  type NetworkFilterToken,
  parseNetworkFilterToken,
} from '../utils-network';
import { IconButton } from '@/common/ui/icon-button';
import type { MobilePreviewNetworkRequest } from '@shared/mobile-simulator-types';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';

export function NetworkFacetButton({
  label,
  count,
  active,
  failed,
  onClick,
  onContextMenu,
  contextPath,
}: {
  label: string;
  count: number;
  active: boolean;
  failed?: boolean;
  onClick: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  contextPath?: string;
}) {
  return (
    <button
      type="button"
      data-network-filter-context={contextPath ? 'endpoint' : undefined}
      data-network-filter-path={contextPath}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseDown={(event) => {
        if (event.button === 2) onContextMenu?.(event);
      }}
      className={clsx(
        'flex h-[26px] w-full items-center gap-2 rounded-[3px] px-2 text-left transition-colors',
        active ? 'bg-zinc-800/70 text-ink-1' : 'text-ink-2 hover:bg-zinc-900/80',
      )}
    >
      <span
        className={clsx(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          failed ? 'bg-status-fail' : 'bg-emerald-300',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      <span className="text-ink-4 font-mono text-[10px]">{count}</span>
    </button>
  );
}


export function NetworkFilterChip({
  label,
  count,
  active,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: 'neutral' | 'danger' | 'success';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[3px] border px-1.5 text-[10px] font-medium transition-colors',
        active
          ? 'border-zinc-800 bg-zinc-800/70 text-ink-1'
          : 'border-transparent text-ink-2 hover:bg-zinc-900/80',
      )}
    >
      {tone !== 'neutral' ? (
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            tone === 'danger' ? 'bg-status-fail' : 'bg-emerald-300',
          )}
        />
      ) : null}
      {label}
      <span className="text-ink-4 font-mono text-[10px]">{count}</span>
    </button>
  );
}

export function NetworkFilterAutocomplete({
  tokens,
  onChange,
  requests,
  resultCount,
}: {
  tokens: NetworkFilterToken[];
  onChange: (tokens: NetworkFilterToken[]) => void;
  requests: MobilePreviewNetworkRequest[];
  resultCount: number;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestions = useMemo(
    () => buildNetworkFilterSuggestions({ draft, requests }),
    [draft, requests],
  );
  const isValueSuggestion = draft.replace(/^[-!]/, '').includes(':');

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const focusInput = () => inputRef.current?.focus();
  const addToken = (token: NetworkFilterToken) => {
    if (!token.value.trim()) return;
    logNetworkFilterDebug('autocomplete-add-token', { token });
    onChange([...tokens, token]);
    setDraft('');
    setHighlightedIndex(0);
    setOpen(true);
    requestAnimationFrame(focusInput);
  };
  const removeToken = (index: number) =>
    onChange(tokens.filter((_, tokenIndex) => tokenIndex !== index));
  const toggleToken = (index: number) =>
    onChange(
      tokens.map((token, tokenIndex) =>
        tokenIndex === index ? { ...token, neg: !token.neg } : token,
      ),
    );
  const applySuggestion = (suggestion: NetworkFilterSuggestion) => {
    if (suggestion.kind === 'key') {
      setDraft(`${suggestion.neg ? '-' : ''}${suggestion.key}:`);
      setHighlightedIndex(0);
      setOpen(true);
      requestAnimationFrame(focusInput);
      return;
    }
    addToken(suggestion.token);
  };
  const excludeSuggestion = (suggestion: NetworkFilterSuggestion) => {
    if (suggestion.kind !== 'value') return;
    addToken({ ...suggestion.token, neg: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const suggestion = suggestions[highlightedIndex];
      if (suggestion) applySuggestion(suggestion);
      else addToken(parseNetworkFilterToken(draft));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex((index) =>
        Math.min(index + 1, Math.max(0, suggestions.length - 1)),
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Backspace' && !draft && tokens.length > 0) {
      removeToken(tokens.length - 1);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative min-w-[260px] flex-1">
      <div
        role="button"
        tabIndex={-1}
        onClick={() => {
          focusInput();
          setOpen(true);
        }}
        className={clsx(
          'flex min-h-7 cursor-text items-center gap-1.5 rounded-[3px] border bg-zinc-950 px-2 transition-shadow',
          open
            ? 'border-acc shadow-[0_0_0_2px_color-mix(in_oklch,var(--color-acc)_24%,transparent)]'
            : 'border-zinc-800',
        )}
      >
        <Funnel
          className={clsx(
            'h-3.5 w-3.5 shrink-0',
            open ? 'text-acc' : 'text-ink-4',
          )}
        />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {tokens.map((token, index) => (
            <span
              key={`${token.key}:${token.value}:${token.exact ? 'exact' : 'partial'}:${index}`}
              className={clsx(
                'inline-flex h-5 shrink-0 items-center gap-1 rounded-[3px] border px-1.5 font-mono text-[10px]',
                token.neg
                  ? 'border-status-fail/40 bg-status-fail/10 text-ink-2'
                  : 'border-zinc-800 bg-zinc-900/80 text-ink-1',
              )}
            >
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleToken(index);
                }}
                title={token.neg ? 'Click to include' : 'Click to exclude'}
                className="inline-flex min-w-0 items-center gap-1"
              >
                {token.neg ? <Ban className="text-status-fail h-2.5 w-2.5" /> : null}
                {token.key !== 'text' ? (
                  <span className="text-ink-4">{token.key}:</span>
                ) : null}
                <span className={clsx('max-w-32 truncate', token.neg && 'line-through')}>
                  {token.value}
                </span>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  removeToken(index);
                }}
                className="text-ink-4 hover:text-ink-1 rounded-[2px] p-0.5"
                title="Remove filter"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setHighlightedIndex(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={tokens.length > 0 ? '' : 'Filter status:4xx, method:POST, -host:api'}
            className="text-ink-1 h-5 min-w-28 flex-1 border-0 bg-transparent font-mono text-[11px] outline-none placeholder:text-ink-4"
          />
        </div>
        {tokens.length > 0 || draft ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onChange([]);
              setDraft('');
              focusInput();
            }}
            className="text-ink-4 hover:text-ink-1 rounded-[3px] p-0.5"
            title="Clear filter"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {open && suggestions.length > 0 ? (
        <div className="absolute top-[calc(100%+4px)] right-0 left-0 z-40 max-h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-1 shadow-2xl">
          <div className="text-ink-4 px-2 py-1 text-[9px] font-semibold tracking-wide uppercase">
            {isValueSuggestion ? 'Values' : 'Filter by field'}
          </div>
          {suggestions.map((suggestion, index) => {
            const active = highlightedIndex === index;
            const isNegated =
              suggestion.kind === 'value' ? suggestion.token.neg : suggestion.neg;
            return (
              <button
                key={`${suggestion.kind}:${suggestion.label}:${index}`}
                type="button"
                onMouseEnter={() => setHighlightedIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySuggestion(suggestion);
                }}
                className={clsx(
                  'flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left transition-colors',
                  active ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/60',
                )}
              >
                {suggestion.kind === 'key' ? (
                  <ChevronRight className="text-ink-4 h-3 w-3 shrink-0" />
                ) : isNegated ? (
                  <Ban className="text-status-fail h-3 w-3 shrink-0" />
                ) : (
                  <Plus className="text-ink-4 h-3 w-3 shrink-0" />
                )}
                <span
                  className={clsx(
                    'text-ink-1 min-w-0 truncate font-mono text-[11px]',
                    isNegated && 'line-through',
                  )}
                >
                  {suggestion.label}
                </span>
                <span className="min-w-0 flex-1" />
                {suggestion.kind === 'key' ? (
                  <span className="text-ink-4 text-[10px]">{suggestion.hint}</span>
                ) : (
                  <>
                    {active && !isNegated ? (
                      <span
                        role="button"
                        tabIndex={-1}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          excludeSuggestion(suggestion);
                        }}
                        className="text-status-fail border-status-fail/30 bg-status-fail/10 inline-flex h-5 items-center gap-1 rounded-[3px] border px-1.5 text-[10px]"
                      >
                        <Ban className="h-2.5 w-2.5" />
                        Exclude
                      </span>
                    ) : null}
                    <span className="text-ink-4 min-w-5 text-right font-mono text-[10px]">
                      {suggestion.count}
                    </span>
                  </>
                )}
              </button>
            );
          })}
          <div className="text-ink-4 mt-1 flex items-center gap-2 border-t border-zinc-800 px-2 py-1.5 text-[10px]">
            <span className="font-mono">Enter add</span>
            <span className="font-mono">- exclude</span>
            <span className="font-mono">Backspace remove</span>
            <span className="min-w-0 flex-1" />
            <span className="font-mono">
              {resultCount} match{resultCount === 1 ? '' : 'es'}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function NetworkFilterContextMenu({
  state,
  onAddFilter,
  onClose,
}: {
  state: NetworkFilterContextMenuState;
  onAddFilter: (token: NetworkFilterToken) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const left = Math.max(0, Math.min(state.x, window.innerWidth - 260));
  const top = Math.max(0, Math.min(state.y, window.innerHeight - 244));

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const addFilter = (key: Exclude<NetworkFilterKey, 'text'>, value: string, neg: boolean) => {
    const token = {
      key,
      value,
      neg,
      exact: key === 'host' || key === 'path' || undefined,
    };
    logNetworkFilterDebug('context-menu-add-token', { token });
    onAddFilter(token);
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 w-64 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 shadow-2xl"
      style={{ left, top }}
      role="menu"
    >
      <div className="border-b border-zinc-800 px-3 py-2">
        <div className="text-ink-4 text-[9px] font-semibold tracking-wide uppercase">
          {state.title}
        </div>
        <div className="text-ink-2 mt-1 truncate font-mono text-[10px]">
          {state.subtitle}
        </div>
      </div>
      <div className="p-1">
        {state.items.map((item) => (
          <button
            key={`${item.key}:${item.value}`}
            type="button"
            role="menuitem"
            onClick={() => addFilter(item.key, item.value, false)}
            className="hover:bg-zinc-800/80 flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left"
          >
            <Plus className="text-ink-4 h-3 w-3 shrink-0" />
            <span className="text-ink-4 w-12 shrink-0 text-[10px]">{item.key}</span>
            <span className="text-ink-1 min-w-0 truncate font-mono text-[11px]">
              {item.value}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t border-zinc-800 p-1">
        {state.items.map((item) => (
          <button
            key={`exclude:${item.key}:${item.value}`}
            type="button"
            role="menuitem"
            onClick={() => addFilter(item.key, item.value, true)}
            className="hover:bg-zinc-800/80 flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left"
          >
            <Ban className="text-status-fail h-3 w-3 shrink-0" />
            <span className="text-status-fail w-12 shrink-0 text-[10px]">
              not {item.key}
            </span>
            <span className="text-ink-2 min-w-0 truncate font-mono text-[11px] line-through">
              {item.value}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function NetworkDetailSection({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return (
    <section className="grid gap-1">
      <div className="text-ink-3 text-[10px] font-semibold tracking-wide uppercase">
        {title}
      </div>
      <pre className="text-ink-1 max-h-52 overflow-auto rounded-[3px] border border-zinc-900/90 bg-black/35 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {children}
      </pre>
    </section>
  );
}

export function NetworkRequestDetails({
  request,
  onClose,
}: {
  request: MobilePreviewNetworkRequest;
  onClose: () => void;
}) {
  const [detailWidth, setDetailWidth] = useState(392);
  const [activeDetailTab, setActiveDetailTab] =
    useState<NetworkDetailTab>('all');
  const [copiedCurl, setCopiedCurl] = useState(false);
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: detailWidth,
    minWidth: 320,
    maxWidth: 760,
    maxWidthFraction: 0.75,
    direction: 'left',
    onWidthChange: setDetailWidth,
  });
  const requestCookies = getHeaderValue(request.requestHeaders, 'cookie');
  const responseCookies = getHeaderValue(
    request.responseHeaders,
    'set-cookie',
  );

  useEffect(() => {
    queueMicrotask(() => setCopiedCurl(false));
  }, [request.id]);

  const handleCopyCurl = useCallback(async () => {
    await navigator.clipboard.writeText(formatCurlCommand(request));
    setCopiedCurl(true);
    window.setTimeout(() => setCopiedCurl(false), 1400);
  }, [request]);

  const tlsDuration = request.decrypted ? 18 : 0;
  const waitingDuration = Math.max(
    1,
    Math.round((request.durationMs ?? 0) * 0.62),
  );
  const downloadDuration = Math.max(
    1,
    Math.round((request.durationMs ?? 0) * 0.18),
  );
  const timingSections: Array<[string, number, string]> = request.decrypted
    ? [
        ['DNS', 4, 'bg-ink-4'],
        ['Connect', 12, 'bg-sky-300'],
        ['TLS', tlsDuration, 'bg-cyan-300'],
        ['Waiting (TTFB)', waitingDuration, 'bg-amber-400'],
        ['Download', downloadDuration, 'bg-emerald-300'],
      ]
    : [
        ['DNS', 4, 'bg-ink-4'],
        ['Connect', 12, 'bg-sky-300'],
        ['Waiting (TTFB)', waitingDuration, 'bg-amber-400'],
        ['Download', downloadDuration, 'bg-emerald-300'],
      ];
  const rawTimingTotal =
    4 + 12 + tlsDuration + waitingDuration + downloadDuration;
  const timingTotal = rawTimingTotal > 1 ? rawTimingTotal : 1;
  const tabs: Array<{ value: NetworkDetailTab; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'headers', label: 'Headers' },
    { value: 'body', label: 'Body' },
    { value: 'request', label: 'Request' },
    { value: 'timing', label: 'Timing' },
  ];

  return (
    <aside
      style={{ width: detailWidth }}
      className="relative flex min-w-[320px] max-w-[75%] flex-col border-l border-zinc-900/90 bg-zinc-950/80"
    >
      <div
        onMouseDown={handleMouseDown}
        className={clsx(
          'hover:bg-acc/50 absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors',
          isDragging && 'bg-acc/50',
        )}
      />
      <div className="flex items-start justify-between gap-3 border-b border-zinc-900/90 px-3 py-1.5">
        <div className="min-w-0">
          <div className="text-ink-1 flex items-center gap-2 text-[13px] font-medium">
            <span className="font-mono">{request.method}</span>
            <span className={clsx('font-mono', getNetworkStatusClass(request))}>
              {request.status ?? '-'}
            </span>
          </div>
          <div className="text-ink-3 truncate font-mono text-[11px]">
            {request.url}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            size="sm"
            variant="ghost"
            icon={copiedCurl ? <Check /> : <Copy />}
            tooltip={copiedCurl ? 'Copied curl' : 'Copy as curl'}
            onClick={handleCopyCurl}
          />
          <IconButton
            size="sm"
            variant="ghost"
            icon={<X />}
            tooltip="Close"
            onClick={onClose}
          />
        </div>
      </div>
      <div className="flex shrink-0 gap-1 border-b border-zinc-900/90 px-2 py-1">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setActiveDetailTab(tab.value)}
            className={clsx(
              'h-5 rounded-[3px] px-2 text-[10px] font-medium transition-colors',
              activeDetailTab === tab.value
                ? 'bg-zinc-800/70 text-ink-1'
                : 'text-ink-3 hover:bg-zinc-900/80 hover:text-ink-1',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {request.error ? (
          <div className="border-status-fail/40 bg-status-fail/10 text-status-fail mb-3 rounded border px-2 py-1.5 text-xs">
            {request.error}
          </div>
        ) : null}
        <div className="grid gap-2.5">
          {(activeDetailTab === 'all' || activeDetailTab === 'timing') ? (
            <section className="grid gap-1.5">
              <div className="text-ink-3 text-[10px] font-semibold tracking-wide uppercase">
                Timing · {request.durationMs === null ? '-' : `${request.durationMs}ms`}
              </div>
              <div className="grid gap-1.5">
                {timingSections.map(([label, duration, colorClass]) => (
                  <div key={label} className="grid grid-cols-[88px_1fr_40px] items-center gap-2">
                    <span className="text-ink-3 text-[11px]">{label}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
                      <span
                        className={clsx('block h-full rounded-full', colorClass)}
                        style={{ width: `${(duration / timingTotal) * 100}%` }}
                      />
                    </span>
                    <span className="text-ink-3 text-right font-mono text-[10px]">
                      {duration}ms
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {(activeDetailTab === 'all' || activeDetailTab === 'headers') ? (
            <>
              <NetworkDetailSection title="Response headers">
                {formatNetworkHeaders(request.responseHeaders)}
              </NetworkDetailSection>
              <NetworkDetailSection title="Response cookies">
                {responseCookies ?? '-'}
              </NetworkDetailSection>
            </>
          ) : null}
          {(activeDetailTab === 'all' || activeDetailTab === 'request') ? (
            <>
              <NetworkDetailSection title="Request headers">
                {formatNetworkHeaders(request.requestHeaders)}
              </NetworkDetailSection>
              <NetworkDetailSection title="Request cookies">
                {requestCookies ?? '-'}
              </NetworkDetailSection>
              <NetworkDetailSection title="Request body">
                {formatNetworkPreview(request.requestBodyPreview)}
              </NetworkDetailSection>
            </>
          ) : null}
          {(activeDetailTab === 'all' || activeDetailTab === 'body') ? (
            <NetworkDetailSection title="Response body">
              {formatNetworkPreview(request.responseBodyPreview)}
            </NetworkDetailSection>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
