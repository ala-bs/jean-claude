import { describe, expect, it, vi } from 'vitest';

import type { TimesheetEntryInput } from '@shared/timesheet-types';

import {
  createEureciaReadService,
  type EureciaReadFetch,
  type EureciaWriteFetch,
} from './eurecia-read-service';
import {
  type EureciaRowColumn,
  getEureciaRowFieldName,
} from './eurecia-protocol-client';

const ORIGIN = 'https://tenant.example';
const BROWSE_URL = `${ORIGIN}/eurecia/timesheet/Browse.do?module=timesheet`;
const EDIT_URL = `${ORIGIN}/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&param=opaque-sheet`;
const OPEN_URL = `${ORIGIN}/eurecia/timesheet/Open.do?param=opaque-sheet`;
const AXIS_LABELS = { axis1: 'Client', axis2: 'Mission', axis3: 'Role' };

function rowControl(column: EureciaRowColumn, rowIndex: number) {
  return getEureciaRowFieldName({ column, rowIndex });
}

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

function occupiedRow(rowIndex: number) {
  return `
    <span id="dateActivite_${rowIndex}">01/07/2026</span>
    <input name="${rowControl('fullDay', rowIndex)}" value="false">
    <input name="${rowControl('generatedItem', rowIndex)}" value="false">
    <input name="${rowControl('daysWorked_int', rowIndex)}" value="0">
    <input name="${rowControl('daysWorked_fraction', rowIndex)}" value="0.25">
    <input name="${rowControl('imputationStructureId1', rowIndex)}" value="existing-axis-1">
    <input name="${rowControl('imputationStructureId2', rowIndex)}" value="existing-axis-2">
    <input name="${rowControl('imputationStructureId3', rowIndex)}" value="existing-axis-3">
    <textarea name="${rowControl('comment', rowIndex)}">Existing</textarea>
  `;
}

function blankRow(rowIndex: number, { withFullDay = true } = {}) {
  return `
    <span id="dateActivite_${rowIndex}">01/07/2026</span>
    ${
      withFullDay
        ? `<input name="${rowControl('fullDay', rowIndex)}" value="false">`
        : ''
    }
    <input name="${rowControl('generatedItem', rowIndex)}" value="true">
    <input name="${rowControl('daysWorked_int', rowIndex)}" value="0">
    <input name="${rowControl('daysWorked_fraction', rowIndex)}" value="0.0">
    <input name="${rowControl('imputationStructureId1', rowIndex)}" value="">
    <input name="${rowControl('imputationStructureId2', rowIndex)}" value="">
    <input name="${rowControl('imputationStructureId3', rowIndex)}" value="">
    <textarea name="${rowControl('comment', rowIndex)}"></textarea>
  `;
}

/**
 * Eurecia exposes sheet-level actions as buttons that set `validate` before
 * submitting: 2 = save, 4 = submit for approval, 5 = cancel a submission.
 */
function actionButtons(codes: string[]) {
  return codes
    .map((code) => `<a onclick="$('#validate').val('${code}');">act</a>`)
    .join('');
}

const EDITABLE_ACTIONS = actionButtons(['2', '4']);
const SUBMITTED_ACTIONS = actionButtons(['5']);

function openHtml(rows: string, actions = EDITABLE_ACTIONS) {
  return `<html><body>${actions}
    <form action="/eurecia/timesheet/Open.do?param=private-sheet-token" method="post" enctype="multipart/form-data">
      <input name="org.apache.struts.taglib.html.TOKEN" value="private-csrf-token">
      <input name="idTimeSheet" value="internal-timesheet-123">
      <input name="idOfForm" value="private-form-token">
      <input name="validate" value="">
      <input name="changed" value="true">
      ${rows}
    </form>
  </body></html>`;
}

