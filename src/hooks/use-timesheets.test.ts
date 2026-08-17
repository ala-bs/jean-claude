// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '@/lib/api';

import {
  timesheetProviderQueryKey,
  timesheetSheetQueryKey,
  useLoginTimesheet,
  useTimesheetSheet,
  useTimesheetSheets,
} from './use-timesheets';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function renderLoginHook(queryClient = new QueryClient()) {
  let result: ReturnType<typeof useLoginTimesheet> | undefined;
  function Harness() {
    result = useLoginTimesheet();
    return null;
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Harness),
      ),
    );
  });
  return { getResult: () => result!, queryClient };
}

async function renderSheetHook(enabled: boolean) {
  let result: ReturnType<typeof useTimesheetSheet> | undefined;
  const params = {
    provider: 'eurecia' as const,
    sheetId: 'sheet-1',
    navigationUrl:
      'https://tenant.example/eurecia/timesheet/Browse.do?id=sheet-1',
  };
  function Harness({ queryEnabled }: { queryEnabled: boolean }) {
    result = useTimesheetSheet(params, queryEnabled);
    return null;
  }

  const queryClient = new QueryClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const render = async (queryEnabled: boolean) => {
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness, { queryEnabled }),
        ),
      );
    });
  };
  await render(enabled);
  return { getResult: () => result!, render };
}

async function renderSheetsHook() {
  let result: ReturnType<typeof useTimesheetSheets> | undefined;
  function Harness() {
    result = useTimesheetSheets();
    return null;
  }

  const queryClient = new QueryClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Harness),
      ),
    );
  });
  return { getResult: () => result! };
}

describe('timesheet query keys', () => {
  it('uses provider root for login and logout invalidation', () => {
    expect(timesheetProviderQueryKey('eurecia')).toEqual([
      'timesheets',
      'eurecia',
    ]);
  });

  it('includes navigation URL in inspected sheet identity', () => {
    expect(
      timesheetSheetQueryKey({
        provider: 'eurecia',
        sheetId: 'sheet-1',
        navigationUrl:
          'https://tenant.example/eurecia/timesheet/Browse.do?id=sheet-1',
      }),
    ).toEqual([
      'timesheets',
      'eurecia',
      'sheet',
      'sheet-1',
      'https://tenant.example/eurecia/timesheet/Browse.do?id=sheet-1',
    ]);
  });
});

describe('useLoginTimesheet', () => {
  it('resolves successful login and invalidates provider queries', async () => {
    const response = {
      configured: true,
      authenticated: true,
      baseUrl: 'https://tenant.example',
    };
    vi.spyOn(api.timesheets, 'login').mockResolvedValue(response);
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const hook = await renderLoginHook(queryClient);

    let login: Promise<typeof response> | undefined;
    act(() => {
      login = hook.getResult().mutateAsync('eurecia');
    });
    await act(async () => {
      await expect(login).resolves.toEqual(response);
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['timesheets', 'eurecia'],
    });
    await act(async () => {
      await vi.waitFor(() => expect(hook.getResult().isSuccess).toBe(true));
    });
    expect(hook.getResult().isPending).toBe(false);
  });

  it.each([
    ['cancellation', 'Eurecia sign-in was cancelled.'],
    [
      'missing Timesheet access',
      'Signed in to Eurecia, but Timesheet access or configuration is unavailable.',
    ],
  ])('rejects %s and retains error after pending state clears', async (_, message) => {
    let rejectLogin: (error: Error) => void = () => {};
    vi.spyOn(api.timesheets, 'login').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectLogin = reject;
        }),
    );
    const hook = await renderLoginHook();

    let login: Promise<unknown> | undefined;
    act(() => {
      login = hook.getResult().mutateAsync('eurecia');
    });
    const errorResult = login!.catch((error: unknown) => error);
    await act(async () => {
      await vi.waitFor(() => expect(hook.getResult().isPending).toBe(true));
    });

    let error: unknown;
    await act(async () => {
      rejectLogin(new Error(message));
      error = await errorResult;
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(hook.getResult().isPending).toBe(false);
        expect(hook.getResult().isError).toBe(true);
      });
    });

    expect(error).toEqual(new Error(message));
    expect(hook.getResult().error).toEqual(new Error(message));
  });
});

describe('useTimesheetSheet', () => {
  it('does not inspect while disabled and does not retry a deterministic IPC failure', async () => {
    const inspect = vi
      .spyOn(api.timesheets, 'inspectSheet')
      .mockRejectedValue(new Error('latest Browse result'));
    const hook = await renderSheetHook(false);

    expect(inspect).not.toHaveBeenCalled();
    await hook.render(true);
    await act(async () => {
      await vi.waitFor(() => expect(hook.getResult().isError).toBe(true));
    });

    expect(inspect).toHaveBeenCalledOnce();
  });

  it('retains inspected editor data while the query is temporarily disabled', async () => {
    const editor = {
      axisLabels: { axis1: 'Project', axis2: 'Activity', axis3: 'Role' },
      axisOptions: { axis1: [], axis2: [], axis3: [] },
      submission: { known: true, canSave: true, canSubmit: true, submitted: false },
      rows: [],
    };
    const inspect = vi
      .spyOn(api.timesheets, 'inspectSheet')
      .mockResolvedValue(editor);
    const hook = await renderSheetHook(true);
    await act(async () => {
      await vi.waitFor(() => expect(hook.getResult().data).toEqual(editor));
    });

    await hook.render(false);

    expect(hook.getResult().data).toEqual(editor);
    expect(inspect).toHaveBeenCalledOnce();
  });
});

describe('useTimesheetSheets', () => {
  it('exposes a list failure without retrying until explicitly refetched', async () => {
    const error = new Error('list failed');
    const sheets = [
      {
        id: 'sheet-1',
        description: 'July sheet',
        navigationUrl:
          'https://tenant.example/eurecia/timesheet/Browse.do?id=sheet-1',
        start: '2026-07-01',
        end: '2026-07-31',
        status: 'Open',
      },
    ];
    const listSheets = vi
      .spyOn(api.timesheets, 'listSheets')
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(sheets);
    const hook = await renderSheetsHook();

    await act(async () => {
      await vi.waitFor(() => expect(hook.getResult().isError).toBe(true));
    });

    expect(listSheets).toHaveBeenCalledOnce();
    expect(hook.getResult().error).toBe(error);

    await act(async () => {
      await hook.getResult().refetch();
      await vi.waitFor(() => expect(hook.getResult().data).toEqual(sheets));
    });

    expect(listSheets).toHaveBeenCalledTimes(2);
  });
});
