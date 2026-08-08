import type { TimesheetRemoteRow } from './timesheet-types';

export function isTimesheetRemoteRowOccupied(
  row: Pick<
    TimesheetRemoteRow,
    'fraction' | 'axis1Id' | 'axis2Id' | 'axis3Id' | 'comment'
  >,
) {
  return (
    row.fraction > 0 ||
    Boolean(row.axis1Id.trim()) ||
    Boolean(row.axis2Id.trim()) ||
    Boolean(row.axis3Id.trim()) ||
    Boolean(row.comment.trim())
  );
}
