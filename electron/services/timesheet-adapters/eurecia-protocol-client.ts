import { load } from 'cheerio';

import type {
  TimesheetAxisLabels,
  TimesheetAxisOptions,
  TimesheetDayFraction,
  TimesheetEditorModel,
  TimesheetSheetSummary,
} from '@shared/timesheet-types';
import { isTimesheetRemoteRowOccupied } from '@shared/timesheet-utils';

const CSRF_FIELD = 'org.apache.struts.taglib.html.TOKEN';
const FORM_INSTANCE_FIELD = 'idOfForm';
const ROW_COLUMNS = [
  'fullDay',
  'generatedItem',
  'daysWorked_int',
  'daysWorked_fraction',
  'imputationStructureId1',
  'imputationStructureId2',
  'imputationStructureId3',
  'comment',
] as const;
const DECODED_ROW_COLUMNS = [...ROW_COLUMNS, 'daysWorked'] as const;
const SORTED_ROW_COLUMNS = [...ROW_COLUMNS].sort();
const UNDATED_ROW_CLASSIFIER_ERRORS = new Set([
  'Eurecia activity row has malformed duration controls.',
  'Eurecia activity row has unsupported nonzero duration.',
  'Eurecia activity row has malformed full-day controls.',
  'Eurecia activity row has malformed generated-item controls.',
]);

export type EureciaFormField = {
  name: string;
  value: string;
};

export type EureciaTimesheetForm = {
  actionUrl: string;
  method: string;
  enctype: string;
  fields: EureciaFormField[];
};

export type EureciaRowColumn = (typeof DECODED_ROW_COLUMNS)[number];

