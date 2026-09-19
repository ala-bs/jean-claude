// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';

import {
  type AzureFieldRefName,
  FIELD_ASSIGNED_TO,
  FIELD_BOARD_COLUMN,
  FIELD_ITERATION_PATH,
  FIELD_PRIORITY,
  FIELD_STATE,
  FIELD_STORY_POINTS,
  FIELD_TAGS,
  FIELD_TITLE,
  FIELD_WORK_ITEM_TYPE,
  type WorkItemFieldMetadata,
  type WorkItemFieldValue,
} from '@shared/work-item-field-types';
import {
  resolveDetailLayout,
  type WorkItemDisplaySurface,
  type WorkItemRowConfig,
} from '@shared/work-item-display-config-types';
import type { AzureDevOpsWorkItem } from '@/lib/api';

import { WorkItemFieldRows } from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeWorkItem(
  fields: Record<AzureFieldRefName, WorkItemFieldValue>,
): AzureDevOpsWorkItem {
  return {
    id: 1,
    url: 'https://dev.azure.com/org/project/_workitems/edit/1',
    fields: {
      [FIELD_TITLE]: 'A title',
      [FIELD_WORK_ITEM_TYPE]: 'Bug',
      ...fields,
    },
  } as AzureDevOpsWorkItem;
}

function meta(
  overrides: Partial<WorkItemFieldMetadata> & { refName: string },
): WorkItemFieldMetadata {
  return {
    name: overrides.refName,
    type: 'string',
    readOnly: true,
    validWorkItemTypes: [],
    ...overrides,
  };
}

function render(props: {
  workItem: AzureDevOpsWorkItem;
  rows: WorkItemRowConfig[];
  metadata: Record<AzureFieldRefName, WorkItemFieldMetadata>;
  variant?: 'detail' | 'board';
  editable?: boolean;
  onEditField?: (params: {
    refName: AzureFieldRefName;
    value: WorkItemFieldValue;
  }) => void;
  containerClassName?: string;
  layout?: 'stack' | 'inline';
  editors?: Partial<
    Record<
      AzureFieldRefName,
      (ctx: {
        workItem: AzureDevOpsWorkItem;
        value: WorkItemFieldValue;
      }) => ReactNode
    >
  >;
}) {
  act(() =>
    root.render(<WorkItemFieldRows variant="detail" {...props} />),
  );
}

function renderSingle(params: {
  refName: string;
  value: WorkItemFieldValue;
  metadata: Partial<WorkItemFieldMetadata>;
  variant?: 'detail' | 'board';
}) {
  render({
    workItem: makeWorkItem({ [params.refName]: params.value }),
    rows: [{ refName: params.refName, visible: true }],
    metadata: {
      [params.refName]: meta({ refName: params.refName, ...params.metadata }),
    },
    variant: params.variant,
  });
}

