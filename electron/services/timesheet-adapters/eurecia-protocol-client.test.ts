import { describe, expect, it } from 'vitest';

import {
  buildDwrPlainCall,
  getEureciaRowFieldName,
  parseDwrCallback,
  parseTimesheetBrowse,
  parseTimesheetEditorModel,
  parseTimesheetForm,
  parseTimesheetSubmissionState,
  prepareTimesheetDryRun,
} from './eurecia-protocol-client';
import type { EureciaRowColumn } from './eurecia-protocol-client';

const rowFieldName = (column: EureciaRowColumn, rowIndex = 0) =>
  getEureciaRowFieldName({ column, rowIndex });
const ROW_COLUMNS_FOR_TEST: EureciaRowColumn[] = [
  'fullDay',
  'generatedItem',
  'daysWorked_int',
  'daysWorked_fraction',
  'imputationStructureId1',
  'imputationStructureId2',
  'imputationStructureId3',
  'comment',
];

function buildBrowseRow({ href, cells = 13 }: { href: string; cells?: number }) {
  const values = Array.from({ length: cells }, (_, index) => {
    if (index === 0) return `<a href="${href}">Edit</a>`;
    if (index === 2) return 'Synthetic sheet';
    if (index === 3) return '01/07/2026';
    if (index === 4) return '31/07/2026';
    if (index === 12) return 'Open';
    return `cell-${index + 1}`;
  });
  return `<tr class="clickable">${values.map((value) => `<td>${value}</td>`).join('')}</tr>`;
}

function buildTimesheetHtml() {
  return `
    <html>
      <body>
        <form action="/eurecia/other.do" method="post"></form>
        <form action="/eurecia/timesheet/Open.do" method="post" enctype="multipart/form-data">
          <input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="synthetic-csrf">
          <input type="hidden" name="idTimeSheet" value="synthetic-sheet">
          <input type="hidden" name="ctrla" value="activities=ClickFullDay=row_0">
          <input type="hidden" name="validate" value="">
          <input type="hidden" name="changed" value="true">
          <input type="hidden" name="idOfForm" value="synthetic-form-instance">
          <input type="hidden" name="${rowFieldName('fullDay')}" value="false">
          <input type="hidden" name="${rowFieldName('generatedItem')}" value="true">
          <input type="text" name="${rowFieldName('daysWorked_int')}" value="0">
          <input type="text" name="${rowFieldName('daysWorked_fraction')}" value="0.0">
          <input type="text" name="${rowFieldName('imputationStructureId1')}" value="">
          <input type="text" name="${rowFieldName('imputationStructureId2')}" value="">
          <input type="text" name="${rowFieldName('imputationStructureId3')}" value="">
          <textarea name="${rowFieldName('comment')}">Synthetic comment</textarea>
          <input type="hidden" name="duplicate" value="first">
          <input type="checkbox" name="duplicate" value="second" checked>
          <input type="checkbox" name="unchecked" value="ignored">
          <select name="selectedAxis">
            <option value="ignored" selected>Ignored</option>
            <option value="selected" selected>Selected</option>
          </select>
          <select name="firstEnabledAxis">
            <option value="disabled" disabled>Disabled</option>
            <option value="enabled">Enabled</option>
          </select>
          <select name="emptyMultiple" multiple>
            <option value="not-selected">Not selected</option>
          </select>
          <input name="disabled" value="ignored" disabled>
          <fieldset disabled><input name="fieldsetDisabled" value="ignored"></fieldset>
          <input type="submit" name="existingSubmit" value="ignored">
          <input type="hidden" name="validatorComment" value="">
        </form>
      </body>
    </html>
  `;
}

function buildBlankTemplateHtml() {
  return buildTimesheetHtml()
    .replace(
      `name="${rowFieldName('generatedItem')}" value="true"`,
      `name="${rowFieldName('generatedItem')}" value="false"`,
    )
    .replace('Synthetic comment', '');
}

function rowControlHtml({
  column,
  value,
  rowIndex = 0,
}: {
  column: EureciaRowColumn;
  value: string;
  rowIndex?: number;
}) {
  if (column === 'comment') {
    return `<textarea name="${rowFieldName(column, rowIndex)}">${value}</textarea>`;
  }
  const type = ['fullDay', 'generatedItem'].includes(column) ? 'hidden' : 'text';
  return `<input type="${type}" name="${rowFieldName(column, rowIndex)}" value="${value}">`;
}

const DEFAULT_ROW_CONTROL_VALUES: Record<EureciaRowColumn, string> = {
  fullDay: 'false',
  generatedItem: 'false',
  daysWorked: '0',
  daysWorked_int: '0',
  daysWorked_fraction: '0.0',
  imputationStructureId1: '',
  imputationStructureId2: '',
  imputationStructureId3: '',
  comment: '',
};

function editorRowControls({
  rowIndex,
  values = {},
  omitted = [],
}: {
  rowIndex: number;
  values?: Partial<Record<EureciaRowColumn, string>>;
  omitted?: EureciaRowColumn[];
}) {
  return ROW_COLUMNS_FOR_TEST.filter((column) => !omitted.includes(column))
    .map((column) =>
      rowControlHtml({
        column,
        value: values[column] ?? DEFAULT_ROW_CONTROL_VALUES[column],
        rowIndex,
      }),
    )
    .join('');
}

function groupedEditorHtml({
  controls,
  dates,
}: {
  controls: string[];
  dates: Array<{ rowIndex: number; value: string }>;
}) {
  return `<html><body>
    ${dates
      .map(({ rowIndex, value }) => `<span id="dateActivite_${rowIndex}">${value}</span>`)
      .join('')}
    <form action="/eurecia/timesheet/Open.do" method="post" enctype="multipart/form-data">
      ${controls.join('')}
    </form>
  </body></html>`;
}

function removeRowControl(html: string, column: EureciaRowColumn) {
  return html.replace(
    rowControlHtml({ column, value: DEFAULT_ROW_CONTROL_VALUES[column] }),
    '',
  );
}