/** A row as Eurecia re-renders it once the save landed. */
function savedRow(rowIndex: number, fraction = '0.25') {
  return `
    <span id="dateActivite_${rowIndex}">01/07/2026</span>
    <input name="${rowControl('generatedItem', rowIndex)}" value="false">
    <input name="${rowControl('daysWorked_int', rowIndex)}" value="0">
    <input name="${rowControl('daysWorked_fraction', rowIndex)}" value="${fraction}">
    <input name="${rowControl('imputationStructureId1', rowIndex)}" value="axis-1">
    <input name="${rowControl('imputationStructureId2', rowIndex)}" value="axis-2">
    <input name="${rowControl('imputationStructureId3', rowIndex)}" value="axis-3">
    <textarea name="${rowControl('comment', rowIndex)}">Written by tests</textarea>
  `;
}

function fullDayRow(rowIndex: number) {
  return `
    <span id="dateActivite_${rowIndex}">01/07/2026</span>
    <input name="${rowControl('fullDay', rowIndex)}" value="true">
    <input name="${rowControl('generatedItem', rowIndex)}" value="false">
    <input name="${rowControl('imputationStructureId1', rowIndex)}" value="axis-1">
    <input name="${rowControl('imputationStructureId2', rowIndex)}" value="axis-2">
    <input name="${rowControl('imputationStructureId3', rowIndex)}" value="axis-3">
    <textarea name="${rowControl('comment', rowIndex)}">Written by tests</textarea>
  `;
}

const ONE_FREE_ROW = openHtml(`${occupiedRow(0)}${blankRow(1)}`);
const TWO_FREE_ROWS = openHtml(
  `${occupiedRow(0)}${blankRow(1)}${blankRow(2, { withFullDay: false })}`,
);