function normalizeEureciaDate(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00Z`);
  if (
    date.getUTCFullYear() !== Number(match[3]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[1])
  ) {
    return null;
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function parseTimesheetBrowse({
  html,
  pageUrl,
}: {
  html: string;
  pageUrl: string;
}): TimesheetSheetSummary[] {
  const $ = load(html);
  const page = new URL(pageUrl);
  const sheets: TimesheetSheetSummary[] = [];

  $('table.ibody > tbody > tr.clickable').each((_index, element) => {
    const cells = $(element).children('td');
    const href = cells
      .eq(0)
      .find('a[href*="Browse.do"]')
      .toArray()
      .map((link) => $(link).attr('href'))
      .find((candidate): candidate is string => {
        if (!candidate) return false;
        try {
          const url = new URL(candidate, page);
          return (
            url.origin === page.origin &&
            url.pathname === '/eurecia/timesheet/Browse.do' &&
            url.searchParams.get('ctrl') === 'list' &&
            url.searchParams.get('action') === 'Edit'
          );
        } catch {
          return false;
        }
      });
    if (!href || cells.length < 13) return;

    const navigationUrl = new URL(href, page);
    const id = navigationUrl.searchParams.get('param') ?? navigationUrl.searchParams.get('id');
    const start = normalizeEureciaDate(cells.eq(3).text());
    const end = normalizeEureciaDate(cells.eq(4).text());
    if (!id || !start || !end) return;

    sheets.push({
      id,
      navigationUrl: navigationUrl.toString(),
      description: cells.eq(2).text().trim(),
      start,
      end,
      status: cells.eq(12).text().trim(),
    });
  });

  return sheets;
}

type DwrParam =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'null' };

function appendSelectValues({
  control,
  name,
  fields,
}: {
  control: ReturnType<ReturnType<typeof load>>;
  name: string;
  fields: EureciaFormField[];
}) {
  let options = control
    .find('option')
    .filter((_index, option) => control._make(option).attr('selected') !== undefined);
  if (control.attr('multiple') === undefined && options.length > 1) {
    options = options.last();
  }
  if (options.length === 0 && control.attr('multiple') === undefined) {
    options = control
      .find('option')
      .filter((_index, option) => {
        const candidate = control._make(option);
        return (
          candidate.attr('disabled') === undefined &&
          candidate.parents('optgroup[disabled]').length === 0
        );
      })
      .first();
  }
  options.each((_index, option) => {
    const selectedOption = control._make(option);
    if (
      selectedOption.attr('disabled') !== undefined ||
      selectedOption.parents('optgroup[disabled]').length > 0
    ) {
      return;
    }
    fields.push({
      name,
      value: selectedOption.attr('value') ?? selectedOption.text(),
    });
  });
}

export function parseTimesheetForm({
  html,
  pageUrl,
}: {
  html: string;
  pageUrl: string;
}): EureciaTimesheetForm {
  const $ = load(html);
  const form = $('form[action*="timesheet/Open.do"]').first();
  if (form.length === 0) throw new Error('Eurecia timesheet form not found.');

  const action = form.attr('action');
  if (!action) throw new Error('Eurecia timesheet form has no action URL.');

  const actionUrl = new URL(action, pageUrl);
  if (actionUrl.origin !== new URL(pageUrl).origin) {
    throw new Error('Eurecia timesheet form action changed origin.');
  }
  if (actionUrl.pathname !== '/eurecia/timesheet/Open.do') {
    throw new Error('Eurecia timesheet form action path is invalid.');
  }

  const fields: EureciaFormField[] = [];
  form.find('input, select, textarea').each((_index, element) => {
    const control = $(element);
    const name = control.attr('name');
    const disabledByFieldset = control
      .parents('fieldset[disabled]')
      .toArray()
      .some((fieldset) => {
        const firstLegend = $(fieldset).children('legend').first();
        return (
          firstLegend.length === 0 ||
          !firstLegend.find('*').toArray().includes(element)
        );
      });
    if (!name || control.attr('disabled') !== undefined || disabledByFieldset) {
      return;
    }

    if (element.tagName === 'select') {
      appendSelectValues({ control, name, fields });
      return;
    }
    if (element.tagName === 'textarea') {
      fields.push({ name, value: control.text() });
      return;
    }

    const type = (control.attr('type') ?? 'text').toLowerCase();
    if (['button', 'file', 'image', 'reset', 'submit'].includes(type)) return;
    if (
      ['checkbox', 'radio'].includes(type) &&
      control.attr('checked') === undefined
    ) {
      return;
    }
    fields.push({
      name,
      value:
        control.attr('value') ??
        (['checkbox', 'radio'].includes(type) ? 'on' : ''),
    });
  });

  return {
    actionUrl: actionUrl.toString(),
    method: (form.attr('method') ?? 'GET').toUpperCase(),
    enctype: (form.attr('enctype') ?? 'application/x-www-form-urlencoded').toLowerCase(),
    fields,
  };
}

function decodeRowControlName(name: string) {
  try {
    const decoded = decodeURIComponent(name);
    const match = /^ctrlvcol=([^;]+);ctrl=activities;row=row_(\d+);type=txt$/.exec(
      decoded,
    );
    if (!match || !DECODED_ROW_COLUMNS.includes(match[1] as EureciaRowColumn)) return null;
    return {
      column: match[1] as EureciaRowColumn,
      rowIndex: Number(match[2]),
    };
  } catch {
    return null;
  }
}

function parseDurationToken({
  value,
  kind,
}: {
  value: string;
  kind: 'integer' | 'fraction';
}) {
  const pattern = kind === 'integer' ? /^\d+$/ : /^\d+(?:\.\d+)?$/;
  if (!pattern.test(value)) {
    throw new Error('Eurecia activity row has malformed duration controls.');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Eurecia activity row has malformed duration controls.');
  }
  return parsed;
}

function parseDayFraction({
  fullDay,
  daysWorked,
  daysWorkedInt,
  daysWorkedFraction,
}: {
  fullDay: string[];
  daysWorked?: string[];
  daysWorkedInt: string[];
  daysWorkedFraction: string[];
}): TimesheetDayFraction | 0 {
  const integers = (daysWorkedInt.length > 0 ? daysWorkedInt : ['0']).map(
    (value) => parseDurationToken({ value, kind: 'integer' }),
  );
  const fractions = (
    daysWorkedFraction.length > 0 ? daysWorkedFraction : ['0']
  ).map((value) => parseDurationToken({ value, kind: 'fraction' }));
  const integer = integers.at(-1) ?? 0;
  const fraction = fractions.at(-1) ?? 0;
  if (
    !Number.isInteger(integer) ||
    integer < 0 ||
    !Number.isFinite(fraction) ||
    fraction < 0
  ) {
    throw new Error('Eurecia activity row has malformed duration controls.');
  }
  if (fullDay.some((value) => ['1', 'on', 'true'].includes(value.toLowerCase()))) {
    return 1;
  }
  const explicitDays = (daysWorked ?? []).map((value) =>
    parseDurationToken({ value, kind: 'fraction' }),
  );
  const explicitTotal = explicitDays.at(-1);
  if (explicitTotal !== undefined) {
    if (![0, 0.25, 0.5, 0.75, 1].includes(explicitTotal)) {
      throw new Error('Eurecia activity row has unsupported nonzero duration.');
    }
    return explicitTotal as TimesheetDayFraction | 0;
  }
  const total = integer + fraction;
  if (total === 0) return 0;
  if (![0.25, 0.5, 0.75, 1].includes(total)) {
    throw new Error('Eurecia activity row has unsupported nonzero duration.');
  }
  return total as TimesheetDayFraction;
}

function hasPopulatedControl(values: string[] | undefined) {
  return (values ?? []).some((value) => value !== '');
}

function classifyControlCount(values: string[] | undefined) {
  if (!values || values.length === 0) return 'zero';
  return values.length === 1 ? 'one' : 'many';
}

function classifyToggle(values: string[] | undefined) {
  if (!values || values.length === 0) return 'missing';
  let hasTrue = false;
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (['0', 'false'].includes(normalized)) continue;
    if (['1', 'on', 'true'].includes(normalized)) {
      hasTrue = true;
      continue;
    }
    return 'unknown';
  }
  return hasTrue ? 'true-present' : 'false-only';
}

function classifyContent(values: string[] | undefined) {
  if (!values || values.length === 0) return 'missing';
  return hasPopulatedControl(values) ? 'nonempty' : 'empty';
}

function classifyDuration(
  controls: Partial<Record<EureciaRowColumn, string[]>>,
) {
  try {
    const durationValues = [
      ...(controls.daysWorked_int ?? []).map((value) =>
        parseDayFraction({
          fullDay: [],
          daysWorkedInt: [value],
          daysWorkedFraction: [],
        }),
      ),
      ...(controls.daysWorked_fraction ?? []).map((value) =>
        parseDayFraction({
          fullDay: [],
          daysWorkedInt: [],
          daysWorkedFraction: [value],
        }),
      ),
      ...(controls.daysWorked ?? []).map((value) =>
        parseDayFraction({
          fullDay: [],
          daysWorked: [value],
          daysWorkedInt: [],
          daysWorkedFraction: [],
        }),
      ),
    ];
    const fraction = parseDayFraction({
      fullDay: controls.fullDay ?? [],
      daysWorked: controls.daysWorked,
      daysWorkedInt: controls.daysWorked_int ?? [],
      daysWorkedFraction: controls.daysWorked_fraction ?? [],
    });
    return fraction !== 0 || durationValues.some((value) => value !== 0)
      ? 'nonzero'
      : 'zero';
  } catch (error) {
    return error instanceof Error &&
      error.message === 'Eurecia activity row has unsupported nonzero duration.'
      ? 'unsupported'
      : 'malformed';
  }
}

function summarizeUndatedRowStructure(
  controls: Partial<Record<EureciaRowColumn, string[]>>,
) {
  const present = SORTED_ROW_COLUMNS.filter(
    (column) => (controls[column]?.length ?? 0) > 0,
  );
  const missing = SORTED_ROW_COLUMNS.filter(
    (column) => (controls[column]?.length ?? 0) === 0,
  );
  const counts = SORTED_ROW_COLUMNS.map(
    (column) => `${column}:${classifyControlCount(controls[column])}`,
  );
  return [
    `Structure: columns.present=[${present.join(',')}]`,
    `columns.missing=[${missing.join(',')}]`,
    `column-counts=[${counts.join(',')}]`,
    `duration=${classifyDuration(controls)}`,
    `fullDay=${classifyToggle(controls.fullDay)}`,
    `generatedItem=${classifyToggle(controls.generatedItem)}`,
    `axes=[axis1:${classifyContent(controls.imputationStructureId1)},axis2:${classifyContent(controls.imputationStructureId2)},axis3:${classifyContent(controls.imputationStructureId3)}]`,
    `comment=${classifyContent(controls.comment)}.`,
  ].join('; ');
}

function appendUndatedRowStructure({
  message,
  controls,
}: {
  message: string;
  controls: Partial<Record<EureciaRowColumn, string[]>>;
}) {
  return new Error(`${message} ${summarizeUndatedRowStructure(controls)}`);
}

function hasMeaningfulUndatedToggleState({
  values,
  label,
}: {
  values: string[] | undefined;
  label: string;
}) {
  let meaningful = false;
  for (const value of values ?? []) {
    const normalized = value.toLowerCase();
    if (['0', 'false'].includes(normalized)) continue;
    if (['1', 'on', 'true'].includes(normalized)) {
      meaningful = true;
      continue;
    }
    throw new Error(`Eurecia activity row has malformed ${label} controls.`);
  }
  return meaningful;
}

function isBlankUndatedTemplateRow(
  controls: Partial<Record<EureciaRowColumn, string[]>>,
) {
  const durationValues = [
    ...(controls.daysWorked_int ?? []).map((value) =>
      parseDayFraction({
        fullDay: [],
        daysWorkedInt: [value],
        daysWorkedFraction: [],
      }),
    ),
      ...(controls.daysWorked_fraction ?? []).map((value) =>
        parseDayFraction({
          fullDay: [],
          daysWorkedInt: [],
          daysWorkedFraction: [value],
        }),
      ),
      ...(controls.daysWorked ?? []).map((value) =>
        parseDayFraction({
          fullDay: [],
          daysWorked: [value],
          daysWorkedInt: [],
          daysWorkedFraction: [],
        }),
      ),
    ];
  const hasMeaningfulFullDay = hasMeaningfulUndatedToggleState({
    values: controls.fullDay,
    label: 'full-day',
  });
  const hasMeaningfulGeneratedItem = hasMeaningfulUndatedToggleState({
    values: controls.generatedItem,
    label: 'generated-item',
  });
  const fraction = parseDayFraction({
    fullDay: controls.fullDay ?? [],
    daysWorked: controls.daysWorked,
    daysWorkedInt: controls.daysWorked_int ?? [],
    daysWorkedFraction: controls.daysWorked_fraction ?? [],
  });

  if (!ROW_COLUMNS.every((column) => (controls[column]?.length ?? 0) > 0)) {
    return false;
  }

  return (
    fraction === 0 &&
    durationValues.every((value) => value === 0) &&
    !hasMeaningfulFullDay &&
    !hasMeaningfulGeneratedItem &&
    !hasPopulatedControl(controls.imputationStructureId1) &&
    !hasPopulatedControl(controls.imputationStructureId2) &&
    !hasPopulatedControl(controls.imputationStructureId3) &&
    !hasPopulatedControl(controls.comment)
  );
}

function readVisibleAxisCells({
  $,
  rowIndex,
}: {
  $: ReturnType<typeof load>;
  rowIndex: number;
}) {
  const row = $(`#dateActivite_${rowIndex}`).closest('tr');
  if (row.length === 0) return [];
  return row
    .children('td')
    .slice(6, 9)
    .map((_index, cell) =>
      // Editable cells render a <select>; their text is the concatenation of
      // every option label, which must never be mistaken for a selected value.
      $(cell).find('select, input, textarea').length > 0
        ? ''
        : $(cell).text().replace(/\s+/g, ' ').trim(),
    )
    .get();
}

