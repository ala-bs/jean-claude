import clsx from 'clsx';
import { diffWordsWithSpace } from 'diff';

import { AzureHtmlContent } from '@/features/common/ui-azure-html-content';
import { formatRelativeTime } from '@/lib/time';
import type { WorkItemHistoryEntry } from '@/lib/api';

export function WorkItemHistory({
  history,
  isLoading,
  error,
  providerId,
}: {
  history: WorkItemHistoryEntry[];
  isLoading: boolean;
  error: string | null;
  providerId?: string;
}) {
  if (isLoading) {
    return <p className="text-ink-3 text-sm">Loading history...</p>;
  }

  if (error) {
    return <p className="text-status-fail text-sm">{error}</p>;
  }

  if (history.length === 0) {
    return <p className="text-ink-3 text-sm italic">No history found.</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {history.map((entry) => (
        <div
          key={entry.id}
          className="border-glass-border/60 rounded-md border bg-white/[0.018] px-3 py-2.5"
        >
          <div className="mb-2 flex items-baseline gap-2">
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <p className="text-ink-1 truncate text-[13px] font-medium">
                {entry.revisedBy}
              </p>
              <p
                className="text-ink-3 shrink-0 text-[11px]"
                title={
                  entry.revisedDate
                    ? new Date(entry.revisedDate).toLocaleString()
                    : undefined
                }
              >
                {entry.revisedDate
                  ? formatRelativeTime(entry.revisedDate)
                  : 'Unknown date'}
              </p>
            </div>
            <span className="text-ink-4 shrink-0 text-[11px]">
              #{entry.id}
            </span>
          </div>

          <div className="divide-glass-border/50 divide-y">
            {entry.fields.map((field) => (
              <HistoryChangeRow
                key={field.name}
                field={field}
                providerId={providerId}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryChangeRow({
  field,
  providerId,
}: {
  field: WorkItemHistoryEntry['fields'][number];
  providerId?: string;
}) {
  const isComment = field.name === 'Comment' || field.name === 'History';
  const showDiff = shouldShowHistoryTextDiff(field);

  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-1.5">
      <span className="text-ink-2 truncate text-[12px] font-medium">
        {isComment ? 'Comment' : formatHistoryFieldName(field.name)}
      </span>
      {isComment ? (
        <HistoryCommentValue value={field.newValue} providerId={providerId} />
      ) : showDiff ? (
        <HistoryTextDiff
          oldValue={field.oldValue ?? ''}
          newValue={field.newValue ?? ''}
        />
      ) : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_18px_minmax(0,1fr)] items-start gap-1.5">
          <HistoryValue value={field.oldValue} providerId={providerId} />
          <span className="text-ink-4 text-center text-[11px] leading-5">
            -&gt;
          </span>
          <HistoryValue value={field.newValue} providerId={providerId} />
        </div>
      )}
    </div>
  );
}

function HistoryCommentValue({
  value,
  providerId,
}: {
  value?: string;
  providerId?: string;
}) {
  if (!value) {
    return <span className="text-ink-4 text-[12px] italic">Empty</span>;
  }

  if (!value.includes('<')) {
    return (
      <p className="text-ink-1 text-[12px] leading-5 whitespace-pre-wrap">
        {value}
      </p>
    );
  }

  return (
    <AzureHtmlContent
      html={value}
      providerId={providerId}
      className="text-ink-1 text-[12px] leading-5"
      imageClassName="max-h-20 w-auto object-contain"
      enableImageModal
    />
  );
}

function HistoryValue({
  value,
  providerId,
}: {
  value?: string;
  providerId?: string;
}) {
  if (!value) {
    return <span className="text-ink-4 text-[12px] italic">Empty</span>;
  }

  if (!value.includes('<')) {
    return (
      <span className="text-ink-1 truncate text-[12px]" title={value}>
        {value}
      </span>
    );
  }

  return (
    <AzureHtmlContent
      html={value}
      providerId={providerId}
      className="text-ink-2 text-[12px] leading-5"
      imageClassName="max-h-16 w-auto object-contain"
      enableImageModal
    />
  );
}

function formatHistoryFieldName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bId\b/g, 'ID');
}

function shouldShowHistoryTextDiff(
  field: WorkItemHistoryEntry['fields'][number],
): boolean {
  const oldValue = field.oldValue ?? '';
  const newValue = field.newValue ?? '';
  if (!oldValue && !newValue) return false;
  if (oldValue === newValue) return false;

  const fieldName = field.name.toLowerCase();
  return (
    oldValue.includes('<') ||
    newValue.includes('<') ||
    oldValue.length > 40 ||
    newValue.length > 40 ||
    ['acceptance', 'criteria', 'description', 'repro', 'steps', 'title'].some(
      (part) => fieldName.includes(part),
    )
  );
}

function HistoryTextDiff({
  oldValue,
  newValue,
}: {
  oldValue: string;
  newValue: string;
}) {
  const changes = diffWordsWithSpace(
    plainHistoryValue(oldValue),
    plainHistoryValue(newValue),
  );

  return (
    <div className="min-w-0 rounded border border-white/[0.06] bg-black/10 px-2 py-1.5 text-[12px] leading-5">
      {changes.map((part, index) => (
        <span
          key={`${index}-${part.value}`}
          className={clsx(
            part.added &&
              'rounded bg-status-done/15 px-0.5 text-status-done',
            part.removed &&
              'rounded bg-status-fail/15 px-0.5 text-status-fail line-through decoration-status-fail/70',
            !part.added && !part.removed && 'text-ink-2',
          )}
        >
          {part.value}
        </span>
      ))}
    </div>
  );
}

function plainHistoryValue(value: string): string {
  if (!value.includes('<')) return value.trim();

  const element = document.createElement('div');
  element.innerHTML = value;
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}
