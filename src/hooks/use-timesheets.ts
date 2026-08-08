import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  TimesheetAction,
  TimesheetAxisLookupRequest,
  TimesheetDraftParams,
  TimesheetEntryInput,
  TimesheetProviderType,
  TimesheetRowDeletion,
  TimesheetSyncParams,
} from '@shared/timesheet-types';

import { api } from '@/lib/api';

export function timesheetProviderQueryKey(provider: TimesheetProviderType) {
  return ['timesheets', provider] as const;
}

export function timesheetSheetQueryKey(params: {
  provider: TimesheetProviderType;
  sheetId: string;
  navigationUrl: string;
}) {
  return [
    ...timesheetProviderQueryKey(params.provider),
    'sheet',
    params.sheetId,
    params.navigationUrl,
  ] as const;
}

export function useTimesheetAdapters() {
  return useQuery({
    queryKey: ['timesheets', 'adapters'],
    queryFn: () => api.timesheets.listAdapters(),
  });
}

export function useTimesheetDraft(params: TimesheetDraftParams, enabled = true) {
  return useQuery({
    queryKey: ['timesheets', 'draft', params],
    queryFn: () => api.timesheets.buildDraft(params),
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useSyncTimesheet() {
  return useMutation({
    mutationFn: (params: TimesheetSyncParams) => api.timesheets.sync(params),
  });
}

export function useTimesheetAuthStatus(
  provider: TimesheetProviderType = 'eurecia',
  enabled = true,
) {
  return useQuery({
    queryKey: ['timesheets', provider, 'auth'],
    queryFn: () => api.timesheets.authStatus(provider),
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useLoginTimesheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: TimesheetProviderType) =>
      api.timesheets.login(provider),
    onSuccess: (_result, provider) => {
      void queryClient.invalidateQueries({
        queryKey: timesheetProviderQueryKey(provider),
      });
    },
  });
}

export function useLogoutTimesheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: TimesheetProviderType) =>
      api.timesheets.logout(provider),
    onSuccess: (_result, provider) => {
      void queryClient.invalidateQueries({
        queryKey: timesheetProviderQueryKey(provider),
      });
    },
  });
}

export function useTimesheetSheets(
  provider: TimesheetProviderType = 'eurecia',
  enabled = true,
) {
  return useQuery({
    queryKey: ['timesheets', provider, 'sheets'],
    queryFn: () => api.timesheets.listSheets(provider),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useTimesheetSheet(
  params:
    | {
        provider: TimesheetProviderType;
        sheetId: string;
        navigationUrl: string;
      }
    | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: params
      ? timesheetSheetQueryKey(params)
      : ['timesheets', undefined, 'sheet'],
    queryFn: () => api.timesheets.inspectSheet(params!),
    enabled: enabled && !!params,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useLookupTimesheetAxisOptions() {
  return useMutation({
    mutationFn: (
      params: TimesheetAxisLookupRequest & {
        provider: TimesheetProviderType;
      },
    ) => api.timesheets.lookupAxisOptions(params),
  });
}

export function useSaveTimesheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      provider: TimesheetProviderType;
      sheetId: string;
      entries: TimesheetEntryInput[];
      deletions?: TimesheetRowDeletion[];
      action: TimesheetAction;
    }) => api.timesheets.save(params),
    onSuccess: (_result, params) => {
      void queryClient.invalidateQueries({
        queryKey: timesheetProviderQueryKey(params.provider),
      });
    },
  });
}