const MAX_INLINE_AXIS_OPTIONS = 2_000;

/**
 * Collects the axis options Eurecia already rendered inside the row dropdowns.
 * The selected option carries the label of a saved row, so declared rows can be
 * displayed without asking Eurecia for the option list again.
 */
function readInlineAxisOptions($: ReturnType<typeof load>) {
  const options: TimesheetAxisOptions = { axis1: [], axis2: [], axis3: [] };
  const seen: Record<1 | 2 | 3, Set<string>> = {
    1: new Set(),
    2: new Set(),
    3: new Set(),
  };
  $('select[id^="imputationStructureId"]').each((_index, element) => {
    const match = /^imputationStructureId([123])_\d+$/.exec(
      $(element).attr('id') ?? '',
    );
    if (!match) return;
    const axis = Number(match[1]) as 1 | 2 | 3;
    $(element)
      .find('option')
      .each((_optionIndex, option) => {
        const id = $(option).attr('value') ?? '';
        const label = $(option).text().replace(/\s+/g, ' ').trim();
        if (!id.trim() || !label || seen[axis].has(id)) return;
        if (seen[axis].size >= MAX_INLINE_AXIS_OPTIONS) return;
        seen[axis].add(id);
        options[`axis${axis}`].push({ id, label });
      });
  });
  return options;
}

