import { Columns3, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';

import {
  DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
  type WorkItemDisplayConfig,
  type WorkItemRowConfig,
  type WorkItemTabId,
} from '@shared/work-item-display-config-types';
import {
  useWorkItemFieldMetadataMap,
  useWorkItemTypeFields,
} from '@/hooks/use-work-items';
import { Button } from '@/common/ui/button';
import type { Project } from '@shared/types';
import { RowListEditor } from '@/features/project/ui-work-item-display-settings/field-picker';
import { TypeOverrideList } from '@/features/project/ui-work-item-display-settings/type-override-list';

const TAB_LABELS: Record<WorkItemTabId, string> = {
  description: 'Description',
  acceptanceCriteria: 'Acceptance Criteria',
  reproSteps: 'Repro Steps',
  comments: 'Comments',
  history: 'History',
  testCases: 'Test Cases',
};

/**
 * Project Settings → Integrations pane for editing the work item display
 * configuration.
 *
 * Fully controlled: `value === null` means "never configured" and renders the
 * default layout as a starting point without emitting anything. `onChange`
 * always receives a complete config; persisting it is the caller's job.
 */
export function WorkItemDisplaySettings({
  project,
  value,
  onChange,
}: {
  project: Project;
  value: WorkItemDisplayConfig | null;
  onChange: (next: WorkItemDisplayConfig) => void;
}) {
  const config = value ?? DEFAULT_WORK_ITEM_DISPLAY_CONFIG;
  const queryParams = {
    providerId: project.workItemProviderId ?? undefined,
    azureProjectId: project.workItemProjectId ?? undefined,
  };
  const fieldsQuery = useWorkItemTypeFields(queryParams);
  const metadataMap = useWorkItemFieldMetadataMap(queryParams);
  // Only a successful fetch tells us the real field universe. While loading or
  // after a failure (F4) we fall back to built-in core metadata and never
  // accuse a configured field of being unavailable (F2).
  const metadataResolved = fieldsQuery.isSuccess;

  const workItemTypes = useMemo(() => {
    const types = new Set<string>(Object.keys(config.overridesByType));
    for (const field of Object.values(metadataMap)) {
      for (const type of field.validWorkItemTypes) types.add(type);
    }
    return [...types].sort((left, right) => left.localeCompare(right));
  }, [metadataMap, config.overridesByType]);

  function setDetailRows(rows: WorkItemRowConfig[]) {
    onChange({ ...config, detail: { ...config.detail, rows } });
  }

  function setBoardRows(rows: WorkItemRowConfig[]) {
    onChange({ ...config, board: { ...config.board, rows } });
  }

  function toggleTab(id: WorkItemTabId) {
    onChange({
      ...config,
      detail: {
        ...config.detail,
        tabs: config.detail.tabs.map((tab) =>
          tab.id === id ? { ...tab, visible: !tab.visible } : tab,
        ),
      },
    });
  }

  return (
    <section className="border-line-soft mt-4 border-t pt-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Columns3 className="text-acc-ink h-4 w-4" aria-hidden />
          <h3 className="text-ink-1 text-sm font-semibold">
            Work item fields
          </h3>
        </div>
        <p className="text-ink-3 mt-1 max-w-xl text-xs leading-relaxed">
          Choose which Azure fields appear on work item detail panels and board
          cards, and in what order.
        </p>
      </div>

      {fieldsQuery.isError && (
        <div
          role="alert"
          className="border-status-fail/30 bg-status-fail/10 mt-3 flex items-start justify-between gap-3 rounded-lg border px-3 py-2"
        >
          <p className="text-status-fail text-xs">
            Couldn&apos;t load field metadata from Azure DevOps. Check the
            provider&apos;s credentials in Settings. Only built-in fields are
            listed until this succeeds.
            {fieldsQuery.error?.message ? ` (${fieldsQuery.error.message})` : ''}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon={<RefreshCw />}
            onClick={() => void fieldsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      <div className="mt-4">
        <p className="text-ink-1 text-xs font-semibold tracking-wide uppercase">
          Detail panel fields
        </p>
        <p className="text-ink-3 mt-0.5 mb-2 text-[11px]">
          Rendered top to bottom in the work item detail panel.
        </p>
        <RowListEditor
          rows={config.detail.rows}
          listLabel="detail fields"
          metadataMap={metadataMap}
          metadataResolved={metadataResolved}
          onChange={setDetailRows}
        />
      </div>

      <div className="mt-5">
        <p className="text-ink-1 text-xs font-semibold tracking-wide uppercase">
          Detail panel tabs
        </p>
        <p className="text-ink-3 mt-0.5 mb-2 text-[11px]">
          Hidden tabs never mount. Repro steps still only show on bugs.
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {config.detail.tabs.map((tab) => (
            <li key={tab.id}>
              <Button
                type="button"
                variant={tab.visible ? 'secondary' : 'ghost'}
                size="xs"
                icon={tab.visible ? <Eye /> : <EyeOff />}
                aria-label={`${tab.visible ? 'Hide' : 'Show'} the ${TAB_LABELS[tab.id]} tab`}
                aria-pressed={tab.visible}
                onClick={() => toggleTab(tab.id)}
              >
                {TAB_LABELS[tab.id]}
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-5">
        <p className="text-ink-1 text-xs font-semibold tracking-wide uppercase">
          Board card fields
        </p>
        <p className="text-ink-3 mt-0.5 mb-2 text-[11px]">
          One list for every work item type.
        </p>
        <RowListEditor
          rows={config.board.rows}
          listLabel="board fields"
          metadataMap={metadataMap}
          metadataResolved={metadataResolved}
          onChange={setBoardRows}
        />
      </div>

      <TypeOverrideList
        config={config}
        metadataMap={metadataMap}
        metadataResolved={metadataResolved}
        workItemTypes={workItemTypes}
        onChange={onChange}
      />
    </section>
  );
}