function createFetch(openBodies: string[]) {
  const bodies = [...openBodies];
  let lastOpenBody = openBodies[0];
  const fetch = vi.fn<EureciaReadFetch>(async (url, init) => {
    if (url.includes('/api/v3/users/me/initData')) {
      return response({
        url,
        body: JSON.stringify({
          navigation: { nested: 'timesheet/Browse.do?module=timesheet' },
        }),
        contentType: 'application/json; charset=utf-8',
      });
    }
    if (url === BROWSE_URL) {
      return response({ url, body: browseHtml(), contentType: 'text/html' });
    }
    if (url === EDIT_URL) {
      // Followed requests land on the editor; manual ones expose the redirect.
      if (init.redirect === 'follow') {
        lastOpenBody = bodies.length > 1 ? bodies.shift()! : bodies[0];
        return response({
          url: OPEN_URL,
          body: lastOpenBody,
          contentType: 'text/html',
        });
      }
      return response({
        url,
        body: '',
        contentType: 'text/html',
        location: OPEN_URL,
        status: 302,
      });
    }
    if (url.startsWith(`${ORIGIN}/eurecia/timesheet/Open.do`)) {
      lastOpenBody = bodies.length > 1 ? bodies.shift()! : bodies[0];
      return response({ url, body: lastOpenBody, contentType: 'text/html' });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetch, setOpenBodies: (next: string[]) => bodies.splice(0, bodies.length, ...next) };
}

function entry(overrides: Partial<TimesheetEntryInput> = {}): TimesheetEntryInput {
  return {
    date: '2026-07-01',
    fraction: 0.25,
    axis1Id: 'axis-1',
    axis2Id: 'axis-2',
    axis3Id: 'axis-3',
    comment: 'Written by tests',
    sourceDraftIds: ['draft-1'],
    ...overrides,
  };
}

function fieldValues(body: Buffer, name: string) {
  const text = body.toString('utf8');
  return [
    ...text.matchAll(
      new RegExp(
        `name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`,
        'g',
      ),
    ),
  ].map((match) => match[1]);
}

async function savingService({
  openBodies,
  writeResponses,
}: {
  openBodies: string[];
  writeResponses: Array<ReturnType<typeof response>>;
}) {
  const { fetch } = createFetch(openBodies);
  const pendingWrites = [...writeResponses];
  const writeBodies: Buffer[] = [];
  const writeFetch = vi.fn<EureciaWriteFetch>(async (_url, init) => {
    writeBodies.push(init.body);
    const next = pendingWrites.shift();
    if (!next) throw new Error('Unexpected write');
    return next;
  });
  const service = createEureciaReadService({
    baseUrl: ORIGIN,
    axisLabels: AXIS_LABELS,
    fetch,
    writeFetch,
  });
  const [sheet] = await service.listSheets();
  await service.inspectSheet({
    sheetId: sheet.id,
    navigationUrl: sheet.navigationUrl,
  });
  return { service, sheet, fetch, writeFetch, writeBodies };
}

const RELOADED_URL = `${ORIGIN}/eurecia/timesheet/Open.do?mode=edit&id=opaque-sheet`;

/** Electron follows the save redirect, so the write lands on the reloaded page. */
const savedRedirect = (body: string) =>
  response({ url: RELOADED_URL, body, contentType: 'text/html' });

/** The POST lands on the form action URL when Eurecia does not redirect. */
const ACTION_URL = `${ORIGIN}/eurecia/timesheet/Open.do?param=private-sheet-token`;

/** A row action re-renders in place: same URL, no redirect. */
const rerendered = (body: string) =>
  response({ url: ACTION_URL, body, contentType: 'text/html' });

describe('Eurecia timesheet row updates', () => {
  const target = {
    date: '2026-07-01',
    rowIndex: 0,
    fraction: 0.25 as const,
    axis1Id: 'existing-axis-1',
    axis2Id: 'existing-axis-2',
    axis3Id: 'existing-axis-3',
    comment: 'Existing',
  };

  it('rewrites a saved row in place with a single post', async () => {
    const { service, sheet, writeBodies } = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [savedRedirect(openHtml(`${savedRow(0)}${blankRow(1)}`))],
    });

    const result = await service.save({
      sheetId: sheet.id,
      entries: [],
      action: 'save',
      updates: [
        {
          target,
          values: {
            fraction: 0.25,
            axis1Id: 'axis-1',
            axis2Id: 'axis-2',
            axis3Id: 'axis-3',
            comment: 'Written by tests',
          },
        },
      ],
    });

    expect(result.summary).toMatchObject({
      entryCount: 0,
      addedRowCount: 0,
      deletedRowCount: 0,
      updatedRowCount: 1,
    });
    // No delete/add round trips: the edit rides the save post.
    expect(writeBodies).toHaveLength(1);
    const body = writeBodies[0];
    expect(fieldValues(body, rowControl('imputationStructureId3', 0))).toEqual([
      'axis-3',
    ]);
    expect(fieldValues(body, rowControl('comment', 0))).toEqual([
      'Written by tests',
    ]);
  });

  it('accounts for a changed fraction in the declared totals check', async () => {
    const raiseTo = (fraction: 0.25 | 0.5) => ({
      target,
      values: {
        fraction,
        axis1Id: 'axis-1',
        axis2Id: 'axis-2',
        axis3Id: 'axis-3',
        comment: 'Written by tests',
      },
    });

    const applied = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [
        savedRedirect(openHtml(`${savedRow(0, '0.5')}${blankRow(1)}`)),
      ],
    });
    const result = await applied.service.save({
      sheetId: applied.sheet.id,
      entries: [],
      action: 'save',
      updates: [raiseTo(0.5)],
    });
    expect(result.summary.updatedRowCount).toBe(1);

    // The same reload no longer confirms a save that asked for a different day
    // count, so the expected delta is really being compared.
    const ignored = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [
        savedRedirect(openHtml(`${savedRow(0, '0.5')}${blankRow(1)}`)),
      ],
    });
    await expect(
      ignored.service.save({
        sheetId: ignored.sheet.id,
        entries: [],
        action: 'save',
        updates: [raiseTo(0.25)],
      }),
    ).rejects.toThrow(/expected 0.25 day\(s\) declared, found 0.5/);
  });

  it('rejects two rows on one day swapping values without being written', async () => {
    // Both rows already hold the other's values, so a per-day existence check
    // would confirm a save Eurecia never applied.
    const rowA = (rowIndex: number, axis1Id: string) => `
      <span id="dateActivite_${rowIndex}">01/07/2026</span>
      <input name="${rowControl('generatedItem', rowIndex)}" value="false">
      <input name="${rowControl('daysWorked_int', rowIndex)}" value="0">
      <input name="${rowControl('daysWorked_fraction', rowIndex)}" value="0.25">
      <input name="${rowControl('imputationStructureId1', rowIndex)}" value="${axis1Id}">
      <input name="${rowControl('imputationStructureId2', rowIndex)}" value="axis-2">
      <input name="${rowControl('imputationStructureId3', rowIndex)}" value="axis-3">
      <textarea name="${rowControl('comment', rowIndex)}">Shared</textarea>
    `;
    const unchanged = openHtml(`${rowA(0, 'project-x')}${rowA(1, 'project-y')}`);
    const { service, sheet } = await savingService({
      openBodies: [unchanged],
      writeResponses: [savedRedirect(unchanged)],
    });
    const swap = (rowIndex: number, from: string, to: string) => ({
      target: {
        date: '2026-07-01',
        rowIndex,
        fraction: 0.25 as const,
        axis1Id: from,
        axis2Id: 'axis-2',
        axis3Id: 'axis-3',
        comment: 'Shared',
      },
      values: {
        fraction: 0.25 as const,
        axis1Id: to,
        axis2Id: 'axis-2',
        axis3Id: 'axis-3',
        comment: 'Shared',
      },
    });

    await expect(
      service.save({
        sheetId: sheet.id,
        entries: [],
        action: 'save',
        updates: [
          swap(0, 'project-x', 'project-y'),
          swap(1, 'project-y', 'project-x'),
        ],
      }),
    ).rejects.toThrow(/did not apply the row update/i);
  });

  it('refuses an update that would push the day past one declared day', async () => {
    const { service, sheet, writeFetch } = await savingService({
      openBodies: [openHtml(`${occupiedRow(0)}${occupiedRow(1)}${blankRow(2)}`)],
      writeResponses: [],
    });

    await expect(
      service.save({
        sheetId: sheet.id,
        entries: [],
        action: 'save',
        updates: [
          {
            target,
            values: {
              fraction: 1,
              axis1Id: 'axis-1',
              axis2Id: 'axis-2',
              axis3Id: 'axis-3',
              comment: 'Written by tests',
            },
          },
        ],
      }),
    ).rejects.toThrow(/cannot declare more than one day/i);
    // Nothing was posted: the sheet is rejected before it is touched.
    expect(writeFetch).not.toHaveBeenCalled();
  });

  it('fails when the reloaded row does not carry the new values', async () => {
    const { service, sheet } = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [savedRedirect(ONE_FREE_ROW)],
    });

    await expect(
      service.save({
        sheetId: sheet.id,
        entries: [],
        action: 'save',
        updates: [
          {
            target,
            values: {
              fraction: 0.25,
              axis1Id: 'axis-1',
              axis2Id: 'axis-2',
              axis3Id: 'axis-3',
              comment: 'Written by tests',
            },
          },
        ],
      }),
    ).rejects.toThrow(/did not apply the row update/i);
  });

  it('refuses to update a row that no longer matches the sheet', async () => {
    const { service, sheet } = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [],
    });

    await expect(
      service.save({
        sheetId: sheet.id,
        entries: [],
        action: 'save',
        updates: [
          {
            target: { ...target, axis1Id: 'moved-axis-1' },
            values: {
              fraction: 0.25,
              axis1Id: 'axis-1',
              axis2Id: 'axis-2',
              axis3Id: 'axis-3',
              comment: 'Written by tests',
            },
          },
        ],
      }),
    ).rejects.toThrow(/no longer on the sheet/i);
  });
});