export function parseTimesheetEditorModel({
  html,
  pageUrl,
  axisLabels,
}: {
  html: string;
  pageUrl: string;
  axisLabels: TimesheetAxisLabels;
}): TimesheetEditorModel {
  const $ = load(html);
  const form = parseTimesheetForm({ html, pageUrl });
  const controlsByRow = new Map<
    number,
    Partial<Record<EureciaRowColumn, string[]>>
  >();

  for (const field of form.fields) {
    const rowControl = decodeRowControlName(field.name);
    if (!rowControl) continue;
    const controls = controlsByRow.get(rowControl.rowIndex) ?? {};
    (controls[rowControl.column] ??= []).push(field.value);
    controlsByRow.set(rowControl.rowIndex, controls);
  }
  $('[id^="dateActivite_"]').each((_index, element) => {
    const match = /^dateActivite_(\d+)$/.exec($(element).attr('id') ?? '');
    if (match) {
      const rowIndex = Number(match[1]);
      if (!controlsByRow.has(rowIndex)) controlsByRow.set(rowIndex, {});
    }
  });
  controlsByRow.forEach((controls, rowIndex) => {
    const visibleAxisCells = readVisibleAxisCells({ $, rowIndex });
    ([1, 2, 3] as const).forEach((axis) => {
      const column = `imputationStructureId${axis}` as EureciaRowColumn;
      if (controls[column]?.some((value) => value.trim())) return;
      const select = $(`#${column}_${rowIndex}`).first();
      const value = select.length ? select.val() : undefined;
      const selectedValue = Array.isArray(value) ? value.at(-1) : value;
      const visibleValue = visibleAxisCells[axis - 1];
      if (typeof selectedValue === 'string' && selectedValue.trim()) {
        controls[column] = [selectedValue];
      } else if (visibleValue) {
        controls[column] = [visibleValue];
      }
    });
  });

  let inheritedDate: string | null = null;
  // Numeric order defines grouping: index gaps inherit only the latest prior explicit row date.
  const rows = [...controlsByRow]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .flatMap(([rowIndex, controls]) => {
      const dateElement = $(`#dateActivite_${rowIndex}`).first();
      let date: string;
      if (dateElement.length === 0) {
        try {
          if (isBlankUndatedTemplateRow(controls)) return [];
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !UNDATED_ROW_CLASSIFIER_ERRORS.has(error.message)
          ) {
            throw error;
          }
          throw appendUndatedRowStructure({ message: error.message, controls });
        }
        if (!inheritedDate) {
          throw appendUndatedRowStructure({
            message: `Eurecia activity row ${rowIndex} has no date control.`,
            controls,
          });
        }
        date = inheritedDate;
      } else {
        const explicitDate = normalizeEureciaDate(dateElement.text());
        if (!explicitDate) {
          throw new Error(`Eurecia activity row ${rowIndex} has malformed date.`);
        }
        inheritedDate = explicitDate;
        date = explicitDate;
      }
      const rowControls = {
        fraction: parseDayFraction({
          fullDay: controls.fullDay ?? [],
          daysWorked: controls.daysWorked,
          daysWorkedInt: controls.daysWorked_int ?? [],
          daysWorkedFraction: controls.daysWorked_fraction ?? [],
        }),
        axis1Id: controls.imputationStructureId1?.at(-1) ?? '',
        axis2Id: controls.imputationStructureId2?.at(-1) ?? '',
        axis3Id: controls.imputationStructureId3?.at(-1) ?? '',
        comment: controls.comment?.at(-1) ?? '',
      };
      const row = {
        rowIndex,
        date,
        ...rowControls,
      };
      return [{ ...row, occupied: isTimesheetRemoteRowOccupied(row) }];
    });

  return {
    axisLabels: { ...axisLabels },
    axisOptions: readInlineAxisOptions($),
    rows,
  };
}

