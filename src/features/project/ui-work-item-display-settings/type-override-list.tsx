import {
  type FieldMetadataMap,
  RowListEditor,
} from '@/features/project/ui-work-item-display-settings/field-picker';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  WorkItemDetailLayout,
  WorkItemDisplayConfig,
} from '@shared/work-item-display-config-types';

import { Button } from '@/common/ui/button';
import { WORK_ITEM_DISPLAY_CONFIG_MAX_OVERRIDES } from '@shared/work-item-display-config-types';

function cloneLayout(layout: WorkItemDetailLayout): WorkItemDetailLayout {
  return {
    rows: layout.rows.map((row) => ({ ...row })),
    tabs: layout.tabs.map((tab) => ({ ...tab })),
  };
}

/**
 * Opt-in per-work-item-type detail overrides (decisions 10 and 18). A type
 * without an entry inherits the shared detail layout; the board layout is never
 * overridden.
 */
export function TypeOverrideList({
  config,
  metadataMap,
  metadataResolved,
  workItemTypes,
  onChange,
}: {
  config: WorkItemDisplayConfig;
  metadataMap: FieldMetadataMap;
  metadataResolved: boolean;
  workItemTypes: string[];
  onChange: (next: WorkItemDisplayConfig) => void;
}) {
  const [selectedType, setSelectedType] = useState('');
  const overrideTypes = useMemo(
    () => Object.keys(config.overridesByType).sort(),
    [config.overridesByType],
  );
  const addableTypes = useMemo(
    () =>
      workItemTypes.filter(
        (type) => !Object.hasOwn(config.overridesByType, type),
      ),
    [workItemTypes, config.overridesByType],
  );
  const value = addableTypes.includes(selectedType) ? selectedType : '';
  const atLimit =
    overrideTypes.length >= WORK_ITEM_DISPLAY_CONFIG_MAX_OVERRIDES;

  function setOverride(type: string, layout: WorkItemDetailLayout | null) {
    const overridesByType = { ...config.overridesByType };
    if (layout) overridesByType[type] = layout;
    else delete overridesByType[type];
    onChange({ ...config, overridesByType });
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-ink-1 text-xs font-semibold tracking-wide uppercase">
            Per-type overrides
          </p>
          <p className="text-ink-3 mt-0.5 text-[11px]">
            Types without an override inherit the detail layout above. Board
            cards always use the single board layout.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Work item type for new override"
            className="border-glass-border bg-bg-1 text-ink-1 h-7 rounded-md border px-2 text-xs"
            disabled={atLimit || addableTypes.length === 0}
            value={value}
            onChange={(event) => setSelectedType(event.target.value)}
          >
            <option value="">Add override for type…</option>
            {addableTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            icon={<Plus />}
            aria-label="Add override for the selected work item type"
            disabled={atLimit || !value}
            onClick={() => {
              if (!value) return;
              setOverride(value, cloneLayout(config.detail));
              setSelectedType('');
            }}
          >
            Add override
          </Button>
        </div>
      </div>

      {overrideTypes.length === 0 ? (
        <p className="border-glass-border bg-bg-1/40 text-ink-3 mt-2 rounded-lg border border-dashed px-3 py-4 text-center text-xs">
          No type overrides. Every work item type uses the detail layout.
        </p>
      ) : (
        <div className="mt-2 space-y-3">
          {overrideTypes.map((type) => {
            const layout = config.overridesByType[type];
            return (
              <div
                key={type}
                className="border-glass-border bg-bg-0/70 rounded-lg border p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-ink-1 text-xs font-semibold">{type}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon={<Trash2 />}
                    aria-label={`Remove the ${type} override`}
                    title="Remove override"
                    onClick={() => setOverride(type, null)}
                  >
                    Remove override
                  </Button>
                </div>
                <RowListEditor
                  rows={layout.rows}
                  listLabel={`${type} fields`}
                  metadataMap={metadataMap}
                  metadataResolved={metadataResolved}
                  onChange={(rows) => setOverride(type, { ...layout, rows })}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
