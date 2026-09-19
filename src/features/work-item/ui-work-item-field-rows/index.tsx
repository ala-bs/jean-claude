import clsx from 'clsx';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import type { ReactNode } from 'react';

import {
  type AzureFieldRefName,
  EDITABLE_FIELD_REFNAMES,
  FIELD_BOARD_COLUMN,
  getFieldValue,
  getWorkItemType,
  type WorkItemFieldMetadata,
  type WorkItemFieldValue,
} from '@shared/work-item-field-types';
import type { WorkItemRowConfig } from '@shared/work-item-display-config-types';

import { renderFieldValue } from './render-field-value';

const EDITABLE = new Set<AzureFieldRefName>(EDITABLE_FIELD_REFNAMES);

/**
 * Which refNames may have a host-supplied inline editor injected (decision 22).
 *
 * This is `EDITABLE_FIELD_REFNAMES` plus `System.BoardColumn`: the board column
 * is not editable through the generic `onEditField` affordance (it needs the
 * project's column list, so it has no entry in `EDITABLE_FIELD_REFNAMES`), yet
 * both detail panels render a live `WorkItemBoardColumnEditor` for it today.
 * Gating on `EDITABLE_FIELD_REFNAMES` alone would silently delete that editor.
 * Custom fields are still never editable.
 */
const EDITOR_HOSTABLE = new Set<AzureFieldRefName>([
  ...EDITABLE_FIELD_REFNAMES,
  FIELD_BOARD_COLUMN,
]);

/**
 * F7: `validWorkItemTypes: []` means "valid for every type" (the shape
 * `CORE_FIELD_METADATA` uses), not "valid for nothing".
 */
function isValidForType(params: {
  metadata: WorkItemFieldMetadata;
  workItemType: string;
}): boolean {
  const { validWorkItemTypes } = params.metadata;
  if (validWorkItemTypes.length === 0) return true;
  return validWorkItemTypes.includes(params.workItemType);
}

/**
 * Renders the configured metadata rows for a work item.
 *
 * Row selection is config-driven and purely declarative: a row is dropped when
 * it is hidden, when its refName has no metadata (F2 — the field was removed
 * from the template), or when the field is not valid for this work item type
 * (F7). Value rendering is delegated to `renderFieldValue`, which owns the
 * per-type rendering and the F5 fallback.
 */