export function getEureciaRowFieldName({
  column,
  rowIndex,
}: {
  column: EureciaRowColumn;
  rowIndex: number;
}) {
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    throw new Error('Eurecia row index must be a non-negative integer.');
  }
  return encodeURIComponent(
    `ctrlvcol=${column};ctrl=activities;row=row_${rowIndex};type=txt`,
  );
}

function requireUniqueField({
  fields,
  name,
  label,
}: {
  fields: EureciaFormField[];
  name: string;
  label: string;
}) {
  const matches = fields.filter((field) => field.name === name);
  if (matches.length !== 1) {
    throw new Error(`Eurecia form requires exactly one ${label}.`);
  }
  if (!matches[0].value) {
    throw new Error(`Eurecia form requires a fresh ${label}.`);
  }
}

function summarizeUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  url.username = '';
  url.password = '';
  for (const key of url.searchParams.keys()) {
    url.searchParams.set(key, '[REDACTED]');
  }
  url.hash = '';
  return url.toString();
}

function replaceFieldValues({
  fields,
  name,
  values,
}: {
  fields: EureciaFormField[];
  name: string;
  values: string[];
}) {
  const firstIndex = fields.findIndex((field) => field.name === name);
  if (firstIndex === -1) {
    throw new Error(`Eurecia form control not found: ${name}`);
  }

  return fields.flatMap((field, index) => {
    if (field.name !== name) return [field];
    if (index !== firstIndex) return [];
    return values.map((value) => ({ name, value }));
  });
}