describe('Eurecia timesheet submit for approval', () => {
  it('submits an already-saved sheet without entries', async () => {
    const saved = openHtml(`${occupiedRow(0)}${savedRow(1)}`);
    const { service, sheet, writeBodies } = await savingService({
      openBodies: [saved],
      writeResponses: [
        savedRedirect(
          openHtml(`${occupiedRow(0)}${savedRow(1)}`, SUBMITTED_ACTIONS),
        ),
      ],
    });

    const result = await service.save({
      sheetId: sheet.id,
      entries: [],
      action: 'submit-for-approval',
    });

    expect(result.summary).toMatchObject({
      action: 'submit-for-approval',
      entryCount: 0,
      addedRowCount: 0,
      savedRowIndices: [],
    });
    expect(fieldValues(writeBodies[0], 'validate')).toEqual(['4']);
    expect(fieldValues(writeBodies[0], 'btnApply')).toEqual(['clicked']);
  });

  it('saves and verifies pending entries before submitting them', async () => {
    const saved = openHtml(`${occupiedRow(0)}${savedRow(1)}`);
    const { service, sheet, writeBodies } = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [
        // The write lands while the sheet is still editable, so its rows can be
        // verified; only then is the sheet submitted.
        savedRedirect(saved),
        savedRedirect(openHtml(`${occupiedRow(0)}${savedRow(1)}`, SUBMITTED_ACTIONS)),
      ],
    });

    const result = await service.save({
      sheetId: sheet.id,
      entries: [entry({ rowIndex: 1 })],
      action: 'submit-for-approval',
    });

    expect(result.summary).toMatchObject({ action: 'submit-for-approval', entryCount: 1 });
    expect(writeBodies).toHaveLength(2);
    expect(fieldValues(writeBodies[0], 'validate')).toEqual(['2']);
    expect(fieldValues(writeBodies[1], 'validate')).toEqual(['4']);
  });

  it('does not submit when the written entries are missing from the saved sheet', async () => {
    const { service, sheet, writeBodies } = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [savedRedirect(ONE_FREE_ROW)],
    });

    await expect(
      service.save({
        sheetId: sheet.id,
        entries: [entry({ rowIndex: 1 })],
        action: 'submit-for-approval',
      }),
    ).rejects.toThrow(/did not apply the timesheet save/i);
    // The sheet stays editable: no submit was attempted on an unverified write.
    expect(writeBodies).toHaveLength(1);
  });

  it('does not check declared totals against the read-only submitted sheet', async () => {
    // Eurecia disables the duration controls once a sheet is submitted, so its
    // rows read back as zero days even though nothing was lost.
    const lockedRow = `
      <span id="dateActivite_0">01/07/2026</span>
      <input name="${rowControl('generatedItem', 0)}" value="false">
      <input name="${rowControl('imputationStructureId1', 0)}" value="axis-1">
      <input name="${rowControl('imputationStructureId2', 0)}" value="axis-2">
      <input name="${rowControl('imputationStructureId3', 0)}" value="axis-3">
      <textarea name="${rowControl('comment', 0)}">Written by tests</textarea>
    `;
    const { service, sheet } = await savingService({
      openBodies: [openHtml(`${occupiedRow(0)}${blankRow(1)}`)],
      writeResponses: [
        savedRedirect(openHtml(lockedRow, SUBMITTED_ACTIONS)),
      ],
    });

    const result = await service.save({
      sheetId: sheet.id,
      entries: [],
      action: 'submit-for-approval',
    });

    expect(result.summary.action).toBe('submit-for-approval');
  });

  it('fails when the reloaded sheet is still submittable', async () => {
    const saved = openHtml(`${occupiedRow(0)}${savedRow(1)}`);
    const { service, sheet } = await savingService({
      openBodies: [saved],
      writeResponses: [savedRedirect(saved)],
    });

    await expect(
      service.save({ sheetId: sheet.id, entries: [], action: 'submit-for-approval' }),
    ).rejects.toThrow(/did not submit the timesheet/i);
  });

  it('refuses to submit a sheet that no longer offers the action', async () => {
    const { service, sheet } = await savingService({
      openBodies: [
        openHtml(`${occupiedRow(0)}${savedRow(1)}`, SUBMITTED_ACTIONS),
      ],
      writeResponses: [],
    });

    await expect(
      service.save({ sheetId: sheet.id, entries: [], action: 'submit-for-approval' }),
    ).rejects.toThrow(/cannot be submitted for approval/i);
  });
});

