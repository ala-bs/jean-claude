import type {
  TimesheetAdapterCapability,
  TimesheetBuildDraftInput,
  TimesheetDraftResult,
  TimesheetProviderType,
  TimesheetSyncParams,
  TimesheetSyncResult,
} from '@shared/timesheet-types';

export type TimesheetAdapter = {
  provider: TimesheetProviderType;
  displayName: string;
  getCapabilities: () => TimesheetAdapterCapability;
  buildDraft: (input: TimesheetBuildDraftInput) => TimesheetDraftResult;
  sync: (params: TimesheetSyncParams) => Promise<TimesheetSyncResult>;
};