export function prepareTimesheetDryRun({
  form,
  action,
  rowUpdates,
}: {
  form: EureciaTimesheetForm;
  action: 'save' | 'submit-for-approval';
  rowUpdates: Array<{
    rowIndex: number;
    controls: Partial<Record<EureciaRowColumn, string[]>>;
  }>;
}) {
  requireUniqueField({
    fields: form.fields,
    name: CSRF_FIELD,
    label: 'CSRF token',
  });
  requireUniqueField({
    fields: form.fields,
    name: FORM_INSTANCE_FIELD,
    label: 'form instance ID',
  });
  if (form.method !== 'POST' || form.enctype !== 'multipart/form-data') {
    throw new Error('Unexpected Eurecia timesheet form transport.');
  }

  let fields = form.fields.filter(
    (field) => !['btnApply', 'ctrla'].includes(field.name),
  );
  fields = replaceFieldValues({
    fields,
    name: 'validate',
    values: [action === 'save' ? '2' : '4'],
  });
  fields = replaceFieldValues({
    fields,
    name: 'changed',
    values: ['false'],
  });

  for (const update of rowUpdates) {
    for (const [column, values] of Object.entries(update.controls)) {
      fields = replaceFieldValues({
        fields,
        name: getEureciaRowFieldName({
          column: column as EureciaRowColumn,
          rowIndex: update.rowIndex,
        }),
        values,
      });
    }
  }
  fields.push({ name: 'btnApply', value: 'clicked' });

  return {
    method: 'POST' as const,
    url: form.actionUrl,
    fields,
    summary: {
      action,
      method: 'POST' as const,
      url: summarizeUrl(form.actionUrl),
      fieldCount: fields.length,
      changedRows: [...new Set(rowUpdates.map(({ rowIndex }) => rowIndex))].sort(
        (left, right) => left - right,
      ),
      hasCsrfToken: true,
      hasFormInstanceId: true,
    },
  };
}

export function hasEureciaRowControl({
  fields,
  column,
  rowIndex,
}: {
  fields: EureciaFormField[];
  column: EureciaRowColumn;
  rowIndex: number;
}) {
  const name = getEureciaRowFieldName({ column, rowIndex });
  return fields.some((field) => field.name === name);
}

function requirePostForm(form: EureciaTimesheetForm) {
  requireUniqueField({
    fields: form.fields,
    name: CSRF_FIELD,
    label: 'CSRF token',
  });
  requireUniqueField({
    fields: form.fields,
    name: FORM_INSTANCE_FIELD,
    label: 'form instance ID',
  });
  if (form.method !== 'POST' || form.enctype !== 'multipart/form-data') {
    throw new Error('Unexpected Eurecia timesheet form transport.');
  }
}

