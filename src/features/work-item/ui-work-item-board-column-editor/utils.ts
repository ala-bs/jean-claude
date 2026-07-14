import type { AzureDevOpsBoardColumn } from '@/lib/api';

export function getEditableBoardColumns({
  columns,
  workItemType,
  currentColumn,
}: {
  columns: AzureDevOpsBoardColumn[];
  workItemType: string;
  currentColumn: string;
}): AzureDevOpsBoardColumn[] {
  const mappedColumns = columns.filter(
    (column) => !!column.stateMappings[workItemType],
  );
  if (
    !currentColumn ||
    mappedColumns.some((column) => column.name === currentColumn)
  ) {
    return mappedColumns;
  }
  return [
    {
      id: `current:${currentColumn}`,
      name: currentColumn,
      stateMappings: {},
    },
    ...mappedColumns,
  ];
}