describe('WorkItemFieldRows field types', () => {
  it('renders a string field as text', () => {
    renderSingle({
      refName: 'Custom.Str',
      value: 'hello',
      metadata: { name: 'Str', type: 'string' },
    });
    expect(container.textContent).toContain('Str');
    expect(container.textContent).toContain('hello');
  });

  it('renders a plainText field as text', () => {
    renderSingle({
      refName: 'Custom.Plain',
      value: 'plain value',
      metadata: { name: 'Plain', type: 'plainText' },
    });
    expect(container.textContent).toContain('plain value');
  });

  it('renders an integer field as a number', () => {
    renderSingle({
      refName: 'Custom.Int',
      value: 3,
      metadata: { name: 'Int', type: 'integer' },
    });
    expect(container.textContent).toContain('3');
  });

  it('renders a double field as a number', () => {
    renderSingle({
      refName: 'Custom.Dbl',
      value: 2.5,
      metadata: { name: 'Dbl', type: 'double' },
    });
    expect(container.textContent).toContain('2.5');
  });

  it('renders a dateTime field as a relative date', () => {
    renderSingle({
      refName: 'Custom.When',
      value: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      metadata: { name: 'When', type: 'dateTime' },
    });
    expect(container.textContent).toContain('2h ago');
  });

  it('renders a boolean field as a check state', () => {
    renderSingle({
      refName: 'Custom.Flag',
      value: true,
      metadata: { name: 'Flag', type: 'boolean' },
    });
    expect(container.querySelector('[data-field-value="true"]')).not.toBeNull();

    renderSingle({
      refName: 'Custom.Flag',
      value: false,
      metadata: { name: 'Flag', type: 'boolean' },
    });
    expect(container.querySelector('[data-field-value="false"]')).not.toBeNull();
  });

  it('renders an identity field as avatar plus name', () => {
    renderSingle({
      refName: FIELD_ASSIGNED_TO,
      value: { displayName: 'Ada Lovelace', uniqueName: 'ada@example.com' },
      metadata: { name: 'Assigned To', type: 'identity' },
    });
    expect(container.textContent).toContain('Ada Lovelace');
  });

  it('renders a treePath field as the last segment with the full path on hover', () => {
    renderSingle({
      refName: 'System.IterationPath',
      value: 'Project\\Release 1\\Sprint 3',
      metadata: { name: 'Iteration Path', type: 'treePath' },
    });
    const node = container.querySelector('[data-field-tree-path]');
    expect(node?.textContent).toBe('Sprint 3');
    expect(node?.getAttribute('title')).toBe('Project\\Release 1\\Sprint 3');
  });

  it('renders a picklistString field as a chip', () => {
    renderSingle({
      refName: 'Custom.Severity',
      value: 'High',
      metadata: { name: 'Severity', type: 'picklistString' },
    });
    const chip = container.querySelector('[data-field-chip]');
    expect(chip?.textContent).toBe('High');
  });

  it('sanitizes an html field value', () => {
    renderSingle({
      refName: 'Custom.Notes',
      value:
        '<p>Safe text</p><script>window.__pwned = 1;</script><img src="x" onerror="window.__pwned = 1">',
      metadata: { name: 'Notes', type: 'html' },
    });
    expect(container.textContent).toContain('Safe text');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.innerHTML).not.toContain('__pwned');
  });
});

describe('WorkItemFieldRows filtering', () => {
  it('skips a refName absent from metadata (F2)', () => {
    render({
      workItem: makeWorkItem({ 'Custom.Gone': 'ghost value' }),
      rows: [{ refName: 'Custom.Gone', visible: true }],
      metadata: {},
    });
    expect(container.textContent).not.toContain('ghost value');
  });

  it('skips a refName whose validWorkItemTypes excludes the item type (F7)', () => {
    render({
      workItem: makeWorkItem({ 'Custom.Only': 'task only' }),
      rows: [{ refName: 'Custom.Only', visible: true }],
      metadata: {
        'Custom.Only': meta({
          refName: 'Custom.Only',
          name: 'Only',
          validWorkItemTypes: ['Task'],
        }),
      },
    });
    expect(container.textContent).not.toContain('task only');
  });

  it('renders a refName whose validWorkItemTypes is empty (all types)', () => {
    render({
      workItem: makeWorkItem({ 'Custom.All': 'any type' }),
      rows: [{ refName: 'Custom.All', visible: true }],
      metadata: {
        'Custom.All': meta({
          refName: 'Custom.All',
          name: 'All',
          validWorkItemTypes: [],
        }),
      },
    });
    expect(container.textContent).toContain('any type');
  });

  it('skips rows that are not visible', () => {
    render({
      workItem: makeWorkItem({ 'Custom.Hidden': 'hidden value' }),
      rows: [{ refName: 'Custom.Hidden', visible: false }],
      metadata: {
        'Custom.Hidden': meta({ refName: 'Custom.Hidden', name: 'Hidden' }),
      },
    });
    expect(container.textContent).not.toContain('hidden value');
  });
});

