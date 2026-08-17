import { describe, expect, it, vi } from 'vitest';

import type { TimesheetEntryInput } from '@shared/timesheet-types';

import {
  createEureciaReadService,
  EURECIA_REDACTED_SHEET_ID,
  EureciaBrowseDiscoveryError,
  type EureciaReadFetch,
  EureciaTimesheetAccessError,
  parseRedactedTimesheetForm,
} from './eurecia-read-service';
import {
  type EureciaRowColumn,
  getEureciaRowFieldName,
} from './eurecia-protocol-client';

const ORIGIN = 'https://tenant.example';
const BROWSE_URL = `${ORIGIN}/eurecia/timesheet/Browse.do?module=timesheet`;
const EDIT_URL = `${ORIGIN}/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&param=opaque-sheet`;
const OPEN_URL = `${ORIGIN}/eurecia/timesheet/Open.do?param=opaque-sheet`;
const INTERNAL_SHEET_ID = 'internal-timesheet-123';
const AXIS_LABELS = { axis1: 'Client', axis2: 'Mission', axis3: 'Role' };

function response({
  url,
  body,
  contentType,
  location,
  status = 200,
}: {
  url: string;
  body: string;
  contentType: string;
  location?: string;
  status?: number;
}) {
  const headers = new Headers({ 'content-type': contentType });
  if (location) headers.set('location', location);
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => body,
  };
}

function browseHtml() {
  const cells = Array.from({ length: 13 }, (_, index) => {
    if (index === 0) return `<a href="${EDIT_URL}">Edit</a>`;
    if (index === 2) return 'July synthetic sheet';
    if (index === 3) return '01/07/2026';
    if (index === 4) return '31/07/2026';
    if (index === 12) return 'Open';
    return '';
  });
  return `<table class="ibody"><tbody><tr class="clickable">${cells
    .map((cell) => `<td>${cell}</td>`)
    .join('')}</tr></tbody></table>`;
}

function rowControl(column: EureciaRowColumn, rowIndex = 0) {
  return getEureciaRowFieldName({ column, rowIndex });
}

function activityRow({
  rowIndex,
  fraction = 0,
  comment = '',
}: {
  rowIndex: number;
  fraction?: number;
  comment?: string;
}) {
  return `
    <span id="dateActivite_${rowIndex}">01/07/2026</span>
    <input name="${rowControl('fullDay', rowIndex)}" value="false">
    <input name="${rowControl('generatedItem', rowIndex)}" value="true">
    <input name="${rowControl('daysWorked_int', rowIndex)}" value="0">
    <input name="${rowControl('daysWorked_fraction', rowIndex)}" value="${fraction}">
    <input name="${rowControl('imputationStructureId1', rowIndex)}" value="">
    <input name="${rowControl('imputationStructureId2', rowIndex)}" value="">
    <input name="${rowControl('imputationStructureId3', rowIndex)}" value="">
    <textarea name="${rowControl('comment', rowIndex)}">${comment}</textarea>
  `;
}

function openHtml() {
  return `<html><body>
    <span id="dateActivite_0">01/07/2026</span>
    <form action="/eurecia/timesheet/Open.do?param=private-sheet-token" method="post" enctype="multipart/form-data">
      <input name="org.apache.struts.taglib.html.TOKEN" value="private-csrf-token">
      <input name="idTimeSheet" value="${INTERNAL_SHEET_ID}">
      <input name="idOfForm" value="private-form-token">
      <input name="validate" value="">
      <input name="changed" value="true">
      <input name="${rowControl('fullDay')}" value="false">
      <input name="${rowControl('generatedItem')}" value="true">
      <input name="${rowControl('daysWorked_int')}" value="0">
      <input name="${rowControl('daysWorked_fraction')}" value="0.25">
      <input name="${rowControl('imputationStructureId1')}" value="existing-axis-1">
      <input name="${rowControl('imputationStructureId2')}" value="existing-axis-2">
      <input name="${rowControl('imputationStructureId3')}" value="existing-axis-3">
      <textarea name="${rowControl('comment')}">Private existing comment</textarea>
    </form>
  </body></html>`;
}

