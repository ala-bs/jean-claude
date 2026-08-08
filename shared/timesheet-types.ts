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

export type TimesheetBuildDraftInput = {
  params: TimesheetDraftParams;
  events: WorkActivityEvent[];
};