function prependRowControl({
  html,
  column,
  value,
}: {
  html: string;
  column: EureciaRowColumn;
  value: string;
}) {
  const original = rowControlHtml({
    column,
    value: DEFAULT_ROW_CONTROL_VALUES[column],
  });
  return html.replace(original, `${rowControlHtml({ column, value })}${original}`);
}

function replaceDurationControl({
  html,
  column,
  value,
}: {
  html: string;
  column: 'daysWorked_int' | 'daysWorked_fraction';
  value: string;
}) {
  return html.replace(
    rowControlHtml({ column, value: DEFAULT_ROW_CONTROL_VALUES[column] }),
    rowControlHtml({ column, value }),
  );
}

function getEditorParseError(html: string) {
  try {
    parseTimesheetEditorModel({
      html,
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
      axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error('Expected editor parsing to fail.');
}

describe('Eurecia sheet submission state', () => {
  const action = (markup: string) => `<html><body>${markup}</body></html>`;

  it('reads the actions an editable sheet offers, whatever the quoting', () => {
    expect(
      parseTimesheetSubmissionState({
        html: action(
          `<a onclick="$('#validate').val('2');">save</a>` +
            `<button onclick='$("#validate") .val( "4" );'>submit</button>`,
        ),
      }),
    ).toEqual({ known: true, canSave: true, canSubmit: true, submitted: false });
  });

  it('reports a submitted sheet only when the submit action is gone', () => {
    expect(
      parseTimesheetSubmissionState({
        html: action(`<a onclick="$('#validate').val('5');">cancel</a>`),
      }),
    ).toMatchObject({ known: true, canSubmit: false, submitted: true });
    // A sheet offering both is still submittable, so it is not "submitted".
    expect(
      parseTimesheetSubmissionState({
        html: action(
          `<a onclick="$('#validate').val('4');">submit</a>` +
            `<a onclick="$('#validate').val('5');">cancel</a>`,
        ),
      }),
    ).toMatchObject({ canSubmit: true, submitted: false });
  });

  it('reports an unknown state instead of guessing when no action is found', () => {
    expect(
      parseTimesheetSubmissionState({ html: action('<p>no actions here</p>') }),
    ).toEqual({ known: false, canSave: false, canSubmit: false, submitted: false });
  });

  it('ignores validate codes that are not attached to an action', () => {
    expect(
      parseTimesheetSubmissionState({
        html: action(`<script>$('#validate').val('4');</script>`),
      }),
    ).toMatchObject({ known: false, canSubmit: false });
  });
});

describe('Eurecia timesheet form protocol', () => {
  it('parses only literal Browse table rows and normalizes their dates', () => {
    const validHref =
      '/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&param=opaque-sheet';
    const html = `
      <table class="ibody"><tbody>
        ${buildBrowseRow({ href: validHref })}
        ${buildBrowseRow({ href: '/eurecia/timesheet/Browse.do?ctrl=list&action=View&id=ignored' })}
        ${buildBrowseRow({ href: validHref, cells: 12 })}
      </tbody></table>
      <div><table class="ibody"><tbody><tr><td>
        <table><tbody>${buildBrowseRow({ href: validHref })}</tbody></table>
      </td></tr></tbody></table></div>
      <table><tbody>${buildBrowseRow({ href: validHref })}</tbody></table>
    `;

    expect(
      parseTimesheetBrowse({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Browse.do',
      }),
    ).toEqual([
      {
        id: 'opaque-sheet',
        navigationUrl:
          'https://tenant.example/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&param=opaque-sheet',
        description: 'Synthetic sheet',
        start: '2026-07-01',
        end: '2026-07-31',
        status: 'Open',
      },
    ]);
  });

  it('skips malformed and cross-origin Browse rows', () => {
    expect(
      parseTimesheetBrowse({
        html: `<table class="ibody"><tbody>
          ${buildBrowseRow({ href: 'https://other.example/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&id=secret' })}
          ${buildBrowseRow({ href: '/eurecia/timesheet/Browse.do?ctrl=list&action=Edit' })}
          ${buildBrowseRow({ href: '/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&id=bad-date' }).replace('01/07/2026', '31/02/2026')}
        </tbody></table>`,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Browse.do',
      }),
    ).toEqual([]);
  });

  it('rejects Browse links on lookalike pathnames', () => {
    expect(
      parseTimesheetBrowse({
        html: `<table class="ibody"><tbody>
          ${buildBrowseRow({ href: '/other/timesheet/Browse.do?ctrl=list&action=Edit&id=wrong-base' })}
          ${buildBrowseRow({ href: '/eurecia/timesheet/prefix-Browse.do?ctrl=list&action=Edit&id=wrong-name' })}
          ${buildBrowseRow({ href: '/eurecia/timesheet/Browse.do/suffix?ctrl=list&action=Edit&id=wrong-suffix' })}
        </tbody></table>`,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Browse.do',
      }),
    ).toEqual([]);
  });

  it('parses ordered successful controls from the timesheet form', () => {
    const form = parseTimesheetForm({
      html: buildTimesheetHtml(),
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do?id=sheet',
    });

    expect(form.actionUrl).toBe(
      'https://tenant.example/eurecia/timesheet/Open.do',
    );
    expect(form.method).toBe('POST');
    expect(form.enctype).toBe('multipart/form-data');
    expect(form.fields.filter(({ name }) => name === 'duplicate')).toEqual([
      { name: 'duplicate', value: 'first' },
      { name: 'duplicate', value: 'second' },
    ]);
    expect(form.fields).toContainEqual({
      name: rowFieldName('comment'),
      value: 'Synthetic comment',
    });
    expect(form.fields).toContainEqual({
      name: 'selectedAxis',
      value: 'selected',
    });
    expect(form.fields).toContainEqual({
      name: 'firstEnabledAxis',
      value: 'enabled',
    });
    expect(form.fields.some(({ name }) => name === 'emptyMultiple')).toBe(
      false,
    );
    expect(form.fields.some(({ name }) => name === 'unchecked')).toBe(false);
    expect(form.fields.some(({ name }) => name === 'disabled')).toBe(false);
    expect(form.fields.some(({ name }) => name === 'fieldsetDisabled')).toBe(
      false,
    );
    expect(form.fields.some(({ name }) => name === 'existingSubmit')).toBe(
      false,
    );
  });

  it('allows form action queries but rejects lookalike Open pathnames', () => {
    const queriedForm = parseTimesheetForm({
      html: buildTimesheetHtml().replace(
        '/eurecia/timesheet/Open.do',
        '/eurecia/timesheet/Open.do?mode=edit',
      ),
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
    });
    expect(queriedForm.actionUrl).toBe(
      'https://tenant.example/eurecia/timesheet/Open.do?mode=edit',
    );

    for (const pathname of [
      '/other/timesheet/Open.do',
      '/eurecia/timesheet/Open.do/suffix',
      '/eurecia/timesheet/Open.do.evil',
    ]) {
      expect(() =>
        parseTimesheetForm({
          html: buildTimesheetHtml().replace(
            '/eurecia/timesheet/Open.do',
            pathname,
          ),
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        }),
      ).toThrow('action path is invalid');
    }
  });

  it.each([
    ['save', '2'],
    ['submit-for-approval', '4'],
  ] as const)('prepares a %s dry-run without sending it', (action, validate) => {
    const form = parseTimesheetForm({
      html: buildTimesheetHtml(),
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do?id=sheet',
    });

    const result = prepareTimesheetDryRun({
      form,
      action,
      rowUpdates: [
        {
          rowIndex: 0,
          controls: {
            fullDay: ['true', 'true'],
            generatedItem: ['false'],
            daysWorked_int: [],
            daysWorked_fraction: [],
            imputationStructureId1: ['project-placeholder'],
            imputationStructureId2: ['activity-placeholder'],
            imputationStructureId3: ['role-placeholder'],
          },
        },
      ],
    });

    expect(
      result.fields.filter(({ name }) => name === rowFieldName('fullDay')),
    ).toEqual([
      { name: rowFieldName('fullDay'), value: 'true' },
      { name: rowFieldName('fullDay'), value: 'true' },
    ]);
    expect(
      result.fields.some(
        ({ name }) => name === rowFieldName('daysWorked_int'),
      ),
    ).toBe(false);
    expect(result.fields).toContainEqual({ name: 'validate', value: validate });
    expect(result.fields).toContainEqual({ name: 'changed', value: 'false' });
    expect(result.fields).toContainEqual({
      name: 'btnApply',
      value: 'clicked',
    });
    expect(result.fields.some(({ name }) => name === 'ctrla')).toBe(false);
    expect(result.summary).toEqual({
      action,
      method: 'POST',
      url: 'https://tenant.example/eurecia/timesheet/Open.do',
      fieldCount: result.fields.length,
      changedRows: [0],
      hasCsrfToken: true,
      hasFormInstanceId: true,
    });
    expect(JSON.stringify(result.summary)).not.toContain('synthetic-csrf');
    expect(JSON.stringify(result.summary)).not.toContain(
      'synthetic-form-instance',
    );
  });

  it('rejects preparation without fresh form security state', () => {
    const form = parseTimesheetForm({
      html: buildTimesheetHtml().replace('synthetic-csrf', ''),
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
    });

    expect(() =>
      prepareTimesheetDryRun({ form, action: 'save', rowUpdates: [] }),
    ).toThrow('fresh CSRF token');
  });

  it('rejects ambiguous duplicate security fields', () => {
    const form = parseTimesheetForm({
      html: buildTimesheetHtml().replace(
        '<input type="hidden" name="idTimeSheet"',
        '<input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="duplicate"><input type="hidden" name="idTimeSheet"',
      ),
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
    });

    expect(() =>
      prepareTimesheetDryRun({ form, action: 'save', rowUpdates: [] }),
    ).toThrow('exactly one CSRF token');
  });

  it('uses the captured literal row-control name contract', () => {
    expect(getEureciaRowFieldName({ column: 'fullDay', rowIndex: 0 })).toBe(
      'ctrlvcol%3DfullDay%3Bctrl%3Dactivities%3Brow%3Drow_0%3Btype%3Dtxt',
    );
    expect(() =>
      getEureciaRowFieldName({ column: 'fullDay', rowIndex: -1 }),
    ).toThrow('non-negative integer');
  });

  it('redacts target identifiers from the dry-run summary URL', () => {
    const form = parseTimesheetForm({
      html: buildTimesheetHtml().replace(
        '/eurecia/timesheet/Open.do',
        '/eurecia/timesheet/Open.do?mode=edit&id=sheet-placeholder',
      ),
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
    });

    const result = prepareTimesheetDryRun({
      form,
      action: 'save',
      rowUpdates: [],
    });

    expect(result.url).toContain('id=sheet-placeholder');
    expect(result.summary.url).toBe(
      'https://tenant.example/eurecia/timesheet/Open.do?mode=%5BREDACTED%5D&id=%5BREDACTED%5D',
    );
  });

  it('maps Open activity rows using decoded controls and caller axis labels', () => {
    const html = buildTimesheetHtml()
      .replace('<body>', '<body><span id="dateActivite_0">02/07/2026</span>')
      .replace(`name="${rowFieldName('fullDay')}" value="false"`, `name="${rowFieldName('fullDay')}" value="true"`)
      .replace('project-placeholder', 'unused');
    const model = parseTimesheetEditorModel({
      html,
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do?id=sheet',
      axisLabels: {
        axis1: 'Client',
        axis2: 'Mission',
        axis3: 'Role',
      },
    });

    expect(model).toEqual({
      axisLabels: { axis1: 'Client', axis2: 'Mission', axis3: 'Role' },
      axisOptions: { axis1: [], axis2: [], axis3: [] },
      submission: { known: false, canSave: false, canSubmit: false, submitted: false },
      rows: [
        {
          rowIndex: 0,
          date: '2026-07-02',
          fraction: 1,
          axis1Id: '',
          axis2Id: '',
          axis3Id: '',
          comment: 'Synthetic comment',
          occupied: true,
        },
      ],
    });
  });

  it('reads saved axis selections from runtime select ids when encoded form fields are blank', () => {
    const html = buildTimesheetHtml()
      .replace('<body>', '<body><span id="dateActivite_0">02/07/2026</span>')
      .replace(`name="${rowFieldName('fullDay')}" value="false"`, `name="${rowFieldName('fullDay')}" value="true"`)
      .replace(
        '<input type="hidden" name="validatorComment" value="">',
        `<select id="imputationStructureId1_0"><option value="">Select</option><option value="client-saved" selected>Client saved</option></select>
         <select id="imputationStructureId2_0"><option value="mission-saved" selected>Mission saved</option></select>
         <select id="imputationStructureId3_0"><option value="role-saved" selected>Role saved</option></select>
         <input type="hidden" name="validatorComment" value="">`,
      );

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do?id=sheet',
        axisLabels: { axis1: 'Client', axis2: 'Mission', axis3: 'Role' },
      }).rows[0],
    ).toMatchObject({
      axis1Id: 'client-saved',
      axis2Id: 'mission-saved',
      axis3Id: 'role-saved',
    });
  });

  it('preserves zero rows and adds integer and quarter fractions', () => {
    const secondRow = ROW_COLUMNS_FOR_TEST.map((column) => {
      const value =
        column === 'daysWorked_int'
          ? '0'
          : column === 'daysWorked_fraction'
            ? '0.25'
            : column === 'comment'
              ? 'Quarter day'
              : '';
      return `<input name="${rowFieldName(column, 1)}" value="${value}">`;
    }).join('');
    const html = buildTimesheetHtml()
      .replace('<body>', '<body><span id="dateActivite_0">03/07/2026</span><span id="dateActivite_1">03/07/2026</span><span id="dateActivite_2">04/07/2026</span>')
      .replace(
        '<input type="hidden" name="validatorComment" value="">',
        `${secondRow}<input type="hidden" name="validatorComment" value="">`,
      );

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows.map(({ rowIndex, fraction, occupied }) => ({ rowIndex, fraction, occupied })),
    ).toEqual([
      { rowIndex: 0, fraction: 0, occupied: true },
      { rowIndex: 1, fraction: 0.25, occupied: true },
      { rowIndex: 2, fraction: 0, occupied: false },
    ]);
  });

  it('reads whole-day runtime duration from daysWorked controls', () => {
    const html = groupedEditorHtml({
      controls: [
        `
          <input name="${rowFieldName('fullDay')}" value="false">
          <input name="${rowFieldName('generatedItem')}" value="true">
          <input id="daysWorked_0" name="${rowFieldName('daysWorked')}" value="1">
          <textarea name="${rowFieldName('comment')}"></textarea>
        `,
      ],
      dates: [{ rowIndex: 0, value: '20/07/2026' }],
    });

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows[0],
    ).toMatchObject({
      rowIndex: 0,
      date: '2026-07-20',
      fraction: 1,
      occupied: true,
    });
  });

  it('reads visible axis labels from unit-based runtime table rows', () => {
    const html = `<html><body>
      <form action="/eurecia/timesheet/Open.do" method="post">
        <table class="ibody">
          <tbody>
            <tr class="editing">
              <td>Nouveau</td>
              <td>Lundi (1.0j)</td>
              <td><span id="dateActivite_0">20/07/2026</span></td>
              <td></td>
              <td>
                <input name="${rowFieldName('fullDay')}" value="true">
                <input name="${rowFieldName('generatedItem')}" value="true">
                <input id="daysWorked_0" name="${rowFieldName('daysWorked')}" value="1">
              </td>
              <td></td>
              <td>[OES][Projet] - Canaux directs - New APP</td>
              <td>OUIGO Espana</td>
              <td>Developpement</td>
              <td><textarea name="${rowFieldName('comment')}"></textarea></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </form>
    </body></html>`;

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'Project', axis2: 'Activity', axis3: 'Role' },
      }).rows[0],
    ).toMatchObject({
      axis1Id: '[OES][Projet] - Canaux directs - New APP',
      axis2Id: 'OUIGO Espana',
      axis3Id: 'Developpement',
    });
  });

  it('exposes the labels Eurecia rendered for saved axis selections', () => {
    const html = `<html><body>
      <form action="/eurecia/timesheet/Open.do" method="post">
        <table class="ibody">
          <tbody>
            <tr class="editing">
              <td>Nouveau</td>
              <td>Lundi</td>
              <td><span id="dateActivite_0">03/08/2026</span></td>
              <td></td>
              <td>
                <input name="${rowFieldName('fullDay')}" value="false">
                <input name="${rowFieldName('generatedItem')}" value="false">
                <input name="${rowFieldName('daysWorked_int')}" value="0">
                <input name="${rowFieldName('daysWorked_fraction')}" value="0.25">
              </td>
              <td></td>
              <td><select id="imputationStructureId1_0" name="${rowFieldName('imputationStructureId1')}"><option selected value='project-id'>|   |----[OES][Projet] - New APP</option><option value=''></option></select></td>
              <td><select id="imputationStructureId2_0" name="${rowFieldName('imputationStructureId2')}"><option selected value='mission-id'>OUIGO Espana</option><option value=''></option></select></td>
              <td><select id="imputationStructureId3_0" name="${rowFieldName('imputationStructureId3')}"><option selected value='role-id'>Developpement</option><option value=''></option></select></td>
              <td><textarea name="${rowFieldName('comment')}"></textarea></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </form>
    </body></html>`;

    const model = parseTimesheetEditorModel({
      html,
      pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
      axisLabels: { axis1: 'Project', axis2: 'Activity', axis3: 'Role' },
    });

    expect(model.rows[0]).toMatchObject({
      axis1Id: 'project-id',
      axis2Id: 'mission-id',
      axis3Id: 'role-id',
      occupied: true,
    });
    // Saved rows can be labelled without a second Eurecia round trip.
    expect(model.axisOptions.axis1).toEqual([
      { id: 'project-id', label: '| |----[OES][Projet] - New APP' },
    ]);
    expect(model.axisOptions.axis2).toEqual([
      { id: 'mission-id', label: 'OUIGO Espana' },
    ]);
    expect(model.axisOptions.axis3).toEqual([
      { id: 'role-id', label: 'Developpement' },
    ]);
  });

  it('keeps blank editable rows free instead of reading option labels', () => {
    const html = `<html><body>
      <form action="/eurecia/timesheet/Open.do" method="post">
        <table class="ibody">
          <tbody>
            <tr class="editing">
              <td>Nouveau</td>
              <td>Mercredi</td>
              <td><span id="dateActivite_0">05/08/2026</span></td>
              <td></td>
              <td>
                <input name="${rowFieldName('fullDay')}" value="false">
                <input name="${rowFieldName('generatedItem')}" value="true">
                <input name="${rowFieldName('daysWorked_int')}" value="0">
                <input name="${rowFieldName('daysWorked_fraction')}" value="0.0">
              </td>
              <td></td>
              <td><select id="imputationStructureId1_0" name="${rowFieldName('imputationStructureId1')}"><option selected value=''></option><option>|   |----[OFR][BUILD] - Pilotage transverse</option><option value=''></option></select></td>
              <td><select id="imputationStructureId2_0" name="${rowFieldName('imputationStructureId2')}"><option selected value=''></option><option value=''></option></select></td>
              <td><select id="imputationStructureId3_0" name="${rowFieldName('imputationStructureId3')}"><option selected value=''></option><option>Formation</option><option value=''></option></select></td>
              <td><textarea name="${rowFieldName('comment')}"></textarea></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </form>
    </body></html>`;

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'Project', axis2: 'Activity', axis3: 'Role' },
      }).rows[0],
    ).toMatchObject({
      rowIndex: 0,
      date: '2026-08-05',
      fraction: 0,
      axis1Id: '',
      axis2Id: '',
      axis3Id: '',
      occupied: false,
    });
  });

  it('inherits the prior displayed date for a populated continuation activity row', () => {
    const html = groupedEditorHtml({
      controls: [
        editorRowControls({
          rowIndex: 0,
          values: {
            daysWorked_fraction: '0.25',
            imputationStructureId1: 'client-a',
            imputationStructureId2: 'mission-a',
            imputationStructureId3: 'role-a',
            comment: 'First activity',
          },
        }),
        editorRowControls({
          rowIndex: 1,
          omitted: ['fullDay'],
          values: {
            daysWorked_fraction: '0.5',
            imputationStructureId1: 'client-b',
            imputationStructureId2: 'mission-b',
            imputationStructureId3: 'role-b',
            comment: 'Continuation activity',
          },
        }),
      ],
      dates: [{ rowIndex: 0, value: '03/07/2026' }],
    });

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows,
    ).toEqual([
      {
        rowIndex: 0,
        date: '2026-07-03',
        fraction: 0.25,
        axis1Id: 'client-a',
        axis2Id: 'mission-a',
        axis3Id: 'role-a',
        comment: 'First activity',
        occupied: true,
      },
      {
        rowIndex: 1,
        date: '2026-07-03',
        fraction: 0.5,
        axis1Id: 'client-b',
        axis2Id: 'mission-b',
        axis3Id: 'role-b',
        comment: 'Continuation activity',
        occupied: true,
      },
    ]);
  });

  it('groups rows by numeric index despite shuffled controls and date elements', () => {
    const controls = [3, 1, 2, 0].map((rowIndex) =>
      editorRowControls({
        rowIndex,
        values: {
          daysWorked_fraction: rowIndex === 3 ? '0.5' : '0.25',
          comment: `Activity ${rowIndex}`,
        },
      }),
    );
    const html = groupedEditorHtml({
      controls,
      dates: [
        { rowIndex: 2, value: '04/07/2026' },
        { rowIndex: 0, value: '03/07/2026' },
      ],
    });

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows.map(({ rowIndex, date, fraction, comment }) => ({
        rowIndex,
        date,
        fraction,
        comment,
      })),
    ).toEqual([
      { rowIndex: 0, date: '2026-07-03', fraction: 0.25, comment: 'Activity 0' },
      { rowIndex: 1, date: '2026-07-03', fraction: 0.25, comment: 'Activity 1' },
      { rowIndex: 2, date: '2026-07-04', fraction: 0.25, comment: 'Activity 2' },
      { rowIndex: 3, date: '2026-07-04', fraction: 0.5, comment: 'Activity 3' },
    ]);
  });

  it('rejects a populated undated row before the first numeric dated row', () => {
    const html = groupedEditorHtml({
      controls: [
        editorRowControls({
          rowIndex: 2,
          values: { daysWorked_fraction: '0.25' },
        }),
        editorRowControls({
          rowIndex: 0,
          values: { daysWorked_fraction: '0.25', comment: 'Leading activity' },
        }),
      ],
      dates: [{ rowIndex: 2, value: '04/07/2026' }],
    });

    expect(() =>
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }),
    ).toThrow('activity row 0 has no date control');
  });

  it('skips blank undated templates without changing date inheritance across gaps', () => {
    const html = groupedEditorHtml({
      controls: [
        editorRowControls({ rowIndex: 0 }),
        editorRowControls({ rowIndex: 4 }),
        editorRowControls({
          rowIndex: 9,
          omitted: ['fullDay'],
          values: { daysWorked_fraction: '0.25', comment: 'After gap' },
        }),
      ],
      dates: [{ rowIndex: 0, value: '05/07/2026' }],
    });

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows.map(({ rowIndex, date, comment }) => ({ rowIndex, date, comment })),
    ).toEqual([
      { rowIndex: 0, date: '2026-07-05', comment: '' },
      { rowIndex: 9, date: '2026-07-05', comment: 'After gap' },
    ]);
  });

  it('rejects a malformed explicit date instead of inheriting a prior date', () => {
    const html = groupedEditorHtml({
      controls: [
        editorRowControls({ rowIndex: 0 }),
        editorRowControls({ rowIndex: 1 }),
      ],
      dates: [
        { rowIndex: 0, value: '05/07/2026' },
        { rowIndex: 1, value: '31/02/2026' },
      ],
    });

    expect(() =>
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }),
    ).toThrow('activity row 1 has malformed date');
  });

  it('skips an undated blank template row with encoded default controls', () => {
    expect(
      parseTimesheetEditorModel({
        html: buildBlankTemplateHtml(),
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows,
    ).toEqual([]);
  });

  it.each(ROW_COLUMNS_FOR_TEST)(
    'does not skip an undated row missing the %s control',
    (column) => {
      expect(() =>
        parseTimesheetEditorModel({
          html: removeRowControl(buildBlankTemplateHtml(), column),
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }),
      ).toThrow('activity row 0 has no date control');
    },
  );

  it.each([
    ['daysWorked_int', '1'],
    ['daysWorked_fraction', '0.25'],
    ['fullDay', 'true'],
    ['generatedItem', 'true'],
    ['imputationStructureId1', 'project-placeholder'],
    ['imputationStructureId2', ' '],
    ['comment', 'Existing work'],
    ['comment', ' '],
  ] as const)(
    'does not let final blank %s duplicate mask prior value %s',
    (column, value) => {
      expect(() =>
        parseTimesheetEditorModel({
          html: prependRowControl({
            html: buildBlankTemplateHtml(),
            column,
            value,
          }),
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }),
      ).toThrow('activity row 0 has no date control');
    },
  );

  it.each([
    ['daysWorked_int', 'invalid', 'malformed duration'],
    ['daysWorked_fraction', 'invalid', 'malformed duration'],
    ['fullDay', 'sometimes', 'malformed full-day'],
    ['generatedItem', 'sometimes', 'malformed generated'],
  ] as const)(
    'rejects malformed prior %s duplicate %s',
    (column, value, message) => {
      expect(() =>
        parseTimesheetEditorModel({
          html: prependRowControl({
            html: buildBlankTemplateHtml(),
            column,
            value,
          }),
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }),
      ).toThrow(message);
    },
  );

  it.each([
    ['fullDay', 'malformed full-day'],
    ['generatedItem', 'malformed generated'],
  ] as const)(
    'validates malformed %s duplicate after a meaningful value',
    (column, message) => {
      const meaningfulHtml = prependRowControl({
        html: buildBlankTemplateHtml(),
        column,
        value: 'true',
      });
      const html = prependRowControl({
        html: meaningfulHtml,
        column,
        value: 'sometimes',
      });

      expect(() =>
        parseTimesheetEditorModel({
          html,
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }),
      ).toThrow(message);
    },
  );

  it('skips repeated false and zero defaults on a complete undated row', () => {
    const html = ([
      ['fullDay', '0'],
      ['generatedItem', '0'],
      ['daysWorked_int', '0'],
      ['daysWorked_fraction', '0.0'],
    ] as const).reduce(
      (current, [column, value]) =>
        prependRowControl({ html: current, column, value }),
      buildBlankTemplateHtml(),
    );

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows,
    ).toEqual([]);
  });

  it('keeps a dated blank template row available', () => {
    expect(
      parseTimesheetEditorModel({
        html: buildBlankTemplateHtml().replace(
          '<body>',
          '<body><span id="dateActivite_0">03/07/2026</span>',
        ),
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows,
    ).toEqual([
      {
        rowIndex: 0,
        date: '2026-07-03',
        fraction: 0,
        axis1Id: '',
        axis2Id: '',
        axis3Id: '',
        comment: '',
        occupied: false,
      },
    ]);
  });

  it.each([
    ['nonzero duration', 'daysWorked_fraction', '0.25'],
    ['axis selection', 'imputationStructureId1', 'project-placeholder'],
    ['comment', 'comment', 'Existing work'],
    ['generated state', 'generatedItem', 'true'],
    ['full-day state', 'fullDay', 'true'],
  ] as const)(
    'rejects an undated template row with %s',
    (_label, column, value) => {
      const html = buildBlankTemplateHtml().replace(
        `name="${rowFieldName(column)}" value="${
          column === 'daysWorked_fraction' ? '0.0' : 'false'
        }"`,
        `name="${rowFieldName(column)}" value="${value}"`,
      );
      const populatedHtml =
        column === 'imputationStructureId1'
          ? html.replace(
              `name="${rowFieldName(column)}" value=""`,
              `name="${rowFieldName(column)}" value="${value}"`,
            )
          : column === 'comment'
            ? html.replace(
                `<textarea name="${rowFieldName(column)}"></textarea>`,
                `<textarea name="${rowFieldName(column)}">${value}</textarea>`,
              )
            : html;

      expect(() =>
        parseTimesheetEditorModel({
          html: populatedHtml,
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }),
      ).toThrow('activity row 0 has no date control');
    },
  );

  it.each([
    ['invalid', 'malformed duration'],
    ['0.3', 'unsupported nonzero duration'],
  ])(
    'rejects undated template row duration %s as %s',
    (duration, message) => {
      const html = buildBlankTemplateHtml().replace(
        `name="${rowFieldName('daysWorked_fraction')}" value="0.0"`,
        `name="${rowFieldName('daysWorked_fraction')}" value="${duration}"`,
      );

      expect(() =>
        parseTimesheetEditorModel({
          html,
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }),
      ).toThrow(message);
    },
  );

  it.each([
    ['daysWorked_int', ''],
    ['daysWorked_int', ' '],
    ['daysWorked_int', '0x1'],
    ['daysWorked_int', '1e0'],
    ['daysWorked_int', '+1'],
    ['daysWorked_int', '-0'],
    ['daysWorked_int', 'Infinity'],
    ['daysWorked_int', 'NaN'],
    ['daysWorked_int', '0.0'],
    ['daysWorked_fraction', ''],
    ['daysWorked_fraction', ' '],
    ['daysWorked_fraction', '0x0'],
    ['daysWorked_fraction', '2.5e-1'],
    ['daysWorked_fraction', '+0.25'],
    ['daysWorked_fraction', '-0'],
    ['daysWorked_fraction', 'Infinity'],
    ['daysWorked_fraction', 'NaN'],
    ['daysWorked_fraction', '.25'],
    ['daysWorked_fraction', '0.'],
  ] as const)(
    'rejects non-decimal %s token %j for dated and undated rows',
    (column, value) => {
      const undatedHtml = replaceDurationControl({
        html: buildBlankTemplateHtml(),
        column,
        value,
      });
      const datedHtml = undatedHtml.replace(
        '<body>',
        '<body><span id="dateActivite_0">03/07/2026</span>',
      );

      for (const html of [datedHtml, undatedHtml]) {
        expect(() =>
          parseTimesheetEditorModel({
            html,
            pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
            axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
          }),
        ).toThrow('malformed duration');
      }
    },
  );

  it.each([
    ['0', 0],
    ['0.0', 0],
    ['00.00', 0],
    ['0.25', 0.25],
    ['0.50', 0.5],
    ['0.75', 0.75],
    ['1.0', 1],
  ] as const)('accepts plain decimal fraction token %s', (value, fraction) => {
    const html = replaceDurationControl({
      html: buildBlankTemplateHtml(),
      column: 'daysWorked_fraction',
      value,
    }).replace(
      '<body>',
      '<body><span id="dateActivite_0">03/07/2026</span>',
    );

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows[0].fraction,
    ).toBe(fraction);
  });

  it.each([
    ['daysWorked_int', ' '],
    ['daysWorked_int', '0x1'],
    ['daysWorked_fraction', '2.5e-1'],
    ['daysWorked_fraction', '+0.25'],
  ] as const)(
    'rejects malformed prior dated %s duplicate %j',
    (column, value) => {
      const html = prependRowControl({
        html: buildBlankTemplateHtml(),
        column,
        value,
      }).replace(
        '<body>',
        '<body><span id="dateActivite_0">03/07/2026</span>',
      );

      expect(() =>
        parseTimesheetEditorModel({
          html,
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }),
      ).toThrow('malformed duration');
    },
  );

  it('keeps final-value duration semantics for valid dated duplicates', () => {
    const html = prependRowControl({
      html: buildBlankTemplateHtml(),
      column: 'daysWorked_fraction',
      value: '0.25',
    }).replace(
      '<body>',
      '<body><span id="dateActivite_0">03/07/2026</span>',
    );

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows[0].fraction,
    ).toBe(0);
  });

  it.each([
    ['0', '0'],
    ['00', '00.00'],
  ])(
    'accepts integer zero %s and fraction zero %s for an undated blank row',
    (integer, fraction) => {
      const html = replaceDurationControl({
        html: replaceDurationControl({
          html: buildBlankTemplateHtml(),
          column: 'daysWorked_int',
          value: integer,
        }),
        column: 'daysWorked_fraction',
        value: fraction,
      });

      expect(
        parseTimesheetEditorModel({
          html,
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }).rows,
      ).toEqual([]);
    },
  );

  it.each([
    ['0', 0],
    ['00', 0],
    ['1', 1],
    ['01', 1],
  ] as const)('accepts base-10 integer token %s', (value, fraction) => {
    const html = replaceDurationControl({
      html: buildBlankTemplateHtml(),
      column: 'daysWorked_int',
      value,
    }).replace(
      '<body>',
      '<body><span id="dateActivite_0">03/07/2026</span>',
    );

    expect(
      parseTimesheetEditorModel({
        html,
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }).rows[0].fraction,
    ).toBe(fraction);
  });

  it.each(['0.3', 'invalid'])(
    'rejects malformed or unsupported nonzero row duration %s',
    (duration) => {
      const html = buildTimesheetHtml()
        .replace('<body>', '<body><span id="dateActivite_0">03/07/2026</span>')
        .replace(
          `name="${rowFieldName('daysWorked_fraction')}" value="0.0"`,
          `name="${rowFieldName('daysWorked_fraction')}" value="${duration}"`,
        );

      expect(() =>
        parseTimesheetEditorModel({
          html,
          pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
          axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
        }),
      ).toThrow(/malformed duration|unsupported nonzero duration/);
    },
  );

  it('rejects an activity row with a missing date control', () => {
    expect(() =>
      parseTimesheetEditorModel({
        html: buildTimesheetHtml(),
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }),
    ).toThrow('activity row 0 has no date control');
  });

  it('adds an exact fixed structural summary without leaking hostile row values', () => {
    const secrets = [
      'SECRET_AXIS_ID_7f4a',
      'SECRET_COMMENT_TOKEN_91bc',
      'https://hostile.example/private?token=SECRET_URL_TOKEN',
      '<script>SECRET_HTML_PAYLOAD</script>',
    ];
    const html = prependRowControl({
      html: removeRowControl(
        removeRowControl(
          buildBlankTemplateHtml().replace(
            rowControlHtml({ column: 'imputationStructureId1', value: '' }),
            rowControlHtml({ column: 'imputationStructureId1', value: secrets[0] }),
          ),
          'generatedItem',
        ),
        'imputationStructureId3',
      ),
      column: 'comment',
      value: `${secrets[1]} ${secrets[2]} ${secrets[3]}`,
    });

    const message = getEditorParseError(html);

    expect(message).toBe(
      'Eurecia activity row 0 has no date control. Structure: columns.present=[comment,daysWorked_fraction,daysWorked_int,fullDay,imputationStructureId1,imputationStructureId2]; columns.missing=[generatedItem,imputationStructureId3]; column-counts=[comment:many,daysWorked_fraction:one,daysWorked_int:one,fullDay:one,generatedItem:zero,imputationStructureId1:one,imputationStructureId2:one,imputationStructureId3:zero]; duration=zero; fullDay=false-only; generatedItem=missing; axes=[axis1:nonempty,axis2:empty,axis3:missing]; comment=nonempty.',
    );
    for (const secret of secrets) expect(message).not.toContain(secret);
    expect(message).not.toContain('hostile.example');
  });

  it.each([
    [
      'daysWorked_fraction',
      'SECRET_MALFORMED_DURATION',
      'Eurecia activity row has malformed duration controls. Structure: columns.present=[comment,daysWorked_fraction,daysWorked_int,fullDay,generatedItem,imputationStructureId1,imputationStructureId2,imputationStructureId3]; columns.missing=[]; column-counts=[comment:one,daysWorked_fraction:one,daysWorked_int:one,fullDay:one,generatedItem:one,imputationStructureId1:one,imputationStructureId2:one,imputationStructureId3:one]; duration=malformed; fullDay=false-only; generatedItem=false-only; axes=[axis1:empty,axis2:empty,axis3:empty]; comment=empty.',
    ],
    [
      'generatedItem',
      'SECRET_UNKNOWN_TOGGLE',
      'Eurecia activity row has malformed generated-item controls. Structure: columns.present=[comment,daysWorked_fraction,daysWorked_int,fullDay,generatedItem,imputationStructureId1,imputationStructureId2,imputationStructureId3]; columns.missing=[]; column-counts=[comment:one,daysWorked_fraction:one,daysWorked_int:one,fullDay:one,generatedItem:one,imputationStructureId1:one,imputationStructureId2:one,imputationStructureId3:one]; duration=zero; fullDay=false-only; generatedItem=unknown; axes=[axis1:empty,axis2:empty,axis3:empty]; comment=empty.',
    ],
  ] as const)(
    'adds fixed structural diagnostics to an undated malformed %s control',
    (column, secret, expected) => {
      const html =
        column === 'daysWorked_fraction'
          ? replaceDurationControl({
              html: buildBlankTemplateHtml(),
              column,
              value: secret,
            })
          : buildBlankTemplateHtml().replace(
              rowControlHtml({ column, value: 'false' }),
              rowControlHtml({ column, value: secret }),
            );

      const message = getEditorParseError(html);

      expect(message).toBe(expected);
      expect(message).not.toContain(secret);
    },
  );

  it.each([
    [
      'daysWorked_fraction',
      '0.25',
      'no date control',
      'duration=nonzero',
      'fullDay=false-only',
    ],
    [
      'daysWorked_fraction',
      '0.3',
      'unsupported nonzero duration',
      'duration=unsupported',
      'fullDay=false-only',
    ],
    [
      'fullDay',
      'true',
      'no date control',
      'duration=nonzero',
      'fullDay=true-present',
    ],
  ] as const)(
    'uses fixed %s structural categories for an undated rejected row',
    (column, value, baseError, durationCategory, toggleCategory) => {
      const html = buildBlankTemplateHtml().replace(
        rowControlHtml({
          column,
          value: column === 'daysWorked_fraction' ? '0.0' : 'false',
        }),
        rowControlHtml({ column, value }),
      );

      const message = getEditorParseError(html);

      expect(message).toContain(baseError);
      expect(message).toContain(`; ${durationCategory};`);
      expect(message).toContain(`; ${toggleCategory};`);
      expect(message).not.toContain(`=${value};`);
    },
  );

  it('does not add undated-row diagnostics to a dated malformed duration error', () => {
    const html = replaceDurationControl({
      html: buildBlankTemplateHtml(),
      column: 'daysWorked_fraction',
      value: 'SECRET_DATED_MALFORMED_DURATION',
    }).replace(
      '<body>',
      '<body><span id="dateActivite_0">03/07/2026</span>',
    );

    expect(getEditorParseError(html)).toBe(
      'Eurecia activity row has malformed duration controls.',
    );
  });

  it('rejects an activity row with a malformed date control', () => {
    expect(() =>
      parseTimesheetEditorModel({
        html: buildTimesheetHtml().replace(
          '<body>',
          '<body><span id="dateActivite_0">31/02/2026</span>',
        ),
        pageUrl: 'https://tenant.example/eurecia/timesheet/Open.do',
        axisLabels: { axis1: 'One', axis2: 'Two', axis3: 'Three' },
      }),
    ).toThrow('activity row 0 has malformed date');
  });
});

