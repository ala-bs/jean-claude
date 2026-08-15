// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type {
  TimesheetDraftResult,
  TimesheetEditorModel,
  TimesheetSheetSummary,
} from '@shared/timesheet-types';

import { api } from '@/lib/api';
import { RootOverlay } from '@/common/context/overlay';
import { timesheetSheetQueryKey } from '@/hooks/use-timesheets';

import { EureciaSyncDialog } from '.';

vi.mock('@/common/ui/modal', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? createElement('div', null, children) : null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const range = { start: '2026-07-13T00:00:00.000Z', end: '2026-07-14T00:00:00.000Z' };
const sheet: TimesheetSheetSummary = {
  id: 'sheet-1',
  navigationUrl: 'https://tenant.example/timesheet?id=sheet-1',
  description: 'July sheet',
  start: '2026-07-13',
  end: '2026-07-14',
  status: 'Open',
};
const draft: TimesheetDraftResult = {
  provider: 'eurecia',
  displayName: 'Eurecia',
  entries: [
    {
      id: 'draft-1',
      provider: 'eurecia',
      date: '2026-07-13',
      project: { id: null, name: null },
      role: null,
      workItem: null,
      durationMinutes: null,
      description: 'Fresh draft source',
      sourceEventIds: [],
      metadata: {},
      items: [],
    },
  ],
  warnings: [],
};
const draftQueryKey = [
  'timesheets',
  'draft',
  { provider: 'eurecia', start: range.start, end: range.end },
] as const;

const SUBMITTED_STATE = {
  known: true,
  canSave: false,
  canSubmit: false,
  submitted: true,
} as const;

function editorModel(
  label: string,
  rowIndex: number,
  occupiedFraction: 0 | 0.25 = 0,
  submission: TimesheetEditorModel['submission'] = {
    known: true,
    canSave: true,
    canSubmit: true,
    submitted: false,
  },
): TimesheetEditorModel {
  return {
    axisLabels: { axis1: label, axis2: '', axis3: '' },
    axisOptions: { axis1: [], axis2: [], axis3: [] },
    submission,
    rows: [
      {
        rowIndex,
        date: '2026-07-13',
        fraction: 0,
        occupied: false,
        axis1Id: '',
        axis2Id: '',
        axis3Id: '',
        comment: '',
      },
      ...(occupiedFraction
        ? [
            {
              rowIndex: rowIndex + 1,
              date: '2026-07-13',
              fraction: occupiedFraction,
              occupied: true,
              axis1Id: `occupied-${label}`,
              axis2Id: '',
              axis3Id: '',
              comment: '',
            } as const,
          ]
        : []),
    ],
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  globalThis.localStorage?.clear();
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function seedDialogQueries(
  queryClient: QueryClient,
  editor: TimesheetEditorModel,
  editorUpdatedAt: number,
) {
  queryClient.setQueryData(
    ['timesheets', 'eurecia', 'auth'],
    { configured: true, authenticated: true, baseUrl: 'https://tenant.example' },
    { updatedAt: 100 },
  );
  queryClient.setQueryData(['timesheets', 'eurecia', 'sheets'], [sheet], {
    updatedAt: 100,
  });
  queryClient.setQueryData(
    draftQueryKey,
    draft,
    { updatedAt: 100 },
  );
  queryClient.setQueryData(
    timesheetSheetQueryKey({
      provider: 'eurecia',
      sheetId: sheet.id,
      navigationUrl: sheet.navigationUrl,
    }),
    editor,
    { updatedAt: editorUpdatedAt },
  );
}

async function renderDialog(queryClient: QueryClient, onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          RootOverlay,
          null,
          createElement(EureciaSyncDialog, {
            isOpen: true,
            onClose,
            range,
          }),
        ),
      ),
    );
  });
}

async function enterEditor() {
  const sheetButton = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('July sheet'),
  );
  if (!sheetButton) return;
  await act(async () => sheetButton.click());
}

async function addProjectAndFillFirstDay(label: string) {
  const picker = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label^="Add "]',
  );
  await act(async () => picker?.click());
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find((button) => button.textContent?.includes(label))
      ?.click();
  });
  const fill = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Fill "]',
  );
  await act(async () => fill?.click());
}