describe('WorkItemFieldRows type mismatch (F5)', () => {
  it('falls back to String(value) and warns once per refName', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const props = {
        workItem: makeWorkItem({ 'Custom.Bad': 42 }),
        rows: [{ refName: 'Custom.Bad', visible: true }],
        metadata: {
          'Custom.Bad': meta({
            refName: 'Custom.Bad',
            name: 'Bad',
            type: 'identity' as const,
          }),
        },
      };
      render(props);
      expect(container.textContent).toContain('42');
      expect(warn).toHaveBeenCalledTimes(1);

      render(props);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('WorkItemFieldRows editing', () => {
  it('makes an editable refName clickable and reports the raw value', () => {
    const onEditField = vi.fn();
    render({
      workItem: makeWorkItem({ [FIELD_TITLE]: 'A title' }),
      rows: [{ refName: FIELD_TITLE, visible: true }],
      metadata: {
        [FIELD_TITLE]: meta({
          refName: FIELD_TITLE,
          name: 'Title',
          readOnly: false,
        }),
      },
      editable: true,
      onEditField,
    });

    const button = container.querySelector<HTMLButtonElement>(
      `[data-edit-field="${FIELD_TITLE}"]`,
    );
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(onEditField).toHaveBeenCalledWith({
      refName: FIELD_TITLE,
      value: 'A title',
    });
  });

  it('ignores editable for a refName outside EDITABLE_FIELD_REFNAMES', () => {
    const onEditField = vi.fn();
    render({
      workItem: makeWorkItem({ 'Custom.Str': 'read only' }),
      rows: [{ refName: 'Custom.Str', visible: true }],
      metadata: {
        'Custom.Str': meta({
          refName: 'Custom.Str',
          name: 'Str',
          readOnly: false,
        }),
      },
      editable: true,
      onEditField,
    });

    expect(container.textContent).toContain('read only');
    expect(
      container.querySelector('[data-edit-field="Custom.Str"]'),
    ).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('WorkItemFieldRows board variant', () => {
  it('renders compact rows without an edit affordance', () => {
    const onEditField = vi.fn();
    render({
      workItem: makeWorkItem({ [FIELD_TITLE]: 'A title' }),
      rows: [{ refName: FIELD_TITLE, visible: true }],
      metadata: {
        [FIELD_TITLE]: meta({
          refName: FIELD_TITLE,
          name: 'Title',
          readOnly: false,
        }),
      },
      variant: 'board',
      editable: true,
      onEditField,
    });

    expect(container.textContent).toContain('A title');
    expect(container.querySelector('button')).toBeNull();
    expect(
      container.querySelector('[data-work-item-field-rows="board"]'),
    ).not.toBeNull();
  });
});

describe('WorkItemFieldRows injected editors', () => {
  it('renders the injected editor instead of the read-only value', () => {
    act(() =>
      root.render(
        <WorkItemFieldRows
          variant="detail"
          workItem={makeWorkItem({ [FIELD_PRIORITY]: 3 })}
          rows={[{ refName: FIELD_PRIORITY, visible: true }]}
          metadata={{
            [FIELD_PRIORITY]: meta({
              refName: FIELD_PRIORITY,
              name: 'Priority',
              type: 'integer',
            }),
          }}
          editors={{
            [FIELD_PRIORITY]: ({ value }) => (
              <span data-testid="injected">editor:{String(value)}</span>
            ),
          }}
        />,
      ),
    );

    expect(container.querySelector('[data-testid="injected"]')).not.toBeNull();
    expect(container.textContent).toContain('editor:3');
    // The read-only label/value pair is replaced, not duplicated.
    expect(container.textContent).not.toContain('Priority');
    expect(
      container.querySelector(`[data-field-row="${FIELD_PRIORITY}"]`),
    ).not.toBeNull();
  });

  it('ignores an editor supplied for a non-editable refName', () => {
    act(() =>
      root.render(
        <WorkItemFieldRows
          variant="detail"
          workItem={makeWorkItem({ 'Custom.Str': 'read only' })}
          rows={[{ refName: 'Custom.Str', visible: true }]}
          metadata={{
            'Custom.Str': meta({ refName: 'Custom.Str', name: 'Str' }),
          }}
          editors={{
            'Custom.Str': () => <span data-testid="injected">nope</span>,
          }}
        />,
      ),
    );

    expect(container.querySelector('[data-testid="injected"]')).toBeNull();
    expect(container.textContent).toContain('read only');
  });

  it('renders an injected editor even when the field has no metadata', () => {
    act(() =>
      root.render(
        <WorkItemFieldRows
          variant="detail"
          workItem={makeWorkItem({})}
          rows={[{ refName: FIELD_STATE, visible: true }]}
          metadata={{}}
          editors={{ [FIELD_STATE]: () => <span>state editor</span> }}
        />,
      ),
    );

    expect(container.textContent).toContain('state editor');
  });

  it('ignores editors in the board variant', () => {
    act(() =>
      root.render(
        <WorkItemFieldRows
          variant="board"
          workItem={makeWorkItem({ [FIELD_PRIORITY]: 3 })}
          rows={[{ refName: FIELD_PRIORITY, visible: true }]}
          metadata={{
            [FIELD_PRIORITY]: meta({
              refName: FIELD_PRIORITY,
              name: 'Priority',
              type: 'integer',
            }),
          }}
          editors={{
            [FIELD_PRIORITY]: () => <span data-testid="injected">nope</span>,
          }}
        />,
      ),
    );

    expect(container.querySelector('[data-testid="injected"]')).toBeNull();
    expect(container.textContent).toContain('3');
  });
});

const ALL_CORE_METADATA: Record<AzureFieldRefName, WorkItemFieldMetadata> =
  Object.fromEntries(
    [
      FIELD_ASSIGNED_TO,
      FIELD_STATE,
      FIELD_BOARD_COLUMN,
      FIELD_ITERATION_PATH,
      FIELD_STORY_POINTS,
      FIELD_PRIORITY,
      FIELD_TAGS,
    ].map((refName) => [refName, meta({ refName })]),
  );

function renderedRefNames(): string[] {
  return [...container.querySelectorAll('[data-field-row]')].map(
    (node) => node.getAttribute('data-field-row') ?? '',
  );
}

describe('WorkItemFieldRows surface defaults', () => {
  const surfaces: Array<[WorkItemDisplaySurface, string[]]> = [
    [
      'preview-editorial',
      [
        FIELD_ASSIGNED_TO,
        FIELD_STATE,
        FIELD_BOARD_COLUMN,
        FIELD_ITERATION_PATH,
        FIELD_STORY_POINTS,
        FIELD_PRIORITY,
        FIELD_TAGS,
      ],
    ],
    [
      'preview-readonly',
      [FIELD_ASSIGNED_TO, FIELD_STATE, FIELD_PRIORITY, FIELD_TAGS],
    ],
    [
      'feed-modal',
      [
        FIELD_STATE,
        FIELD_BOARD_COLUMN,
        FIELD_ASSIGNED_TO,
        FIELD_STORY_POINTS,
        FIELD_ITERATION_PATH,
        FIELD_TAGS,
      ],
    ],
  ];

  for (const [surface, expected] of surfaces) {
    it(`renders exactly the ${surface} default rows, in order, for a null config`, () => {
      const layout = resolveDetailLayout(null, 'Bug', surface);
      render({
        workItem: makeWorkItem({}),
        rows: layout.rows,
        metadata: ALL_CORE_METADATA,
      });
      expect(renderedRefNames()).toEqual(expected);
    });
  }

  it('drops exactly the row a config hides', () => {
    const layout = resolveDetailLayout(null, 'Bug', 'preview-editorial');
    const rows = layout.rows.map((row) =>
      row.refName === FIELD_PRIORITY ? { ...row, visible: false } : row,
    );
    render({ workItem: makeWorkItem({}), rows, metadata: ALL_CORE_METADATA });
    expect(renderedRefNames()).toEqual([
      FIELD_ASSIGNED_TO,
      FIELD_STATE,
      FIELD_BOARD_COLUMN,
      FIELD_ITERATION_PATH,
      FIELD_STORY_POINTS,
      FIELD_TAGS,
    ]);
  });

  it('resolves the same rows on every detail surface once a config exists', () => {
    const config = {
      version: 1 as const,
      detail: {
        rows: [
          { refName: FIELD_STATE, visible: true },
          { refName: FIELD_ASSIGNED_TO, visible: true },
        ],
        tabs: [],
      },
      board: { rows: [] },
      overridesByType: {},
    };

    const perSurface = (
      ['preview-editorial', 'preview-readonly', 'feed-modal'] as const
    ).map((surface) => {
      render({
        workItem: makeWorkItem({}),
        rows: resolveDetailLayout(config, 'Bug', surface).rows,
        metadata: ALL_CORE_METADATA,
      });
      return renderedRefNames();
    });

    expect(perSurface[0]).toEqual([FIELD_STATE, FIELD_ASSIGNED_TO]);
    expect(perSurface[1]).toEqual(perSurface[0]);
    expect(perSurface[2]).toEqual(perSurface[0]);
  });
});

describe('read-only row typography and layout', () => {
  const ROW = { refName: 'Microsoft.VSTS.Common.Priority', visible: true };
  const METADATA = {
    'Microsoft.VSTS.Common.Priority': meta({
      refName: 'Microsoft.VSTS.Common.Priority',
      name: 'Priority',
      type: 'integer' as const,
    }),
  };
  const WORK_ITEM = () =>
    makeWorkItem({ 'Microsoft.VSTS.Common.Priority': 2 });

  function priorityRow(): HTMLElement {
    const row = container.querySelector<HTMLElement>(
      '[data-field-row="Microsoft.VSTS.Common.Priority"]',
    );
    if (!row) throw new Error('priority row not rendered');
    return row;
  }

  it('sets its own font size so a host containerClassName cannot drop it', () => {
    // Regression: typography used to live only on the default container
    // classes, which `containerClassName` replaces wholesale — so a host
    // supplying its own layout silently lost `text-xs` and the row rendered
    // at the ambient base size, visibly larger than its neighbours.
    render({
      workItem: WORK_ITEM(),
      rows: [ROW],
      metadata: METADATA,
      containerClassName: 'mt-3 flex flex-wrap items-center gap-3',
      layout: 'inline',
    });
    expect(priorityRow().className).toContain('text-xs');
  });

  it('keeps the fixed label column only when stacked', () => {
    render({ workItem: WORK_ITEM(), rows: [ROW], metadata: METADATA });
    expect(priorityRow().querySelector('span')?.className).toContain('w-28');

    render({
      workItem: WORK_ITEM(),
      rows: [ROW],
      metadata: METADATA,
      layout: 'inline',
    });
    expect(priorityRow().querySelector('span')?.className).not.toContain(
      'w-28',
    );
  });
});

describe('editor that renders nothing', () => {
  const PRIORITY = 'Microsoft.VSTS.Common.Priority';

  it('falls back to the read-only value instead of dropping the row', () => {
    // Regression: the visibility predicate and the render branch both keyed off
    // the editor FUNCTION's existence, so a host editor returning null (every
    // read-only surface does this) rendered an empty wrapper and the configured
    // field vanished — no label, no value.
    render({
      workItem: makeWorkItem({ [PRIORITY]: 2 }),
      rows: [{ refName: PRIORITY, visible: true }],
      metadata: {
        [PRIORITY]: meta({ refName: PRIORITY, name: 'Priority', type: 'integer' }),
      },
      editors: { [PRIORITY]: () => null },
    });
    expect(container.textContent).toContain('Priority');
    expect(container.textContent).toContain('2');
  });

  it('still prefers the editor when it renders something', () => {
    render({
      workItem: makeWorkItem({ [PRIORITY]: 2 }),
      rows: [{ refName: PRIORITY, visible: true }],
      metadata: {
        [PRIORITY]: meta({ refName: PRIORITY, name: 'Priority', type: 'integer' }),
      },
      editors: { [PRIORITY]: () => <span>EDITOR</span> },
    });
    expect(container.textContent).toContain('EDITOR');
    expect(container.textContent).not.toContain('Priority');
  });

  it('drops a row whose editor renders nothing and has no metadata', () => {
    render({
      workItem: makeWorkItem({ [PRIORITY]: 2 }),
      rows: [{ refName: PRIORITY, visible: true }],
      metadata: {},
      editors: { [PRIORITY]: () => null },
    });
    expect(container.querySelector(`[data-field-row="${PRIORITY}"]`)).toBeNull();
  });

  it('does not resolve a prototype-named refName through the metadata map', () => {
    render({
      workItem: makeWorkItem({ toString: 'x' }),
      rows: [{ refName: 'toString', visible: true }],
      metadata: {},
    });
    expect(container.querySelector('[data-field-row="toString"]')).toBeNull();
  });
});