describe('Eurecia timesheet save', () => {
  it('posts entries into an existing blank row', async () => {
    const { service, sheet, fetch, writeBodies } = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [
        savedRedirect(openHtml(`${occupiedRow(0)}${savedRow(1)}`)),
      ],
    });

    const result = await service.save({
      sheetId: sheet.id,
      entries: [entry({ rowIndex: 1 })],
      action: 'save',
    });

    expect(result.summary).toMatchObject({
      action: 'save',
      entryCount: 1,
      addedRowCount: 0,
      savedRowIndices: [1],
      dates: ['2026-07-01'],
    });
    expect(writeBodies).toHaveLength(1);
    const body = writeBodies[0];
    expect(fieldValues(body, 'validate')).toEqual(['2']);
    expect(fieldValues(body, 'changed')).toEqual(['false']);
    expect(fieldValues(body, 'btnApply')).toEqual(['clicked']);
    expect(fieldValues(body, rowControl('daysWorked_fraction', 1))).toEqual([
      '0.25',
    ]);
    expect(fieldValues(body, rowControl('imputationStructureId3', 1))).toEqual([
      'axis-3',
    ]);
    expect(fieldValues(body, rowControl('generatedItem', 1))).toEqual(['false']);
    // The occupied row is echoed back untouched.
    expect(fieldValues(body, rowControl('imputationStructureId1', 0))).toEqual([
      'existing-axis-1',
    ]);
    // Browse edit links are one-shot, so the save reopens the inspected editor.
    expect(
      fetch.mock.calls.filter(
        ([url, init]) => init.redirect === 'follow' && url === EDIT_URL,
      ),
    ).toHaveLength(0);
    expect(
      fetch.mock.calls.filter(
        ([url, init]) => init.redirect === 'follow' && url === OPEN_URL,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('adds a row before saving when the sheet has no free slot', async () => {
    const { service, sheet, writeBodies } = await savingService({
      openBodies: [ONE_FREE_ROW, ONE_FREE_ROW, TWO_FREE_ROWS],
      writeResponses: [
        rerendered(TWO_FREE_ROWS),
        savedRedirect(
          openHtml(`${occupiedRow(0)}${savedRow(1)}${savedRow(2)}`),
        ),
      ],
    });

    const result = await service.save({
      sheetId: sheet.id,
      entries: [entry({ rowIndex: 1 }), entry({ sourceDraftIds: ['draft-2'] })],
      action: 'save',
    });

    expect(result.summary.addedRowCount).toBe(1);
    expect(result.summary.savedRowIndices).toEqual([1, 2]);
    expect(writeBodies).toHaveLength(2);
    expect(fieldValues(writeBodies[0], 'ctrla')).toEqual([
      'activities=AddLine=row_1',
    ]);
    expect(fieldValues(writeBodies[0], 'validate')).toEqual(['']);
    expect(fieldValues(writeBodies[0], 'btnApply')).toEqual([]);
    // Rows created by AddLine render no full-day control, so none is posted.
    expect(fieldValues(writeBodies[1], rowControl('fullDay', 2))).toEqual([]);
    expect(fieldValues(writeBodies[1], rowControl('daysWorked_fraction', 2))).toEqual(
      ['0.25'],
    );
  });

  it('marks a full day with the full-day control when the row has one', async () => {
    const { service, sheet, writeBodies } = await savingService({
      openBodies: [openHtml(blankRow(0))],
      writeResponses: [savedRedirect(openHtml(fullDayRow(0)))],
    });

    await service.save({
      sheetId: sheet.id,
      entries: [entry({ rowIndex: 0, fraction: 1 })],
      action: 'save',
    });

    expect(fieldValues(writeBodies[0], rowControl('fullDay', 0))).toEqual([
      'true',
      'true',
    ]);
    // Ticking the box alone leaves Eurecia showing "Nb jours" 0, so the day
    // count is posted with it.
    expect(fieldValues(writeBodies[0], rowControl('daysWorked_int', 0))).toEqual(
      ['1'],
    );
    expect(
      fieldValues(writeBodies[0], rowControl('daysWorked_fraction', 0)),
    ).toEqual(['0.0']);
  });

  it('posts the day count even when Eurecia renders it disabled', async () => {
    // Eurecia disables the day inputs on full-day rows, so they never reach the
    // parsed form; the save has to add them back.
    const rowWithoutDurationControls = `
      <span id="dateActivite_0">01/07/2026</span>
      <input name="${rowControl('fullDay', 0)}" value="false">
      <input name="${rowControl('generatedItem', 0)}" value="true">
      <input name="${rowControl('imputationStructureId1', 0)}" value="">
      <input name="${rowControl('imputationStructureId2', 0)}" value="">
      <input name="${rowControl('imputationStructureId3', 0)}" value="">
      <textarea name="${rowControl('comment', 0)}"></textarea>
    `;
    const { service, sheet, writeBodies } = await savingService({
      openBodies: [openHtml(rowWithoutDurationControls)],
      writeResponses: [savedRedirect(openHtml(fullDayRow(0)))],
    });

    await service.save({
      sheetId: sheet.id,
      entries: [entry({ rowIndex: 0, fraction: 1 })],
      action: 'save',
    });

    expect(fieldValues(writeBodies[0], rowControl('daysWorked_int', 0))).toEqual(
      ['1'],
    );
  });

  it('deletes a saved row before writing the remaining entries', async () => {
    const AFTER_DELETE = openHtml(`${blankRow(0)}${blankRow(1)}`);
    const { service, sheet, writeBodies } = await savingService({
      openBodies: [ONE_FREE_ROW, ONE_FREE_ROW],
      writeResponses: [
        // The delete re-renders in place; the saved row is gone.
        rerendered(AFTER_DELETE),
        savedRedirect(openHtml(`${savedRow(0)}${blankRow(1)}`)),
      ],
    });

    const result = await service.save({
      sheetId: sheet.id,
      entries: [entry()],
      action: 'save',
      deletions: [
        {
          date: '2026-07-01',
          rowIndex: 0,
          fraction: 0.25,
          axis1Id: 'existing-axis-1',
          axis2Id: 'existing-axis-2',
          axis3Id: 'existing-axis-3',
          comment: 'Existing',
        },
      ],
    });

    expect(result.summary.deletedRowCount).toBe(1);
    expect(writeBodies).toHaveLength(2);
    expect(fieldValues(writeBodies[0], 'ctrla')).toEqual([
      'activities=Delete=row_0',
    ]);
    expect(fieldValues(writeBodies[0], 'validate')).toEqual(['']);
    expect(fieldValues(writeBodies[0], 'btnApply')).toEqual([]);
    expect(fieldValues(writeBodies[1], 'validate')).toEqual(['2']);
  });

  it('refuses to delete a row that no longer matches the sheet', async () => {
    const { service, sheet } = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [],
    });

    await expect(
      service.save({
        sheetId: sheet.id,
        entries: [entry({ rowIndex: 1 })],
        action: 'save',
        deletions: [
          {
            date: '2026-07-01',
            rowIndex: 0,
            fraction: 0.5,
            axis1Id: 'moved-axis-1',
            axis2Id: '',
            axis3Id: '',
            comment: '',
          },
        ],
      }),
    ).rejects.toThrow('no longer on the sheet');
  });

  it('rejects saving without a write-capable session', async () => {
    const { fetch } = createFetch([ONE_FREE_ROW]);
    const service = createEureciaReadService({
      baseUrl: ORIGIN,
      axisLabels: AXIS_LABELS,
      fetch,
    });
    const [sheet] = await service.listSheets();
    await service.inspectSheet({
      sheetId: sheet.id,
      navigationUrl: sheet.navigationUrl,
    });

    await expect(
      service.save({
        sheetId: sheet.id,
        entries: [entry({ rowIndex: 1 })],
        action: 'save',
      }),
    ).rejects.toThrow('write-capable');
  });

  it('fails when the reloaded sheet does not reflect the entries', async () => {
    const { service, sheet } = await savingService({
      openBodies: [ONE_FREE_ROW],
      writeResponses: [rerendered(ONE_FREE_ROW)],
    });

    await expect(
      service.save({
        sheetId: sheet.id,
        entries: [entry({ rowIndex: 1 })],
        action: 'save',
      }),
    ).rejects.toThrow('did not apply the timesheet save');
  });
});
