import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  type AzureFieldRefName,
  type WorkItemFieldMetadata,
  type WorkItemFieldValue,
  type WorkItemIdentity,
} from '@shared/work-item-field-types';
import { simplifyWorkItemHtml } from '@shared/work-item-html';

import { AzureHtmlContent } from '@/features/common/ui-azure-html-content';
import { Chip } from '@/common/ui/chip';
import { formatRelativeTime } from '@/lib/time';
import { UserAvatar } from '@/common/ui/user-avatar';

export const EMPTY_FIELD_PLACEHOLDER = '—';

/**
 * F5: a value whose runtime type disagrees with the declared metadata type
 * falls back to `String(value)`, and we warn exactly once per refName so a
 * mis-typed field in a busy board does not flood the console.
 */
const warnedRefNames = new Set<AzureFieldRefName>();

function warnTypeMismatch(params: {
  refName: AzureFieldRefName;
  type: string;
  value: WorkItemFieldValue;
}): void {
  if (warnedRefNames.has(params.refName)) return;
  warnedRefNames.add(params.refName);
  console.warn(
    `[WorkItemFieldRows] field "${params.refName}" is declared as "${params.type}" but its value is ${typeof params.value}; falling back to string rendering`,
  );
}

function isIdentity(value: WorkItemFieldValue): value is WorkItemIdentity {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.displayName === 'string'
  );
}

function stringifyValue(value: WorkItemFieldValue): string {
  return isIdentity(value) ? value.displayName : String(value);
}

function fallback(params: {
  refName: AzureFieldRefName;
  type: string;
  value: WorkItemFieldValue;
}): ReactNode {
  warnTypeMismatch(params);
  return <span className="truncate">{stringifyValue(params.value)}</span>;
}

/** Last segment of an Azure area/iteration path; both separators appear in the wild. */
function lastPathSegment(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

/**
 * Sanitized plain text for the compact board variant: the same
 * `simplifyWorkItemHtml` pass used everywhere else, then all remaining markup
 * dropped. The result is rendered as a text node, never as HTML.
 */
function htmlToPlainText(html: string): string {
  return simplifyWorkItemHtml(html)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Renders one field value according to its declared metadata type.
 *
 * `html` values are arbitrary Azure content: they always go through
 * `simplifyWorkItemHtml` (script/style/img stripped, attributes allow-listed)
 * and are then handed to `AzureHtmlContent`, which converts to Markdown and
 * renders it as React nodes. There is no `dangerouslySetInnerHTML` path here.
 */
export function renderFieldValue(params: {
  refName: AzureFieldRefName;
  value: WorkItemFieldValue;
  metadata: WorkItemFieldMetadata;
  variant: 'detail' | 'board';
}): ReactNode {
  const { refName, value, metadata, variant } = params;

  if (value === null || value === undefined || value === '') {
    return <span className="text-ink-3">{EMPTY_FIELD_PLACEHOLDER}</span>;
  }

  const mismatch = { refName, type: metadata.type, value };

  switch (metadata.type) {
    case 'string':
    case 'plainText': {
      if (typeof value !== 'string') return fallback(mismatch);
      return <span className="truncate">{value}</span>;
    }

    case 'html': {
      if (typeof value !== 'string') return fallback(mismatch);
      const sanitized = simplifyWorkItemHtml(value);
      if (variant === 'board') {
        return <span className="truncate">{htmlToPlainText(value)}</span>;
      }
      return (
        <AzureHtmlContent className="min-w-0 text-xs" html={sanitized} />
      );
    }

    case 'integer':
    case 'double': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return fallback(mismatch);
      }
      return <span className="tabular-nums">{String(value)}</span>;
    }

    case 'dateTime': {
      if (typeof value !== 'string') return fallback(mismatch);
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return fallback(mismatch);
      return (
        <span className="truncate" title={value}>
          {formatRelativeTime(value)}
        </span>
      );
    }

    case 'boolean': {
      if (typeof value !== 'boolean') return fallback(mismatch);
      return (
        <span
          className="inline-flex items-center"
          data-field-value={String(value)}
          aria-label={value ? 'Yes' : 'No'}
          title={value ? 'Yes' : 'No'}
        >
          {value ? (
            <Check className="text-status-done h-3.5 w-3.5" />
          ) : (
            <Minus className="text-ink-3 h-3.5 w-3.5" />
          )}
        </span>
      );
    }

    case 'identity': {
      if (!isIdentity(value)) return fallback(mismatch);
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <UserAvatar
            name={value.displayName}
            title={value.uniqueName ?? value.displayName}
            imageUrl={value.imageUrl}
            size="sm"
          />
          <span className="truncate">{value.displayName}</span>
        </span>
      );
    }

    case 'treePath': {
      if (typeof value !== 'string') return fallback(mismatch);
      return (
        <span className="truncate" data-field-tree-path="" title={value}>
          {lastPathSegment(value)}
        </span>
      );
    }

    case 'picklistString': {
      if (typeof value !== 'string') return fallback(mismatch);
      return (
        <span className="min-w-0" data-field-chip="">
          <Chip size="xs">{value}</Chip>
        </span>
      );
    }

    default:
      return fallback(mismatch);
  }
}

/** Test-only: the warn-once registry is module state. */
export function resetFieldValueWarnings(): void {
  warnedRefNames.clear();
}