function createFetchQueue(overrides?: { openBody?: string }) {
  const responses = [
    response({
      url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
      body: JSON.stringify({
        navigation: { nested: 'timesheet/Browse.do?module=timesheet' },
      }),
      contentType: 'application/json; charset=utf-8',
    }),
    response({
      url: BROWSE_URL,
      body: browseHtml(),
      contentType: 'text/html; charset=utf-8',
    }),
    response({
      url: EDIT_URL,
      body: '',
      contentType: 'text/html',
      location: OPEN_URL,
      status: 302,
    }),
    response({
      url: OPEN_URL,
      body: overrides?.openBody ?? openHtml(),
      contentType: 'text/html',
    }),
  ];
  return vi.fn<EureciaReadFetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected fetch');
    return next;
  });
}

async function inspectService(fetch = createFetchQueue()) {
  const service = createEureciaReadService({
    baseUrl: ORIGIN,
    axisLabels: AXIS_LABELS,
    fetch,
  });
  const [sheet] = await service.listSheets();
  const editor = await service.inspectSheet({
    sheetId: sheet.id,
    navigationUrl: sheet.navigationUrl,
  });
  return { service, fetch, sheet, editor };
}

async function listedService() {
  const fetch = createFetchQueue();
  const service = createEureciaReadService({
    baseUrl: ORIGIN,
    axisLabels: AXIS_LABELS,
    fetch,
  });
  const [sheet] = await service.listSheets();
  const expectedRevision = service.beginSheetInspection({
    sheetId: sheet.id,
    navigationUrl: sheet.navigationUrl,
  });
  return { service, fetch, sheet, expectedRevision };
}

function entry(overrides: Partial<TimesheetEntryInput> = {}): TimesheetEntryInput {
  return {
    date: '2026-07-01',
    fraction: 0.25,
    axis1Id: 'axis-1',
    axis2Id: 'axis-2',
    axis3Id: 'axis-3',
    comment: '',
    sourceDraftIds: ['draft-placeholder'],
    ...overrides,
  };
}

