import { load } from 'cheerio';

import type {
  TimesheetAction,
  TimesheetAxisLabels,
  TimesheetDryRunResult,
  TimesheetEditorModel,
  TimesheetEntryInput,
  TimesheetRowDeletion,
  TimesheetSaveResult,
  TimesheetSheetSummary,
} from '@shared/timesheet-types';

import {
  buildMultipartFormBody,
  hasEureciaRowControl,
  parseTimesheetBrowse,
  parseTimesheetEditorModel,
  parseTimesheetForm,
  prepareTimesheetAddRow,
  prepareTimesheetDeleteRow,
  prepareTimesheetDryRun,
  prepareTimesheetSave,
} from './eurecia-protocol-client';
import { dbg } from '../../lib/debug';
import type { EureciaTimesheetForm } from './eurecia-protocol-client';
import { isTimesheetRemoteRowOccupied } from '@shared/timesheet-utils';

const INIT_DATA_PATH = '/eurecia/api/v3/users/me/initData';
const BROWSE_PATH = '/eurecia/timesheet/Browse.do';
const OPEN_PATH = '/eurecia/timesheet/Open.do';
const COMMENT_MAX_LENGTH = 2_000;
const MAX_SHEET_ID_CHARACTERS = 512;
const MAX_SHEET_ID_BYTES = 1_024;
const ALLOWED_FRACTIONS = new Set([0.25, 0.5, 0.75, 1]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const EURECIA_REDACTED_SHEET_ID =
  '__JEAN_CLAUDE_REDACTED_TIMESHEET_ID__';

type FetchResponse = Pick<
  Response,
  'headers' | 'ok' | 'status' | 'text' | 'url'
>;

export type EureciaReadFetch = (
  url: string,
  init: {
    method: 'GET';
    redirect: 'manual' | 'follow';
    credentials: 'include';
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export type EureciaWriteFetch = (
  url: string,
  init: {
    method: 'POST';
    redirect: 'follow';
    credentials: 'include';
    headers: Record<string, string>;
    body: Buffer;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

const MAX_ADDED_ROWS = 32;

export class EureciaTimesheetAccessError extends Error {
  override name = 'EureciaTimesheetAccessError';
  readonly reason = 'missing-timesheet-browse' as const;
}

export type EureciaBrowseDiscoveryFailureReason =
  | 'network'
  | 'timeout-or-cancel'
  | 'login-redirect'
  | 'http-status'
  | 'content-type'
  | 'invalid-json'
  | 'invalid-payload'
  | 'missing-navigation-marker'
  | 'unknown';

const DISCOVERY_ERROR_MESSAGES: Record<
  EureciaBrowseDiscoveryFailureReason,
  string
> = {
  network: 'Eurecia Browse discovery failed due to a network error.',
  'timeout-or-cancel': 'Eurecia Browse discovery was cancelled or timed out.',
  'login-redirect': 'Eurecia redirect attempted a prohibited endpoint transition.',
  'http-status': 'Eurecia Browse discovery failed with an HTTP status.',
  'content-type': 'Eurecia response must use json content type.',
  'invalid-json': 'Eurecia initData response is not valid JSON.',
  'invalid-payload': 'Eurecia initData response is not authenticated.',
  'missing-navigation-marker': 'Eurecia initData response is not authenticated.',
  unknown: 'Eurecia Browse discovery failed for an unknown reason.',
};

export class EureciaBrowseDiscoveryError extends Error {
  override name = 'EureciaBrowseDiscoveryError';

  constructor(public readonly reason: EureciaBrowseDiscoveryFailureReason) {
    super(DISCOVERY_ERROR_MESSAGES[reason]);
  }
}

export function parseRedactedTimesheetForm({
  html,
  pageUrl,
}: {
  html: string;
  pageUrl: string;
}) {
  const form = parseTimesheetForm({ html, pageUrl });
  const sheetIds = form.fields.filter(({ name }) => name === 'idTimeSheet');
  if (
    sheetIds.length !== 1 ||
    !sheetIds[0].value.trim() ||
    sheetIds[0].value.length > MAX_SHEET_ID_CHARACTERS ||
    Buffer.byteLength(sheetIds[0].value, 'utf8') > MAX_SHEET_ID_BYTES
  ) {
    throw new Error('Eurecia form requires exactly one nonempty timesheet ID.');
  }
  return {
    ...form,
    fields: form.fields.map((field) =>
      field.name === 'idTimeSheet'
        ? { ...field, value: EURECIA_REDACTED_SHEET_ID }
        : field,
    ),
  };
}

function isCancellation(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted || !error || typeof error !== 'object') return !!signal?.aborted;
  const value = error as Record<string, unknown>;
  return (
    value.name === 'AbortError' ||
    value.name === 'TimeoutError' ||
    value.code === 'ABORT_ERR' ||
    value.code === 'ERR_ABORTED'
  );
}

function classifyDiscoveryRequestError(error: unknown, signal?: AbortSignal) {
  if (isCancellation(error, signal)) return 'timeout-or-cancel' as const;
  if (error instanceof Error) {
    if (
      error.message === 'Eurecia redirect attempted a prohibited endpoint transition.' ||
      error.message === 'Eurecia fetch followed an unexpected redirect.' ||
      error.message === 'Eurecia redirect limit exceeded.' ||
      error.message === 'Eurecia redirect has no location.' ||
      error.message === 'Eurecia response ended at an unexpected endpoint.'
    ) {
      return 'login-redirect' as const;
    }
    if (/^Eurecia read failed with status \d+\.$/.test(error.message)) {
      return 'http-status' as const;
    }
  }
  return 'network' as const;
}

function validateBaseOrigin(baseUrl: string) {
  const url = new URL(baseUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Eurecia base URL must be an HTTPS origin.');
  }
  return url.origin;
}

function validateReadUrl(rawUrl: string, baseOrigin: string) {
  const url = new URL(rawUrl, baseOrigin);
  if (
    url.origin !== baseOrigin ||
    url.username ||
    url.password ||
    !(url.pathname === '/eurecia' || url.pathname.startsWith('/eurecia/'))
  ) {
    throw new Error('Eurecia read URL must be a same-origin /eurecia/ path.');
  }
  return url;
}

function requireContentType(response: FetchResponse, expected: 'html' | 'json') {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const valid =
    expected === 'json'
      ? /^application\/(?:[\w.+-]+\+)?json(?:;|$)/.test(contentType)
      : /^text\/html(?:;|$)/.test(contentType);
  if (!valid) {
    throw new Error(`Eurecia response must use ${expected} content type.`);
  }
}

function requireAuthenticatedHtml(html: string, requiredSelector: string) {
  const $ = load(html);
  const hasLoginForm = $('input[type="password"]').length > 0 ||
    $('form').toArray().some((form) =>
      /(?:login|signin|authenticate)/i.test($(form).attr('action') ?? ''),
    );
  if (hasLoginForm || $(requiredSelector).length === 0) {
    throw new Error('Eurecia response is not an authenticated timesheet page.');
  }
}

function findBrowseUrl(value: unknown, baseOrigin: string): string | null {
  if (typeof value === 'string') {
    if (!value.includes('timesheet/Browse.do')) return null;
    try {
      const candidate = validateReadUrl(
        new URL(value, `${baseOrigin}/eurecia/`).toString(),
        baseOrigin,
      );
      return candidate.pathname === BROWSE_PATH ? candidate.toString() : null;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  for (const nestedValue of Object.values(value)) {
    const result = findBrowseUrl(nestedValue, baseOrigin);
    if (result) return result;
  }
  return null;
}

function isIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

function buildDryRun({
  sheetId,
  entries,
  action,
  editor,
  form,
  sheet,
}: {
  sheetId: string;
  entries: TimesheetEntryInput[];
  action: TimesheetAction;
  editor: TimesheetEditorModel;
  form: EureciaTimesheetForm;
  sheet: TimesheetSheetSummary;
}): TimesheetDryRunResult {
  if (!sheetId) {
    throw new Error('Dry run requires selected inspected sheet.');
  }
  const cachedSheetIds = form.fields.filter(({ name }) => name === 'idTimeSheet');
  if (
    cachedSheetIds.length !== 1 ||
    cachedSheetIds[0].value !== EURECIA_REDACTED_SHEET_ID
  ) {
    throw new Error('Dry run requires redacted inspected form identity.');
  }
  if (entries.length === 0) {
    throw new Error('Timesheet dry run requires at least one entry.');
  }
  if (!['save', 'submit-for-approval'].includes(action)) {
    throw new Error('Dry run action must be save or submit-for-approval.');
  }

  const entriesByDate = new Map<string, TimesheetEntryInput[]>();
  const existingRows = new Map(editor.rows.map((row) => [row.rowIndex, row]));
  const usedRowIndices = new Set<number>();
  for (const entry of entries) {
    if (!isIsoDate(entry.date)) throw new Error('Timesheet entry date is invalid.');
    if (entry.date < sheet.start || entry.date > sheet.end) {
      throw new Error('Timesheet entry date is outside selected sheet range.');
    }
    if (!ALLOWED_FRACTIONS.has(entry.fraction)) {
      throw new Error('Timesheet entry fraction must be a quarter day.');
    }
    if (typeof entry.comment !== 'string' || entry.comment.length > COMMENT_MAX_LENGTH) {
      throw new Error(`Timesheet comments cannot exceed ${COMMENT_MAX_LENGTH} characters.`);
    }
    if (entry.rowIndex !== undefined) {
      if (!Number.isInteger(entry.rowIndex) || entry.rowIndex < 0) {
        throw new Error('Timesheet row index must be a non-negative integer.');
      }
      if (usedRowIndices.has(entry.rowIndex)) {
        throw new Error('Existing timesheet row indices cannot be duplicated.');
      }
      const existingRow = existingRows.get(entry.rowIndex);
      if (!existingRow || existingRow.date !== entry.date) {
        throw new Error('Timesheet row does not belong to selected sheet date.');
      }
      if (existingRow.occupied || isTimesheetRemoteRowOccupied(existingRow)) {
        throw new Error('Occupied Eurecia rows cannot be targeted by dry run.');
      }
      usedRowIndices.add(entry.rowIndex);
    }
    const dateEntries = entriesByDate.get(entry.date) ?? [];
    dateEntries.push(entry);
    entriesByDate.set(entry.date, dateEntries);
  }

  const warnings: string[] = [];
  for (const [date, dateEntries] of entriesByDate) {
    const occupiedRows = editor.rows.filter(
      (row) =>
        row.date === date &&
        (row.occupied || isTimesheetRemoteRowOccupied(row)),
    );
    if (occupiedRows.length + dateEntries.length > 4) {
      throw new Error(`Timesheet date ${date} cannot have more than four entries.`);
    }
    const occupiedTotal = occupiedRows.reduce((sum, row) => sum + row.fraction, 0);
    const entriesTotal = dateEntries.reduce((sum, entry) => sum + entry.fraction, 0);
    const total = occupiedTotal + entriesTotal;
    if (total > 1) {
      dbg.timesheet('dry run: day over capacity', {
        date,
        occupiedTotal,
        entriesTotal,
        occupiedRows: occupiedRows.map((row) => ({
          rowIndex: row.rowIndex,
          fraction: row.fraction,
        })),
      });
      throw new Error(
        `Timesheet date ${date} exceeds one day: ${occupiedTotal} already declared plus ${entriesTotal} drafted.`,
      );
    }
    if (dateEntries.some((entry) => entry.rowIndex === undefined)) {
      warnings.push(`${date}: inferred rows cannot be added during read-only phase.`);
    }
    if (occupiedRows.length > 0) {
      warnings.push(
        `${date}: existing Eurecia entries are preserved; dry run models new rows.`,
      );
    }
    if (dateEntries.length > 2) {
      warnings.push(`${date}: entries beyond second row need extra verification.`);
      const capturedRows = editor.rows.filter((row) => row.date === date).length;
      if (capturedRows < dateEntries.length) {
        warnings.push(`${date}: third or fourth row was not captured from Eurecia.`);
      }
    }
  }

  const existingEntries = entries.filter(
    (entry): entry is TimesheetEntryInput & { rowIndex: number } =>
      entry.rowIndex !== undefined,
  );
  if (existingEntries.length > 0) {
    prepareTimesheetDryRun({
      form,
      action,
      rowUpdates: existingEntries.map((entry) => ({
        rowIndex: entry.rowIndex,
        controls: {
          fullDay: entry.fraction === 1 ? ['true', 'true'] : ['false'],
          generatedItem: ['false'],
          daysWorked_int: entry.fraction === 1 ? [] : ['0'],
          daysWorked_fraction:
            entry.fraction === 1 ? [] : [String(entry.fraction)],
          imputationStructureId1: [entry.axis1Id],
          imputationStructureId2: [entry.axis2Id],
          imputationStructureId3: [entry.axis3Id],
          comment: [entry.comment],
        },
      })),
    });
  }

  return {
    provider: 'eurecia',
    sheetId,
    summary: {
      action,
      entryCount: entries.length,
      inferredEntryCount: entries.filter(({ rowIndex }) => rowIndex === undefined)
        .length,
      changedRowIndices: [...usedRowIndices].sort((left, right) => left - right),
      dates: [...entriesByDate.keys()].sort(),
    },
    warnings,
  };
}

function buildRowControls({
  entry,
  fields,
  rowIndex,
}: {
  entry: TimesheetEntryInput;
  fields: EureciaTimesheetForm['fields'];
  rowIndex: number;
}) {
  const supportsFullDay = hasEureciaRowControl({
    fields,
    column: 'fullDay',
    rowIndex,
  });
  const isFullDay = entry.fraction === 1;
  return {
    ...(supportsFullDay
      ? { fullDay: isFullDay ? ['true', 'true'] : ['false'] }
      : {}),
    generatedItem: ['false'],
    ...(supportsFullDay && isFullDay
      ? { daysWorked_int: [], daysWorked_fraction: [] }
      : {
          daysWorked_int: [isFullDay ? '1' : '0'],
          daysWorked_fraction: [isFullDay ? '0.0' : String(entry.fraction)],
        }),
    imputationStructureId1: [entry.axis1Id],
    imputationStructureId2: [entry.axis2Id],
    imputationStructureId3: [entry.axis3Id],
    comment: [entry.comment],
  };
}

function matchesDeletion(
  row: TimesheetEditorModel['rows'][number],
  deletion: TimesheetRowDeletion,
) {
  return (
    row.date === deletion.date &&
    row.fraction === deletion.fraction &&
    row.axis1Id === deletion.axis1Id &&
    row.axis2Id === deletion.axis2Id &&
    row.axis3Id === deletion.axis3Id &&
    row.comment === deletion.comment
  );
}

function countMatchingRows(
  rows: TimesheetEditorModel['rows'],
  deletion: TimesheetRowDeletion,
) {
  return rows.filter((row) => matchesDeletion(row, deletion)).length;
}

/** Prefers the hinted row, then any row on that date holding the same values. */
function findDeletionIndex(
  rows: TimesheetEditorModel['rows'],
  deletion: TimesheetRowDeletion,
) {
  const hinted = rows.findIndex(
    (row) => row.rowIndex === deletion.rowIndex && matchesDeletion(row, deletion),
  );
  if (hinted !== -1) return hinted;
  return rows.findIndex((row) => matchesDeletion(row, deletion));
}

/** The sheet as it will look once every staged deletion has been applied. */
function withoutDeletedRows(
  rows: TimesheetEditorModel['rows'],
  deletions: TimesheetRowDeletion[],
) {
  const remaining = [...rows];
  for (const deletion of deletions) {
    const index = findDeletionIndex(remaining, deletion);
    if (index === -1) {
      throw new Error(
        `Eurecia row for ${deletion.date} is no longer on the sheet. Refresh before saving.`,
      );
    }
    remaining.splice(index, 1);
  }
  return remaining;
}

export function createEureciaReadService({
  baseUrl,
  axisLabels,
  fetch,
  writeFetch,
}: {
  baseUrl: string;
  axisLabels: TimesheetAxisLabels;
  fetch: EureciaReadFetch;
  writeFetch?: EureciaWriteFetch;
}) {
  const baseOrigin = validateBaseOrigin(baseUrl);
  const listedSheets = new Map<string, TimesheetSheetSummary>();
  let listRevision = 0;
  const inspectedSheets = new Map<
    string,
    {
      editor: TimesheetEditorModel;
      form: EureciaTimesheetForm;
      sheet: TimesheetSheetSummary;
      /** Editor URL the inspection landed on; Browse edit links are one-shot. */
      openUrl: string;
    }
  >();

  /**
   * `follow` delegates redirect handling to the network stack: Electron cancels
   * manual redirects outright, so hops that really do redirect (the Browse edit
   * link) must be followed and validated by their landing URL instead.
   */
  async function get({
    rawUrl,
    allowedPaths,
    finalPath,
    signal,
    follow = false,
  }: {
    rawUrl: string;
    allowedPaths: Set<string>;
    finalPath: string;
    signal?: AbortSignal;
    follow?: boolean;
  }) {
    let url = validateReadUrl(rawUrl, baseOrigin);
    if (follow) {
      if (!allowedPaths.has(url.pathname)) {
        throw new Error('Eurecia redirect attempted a prohibited endpoint transition.');
      }
      const response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow',
        credentials: 'include',
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`Eurecia read failed with status ${response.status}.`);
      }
      // Electron does not always report a landing URL for followed redirects;
      // when it does not, the response body is authenticated and parsed instead.
      const landedUrl = response.url
        ? validateReadUrl(response.url, baseOrigin)
        : null;
      dbg.timesheet('read: followed request', {
        requested: url.pathname,
        landed: landedUrl?.pathname ?? 'unreported',
        status: response.status,
      });
      if (landedUrl) {
        if (!allowedPaths.has(landedUrl.pathname)) {
          throw new Error(
            `Eurecia redirect attempted a prohibited endpoint transition. Landed on ${landedUrl.pathname}.`,
          );
        }
        if (landedUrl.pathname !== finalPath) {
          throw new Error(
            `Eurecia response ended at an unexpected endpoint. Requested ${url.pathname}, landed on ${landedUrl.pathname}.`,
          );
        }
      }
      return response;
    }
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (!allowedPaths.has(url.pathname)) {
        throw new Error('Eurecia redirect attempted a prohibited endpoint transition.');
      }
      const response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        credentials: 'include',
        ...(signal ? { signal } : {}),
      });
      const responseUrl = validateReadUrl(response.url, baseOrigin);
      if (responseUrl.toString() !== url.toString()) {
        throw new Error('Eurecia fetch followed an unexpected redirect.');
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirectCount >= 5) {
          throw new Error('Eurecia redirect limit exceeded.');
        }
        const location = response.headers.get('location');
        if (!location) throw new Error('Eurecia redirect has no location.');
        let nextUrl: URL;
        try {
          nextUrl = validateReadUrl(new URL(location, url).toString(), baseOrigin);
        } catch {
          throw new Error('Eurecia redirect attempted a prohibited endpoint transition.');
        }
        if (!allowedPaths.has(nextUrl.pathname)) {
          throw new Error('Eurecia redirect attempted a prohibited endpoint transition.');
        }
        url = nextUrl;
        continue;
      }
      if (!response.ok) {
        throw new Error(`Eurecia read failed with status ${response.status}.`);
      }
      if (url.pathname !== finalPath) {
        throw new Error('Eurecia response ended at an unexpected endpoint.');
      }
      return response;
    }
  }

  async function discoverBrowseUrl(signal?: AbortSignal) {
    let response: FetchResponse;
    try {
      response = await get({
        rawUrl: `${baseOrigin}${INIT_DATA_PATH}`,
        allowedPaths: new Set([INIT_DATA_PATH]),
        finalPath: INIT_DATA_PATH,
        signal,
      });
    } catch (error) {
      throw new EureciaBrowseDiscoveryError(
        classifyDiscoveryRequestError(error, signal),
      );
    }
    try {
      requireContentType(response, 'json');
    } catch {
      throw new EureciaBrowseDiscoveryError('content-type');
    }
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new EureciaBrowseDiscoveryError(
        isCancellation(error, signal) ? 'timeout-or-cancel' : 'unknown',
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw new EureciaBrowseDiscoveryError('invalid-json');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new EureciaBrowseDiscoveryError('invalid-payload');
    }
    const candidate = findBrowseUrl(data, baseOrigin);
    if (candidate) return candidate;
    const navigation = (data as Record<string, unknown>).navigation;
    if (!navigation || typeof navigation !== 'object' || Array.isArray(navigation)) {
      throw new EureciaBrowseDiscoveryError('missing-navigation-marker');
    }
    throw new EureciaTimesheetAccessError(
      'Signed in to Eurecia, but Timesheet access or configuration is unavailable. Eurecia timesheet Browse URL not found.',
    );
  }

  function beginSheetInspection({
    sheetId,
    navigationUrl,
  }: {
    sheetId: string;
    navigationUrl: string;
  }) {
    if (listedSheets.get(sheetId)?.navigationUrl !== navigationUrl) {
      throw new Error('Eurecia sheet must be selected from latest Browse result.');
    }
    return listRevision;
  }

  function assertSheetInspectionCurrent({
    sheetId,
    navigationUrl,
    expectedRevision,
  }: {
    sheetId: string;
    navigationUrl: string;
    expectedRevision: number;
  }) {
    if (
      expectedRevision !== listRevision ||
      listedSheets.get(sheetId)?.navigationUrl !== navigationUrl
    ) {
      throw new Error('Eurecia sheet list changed during inspection.');
    }
  }

  function invalidateSheetList() {
    listRevision += 1;
    listedSheets.clear();
    inspectedSheets.clear();
    return listRevision;
  }

  function inspectSheetHtml({
    sheetId,
    navigationUrl,
    pageUrl,
    html,
    expectedRevision,
  }: {
    sheetId: string;
    navigationUrl: string;
    pageUrl: string;
    html: string;
    expectedRevision: number;
  }) {
    assertSheetInspectionCurrent({ sheetId, navigationUrl, expectedRevision });
    const selectedSheet = listedSheets.get(sheetId);
    if (!selectedSheet || selectedSheet.navigationUrl !== navigationUrl) {
      throw new Error('Eurecia sheet must be selected from latest Browse result.');
    }
    let finalUrl: URL;
    try {
      finalUrl = validateReadUrl(pageUrl, baseOrigin);
    } catch {
      throw new Error('Eurecia sheet did not open same-origin Open.do editor.');
    }
    if (finalUrl.pathname !== OPEN_PATH) {
      throw new Error('Eurecia sheet did not open same-origin Open.do editor.');
    }
    requireAuthenticatedHtml(html, 'form[action*="timesheet/Open.do"]');
    const form = parseRedactedTimesheetForm({
      html,
      pageUrl: finalUrl.toString(),
    });
    const editor = parseTimesheetEditorModel({
      html,
      pageUrl: finalUrl.toString(),
      axisLabels,
    });
    assertSheetInspectionCurrent({ sheetId, navigationUrl, expectedRevision });
    inspectedSheets.set(sheetId, {
      editor,
      form,
      sheet: selectedSheet,
      openUrl: finalUrl.toString(),
    });
    return editor;
  }

  return {
    discoverBrowseUrl,
    beginSheetInspection,
    assertSheetInspectionCurrent,
    invalidateSheetList,
    inspectSheetHtml,

    async listSheets(signal?: AbortSignal) {
      const revision = invalidateSheetList();
      const browseUrl = await discoverBrowseUrl(signal);
      const response = await get({
        rawUrl: browseUrl,
        allowedPaths: new Set([BROWSE_PATH]),
        finalPath: BROWSE_PATH,
        signal,
      });
      requireContentType(response, 'html');
      const html = await response.text();
      requireAuthenticatedHtml(html, 'table.ibody');
      const sheets = parseTimesheetBrowse({ html, pageUrl: response.url });
      if (revision !== listRevision) {
        throw new Error('Eurecia sheet list changed during refresh.');
      }
      listedSheets.clear();
      for (const sheet of sheets) listedSheets.set(sheet.id, sheet);
      return sheets;
    },

    async inspectSheet({
      sheetId,
      navigationUrl,
      signal,
    }: {
      sheetId: string;
      navigationUrl: string;
      signal?: AbortSignal;
    }) {
      const expectedRevision = beginSheetInspection({ sheetId, navigationUrl });
      const response = await get({
        rawUrl: navigationUrl,
        allowedPaths: new Set([BROWSE_PATH, OPEN_PATH]),
        finalPath: OPEN_PATH,
        signal,
      });
      requireContentType(response, 'html');
      const html = await response.text();
      return inspectSheetHtml({
        sheetId,
        navigationUrl,
        pageUrl: response.url,
        html,
        expectedRevision,
      });
    },

    prepareDryRun({
      sheetId,
      entries,
      action,
      deletions = [],
    }: {
      sheetId: string;
      entries: TimesheetEntryInput[];
      action: TimesheetAction;
      deletions?: TimesheetRowDeletion[];
    }) {
      const inspected = inspectedSheets.get(sheetId);
      const listed = listedSheets.get(sheetId);
      if (
        !inspected ||
        !listed ||
        inspected.sheet.navigationUrl !== listed.navigationUrl
      ) {
        throw new Error('Eurecia sheet must be inspected from latest Browse result before dry run.');
      }
      // Rows staged for deletion are gone by the time the save runs, so the
      // dry run validates against the sheet as it will be.
      return buildDryRun({
        sheetId,
        entries,
        action,
        ...inspected,
        editor: {
          ...inspected.editor,
          rows: withoutDeletedRows(inspected.editor.rows, deletions),
        },
      });
    },

    /**
     * Writes entries back to Eurecia.
     *
     * Eurecia has no JSON API: the editor page is re-posted as a whole. Rows can
     * only be filled through slots the server already rendered, so missing slots
     * are created first with non-saving `AddLine` posts, then the full form is
     * posted once with `validate=2`.
     */
    async save({
      sheetId,
      entries,
      action,
      deletions = [],
      signal,
    }: {
      sheetId: string;
      entries: TimesheetEntryInput[];
      action: TimesheetAction;
      deletions?: TimesheetRowDeletion[];
      signal?: AbortSignal;
    }): Promise<TimesheetSaveResult> {
      if (!writeFetch) {
        throw new Error('Eurecia save requires a write-capable session.');
      }
      const inspected = inspectedSheets.get(sheetId);
      const listed = listedSheets.get(sheetId);
      if (
        !inspected ||
        !listed ||
        inspected.sheet.navigationUrl !== listed.navigationUrl
      ) {
        throw new Error(
          'Eurecia sheet must be inspected from latest Browse result before saving.',
        );
      }
      // Deleted rows free capacity, so validation runs against the sheet as it
      // will look once the deletions are applied.
      const dryRun = buildDryRun({
        sheetId,
        entries,
        action,
        ...inspected,
        editor: {
          ...inspected.editor,
          rows: withoutDeletedRows(inspected.editor.rows, deletions),
        },
      });
      const navigationUrl = listed.navigationUrl;
      const expectedRevision = beginSheetInspection({ sheetId, navigationUrl });

      async function loadEditorPage(rawUrl: string) {
        const response = await get({
          rawUrl,
          allowedPaths: new Set([BROWSE_PATH, OPEN_PATH]),
          finalPath: OPEN_PATH,
          signal,
          follow: true,
        });
        requireContentType(response, 'html');
        const html = await response.text();
        requireAuthenticatedHtml(html, 'form[action*="timesheet/Open.do"]');
        return readEditorPage({ html, pageUrl: response.url || rawUrl });
      }

      // `pageUrl` only resolves relative URLs; parseTimesheetForm is what proves
      // the document is the Open.do editor (same origin, Open.do action).
      function readEditorPage({ html, pageUrl }: { html: string; pageUrl: string }) {
        const finalUrl = validateReadUrl(pageUrl, baseOrigin);
        return {
          html,
          pageUrl: finalUrl.toString(),
          form: parseTimesheetForm({ html, pageUrl: finalUrl.toString() }),
          editor: parseTimesheetEditorModel({
            html,
            pageUrl: finalUrl.toString(),
            axisLabels,
          }),
        };
      }

      /** Posts the editor form and returns the re-rendered page. */
      async function post({
        page,
        fields,
      }: {
        page: { pageUrl: string; form: EureciaTimesheetForm };
        fields: EureciaTimesheetForm['fields'];
      }) {
        const url = validateReadUrl(page.form.actionUrl, baseOrigin);
        if (url.pathname !== OPEN_PATH) {
          throw new Error('Eurecia timesheet form action path is invalid.');
        }
        const { body, contentType } = buildMultipartFormBody({ fields });
        const response = await writeFetch!(url.toString(), {
          method: 'POST',
          redirect: 'follow',
          credentials: 'include',
          headers: {
            'content-type': contentType,
            referer: page.pageUrl,
          },
          body,
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          throw new Error(`Eurecia write failed with status ${response.status}.`);
        }
        requireContentType(response, 'html');
        const html = await response.text();
        requireAuthenticatedHtml(html, 'form[action*="timesheet/Open.do"]');
        const landedUrl = response.url
          ? validateReadUrl(response.url, baseOrigin)
          : null;
        if (landedUrl && landedUrl.pathname !== OPEN_PATH) {
          throw new Error(
            'Eurecia redirect attempted a prohibited endpoint transition.',
          );
        }
        dbg.timesheet('save: post landed', {
          landed: landedUrl?.pathname ?? 'unreported',
        });
        return readEditorPage({
          html,
          pageUrl: landedUrl?.toString() ?? url.toString(),
        });
      }

      function declaredTotalsByDate(rows: TimesheetEditorModel['rows']) {
        const totals = new Map<string, number>();
        for (const row of rows) {
          if (!row.occupied && !isTimesheetRemoteRowOccupied(row)) continue;
          totals.set(row.date, (totals.get(row.date) ?? 0) + row.fraction);
        }
        return totals;
      }

      function freeRowsByDate(rows: TimesheetEditorModel['rows'], date: string) {
        return rows
          .filter(
            (row) =>
              row.date === date &&
              !row.occupied &&
              !isTimesheetRemoteRowOccupied(row),
          )
          .sort((left, right) => left.rowIndex - right.rowIndex);
      }

      const entriesByDate = new Map<string, TimesheetEntryInput[]>();
      for (const entry of entries) {
        entriesByDate.set(entry.date, [
          ...(entriesByDate.get(entry.date) ?? []),
          entry,
        ]);
      }

      dbg.timesheet('save: loading editor page', {
        deletions: deletions.length,
        dates: [...entriesByDate.keys()],
        source: inspected.openUrl ? 'inspected-editor' : 'browse-link',
      });
      let page = await loadEditorPage(inspected.openUrl || navigationUrl);
      dbg.timesheet('save: editor page loaded', {
        pageUrl: page.pageUrl,
        rowCount: page.editor.rows.length,
      });
      assertSheetInspectionCurrent({ sheetId, navigationUrl, expectedRevision });

      // Eurecia deletes one row per request and renumbers the rest, so each
      // target is resolved again against the page it just returned.
      let deletedRowCount = 0;
      for (const deletion of deletions) {
        const index = findDeletionIndex(page.editor.rows, deletion);
        if (index === -1) {
          throw new Error(
            `Eurecia row for ${deletion.date} is no longer on the sheet. Refresh before saving.`,
          );
        }
        const target = page.editor.rows[index];
        const before = countMatchingRows(page.editor.rows, deletion);
        dbg.timesheet('save: deleting row', {
          date: deletion.date,
          rowIndex: target.rowIndex,
        });
        const nextPage = await post({
          page,
          fields: prepareTimesheetDeleteRow({
            form: page.form,
            rowIndex: target.rowIndex,
          }).fields,
        });
        if (countMatchingRows(nextPage.editor.rows, deletion) >= before) {
          throw new Error(
            `Eurecia did not remove the timesheet row for ${deletion.date}.`,
          );
        }
        page = nextPage;
        deletedRowCount += 1;
      }

      // Grow the grid where the sheet has fewer blank slots than entries.
      let addedRowCount = 0;
      for (const [date, dateEntries] of entriesByDate) {
        for (;;) {
          const missing = dateEntries.length - freeRowsByDate(page.editor.rows, date).length;
          if (missing <= 0) break;
          const anchorRow = [...page.editor.rows]
            .filter((row) => row.date === date)
            .sort((left, right) => right.rowIndex - left.rowIndex)[0];
          if (!anchorRow) {
            throw new Error(`Eurecia sheet has no row to extend for ${date}.`);
          }
          if (addedRowCount >= MAX_ADDED_ROWS) {
            throw new Error('Eurecia save cannot add more rows to this sheet.');
          }
          const addRow = prepareTimesheetAddRow({
            form: page.form,
            rowIndex: anchorRow.rowIndex,
          });
          dbg.timesheet('save: adding row', { date, anchor: anchorRow.rowIndex });
          const nextPage = await post({ page, fields: addRow.fields });
          if (nextPage.editor.rows.length <= page.editor.rows.length) {
            throw new Error('Eurecia did not add the requested timesheet row.');
          }
          page = nextPage;
          addedRowCount += 1;
        }
      }

      // Row indices shift when rows are inserted, so slots are assigned against
      // the freshly rendered grid rather than the indices captured at dry-run.
      const rowUpdates: Array<{
        rowIndex: number;
        controls: ReturnType<typeof buildRowControls>;
      }> = [];
      for (const [date, dateEntries] of entriesByDate) {
        const freeRows = freeRowsByDate(page.editor.rows, date);
        if (freeRows.length < dateEntries.length) {
          throw new Error(`Eurecia sheet has no free row for ${date}.`);
        }
        dateEntries.forEach((entry, index) => {
          const rowIndex = freeRows[index].rowIndex;
          rowUpdates.push({
            rowIndex,
            controls: buildRowControls({
              entry,
              fields: page.form.fields,
              rowIndex,
            }),
          });
        });
      }

      const savePost = prepareTimesheetSave({
        form: page.form,
        action,
        rowUpdates,
      });
      // Eurecia answers a save with the reloaded sheet, so the write is confirmed
      // by the declared totals it reports rather than by transport details.
      const totalsBefore = declaredTotalsByDate(page.editor.rows);
      const expectedTotals = new Map(totalsBefore);
      for (const [date, dateEntries] of entriesByDate) {
        expectedTotals.set(
          date,
          (expectedTotals.get(date) ?? 0) +
            dateEntries.reduce((sum, entry) => sum + entry.fraction, 0),
        );
      }
      dbg.timesheet('save: posting sheet', {
        rows: rowUpdates.map(({ rowIndex }) => rowIndex),
        fieldCount: savePost.fields.length,
      });
      const reloaded = await post({ page, fields: savePost.fields });
      const totalsAfter = declaredTotalsByDate(reloaded.editor.rows);
      for (const [date, expected] of expectedTotals) {
        const actual = totalsAfter.get(date) ?? 0;
        if (Math.abs(actual - expected) > 0.001) {
          dbg.timesheet('save: rejected', { date, expected, actual });
          throw new Error(
            `Eurecia did not apply the timesheet save for ${date}: expected ${expected} day(s) declared, found ${actual}.`,
          );
        }
      }
      dbg.timesheet('save: confirmed', { dates: [...expectedTotals.keys()] });
      const editor = inspectSheetHtml({
        sheetId,
        navigationUrl,
        pageUrl: reloaded.pageUrl,
        html: reloaded.html,
        expectedRevision,
      });

      return {
        provider: 'eurecia',
        sheetId,
        summary: {
          action,
          entryCount: entries.length,
          addedRowCount,
          deletedRowCount,
          savedRowIndices: rowUpdates
            .map(({ rowIndex }) => rowIndex)
            .sort((left, right) => left - right),
          dates: [...entriesByDate.keys()].sort(),
        },
        warnings: dryRun.warnings.filter(
          (warning) => !warning.includes('inferred rows cannot be added'),
        ),
        editor,
      };
    },
  };
}
