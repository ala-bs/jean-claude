// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_FIELD_METADATA,
  FIELD_ASSIGNED_TO,
  FIELD_PRIORITY,
  FIELD_STATE,
  type WorkItemFieldMetadata,
} from '@shared/work-item-field-types';
import { createRoot, type Root } from 'react-dom/client';
import {
  DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
  type WorkItemDisplayConfig,
} from '@shared/work-item-display-config-types';

import { act } from 'react';
import type { Project } from '@shared/types';
import { WorkItemDisplaySettings } from '@/features/project/ui-work-item-display-settings';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SEVERITY: WorkItemFieldMetadata = {
  refName: 'Custom.Severity',
  name: 'Severity',
  type: 'string',
  readOnly: false,
  validWorkItemTypes: ['Bug', 'Issue'],
};

const fieldsQuery = {
  data: [SEVERITY] as WorkItemFieldMetadata[] | undefined,
  isPending: false,
  isSuccess: true,
  isError: false,
  error: null as Error | null,
  refetch: vi.fn(),
};

vi.mock('@/hooks/use-work-items', () => ({
  useWorkItemTypeFields: () => fieldsQuery,
  useBoardColumns: () => ({ data: [] }),
  useWorkItemFieldMetadataMap: () => ({
    ...CORE_FIELD_METADATA,
    ...Object.fromEntries(
      (fieldsQuery.data ?? []).map((field) => [field.refName, field]),
    ),
  }),
}));

const project = {
  id: 'project-1',
  name: 'Acme',
  workItemProviderId: 'provider-1',
  workItemProjectId: 'azure-project-1',
  workItemProjectName: 'Acme',
} as unknown as Project;

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

function render(value: WorkItemDisplayConfig | null) {
  act(() => {
    root.render(
      <WorkItemDisplaySettings
        project={project}
        value={value}
        onChange={onChange}
      />,
    );
  });
}

function click(element: Element | null | undefined) {
  expect(element, 'element to click exists').toBeTruthy();
  act(() => {
    (element as HTMLElement).click();
  });
}

function byLabel(label: string) {
  return container.querySelector(`[aria-label="${label}"]`);
}

function lastConfig(): WorkItemDisplayConfig {
  expect(onChange).toHaveBeenCalled();
  return onChange.mock.calls[onChange.mock.calls.length - 1][0];
}

beforeEach(() => {
  fieldsQuery.data = [SEVERITY];
  fieldsQuery.isPending = false;
  fieldsQuery.isSuccess = true;
  fieldsQuery.isError = false;
  fieldsQuery.error = null;
  onChange.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('WorkItemDisplaySettings', () => {
  it('renders the default config for a never-configured project without calling onChange', () => {
    render(null);

    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Assigned To');
    expect(container.textContent).toContain('Story Points');
  });

  it('marks a configured refName missing from metadata as unavailable and removes it', () => {
    const value: WorkItemDisplayConfig = {
      ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
      detail: {
        ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG.detail,
        rows: [
          { refName: FIELD_ASSIGNED_TO, visible: true },
          { refName: 'Custom.Gone', visible: true },
        ],
      },
    };
    render(value);

    expect(container.textContent).toContain('Unavailable');
    expect(container.textContent).toContain('Custom.Gone');

    click(byLabel('Remove Custom.Gone from detail fields'));

    expect(lastConfig().detail.rows).toEqual([
      { refName: FIELD_ASSIGNED_TO, visible: true },
    ]);
  });

  it('shows the type restriction hint for a type-restricted field', () => {
    render({
      ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
      detail: {
        ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG.detail,
        rows: [{ refName: 'Custom.Severity', visible: true }],
      },
    });

    expect(container.textContent).toContain('only on: Bug, Issue');
  });

  it('reorders detail rows into the expected order', () => {
    const value: WorkItemDisplayConfig = {
      ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
      detail: {
        ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG.detail,
        rows: [
          { refName: FIELD_ASSIGNED_TO, visible: true },
          { refName: FIELD_STATE, visible: true },
          { refName: FIELD_PRIORITY, visible: false },
        ],
      },
    };
    render(value);

    click(byLabel('Move Assigned To down in detail fields'));

    expect(lastConfig().detail.rows).toEqual([
      { refName: FIELD_STATE, visible: true },
      { refName: FIELD_ASSIGNED_TO, visible: true },
      { refName: FIELD_PRIORITY, visible: false },
    ]);
  });

  it('toggles a detail row visibility', () => {
    render(null);

    click(byLabel('Hide State in detail fields'));

    const state = lastConfig().detail.rows.find(
      (row) => row.refName === FIELD_STATE,
    );
    expect(state).toEqual({ refName: FIELD_STATE, visible: false });
  });

  it('toggles a detail tab visibility', () => {
    render(null);

    click(byLabel('Hide the History tab'));

    expect(lastConfig().detail.tabs).toEqual([
      { id: 'description', visible: true },
      { id: 'acceptanceCriteria', visible: true },
      { id: 'reproSteps', visible: true },
      { id: 'comments', visible: true },
      { id: 'history', visible: false },
      { id: 'testCases', visible: true },
    ]);
  });

  it('round-trips adding and removing a type override', () => {
    const original: WorkItemDisplayConfig = DEFAULT_WORK_ITEM_DISPLAY_CONFIG;
    render(original);

    const select = byLabel(
      'Work item type for new override',
    ) as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    act(() => {
      select!.value = 'Bug';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click(byLabel('Add override for the selected work item type'));

    const withOverride = lastConfig();
    expect(Object.keys(withOverride.overridesByType)).toEqual(['Bug']);
    expect(withOverride.overridesByType.Bug).toEqual(original.detail);

    onChange.mockClear();
    render(withOverride);
    click(byLabel('Remove the Bug override'));

    expect(lastConfig()).toEqual(original);
  });

  it('renders the metadata error state without crashing', () => {
    fieldsQuery.data = undefined;
    fieldsQuery.isSuccess = false;
    fieldsQuery.isError = true;
    fieldsQuery.error = new Error('TF400813: unauthorized');

    render(null);

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('field metadata');
    // Rows still render from built-in metadata.
    expect(container.textContent).toContain('Assigned To');
  });
});