export function WorkItemFieldRows({
  workItem,
  rows,
  metadata,
  variant,
  editable,
  onEditField,
  editors,
  containerClassName,
  layout = 'stack',
}: {
  workItem: AzureDevOpsWorkItem;
  rows: WorkItemRowConfig[];
  metadata: Record<AzureFieldRefName, WorkItemFieldMetadata>;
  variant: 'detail' | 'board';
  /** Detail only; only `EDITABLE_FIELD_REFNAMES` react. */
  editable?: boolean;
  onEditField?: (params: {
    refName: AzureFieldRefName;
    value: WorkItemFieldValue;
  }) => void;
  /**
   * Per-refName editor renderers supplied by the host panel (decision 22). For
   * a refName present here the returned node replaces the whole read-only
   * label/value row, so the panel keeps ownership of its editor components and
   * of the label they draw themselves.
   */
  editors?: Partial<
    Record<
      AzureFieldRefName,
      (ctx: {
        workItem: AzureDevOpsWorkItem;
        value: WorkItemFieldValue;
      }) => ReactNode
    >
  >;
  /** Overrides the default row-container classes so a host can keep its own layout. */
  containerClassName?: string;
  /**
   * `stack` gives each read-only row a fixed-width label column so labels align
   * down a vertical list. `inline` keeps the label snug against its value, which
   * is what a host wrapping rows in a horizontal `flex-wrap` needs — a fixed
   * label column there reads as a stray gap.
   */
  layout?: 'stack' | 'inline';
}) {
  const workItemType = getWorkItemType(workItem);
  const isBoard = variant === 'board';

  const editorFor = (refName: AzureFieldRefName) => {
    if (isBoard) return undefined;
    if (!EDITOR_HOSTABLE.has(refName)) return undefined;
    return editors?.[refName];
  };

  /**
   * A host editor may legitimately render nothing — most return `null` when the
   * surface is read-only. Resolve the node here so such a row can fall back to
   * the read-only value instead of disappearing, and so the editor is invoked
   * exactly once per render.
   */
  const resolveRow = (row: WorkItemRowConfig) => {
    const value = getFieldValue(workItem, row.refName);
    const editorNode = editorFor(row.refName)?.({ workItem, value }) ?? null;
    const fieldMetadata = Object.hasOwn(metadata, row.refName)
      ? metadata[row.refName]
      : undefined;
    return { value, editorNode, fieldMetadata };
  };

  const visibleRows = rows
    .filter((row) => row.visible)
    .map((row) => ({ row, ...resolveRow(row) }))
    .filter(({ editorNode, fieldMetadata }) => {
      // An injected editor draws its own label and knows its own field, so it
      // does not depend on the (asynchronously loaded) Azure metadata map.
      if (editorNode) return true;
      // F2: configured refName no longer exists in the project's metadata.
      if (!fieldMetadata) return false;
      return isValidForType({ metadata: fieldMetadata, workItemType });
    });

  if (visibleRows.length === 0) return null;

  return (
    <div
      data-work-item-field-rows={variant}
      className={
        containerClassName ??
        clsx(
          'flex min-w-0 flex-col',
          isBoard ? 'gap-0.5 text-[10px]' : 'gap-2 text-xs',
        )
      }
    >
      {visibleRows.map(({ row, value, editorNode, fieldMetadata }) => {
        if (editorNode) {
          // `contents` keeps the injected editor a direct child of the row
          // container, so hosting it here is layout-neutral.
          return (
            <div
              key={row.refName}
              data-field-row={row.refName}
              className="contents"
            >
              {editorNode}
            </div>
          );
        }

        // Unreachable: the filter above keeps a metadata-less row only when it
        // has an editor node, which is handled right above. Narrows the type.
        if (!fieldMetadata) return null;

        const content = renderFieldValue({
          refName: row.refName,
          value,
          metadata: fieldMetadata,
          variant,
        });

        // `editable` is a detail-surface affordance and applies only to the
        // seven refNames that have an editor in v1 (decision 12).
        const isEditable =
          !isBoard &&
          editable === true &&
          onEditField !== undefined &&
          EDITABLE.has(row.refName);

        return (
          <div
            key={row.refName}
            data-field-row={row.refName}
            className={clsx(
              // Typography is set per row, not inherited from the container:
              // a host panel that overrides `containerClassName` to reproduce
              // its own layout would otherwise drop the font size with it.
              'flex min-w-0 items-start',
              isBoard ? 'gap-1 text-[10px]' : 'gap-2 text-xs',
            )}
          >
            <span
              className={clsx(
                'text-ink-3 shrink-0',
                isBoard && 'w-16 truncate',
                !isBoard && layout === 'stack' && 'w-28',
              )}
              title={fieldMetadata.name}
            >
              {fieldMetadata.name}
            </span>
            {isEditable ? (
              <button
                type="button"
                data-edit-field={row.refName}
                aria-label={`Edit ${fieldMetadata.name}`}
                className="text-ink-1 hover:bg-glass-medium flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors"
                onClick={() => onEditField?.({ refName: row.refName, value })}
              >
                {content}
              </button>
            ) : (
              <span
                className={clsx(
                  'text-ink-1 flex min-w-0 items-center gap-1.5',
                  // Only grow to fill the row when rows are stacked; inside a
                  // host's horizontal wrap the value should size to content.
                  isBoard || layout === 'stack' ? 'flex-1' : 'shrink-0',
                  // Board rows stay compact but are never height-capped.
                  isBoard && 'leading-tight',
                )}
              >
                {content}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