describe('Eurecia DWR protocol', () => {
  it('encodes a plain-call request with typed parameters', () => {
    expect(
      buildDwrPlainCall({
        scriptName: 'AllDwrFunction',
        methodName: 'dwrGetImputationStructureLinkedOptionList',
        params: [
          { type: 'string', value: 'context-placeholder' },
          { type: 'number', value: 2 },
          { type: 'null' },
        ],
        batchId: '3',
        instanceId: '0',
        page: '/eurecia/timesheet/Open.do',
        scriptSessionId: 'synthetic-session',
      }),
    ).toBe(
      [
        'callCount=1',
        'nextReverseAjaxIndex=0',
        'c0-scriptName=AllDwrFunction',
        'c0-methodName=dwrGetImputationStructureLinkedOptionList',
        'c0-id=0',
        'c0-param0=string:context-placeholder',
        'c0-param1=number:2',
        'c0-param2=null:null',
        'batchId=3',
        'instanceId=0',
        'page=/eurecia/timesheet/Open.do',
        'scriptSessionId=synthetic-session',
        '',
      ].join('\n'),
    );
  });

  it('parses boolean and linked-option callbacks without evaluation', () => {
    expect(
      parseDwrCallback(
        'dwr.engine.remote.handleCallback("3", "0", true);',
      ),
    ).toEqual({ batchId: '3', callId: '0', value: true });

    expect(
      parseDwrCallback(`
        dwr.engine.remote.handleCallback("4", "0", [
          true,
          [["project-placeholder", "Project placeholder", false, "", "", ""]],
          "project-placeholder",
          false
        ]);
      `),
    ).toEqual({
      batchId: '4',
      callId: '0',
      value: [
        true,
        [
          [
            'project-placeholder',
            'Project placeholder',
            false,
            '',
            '',
            '',
          ],
        ],
        'project-placeholder',
        false,
      ],
    });

    expect(
      parseDwrCallback(
        'dwr.engine.remote.handleCallback("5", "0", [false, null, "", false]);',
      ),
    ).toEqual({
      batchId: '5',
      callId: '0',
      value: [false, null, '', false],
    });
  });

  it('parses only the captured guarded DWR envelope', () => {
    expect(
      parseDwrCallback(`throw 'allowScriptTagRemoting is false.';
//#DWR-INSERT
//#DWR-REPLY
//#DWR-START#
(function(){
if(!window.dwr)return;
var dwr=window.dwr._[0];
dwr.engine.remote.handleCallback("6", "0", true);
})();
//#DWR-END#
`),
    ).toEqual({ batchId: '6', callId: '0', value: true });
  });

  it('rejects executable DWR callback payloads', () => {
    expect(() =>
      parseDwrCallback(
        'dwr.engine.remote.handleCallback("1", "0", globalThis.alert("unsafe"));',
      ),
    ).toThrow('JSON-compatible');
    expect(() =>
      parseDwrCallback(
        'globalThis.alert("unsafe"); dwr.engine.remote.handleCallback("1", "0", true);',
      ),
    ).toThrow('envelope');
  });
});