describe('EureciaSyncDialog inspection initialization', () => {
  it('starts Eurecia sign in automatically when configured but unauthenticated', async () => {
    const login = vi
      .spyOn(api.timesheets, 'login')
      .mockImplementation(() => new Promise(() => {}));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'auth'],
      { configured: true, authenticated: false, baseUrl: 'https://tenant.example' },
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);

    await act(async () => {
      await vi.waitFor(() => expect(login).toHaveBeenCalledWith('eurecia'));
    });
    expect(login).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('Signing in...');
  });

  it('does not expose or initialize cached editor data while fresh inspection is pending', async () => {
    let resolveInspection: (editor: TimesheetEditorModel) => void = () => {};
    vi.spyOn(api.timesheets, 'inspectSheet').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInspection = resolve;
        }),
    );
    const lookup = vi
      .spyOn(api.timesheets, 'lookupAxisOptions')
      .mockResolvedValue({ axis: 1, options: [], selectedId: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Cached project', 3), 100);
    await queryClient.invalidateQueries({
      queryKey: timesheetSheetQueryKey({
        provider: 'eurecia',
        sheetId: sheet.id,
        navigationUrl: sheet.navigationUrl,
      }),
      refetchType: 'none',
    });
    await renderDialog(queryClient);
    await enterEditor();

    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          'Inspecting sheet and building draft...',
        ),
      );
    });
    expect(document.body.textContent).not.toContain('occupied-Cached project');
    expect(lookup).not.toHaveBeenCalled();

    await act(async () => {
      resolveInspection(editorModel('Fresh project', 9, 0.25, SUBMITTED_STATE));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The sheet is read-only, so its drafts are not seeded as paintable rows.
    expect(document.body.textContent).toContain('0 draft entries');
    expect(document.body.textContent).toContain('occupied-Fresh project');
    expect(document.body.textContent).toContain('25%');
    expect(document.body.textContent).not.toContain('occupied-Cached project');
    // Submitted sheets are read-only in Eurecia, so no axis lookup is attempted.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reinitializes same-key editor data when its result revision changes', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('First project', 3, 0.25), 100);
    await renderDialog(queryClient);
    await enterEditor();
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('occupied-First project'),
      );
    });

    await act(async () => {
      queryClient.setQueryData(
        timesheetSheetQueryKey({
          provider: 'eurecia',
          sheetId: sheet.id,
          navigationUrl: sheet.navigationUrl,
        }),
        editorModel('Second project', 9, 0.25),
        { updatedAt: 200 },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain('25%');
    expect(document.body.textContent).toContain('occupied-Second project');
    expect(document.body.textContent).not.toContain('occupied-First project');
  });

  it('keeps Work Activity draft details out of the Eurecia ledger', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    await renderDialog(queryClient);
    await enterEditor();
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Week breakdown'),
      );
    });

    await act(async () => {
      queryClient.setQueryData(
        draftQueryKey,
        {
          ...draft,
          entries: [
            {
              ...draft.entries[0],
              description: 'Updated draft source',
            },
          ],
        },
        { updatedAt: 200 },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).not.toContain('Fresh draft source');
    expect(document.body.textContent).not.toContain('Updated draft source');
  });

  it('shows rows already saved on a Nouvelle sheet as declared capacity', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Template project', 3, 0.25), 100);
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    expect(document.body.textContent).toContain('1 draft entry');
    expect(document.body.textContent).toContain('Unassigned');
    // A sheet can be "Nouvelle" and still hold saved-but-unsubmitted rows.
    expect(document.body.textContent).toContain('occupied-Template project');
  });

  it('does not show blank template rows as saved capacity', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Template project', 3), 100);
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    expect(document.body.textContent).toContain('Add Template project');
    expect(document.body.textContent).not.toContain('occupied-Template project');
  });

  it('disarms the picked assignment on Escape before closing the dialog', async () => {
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 1,
      options: [{ id: 'project-a', label: 'Project A' }],
      selectedId: null,
    });
    const onClose = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient, onClose);
    await enterEditor();
    await addProjectAndFillFirstDay('Project A');

    const armed = () =>
      [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].some(
        (button) =>
          button.getAttribute('aria-pressed') === 'true' &&
          button.textContent?.includes('Project A'),
      );
    // Picking a project from the palette arms it for painting.
    expect(armed()).toBe(true);

    const escape = () =>
      act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });

    // First Escape only leaves the painting mode.
    await escape();
    expect(armed()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets Nouvelle manual entries be edited and removed', async () => {
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 1,
      options: [{ id: 'project-a', label: 'Project A' }],
      selectedId: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Week breakdown'),
      );
    });

    await addProjectAndFillFirstDay('Project A');

    expect(document.body.textContent).toContain('1 draft entry');
    expect(document.body.textContent).toContain('Duration');
    expect(document.body.textContent).toContain('Project');
    expect(document.body.textContent).toContain('Comment');

    const halfDayButton = document.querySelector<HTMLButtonElement>(
      'button[title="0.5 day"]',
    );
    await act(async () => halfDayButton?.click());

    expect(halfDayButton?.getAttribute('aria-pressed')).toBe('true');

    const textarea = document.querySelector('textarea');
    await act(async () => {
      textarea!.value = 'Manual note';
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(textarea?.value).toBe('Manual note');

    const removeButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Delete entry'),
    );
    await act(async () => removeButton?.click());

    expect(document.body.textContent).toContain('0 draft entries');
    expect(document.body.textContent).toContain('Nothing declared for this week yet.');
  });

  it('loads all Project options and auto-selects Activity when only one is possible', async () => {
    const lookup = vi.spyOn(api.timesheets, 'lookupAxisOptions').mockImplementation(
      async (params) =>
        params.axis === 1
          ? {
              axis: 1,
              options: [
                { id: 'project-a', label: 'Project A' },
                { id: 'project-b', label: 'Project B' },
              ],
              selectedId: null,
            }
          : {
              axis: params.axis,
              options: [{ id: 'activity-a', label: 'Activity A' }],
              selectedId: null,
            },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, {
      ...editorModel('Project', 3),
      axisLabels: { axis1: 'Project', axis2: 'Activity', axis3: 'Role' },
    }, 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Week breakdown'),
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ axis: 1 })),
      );
    });
    await addProjectAndFillFirstDay('Project B');

    await act(async () => {
      await vi.waitFor(() =>
        expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ axis: 2 })),
      );
    });
    const activityCombobox = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Activity"]',
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(activityCombobox?.textContent).toContain('Activity A'),
      );
    });
  });

  it('walks into the neighbouring sheet when the week arrows hit the range edge', async () => {
    const nextSheet: TimesheetSheetSummary = {
      ...sheet,
      id: 'sheet-2',
      navigationUrl: 'https://tenant.example/timesheet?id=sheet-2',
      description: 'August sheet',
      start: '2026-08-03',
      end: '2026-08-04',
    };
    const inspect = vi
      .spyOn(api.timesheets, 'inspectSheet')
      .mockImplementation(() => new Promise(() => {}));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [sheet, nextSheet],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('July sheet'),
      );
    });

    const nextWeek = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Next week"]',
    );
    expect(nextWeek?.disabled).toBe(false);
    await act(async () => nextWeek?.click());

    await act(async () => {
      await vi.waitFor(() =>
        expect(inspect).toHaveBeenCalledWith(
          expect.objectContaining({ sheetId: 'sheet-2' }),
        ),
      );
    });
  });

  it('primes the project picker from an occupied row when no free row exists', async () => {
    const lookup = vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 1,
      options: [{ id: 'project-a', label: 'Project A' }],
      selectedId: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(
      queryClient,
      {
        axisLabels: { axis1: 'Project', axis2: '', axis3: '' },
        axisOptions: { axis1: [], axis2: [], axis3: [] },
      submission: { known: true, canSave: true, canSubmit: true, submitted: false },
        rows: [
          {
            rowIndex: 7,
            date: '2026-07-13',
            fraction: 1,
            occupied: true,
            axis1Id: 'occupied-project',
            axis2Id: '',
            axis3Id: '',
            comment: '',
          },
        ],
      },
      100,
    );
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    await act(async () => {
      await vi.waitFor(() =>
        expect(lookup).toHaveBeenCalledWith(
          expect.objectContaining({ rowIndex: 7, axis: 1 }),
        ),
      );
    });
  });

  it('lists Eurecia projects in the palette before any entry exists', async () => {
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 1,
      options: [
        { id: 'project-a', label: '|---- Project A' },
        { id: 'project-b', label: 'Project B' },
      ],
      selectedId: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Pick from Eurecia'),
      );
    });

    const picker = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label^="Add "]',
    );
    await act(async () => picker?.click());

    expect(document.body.textContent).toContain('Project A');
    expect(document.body.textContent).toContain('Project B');
    expect(document.body.textContent).not.toContain('|----');

    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
        .find((button) => button.textContent?.includes('Project B'))
        ?.click();
    });

    // Added assignments leave the picker and become paintable palette rows.
    expect(
      document.querySelector('button[aria-pressed="true"]')?.textContent,
    ).toContain('Project B');
  });

  it('applies the persisted default role to newly painted entries', async () => {
    globalThis.localStorage.setItem(
      'jean-claude:eurecia:default-role',
      JSON.stringify('role-lead'),
    );
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockImplementation(
      async (params) => ({
        axis: params.axis,
        options:
          params.axis === 1
            ? [{ id: 'project-a', label: 'Project A' }]
            : params.axis === 3
              ? [{ id: 'role-lead', label: 'Tech Lead' }]
              : [],
        selectedId: null,
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, {
      ...editorModel('Project', 3),
      axisLabels: { axis1: 'Project', axis2: 'Activity', axis3: 'Role' },
    }, 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Pick from Eurecia'),
      );
    });
    await addProjectAndFillFirstDay('Project A');

    const roleCombobox = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Role"]',
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(roleCombobox?.textContent).toContain('Tech Lead'),
      );
    });
  });

  it('explains why a submitted sheet cannot be edited', async () => {
    const lookup = vi.spyOn(api.timesheets, 'lookupAxisOptions');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3, 0.25, SUBMITTED_STATE), 100);
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'À Valider' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    expect(document.body.textContent).toContain('À Valider');
    expect(document.body.textContent).toContain('read-only');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('falls back to the sheet status when the page actions cannot be read', async () => {
    // No recognizable action on the page: a "Nouvelle" sheet stays editable
    // instead of silently losing its drafts.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(
      queryClient,
      editorModel('Project', 3, 0, {
        known: false,
        canSave: false,
        canSubmit: false,
        submitted: false,
      }),
      100,
    );
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    expect(document.body.textContent).toContain('1 draft entry');
    expect(document.body.textContent).not.toContain('read-only');
  });

  it('does not seed draft rows on a submitted sheet', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3, 0.25, SUBMITTED_STATE), 100);
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'À Valider' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    expect(document.body.textContent).toContain('0 draft entries');
    expect(document.body.textContent).not.toContain('Unassigned');
    // The drafts were skipped as read-only, not reported as out of range.
    expect(document.body.textContent).not.toContain('falls outside this sheet');
    expect(document.body.textContent).toContain('read-only');
  });

  it('ignores Work Activity drafts that fall outside the selected sheet', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(
      draftQueryKey,
      {
        ...draft,
        entries: [{ ...draft.entries[0], date: '2026-08-10' }],
      },
      { updatedAt: 100 },
    );
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    expect(document.body.textContent).toContain('0 draft entries');
    expect(document.body.textContent).toContain('outside');
  });

  it('backfills rail dropdowns from every option Eurecia returned', async () => {
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockImplementation(
      async (params) => ({
        axis: params.axis,
        options:
          params.axis === 1
            ? [{ id: 'project-a', label: 'Project A' }]
            : params.axis === 2
              ? [
                  { id: 'activity-a', label: 'Activity A' },
                  { id: 'activity-b', label: 'Activity B' },
                ]
              : [{ id: 'role-lead', label: 'Tech Lead' }],
        selectedId: null,
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, {
      ...editorModel('Project', 3),
      axisLabels: { axis1: 'Project', axis2: 'Activity', axis3: 'Role' },
    }, 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();
    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Pick from Eurecia'),
      );
    });
    await addProjectAndFillFirstDay('Project A');

    const roleCombobox = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="Role"]',
    );
    await act(async () => {
      await vi.waitFor(() => expect(roleCombobox?.disabled).toBe(false));
    });
    await act(async () => roleCombobox?.click());

    expect(document.body.textContent).toContain('Tech Lead');
  });

  it('persists resized pane widths and manually added projects', async () => {
    globalThis.localStorage.setItem(
      'jean-claude:eurecia:palette-width',
      JSON.stringify(320),
    );
    globalThis.localStorage.setItem(
      'jean-claude:eurecia:pinned-projects',
      JSON.stringify(['project-pinned']),
    );
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 1,
      options: [{ id: 'project-pinned', label: 'Pinned Project' }],
      selectedId: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Pinned Project'),
      );
    });
    const resizer = document.querySelector(
      '[aria-label="Resize assignments pane"]',
    );
    expect(resizer?.getAttribute('aria-valuenow')).toBe('320');
  });

  it('still lists Eurecia projects when the sheet page already named some', async () => {
    globalThis.localStorage.setItem(
      'jean-claude:eurecia:pinned-projects',
      JSON.stringify(['project-pinned']),
    );
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 1,
      options: [{ id: 'project-pinned', label: 'Pinned Project' }],
      selectedId: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    const model = editorModel('Project', 3);
    seedDialogQueries(
      queryClient,
      {
        ...model,
        // Labels parsed straight from the sheet must not replace the lookup.
        axisOptions: {
          ...model.axisOptions,
          axis1: [{ id: 'project-declared', label: 'Declared Project' }],
        },
      },
      100,
    );
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Pinned Project'),
      );
    });
    expect(document.body.textContent).not.toContain('project-pinned');
  });

  it('offers roles declared on the sheet even when no lookup returns any', async () => {
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 3,
      options: [],
      selectedId: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    const model = editorModel('Project', 3, 0.25);
    seedDialogQueries(
      queryClient,
      {
        ...model,
        axisOptions: {
          ...model.axisOptions,
          axis3: [{ id: 'role-saved', label: 'Saved Role' }],
        },
      },
      100,
    );
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    const roleCombobox = [
      ...document.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'),
    ].find((button) => button.getAttribute('aria-label')?.startsWith('Default '));
    // A role Eurecia already declared keeps the picker usable.
    expect(roleCombobox?.disabled).toBe(false);
    await act(async () => roleCombobox?.click());
    expect(document.body.textContent).toContain('Saved Role');
  });

  it('opens read-only details for a row already saved in Eurecia', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Saved project', 3, 0.25), 100);
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    const savedRow = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Saved Eurecia row"]',
    );
    expect(savedRow).not.toBeNull();
    await act(async () => savedRow?.click());

    expect(document.body.textContent).toContain('Saved in Eurecia');
    expect(document.body.textContent).toContain(
      'This row is already declared in Eurecia',
    );

    // Clicking the same row again closes the panel.
    await act(async () => savedRow?.click());
    expect(document.body.textContent).not.toContain('Saved in Eurecia');
  });

  it('overrides a saved row as a draft entry that replaces it on save', async () => {
    const save = vi.spyOn(api.timesheets, 'save').mockResolvedValue({
      provider: 'eurecia',
      sheetId: sheet.id,
      summary: {
        action: 'save',
        entryCount: 1,
        addedRowCount: 0,
        updatedRowCount: 0,
      deletedRowCount: 1,
        savedRowIndices: [0],
        dates: ['2026-07-13'],
      },
      warnings: [],
      editor: editorModel('Saved project', 3),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Saved project', 3, 0.25), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    const savedRow = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Saved Eurecia row"]',
    );
    await act(async () => savedRow?.click());
    const edit = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Edit as draft'));
    expect(edit).not.toBeNull();
    await act(async () => edit?.click());

    // The copy is editable and the original is staged for removal.
    expect(document.body.textContent).toContain('1 draft entry');
    const halfDay = [
      ...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
    ].find((button) => button.getAttribute('title') === '0.5 day');
    await act(async () => halfDay?.click());

    const saveButton = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Save to Eurecia'));
    await act(async () => saveButton?.click());
    const commit = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.includes('Save to Eurecia'));
    await act(async () => commit?.click());

    // The edited row is rewritten in place rather than deleted and re-added.
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [],
        deletions: [],
        updates: [
          {
            target: expect.objectContaining({ rowIndex: 4, fraction: 0.25 }),
            values: expect.objectContaining({
              fraction: 0.5,
              axis1Id: 'occupied-Saved project',
            }),
          },
        ],
      }),
    );
  });

  it('stages a saved row for deletion and sends it with the save', async () => {
    const save = vi.spyOn(api.timesheets, 'save').mockResolvedValue({
      provider: 'eurecia',
      sheetId: sheet.id,
      summary: {
        action: 'save',
        entryCount: 0,
        addedRowCount: 0,
        updatedRowCount: 0,
      deletedRowCount: 1,
        savedRowIndices: [],
        dates: ['2026-07-13'],
      },
      warnings: [],
      editor: editorModel('Saved project', 3),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Saved project', 3, 0.25), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    const savedRow = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Saved Eurecia row"]',
    );
    await act(async () => savedRow?.click());
    const remove = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Remove from Eurecia'));
    expect(remove).not.toBeNull();
    await act(async () => remove?.click());

    // Removing rows is enough to save, with no draft entries.
    const saveButton = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Save to Eurecia'));
    expect(saveButton?.disabled).toBe(false);
    await act(async () => saveButton?.click());

    expect(document.body.textContent).toContain(
      'permanently deletes 1 saved row',
    );

    const commit = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.includes('Save to Eurecia'));
    await act(async () => commit?.click());

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [],
        deletions: [
          expect.objectContaining({ rowIndex: 4, date: '2026-07-13' }),
        ],
      }),
    );
  });

  it('removes a manually added project from the palette', async () => {
    globalThis.localStorage.setItem(
      'jean-claude:eurecia:pinned-projects',
      JSON.stringify(['project-pinned']),
    );
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 1,
      options: [{ id: 'project-pinned', label: 'Pinned Project' }],
      selectedId: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Pinned Project'),
      );
    });

    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Pinned Project"]',
    );
    expect(remove).not.toBeNull();
    await act(async () => remove?.click());

    expect(document.body.textContent).not.toContain('Pinned Project');
    expect(
      JSON.parse(
        globalThis.localStorage.getItem('jean-claude:eurecia:pinned-projects') ??
          '[]',
      ),
    ).toEqual([]);
  });

  it('adopts a pinned project sub-axis when Eurecia offers a single option', async () => {
    globalThis.localStorage.setItem(
      'jean-claude:eurecia:pinned-projects',
      JSON.stringify(['project-pinned']),
    );
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockImplementation(
      async ({ axis }) => {
        if (axis === 1) {
          return {
            axis,
            options: [{ id: 'project-pinned', label: 'Pinned Project' }],
            selectedId: null,
          };
        }
        if (axis === 2) {
          return {
            axis,
            options: [{ id: 'mission-only', label: 'Only Mission' }],
            selectedId: null,
          };
        }
        // Two roles is a real choice, so nothing is adopted for axis 3.
        return {
          axis,
          options: [
            { id: 'role-a', label: 'Role A' },
            { id: 'role-b', label: 'Role B' },
          ],
          selectedId: null,
        };
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Only Mission'),
      );
    });
    expect(document.body.textContent).not.toContain('No sub-axis');
    expect(document.body.textContent).not.toContain('Role A');
    expect(
      JSON.parse(
        globalThis.localStorage.getItem(
          'jean-claude:eurecia:pinned-project-sub-axes',
        ) ?? '{}',
      ),
    ).toEqual({
      'project-pinned': { axis2Id: 'mission-only', axis3Id: '' },
    });
  });

  it('names a pinned project this sheet does not list from the label cache', async () => {
    globalThis.localStorage.setItem(
      'jean-claude:eurecia:pinned-projects',
      JSON.stringify(['project-elsewhere']),
    );
    globalThis.localStorage.setItem(
      'jean-claude:eurecia:axis-label-cache',
      JSON.stringify({ '1:project-elsewhere': 'Project From Another Sheet' }),
    );
    // This sheet exposes no options at all, so only the cache can name it.
    vi.spyOn(api.timesheets, 'lookupAxisOptions').mockResolvedValue({
      axis: 1,
      options: [],
      selectedId: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedDialogQueries(queryClient, editorModel('Project', 3), 100);
    queryClient.setQueryData(draftQueryKey, { ...draft, entries: [] }, { updatedAt: 100 });
    queryClient.setQueryData(
      ['timesheets', 'eurecia', 'sheets'],
      [{ ...sheet, status: 'Nouvelle' }],
      { updatedAt: 100 },
    );

    await renderDialog(queryClient);
    await enterEditor();

    await act(async () => {
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          'Project From Another Sheet',
        ),
      );
    });
    expect(document.body.textContent).not.toContain('project-elsewhere');
  });
});