/**
 * Builds the non-saving Eurecia POST that appends an activity row to the day of
 * `rowIndex`. Eurecia answers with the full re-rendered editor page.
 */
export function prepareTimesheetAddRow({
  form,
  rowIndex,
}: {
  form: EureciaTimesheetForm;
  rowIndex: number;
}) {
  requirePostForm(form);
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    throw new Error('Eurecia row index must be a non-negative integer.');
  }

  let fields = form.fields.filter(
    (field) => !['btnApply', 'btnSave', 'ctrla'].includes(field.name),
  );
  fields = replaceFieldValues({ fields, name: 'validate', values: [''] });
  fields = replaceFieldValues({ fields, name: 'changed', values: ['false'] });
  fields.push({ name: 'ctrla', value: `activities=AddLine=row_${rowIndex}` });

  return { method: 'POST' as const, url: form.actionUrl, fields };
}

/**
 * Builds the non-saving Eurecia POST that drops an activity row. Eurecia answers
 * with the re-rendered page, where the remaining rows are densely renumbered.
 */
export function prepareTimesheetDeleteRow({
  form,
  rowIndex,
}: {
  form: EureciaTimesheetForm;
  rowIndex: number;
}) {
  requirePostForm(form);
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    throw new Error('Eurecia row index must be a non-negative integer.');
  }

  let fields = form.fields.filter(
    (field) => !['btnApply', 'btnSave', 'ctrla'].includes(field.name),
  );
  fields = replaceFieldValues({ fields, name: 'validate', values: [''] });
  fields = replaceFieldValues({ fields, name: 'changed', values: ['false'] });
  fields.push({ name: 'ctrla', value: `activities=Delete=row_${rowIndex}` });

  return { method: 'POST' as const, url: form.actionUrl, fields };
}

/**
 * Builds the Eurecia save POST (`validate=2` + `btnApply=clicked`). Row controls
 * missing from the rendered form (e.g. `fullDay` on freshly added rows) are
 * skipped instead of throwing.
 */
export function prepareTimesheetSave({
  form,
  action,
  rowUpdates,
}: {
  form: EureciaTimesheetForm;
  action: 'save' | 'submit-for-approval';
  rowUpdates: Array<{
    rowIndex: number;
    controls: Partial<Record<EureciaRowColumn, string[]>>;
  }>;
}) {
  requirePostForm(form);

  let fields = form.fields.filter(
    (field) => !['btnApply', 'btnSave', 'ctrla'].includes(field.name),
  );
  fields = replaceFieldValues({
    fields,
    name: 'validate',
    values: [action === 'save' ? '2' : '4'],
  });
  fields = replaceFieldValues({ fields, name: 'changed', values: ['false'] });

  for (const update of rowUpdates) {
    for (const [column, values] of Object.entries(update.controls)) {
      const name = getEureciaRowFieldName({
        column: column as EureciaRowColumn,
        rowIndex: update.rowIndex,
      });
      if (!fields.some((field) => field.name === name)) continue;
      fields = replaceFieldValues({ fields, name, values });
    }
  }
  fields.push({ name: 'btnApply', value: 'clicked' });

  return {
    method: 'POST' as const,
    url: form.actionUrl,
    fields,
    summary: {
      action,
      method: 'POST' as const,
      url: summarizeUrl(form.actionUrl),
      fieldCount: fields.length,
      changedRows: [...new Set(rowUpdates.map(({ rowIndex }) => rowIndex))].sort(
        (left, right) => left - right,
      ),
    },
  };
}

const MULTIPART_BOUNDARY = '----JeanClaudeEureciaFormBoundary';

