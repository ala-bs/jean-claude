import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { isSpreadsheetPath } from '@shared/spreadsheet-types';

/**
 * Reads a spreadsheet file from disk as base64 so it can be parsed in the
 * renderer. Disabled automatically for non-spreadsheet paths.
 */
export function useSpreadsheetFile(filePath: string | null | undefined) {
  const isSpreadsheet = Boolean(filePath) && isSpreadsheetPath(filePath!);
  const query = useQuery({
    queryKey: ['spreadsheet-content', filePath],
    queryFn: () => api.fs.readSpreadsheetAsBase64(filePath!),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: isSpreadsheet,
  });
  return {
    isSpreadsheet,
    base64: query.data ?? null,
    isLoading: isSpreadsheet && query.isLoading,
  };
}