describe('Eurecia read service', () => {
  it.each([
    [
      'network',
      async () => {
        throw new TypeError('fetch failed with secret-token');
      },
      'network',
    ],
    [
      'login redirect',
      async () =>
        response({
          url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
          body: '',
          contentType: 'text/html',
          location: '/eurecia/',
          status: 302,
        }),
      'login-redirect',
    ],
    [
      'HTTP status',
      async () =>
        response({
          url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
          body: 'secret response body',
          contentType: 'application/json',
          status: 503,
        }),
      'http-status',
    ],
    [
      'content type',
      async () =>
        response({
          url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
          body: '<html>secret login body</html>',
          contentType: 'text/html',
        }),
      'content-type',
    ],
    [
      'invalid JSON',
      async () =>
        response({
          url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
          body: '{"token":"secret-token"',
          contentType: 'application/json',
        }),
      'invalid-json',
    ],
    [
      'invalid payload',
      async () =>
        response({
          url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
          body: '[]',
          contentType: 'application/json',
        }),
      'invalid-payload',
    ],
    [
      'missing navigation marker',
      async () =>
        response({
          url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
          body: JSON.stringify({ challenge: { token: 'secret-token' } }),
          contentType: 'application/json',
        }),
      'missing-navigation-marker',
    ],
    [
      'unknown response read failure',
      async () => ({
        ...response({
          url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
          body: '',
          contentType: 'application/json',
        }),
        text: async () => {
          throw new Error('unknown secret-token');
        },
      }),
      'unknown',
    ],
  ] as const)('classifies %s discovery failures as %s', async (_label, fetchImpl, reason) => {
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch: vi.fn<EureciaReadFetch>(fetchImpl),
    });

    const error = await service.discoverBrowseUrl().catch((caught) => caught);

    expect(error).toBeInstanceOf(EureciaBrowseDiscoveryError);
    expect(error).toMatchObject({ reason });
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });

  it('classifies an aborted discovery without treating it as a network failure', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<EureciaReadFetch>(async (_url, { signal }) => {
      controller.abort();
      throw new DOMException(
        `Aborted token=secret-token ${String(signal?.aborted)}`,
        'AbortError',
      );
    });
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });

    await expect(service.discoverBrowseUrl(controller.signal)).rejects.toMatchObject({
      reason: 'timeout-or-cancel',
    });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('rejects an unauthenticated initData login redirect without classifying it as missing access', async () => {
    const fetch = vi.fn<EureciaReadFetch>(async () =>
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: '',
        contentType: 'text/html',
        location: '/eurecia/',
        status: 302,
      }),
    );
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });

    const error = await service.discoverBrowseUrl().catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EureciaTimesheetAccessError);
    expect(error.message).toContain('prohibited endpoint');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('discovers the Browse URL from valid authenticated initData JSON', async () => {
    const fetch = vi.fn<EureciaReadFetch>(async () =>
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({ navigation: { nested: BROWSE_URL } }),
        contentType: 'application/json',
      }),
    );
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });

    await expect(service.discoverBrowseUrl()).resolves.toBe(BROWSE_URL);
  });

  it('discovers the Browse URL nested outside top-level navigation', async () => {
    const fetch = vi.fn<EureciaReadFetch>(async () =>
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({ modules: { timesheet: { browseUrl: BROWSE_URL } } }),
        contentType: 'application/json',
      }),
    );
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });

    await expect(service.discoverBrowseUrl()).resolves.toBe(BROWSE_URL);
  });

  it.each([
    ['cross-origin', 'https://other.example/eurecia/timesheet/Browse.do'],
    ['wrong-path', `${ORIGIN}/eurecia/admin/timesheet/Browse.do`],
  ])(
    'does not authenticate an outside-navigation %s Browse URL lookalike',
    async (_label, browseUrl) => {
      const fetch = vi.fn<EureciaReadFetch>(async () =>
        response({
          url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
          body: JSON.stringify({ modules: { timesheet: { browseUrl } } }),
          contentType: 'application/json',
        }),
      );
      const service = createEureciaReadService({
        baseUrl: ORIGIN,
        axisLabels: AXIS_LABELS,
        fetch,
      });

      const error = await service.discoverBrowseUrl().catch((caught) => caught);

      expect(error).toBeInstanceOf(EureciaBrowseDiscoveryError);
      expect(error).not.toBeInstanceOf(EureciaTimesheetAccessError);
      expect(error).toMatchObject({ reason: 'missing-navigation-marker' });
    },
  );

  it.each([
    ['empty object', {}],
    ['API error object', { error: { code: 'UNAUTHENTICATED' } }],
    ['MFA challenge payload', { challenge: { type: 'mfa', pending: true } }],
    ['null navigation', { navigation: null }],
    ['array navigation', { navigation: [] }],
    ['scalar navigation', { navigation: 'pending' }],
  ])('keeps polling for unauthenticated initData with %s', async (_label, body) => {
    const fetch = vi.fn<EureciaReadFetch>(async () =>
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify(body),
        contentType: 'application/json',
      }),
    );
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });

    const error = await service.discoverBrowseUrl().catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EureciaTimesheetAccessError);
    expect(error).toMatchObject({ reason: 'missing-navigation-marker' });
    expect(error.message).toContain('not authenticated');
  });

  it('reports valid authenticated initData without a Browse URL as unavailable Timesheet access', async () => {
    const fetch = vi.fn<EureciaReadFetch>(async () =>
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({ navigation: { modules: ['leave', 'expenses'] } }),
        contentType: 'application/json',
      }),
    );
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });

    const error = await service.discoverBrowseUrl().catch((caught) => caught);

    expect(error).toBeInstanceOf(EureciaTimesheetAccessError);
    expect(error).toMatchObject({ reason: 'missing-timesheet-browse' });
    expect(error.message).toContain(
      'Signed in to Eurecia, but Timesheet access or configuration is unavailable.',
    );
  });

  it('discovers, lists, and inspects using same-origin GET requests only', async () => {
    const { fetch, sheet, editor } = await inspectService();

    expect(sheet).toMatchObject({
      id: 'opaque-sheet',
      start: '2026-07-01',
      end: '2026-07-31',
    });
    expect(editor.axisLabels).toEqual(AXIS_LABELS);
    expect(editor.rows).toEqual([
      {
        rowIndex: 0,
        date: '2026-07-01',
        fraction: 0.25,
        axis1Id: 'existing-axis-1',
        axis2Id: 'existing-axis-2',
        axis3Id: 'existing-axis-3',
        comment: 'Private existing comment',
        occupied: true,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetch.mock.calls) {
      expect(new URL(url).origin).toBe(ORIGIN);
      expect(new URL(url).pathname.startsWith('/eurecia/')).toBe(true);
      expect(init).toEqual({
        method: 'GET',
        redirect: 'manual',
        credentials: 'include',
      });
    }
  });

  it('inspects a runtime-shaped grouped continuation row without fullDay or date', async () => {
    const continuation = `
      <input name="${rowControl('generatedItem', 1)}" value="false">
      <input name="${rowControl('daysWorked_int', 1)}" value="0">
      <input name="${rowControl('daysWorked_fraction', 1)}" value="0.5">
      <input name="${rowControl('imputationStructureId1', 1)}" value="runtime-axis-1">
      <input name="${rowControl('imputationStructureId2', 1)}" value="runtime-axis-2">
      <input name="${rowControl('imputationStructureId3', 1)}" value="runtime-axis-3">
      <textarea name="${rowControl('comment', 1)}">Runtime continuation</textarea>
    `;
    const openBody = openHtml().replace('</form>', `${continuation}</form>`);

    const { editor } = await inspectService(createFetchQueue({ openBody }));

    expect(editor.rows).toEqual([
      expect.objectContaining({
        rowIndex: 0,
        date: '2026-07-01',
        fraction: 0.25,
        occupied: true,
      }),
      {
        rowIndex: 1,
        date: '2026-07-01',
        fraction: 0.5,
        axis1Id: 'runtime-axis-1',
        axis2Id: 'runtime-axis-2',
        axis3Id: 'runtime-axis-3',
        comment: 'Runtime continuation',
        occupied: true,
      },
    ]);
  });

  it('stores distinct internal form identity while dry run stays keyed by Browse ID', async () => {
    const { service, sheet } = await inspectService();

    expect(sheet.id).toBe('opaque-sheet');
    expect(
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry()],
      }),
    ).toMatchObject({ sheetId: 'opaque-sheet' });
  });

  it('redacts parsed and cached form identity while preserving read-only dry run', async () => {
    const internalSheetId = 'private-internal-sheet-987';
    const openBody = openHtml().replace(INTERNAL_SHEET_ID, internalSheetId);
    const form = parseRedactedTimesheetForm({ html: openBody, pageUrl: OPEN_URL });

    expect(form.fields.filter(({ name }) => name === 'idTimeSheet')).toEqual([
      { name: 'idTimeSheet', value: EURECIA_REDACTED_SHEET_ID },
    ]);
    expect(JSON.stringify(form)).not.toContain(internalSheetId);

    const { service, sheet, editor } = await inspectService(
      createFetchQueue({ openBody }),
    );
    const dryRun = service.prepareDryRun({
      sheetId: sheet.id,
      action: 'save',
      entries: [entry()],
    });

    expect(dryRun).toMatchObject({ sheetId: 'opaque-sheet' });
    expect(JSON.stringify({ editor, dryRun })).not.toContain(internalSheetId);
  });

  it('invalidates an inspection after the sheet list is refreshed', async () => {
    const { service, fetch, sheet } = await inspectService();
    const refreshFetch = createFetchQueue();
    fetch.mockImplementation(refreshFetch);

    await service.listSheets();

    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        entries: [entry({ rowIndex: 0 })],
        action: 'save',
      }),
    ).toThrow('latest Browse result');
  });

  it('does not cache an inspection completed after a concurrent list refresh', async () => {
    let resolveOpen!: (value: ReturnType<typeof response>) => void;
    const delayedOpen = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveOpen = resolve;
    });
    const responses: Array<
      ReturnType<typeof response> | Promise<ReturnType<typeof response>>
    > = [
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({ navigation: { nested: BROWSE_URL } }),
        contentType: 'application/json',
      }),
      response({
        url: BROWSE_URL,
        body: browseHtml(),
        contentType: 'text/html',
      }),
      response({
        url: EDIT_URL,
        body: '',
        contentType: 'text/html',
        location: OPEN_URL,
        status: 302,
      }),
      delayedOpen,
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({ navigation: { nested: BROWSE_URL } }),
        contentType: 'application/json',
      }),
      response({
        url: BROWSE_URL,
        body: browseHtml(),
        contentType: 'text/html',
      }),
    ];
    const fetch = vi.fn<EureciaReadFetch>(async () => {
      const next = responses.shift();
      if (!next) throw new Error('Unexpected fetch');
      return next;
    });
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });
    const [sheet] = await service.listSheets();
    const inspection = service.inspectSheet({
      sheetId: sheet.id,
      navigationUrl: sheet.navigationUrl,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));

    await service.listSheets();
    resolveOpen(
      response({
        url: OPEN_URL,
        body: openHtml(),
        contentType: 'text/html',
      }),
    );

    await expect(inspection).rejects.toThrow('changed during inspection');
    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        entries: [entry({ rowIndex: 0 })],
        action: 'save',
      }),
    ).toThrow('latest Browse result');
  });

  it('rejects invalid base origins and cross-origin discovery URLs', async () => {
    expect(() =>
      createEureciaReadService({
        baseUrl: `${ORIGIN}/eurecia`,
        axisLabels: AXIS_LABELS,
        fetch: createFetchQueue(),
      }),
    ).toThrow('HTTPS origin');

    const fetch = vi.fn<EureciaReadFetch>(async () =>
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({
          navigation: {},
          url: 'https://other.example/eurecia/timesheet/Browse.do',
        }),
        contentType: 'application/json',
      }),
    );
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });
    await expect(service.discoverBrowseUrl()).rejects.toThrow('not found');
  });

  it('ignores malformed nested discovery candidates until an exact URL is found', async () => {
    const fetch = vi.fn<EureciaReadFetch>(async () =>
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({
          navigation: {
            nested: [
              'https://[malformed/timesheet/Browse.do',
              '/eurecia/nested/timesheet/Browse.do',
              'https://other.example/eurecia/timesheet/Browse.do',
              'timesheet/Browse.do?module=timesheet',
            ],
          },
        }),
        contentType: 'application/json',
      }),
    );
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });

    await expect(service.discoverBrowseUrl()).resolves.toBe(BROWSE_URL);
  });

  it.each([
    'https://other.example/eurecia/timesheet/Browse.do',
    `${ORIGIN}/outside/timesheet/Browse.do`,
    `${ORIGIN}/eurecia/nested/timesheet/Browse.do`,
  ])('rejects prohibited redirect hop without fetching it: %s', async (location) => {
    const responses = [
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({ navigation: {}, url: BROWSE_URL }),
        contentType: 'application/json',
      }),
      response({
        url: BROWSE_URL,
        body: '',
        contentType: 'text/html',
        location,
        status: 302,
      }),
    ];
    const fetch = vi.fn<EureciaReadFetch>(async () => {
      const next = responses.shift();
      if (!next) throw new Error('Prohibited redirect was fetched');
      return next;
    });
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });

    await expect(service.listSheets()).rejects.toThrow('prohibited endpoint');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(location);
  });

  it('rejects login HTML and wrong initData content types', async () => {
    const wrongContentFetch = vi.fn<EureciaReadFetch>(async () =>
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: '<html>login</html>',
        contentType: 'text/html',
      }),
    );
    const wrongContentService = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch: wrongContentFetch,
    });
    await expect(wrongContentService.listSheets()).rejects.toThrow(
      'json content type',
    );

    const responses = [
      response({
        url: `${ORIGIN}/eurecia/api/v3/users/me/initData`,
        body: JSON.stringify({ url: BROWSE_URL }),
        contentType: 'application/json',
      }),
      response({
        url: BROWSE_URL,
        body: '<html><form action="/login"><input type="password"></form></html>',
        contentType: 'text/html',
      }),
    ];
    const loginFetch = vi.fn<EureciaReadFetch>(async () => responses.shift()!);
    const loginService = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch: loginFetch,
    });
    await expect(loginService.listSheets()).rejects.toThrow('authenticated');
  });

  it.each([
    [
      'missing',
      openHtml().replace(
        `<input name="idTimeSheet" value="${INTERNAL_SHEET_ID}">`,
        '',
      ),
    ],
    [
      'duplicate',
      openHtml().replace(
        `<input name="idTimeSheet" value="${INTERNAL_SHEET_ID}">`,
        `<input name="idTimeSheet" value="${INTERNAL_SHEET_ID}"><input name="idTimeSheet" value="${INTERNAL_SHEET_ID}">`,
      ),
    ],
    [
      'duplicate with empty value',
      openHtml().replace(
        `<input name="idTimeSheet" value="${INTERNAL_SHEET_ID}">`,
        `<input name="idTimeSheet" value="${INTERNAL_SHEET_ID}"><input name="idTimeSheet" value="">`,
      ),
    ],
    [
      'empty',
      openHtml().replace(
        `<input name="idTimeSheet" value="${INTERNAL_SHEET_ID}">`,
        '<input name="idTimeSheet" value="">',
      ),
    ],
    [
      'oversized characters',
      openHtml().replace(
        INTERNAL_SHEET_ID,
        'x'.repeat(513),
      ),
    ],
    [
      'oversized bytes',
      openHtml().replace(
        INTERNAL_SHEET_ID,
        '€'.repeat(400),
      ),
    ],
  ])('rejects %s Open form sheet identity before caching', async (_case, openBody) => {
    await expect(
      inspectService(createFetchQueue({ openBody })),
    ).rejects.toThrow('timesheet ID');
  });

  it('ingests trusted editor HTML without another network request', async () => {
    const { service, fetch, sheet, expectedRevision } = await listedService();

    const editor = service.inspectSheetHtml({
      sheetId: sheet.id,
      navigationUrl: sheet.navigationUrl,
      pageUrl: OPEN_URL,
      html: openHtml(),
      expectedRevision,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(editor.rows).toEqual([
      expect.objectContaining({
        rowIndex: 0,
        axis1Id: 'existing-axis-1',
        axis2Id: 'existing-axis-2',
        axis3Id: 'existing-axis-3',
        comment: 'Private existing comment',
        occupied: true,
      }),
    ]);
  });

  it.each([
    ['cross-origin', 'https://evil.example/eurecia/timesheet/Open.do'],
    ['wrong-path', `${ORIGIN}/eurecia/timesheet/Browse.do`],
  ])('rejects trusted editor HTML from a %s page URL', async (_case, pageUrl) => {
    const { service, sheet, expectedRevision } = await listedService();

    expect(() =>
      service.inspectSheetHtml({
        sheetId: sheet.id,
        navigationUrl: sheet.navigationUrl,
        pageUrl,
        html: openHtml(),
        expectedRevision,
      }),
    ).toThrow('same-origin Open.do');
  });

  it.each([
    [
      'duplicate',
      openHtml().replace(
        `<input name="idTimeSheet" value="${INTERNAL_SHEET_ID}">`,
        `<input name="idTimeSheet" value="${INTERNAL_SHEET_ID}"><input name="idTimeSheet" value="${INTERNAL_SHEET_ID}">`,
      ),
    ],
    [
      'empty',
      openHtml().replace(`value="${INTERNAL_SHEET_ID}"`, 'value=""'),
    ],
  ])('rejects trusted HTML with a %s sheet ID', async (_case, html) => {
    const { service, sheet, expectedRevision } = await listedService();

    expect(() =>
      service.inspectSheetHtml({
        sheetId: sheet.id,
        navigationUrl: sheet.navigationUrl,
        pageUrl: OPEN_URL,
        html,
        expectedRevision,
      }),
    ).toThrow('timesheet ID');
  });

  it('rejects trusted HTML without an authenticated editor form', async () => {
    const { service, sheet, expectedRevision } = await listedService();

    expect(() =>
      service.inspectSheetHtml({
        sheetId: sheet.id,
        navigationUrl: sheet.navigationUrl,
        pageUrl: OPEN_URL,
        html: '<html><body>login</body></html>',
        expectedRevision,
      }),
    ).toThrow('authenticated timesheet page');
  });

  it('validates four-entry and daily fraction limits without network calls', async () => {
    const { service, fetch, sheet } = await inspectService();
    const callsBeforeDryRun = fetch.mock.calls.length;

    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [],
      }),
    ).toThrow('at least one entry');
    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: Array.from({ length: 5 }, () => entry()),
      }),
    ).toThrow('more than four');
    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry({ fraction: 0.75 }), entry({ fraction: 0.5 })],
      }),
    ).toThrow('exceeds one day');
    expect(fetch).toHaveBeenCalledTimes(callsBeforeDryRun);
  });

  it('includes occupied fractions in daily capacity validation', async () => {
    const openBody = openHtml().replace(
      `name="${rowControl('daysWorked_fraction')}" value="0.25"`,
      `name="${rowControl('daysWorked_fraction')}" value="0.75"`,
    );
    const { service, sheet } = await inspectService(
      createFetchQueue({ openBody }),
    );

    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry({ fraction: 0.5 })],
      }),
    ).toThrow('exceeds one day');
  });

  it('counts occupied and proposed rows toward four-entry capacity', async () => {
    const openBody = openHtml().replace(
      '</form>',
      `${activityRow({ rowIndex: 1, comment: 'occupied' })}${activityRow({ rowIndex: 2, comment: 'occupied' })}</form>`,
    );
    const { service, sheet } = await inspectService(
      createFetchQueue({ openBody }),
    );

    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry(), entry()],
      }),
    ).toThrow('more than four entries');
  });

  it('allows occupied and proposed fractions totaling one day', async () => {
    const openBody = openHtml()
      .replace(
        `name="${rowControl('daysWorked_fraction')}" value="0.25"`,
        `name="${rowControl('daysWorked_fraction')}" value="0.5"`,
      )
      .replace(
        '</form>',
        `${activityRow({ rowIndex: 1, comment: 'occupied' })}${activityRow({ rowIndex: 2, comment: 'occupied' })}${activityRow({ rowIndex: 3 })}</form>`,
      );
    const { service, sheet } = await inspectService(
      createFetchQueue({ openBody }),
    );

    expect(
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry({ rowIndex: 3, fraction: 0.5 })],
      }).summary,
    ).toMatchObject({ changedRowIndices: [3], inferredEntryCount: 0 });
  });

  it('rejects inferred and existing entries outside selected sheet range', async () => {
    const { service, sheet } = await inspectService();

    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry({ date: '2026-06-30' })],
      }),
    ).toThrow('outside selected sheet range');
    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry({ date: '2026-08-01', rowIndex: 0 })],
      }),
    ).toThrow('outside selected sheet range');
  });

  it('warns for inferred and uncaptured extra rows', async () => {
    const openBody = openHtml()
      .replace(
        `name="${rowControl('daysWorked_fraction')}" value="0.25"`,
        `name="${rowControl('daysWorked_fraction')}" value="0"`,
      )
      .replace('value="existing-axis-1"', 'value=""')
      .replace('value="existing-axis-2"', 'value=""')
      .replace('value="existing-axis-3"', 'value=""')
      .replace('Private existing comment', '');
    const { service, sheet } = await inspectService(
      createFetchQueue({ openBody }),
    );
    const result = service.prepareDryRun({
      sheetId: sheet.id,
      action: 'submit-for-approval',
      entries: [entry(), entry(), entry(), entry()],
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('inferred rows'),
        expect.stringContaining('beyond second row'),
        expect.stringContaining('not captured'),
      ]),
    );
    expect(result.summary).toMatchObject({
      entryCount: 4,
      inferredEntryCount: 4,
      changedRowIndices: [],
    });
  });

  it('rejects an explicit occupied remote row even with malicious input', async () => {
    const { service, fetch, sheet } = await inspectService();
    const callsBeforeDryRun = fetch.mock.calls.length;
    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry({ rowIndex: 0, comment: '' })],
      }),
    ).toThrow('Occupied Eurecia rows');
    expect(fetch).toHaveBeenCalledTimes(callsBeforeDryRun);
  });

  it('warns about occupied dates without exposing existing row details', async () => {
    const { service, sheet } = await inspectService();
    const result = service.prepareDryRun({
      sheetId: sheet.id,
      action: 'save',
      entries: [entry()],
    });

    expect(result.summary).toMatchObject({
      inferredEntryCount: 1,
      changedRowIndices: [],
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('inferred rows'),
        expect.stringContaining(
          '2026-07-01: existing Eurecia entries are preserved',
        ),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /private|existing-axis|existing comment/i,
    );
  });

  it('rejects occupied row indices and unselected sheets', async () => {
    const { service, sheet } = await inspectService();
    expect(() =>
      service.prepareDryRun({
        sheetId: sheet.id,
        action: 'save',
        entries: [entry({ rowIndex: 0 }), entry({ rowIndex: 0 })],
      }),
    ).toThrow('Occupied Eurecia rows');
    expect(() =>
      service.prepareDryRun({
        sheetId: 'other-sheet',
        action: 'save',
        entries: [],
      }),
    ).toThrow('inspected');
  });

  it('frees capacity for rows staged for deletion during a dry run', async () => {
    const { service, sheet } = await inspectService();

    // The sheet's only row is occupied, so without the deletion this fails.
    await expect(async () =>
      service.prepareDryRun({
        sheetId: sheet.id,
        entries: [entry({ fraction: 1 })],
        action: 'save',
      }),
    ).rejects.toThrow(/exceeds one day/);

    const result = service.prepareDryRun({
      sheetId: sheet.id,
      entries: [entry({ fraction: 1 })],
      action: 'save',
      deletions: [
        {
          date: '2026-07-01',
          rowIndex: 0,
          fraction: 0.25,
          axis1Id: 'existing-axis-1',
          axis2Id: 'existing-axis-2',
          axis3Id: 'existing-axis-3',
          comment: 'Private existing comment',
        },
      ],
    });
    expect(result.summary.entryCount).toBe(1);
  });
});