/** Serializes form fields the way the Eurecia browser form does. */
export function buildMultipartFormBody({
  fields,
  boundary = MULTIPART_BOUNDARY,
}: {
  fields: EureciaFormField[];
  boundary?: string;
}) {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    if (field.name.includes('"') || /[\r\n]/.test(field.name)) {
      throw new Error('Eurecia form field name is not serializable.');
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n`,
        'utf8',
      ),
      Buffer.from(field.value, 'utf8'),
      Buffer.from('\r\n', 'utf8'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

function assertSingleLine(value: string, name: string) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`DWR ${name} must not contain line breaks.`);
  }
}

export function buildDwrPlainCall({
  scriptName,
  methodName,
  params,
  batchId,
  instanceId,
  page,
  scriptSessionId,
}: {
  scriptName: string;
  methodName: string;
  params: DwrParam[];
  batchId: string;
  instanceId: string;
  page: string;
  scriptSessionId: string;
}) {
  for (const [name, value] of Object.entries({
    scriptName,
    methodName,
    batchId,
    instanceId,
    page,
    scriptSessionId,
  })) {
    assertSingleLine(value, name);
  }

  const lines = [
    'callCount=1',
    'nextReverseAjaxIndex=0',
    `c0-scriptName=${scriptName}`,
    `c0-methodName=${methodName}`,
    'c0-id=0',
  ];
  params.forEach((param, index) => {
    if (param.type === 'string') {
      assertSingleLine(param.value, `parameter ${index}`);
      lines.push(`c0-param${index}=string:${param.value}`);
      return;
    }
    if (param.type === 'number') {
      if (!Number.isFinite(param.value)) {
        throw new Error(`DWR parameter ${index} must be finite.`);
      }
      lines.push(`c0-param${index}=number:${param.value}`);
      return;
    }
    lines.push(`c0-param${index}=null:null`);
  });
  lines.push(
    `batchId=${batchId}`,
    `instanceId=${instanceId}`,
    `page=${page}`,
    `scriptSessionId=${scriptSessionId}`,
    '',
  );
  return lines.join('\n');
}

export function parseDwrCallback(response: string) {
  const prefix =
    /dwr\.engine\.remote\.handleCallback\(\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\s*,/m.exec(
      response,
    );
  if (!prefix || prefix.index === undefined) {
    throw new Error('Eurecia DWR callback not found.');
  }

  const beforeCallback = response.slice(0, prefix.index);
  const directPreamble = /^\s*$/;
  const guardedPreamble =
    /^throw 'allowScriptTagRemoting is false\.';\r?\n(?:\/\/#DWR-INSERT\r?\n)?\/\/#DWR-REPLY\r?\n\/\/#DWR-START#\r?\n\(function\(\)\{\r?\nif\(!window\.dwr\)return;\r?\nvar dwr=window\.dwr\._\[0\];\r?\n$/;
  if (
    !directPreamble.test(beforeCallback) &&
    !guardedPreamble.test(beforeCallback)
  ) {
    throw new Error('Unexpected Eurecia DWR callback envelope.');
  }

  const payloadStart = prefix.index + prefix[0].length;
  let callbackEnd = -1;
  let arrayDepth = 0;
  let objectDepth = 0;
  let parenthesisDepth = 0;
  let inString = false;
  let escaped = false;
  for (let index = payloadStart; index < response.length; index += 1) {
    const character = response[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') arrayDepth += 1;
    else if (character === ']') arrayDepth -= 1;
    else if (character === '{') objectDepth += 1;
    else if (character === '}') objectDepth -= 1;
    else if (character === '(') parenthesisDepth += 1;
    else if (character === ')') {
      if (parenthesisDepth > 0) parenthesisDepth -= 1;
      else if (arrayDepth === 0 && objectDepth === 0) {
        callbackEnd = index;
        break;
      }
    }
  }
  if (callbackEnd === -1) {
    throw new Error('Eurecia DWR callback is incomplete.');
  }

  const afterCallback = response.slice(callbackEnd + 1);
  const directSuffix = /^\s*;\s*$/;
  const guardedSuffix =
    /^;\r?\n\}\)\(\);\r?\n\/\/#DWR-END#\r?\n?$/;
  if (!directSuffix.test(afterCallback) && !guardedSuffix.test(afterCallback)) {
    throw new Error('Unexpected Eurecia DWR callback envelope.');
  }

  try {
    return {
      batchId: JSON.parse(prefix[1]) as string,
      callId: JSON.parse(prefix[2]) as string,
      value: JSON.parse(
        response.slice(payloadStart, callbackEnd).trim(),
      ) as unknown,
    };
  } catch {
    throw new Error('Eurecia DWR callback value must be JSON-compatible.');
  }
}
