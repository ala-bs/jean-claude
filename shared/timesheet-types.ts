import type {
  WorkActivityEvent,
  WorkActivityEventType,
} from './work-activity-types';

export type TimesheetProviderType = 'eurecia';

export type TimesheetAuthStatus = {
  configured: boolean;
  authenticated: boolean;
  baseUrl: string;
};

export type TimesheetSheetSummary = {
  id: string;
  navigationUrl: string;
  description: string;
  start: string;
  end: string;
  status: string;
};

export type TimesheetAxisLabels = {
  axis1: string;
  axis2: string;
  axis3: string;
};

export type TimesheetAxisOption = {
  id: string;
  label: string;
};

export type TimesheetAxisIndex = 1 | 2 | 3;

export type TimesheetAxisSelection = {
  axis1Id: string;
  axis2Id: string;
  axis3Id: string;
};

export type TimesheetAxisLookupRequest = {
  sheetId: string;
  navigationUrl: string;
  rowIndex: number;
  axis: TimesheetAxisIndex;
  selectedAxisIds: TimesheetAxisSelection;
};

export type TimesheetAxisLookupResult = {
  axis: TimesheetAxisIndex;
  options: TimesheetAxisOption[];
  selectedId: string | null;
};

export type TimesheetAxisOptions = {
  axis1: TimesheetAxisOption[];
  axis2: TimesheetAxisOption[];
  axis3: TimesheetAxisOption[];
};

export type TimesheetDayFraction = 0.25 | 0.5 | 0.75 | 1;

export type TimesheetEntryValues = TimesheetAxisSelection & {
  fraction: TimesheetDayFraction;
  comment: string;
};

export type TimesheetRemoteRow = Omit<TimesheetEntryValues, 'fraction'> & {
  rowIndex: number;
  date: string;
  fraction: TimesheetDayFraction | 0;
  occupied: boolean;
};

export type TimesheetEditorModel = {
  axisLabels: TimesheetAxisLabels;
  axisOptions: TimesheetAxisOptions;
  rows: TimesheetRemoteRow[];
  /** Sheet-level actions the Eurecia editor still offers. */
  submission: TimesheetSubmissionState;
};

export type TimesheetSubmissionState = {
  /** False when no sheet-level action was recognized on the page. */
  known: boolean;
  canSave: boolean;
  canSubmit: boolean;
  submitted: boolean;
};

export type TimesheetEntryInput = TimesheetEntryValues & {
  date: string;
  rowIndex?: number;
  sourceDraftIds: string[];
};

export type TimesheetAction = 'save' | 'submit-for-approval';

/**
 * A row to drop from the sheet. `rowIndex` is only a hint: Eurecia renumbers
 * rows on every delete, so the row is matched on its content.
 */
export type TimesheetRowDeletion = Omit<TimesheetEntryValues, 'fraction'> & {
  date: string;
  rowIndex: number;
  fraction: TimesheetDayFraction | 0;
};

/**
 * An in-place rewrite of a saved row. Eurecia re-posts the whole editor form,
 * so a row is updated by overwriting its controls — no delete/re-add needed.
 * `target` identifies the row exactly like a deletion does (content match with
 * `rowIndex` as a hint), because Eurecia renumbers rows on every add/delete.
 */
export type TimesheetRowUpdate = {
  target: TimesheetRowDeletion;
  values: TimesheetEntryValues;
};

export type TimesheetDryRunSummary = {
  action: TimesheetAction;
  entryCount: number;
  inferredEntryCount: number;
  changedRowIndices: number[];
  dates: string[];
};

export type TimesheetDryRunResult = {
  provider: TimesheetProviderType;
  sheetId: string;
  summary: TimesheetDryRunSummary;
  warnings: string[];
};

export type TimesheetSaveSummary = {
  action: TimesheetAction;
  entryCount: number;
  addedRowCount: number;
  deletedRowCount: number;
  updatedRowCount: number;
  savedRowIndices: number[];
  dates: string[];
};

export type TimesheetSaveResult = {
  provider: TimesheetProviderType;
  sheetId: string;
  summary: TimesheetSaveSummary;
  warnings: string[];
  editor: TimesheetEditorModel;
};

export type TimesheetAdapterCapability = {
  provider: TimesheetProviderType;
  displayName: string;
  supportsDraftEntries: boolean;
  supportsSync: boolean;
  requiresManualDuration: boolean;
};

export type TimesheetDraftParams = {
  provider: TimesheetProviderType;
  start: string;
  end: string;
  projectId?: string;
  type?: WorkActivityEventType;
};

export type TimesheetEntryDraft = {
  id: string;
  provider: TimesheetProviderType;
  date: string;
  project: {
    id: string | null;
    name: string | null;
  };
  role: string | null;
  workItem: {
    id: string;
    title: string | null;
    type: string | null;
  } | null;
  durationMinutes: number | null;
  description: string;
  sourceEventIds: string[];
  metadata: Record<string, unknown>;
  items: TimesheetDraftItem[];
};

export type TimesheetDraftItem = Pick<
  TimesheetEntryDraft,
  'project' | 'role' | 'workItem' | 'description' | 'sourceEventIds' | 'metadata'
>;

export type TimesheetDraftResult = {
  provider: TimesheetProviderType;
  displayName: string;
  entries: TimesheetEntryDraft[];
  warnings: string[];
};

export type TimesheetSyncParams = TimesheetDraftParams & {
  entries: TimesheetEntryDraft[];
};

export type TimesheetSyncResult = {
  provider: TimesheetProviderType;
  status: 'synced' | 'unsupported' | 'not_configured';
  externalIds: string[];
  message: string;
};

/**
 * Rejection message when the user closes the sign-in window without signing in.
 * Errors lose custom properties across Electron IPC, so the renderer matches on
 * this message: both sides must share the constant or the match silently breaks.
 */
export const TIMESHEET_SIGN_IN_CANCELLED_MESSAGE =
  'Eurecia sign-in was cancelled.';

export type TimesheetBuildDraftInput = {
  params: TimesheetDraftParams;
  events: WorkActivityEvent[];
};
