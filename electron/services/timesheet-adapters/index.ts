import type { TimesheetProviderType } from '@shared/timesheet-types';

import { eureciaTimesheetAdapter } from './eurecia-timesheet-adapter';
import type { TimesheetAdapter } from './types';

const ADAPTERS = new Map<TimesheetProviderType, TimesheetAdapter>([
  ['eurecia', eureciaTimesheetAdapter],
]);

export function listTimesheetAdapters() {
  return [...ADAPTERS.values()];
}

export function getTimesheetAdapter(provider: TimesheetProviderType) {
  const adapter = ADAPTERS.get(provider);
  if (!adapter) {
    throw new Error(`Unsupported timesheet provider: ${provider}`);
  }
  return adapter;
}
