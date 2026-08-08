import type {
  TimesheetAdapterCapability,
  TimesheetDraftParams,
  TimesheetDraftResult,
  TimesheetSyncParams,
  TimesheetSyncResult,
} from '@shared/timesheet-types';

import {
  getTimesheetAdapter,
  listTimesheetAdapters,
} from './timesheet-adapters';
import { WorkActivityRepository } from '../database/repositories';

export const timesheetService = {
  listAdapters(): TimesheetAdapterCapability[] {
    return listTimesheetAdapters().map((adapter) => adapter.getCapabilities());
  },

  async buildDraft(params: TimesheetDraftParams): Promise<TimesheetDraftResult> {
    const adapter = getTimesheetAdapter(params.provider);
    const events = await WorkActivityRepository.getRange(params);
    return adapter.buildDraft({ params, events });
  },

  async sync(params: TimesheetSyncParams): Promise<TimesheetSyncResult> {
    const adapter = getTimesheetAdapter(params.provider);
    return adapter.sync(params);
  },
};
