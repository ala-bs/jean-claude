import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  LogIn,
  RefreshCw,
  SendHorizontal,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useQueryClient } from '@tanstack/react-query';

import type {
  TimesheetAction,
  TimesheetAxisIndex,
  TimesheetAxisLookupResult,
  TimesheetAxisOption,
  TimesheetAxisSelection,
  TimesheetEntryInput,
  TimesheetRemoteRow,
  TimesheetRowDeletion,
  TimesheetSheetSummary,
} from '@shared/timesheet-types';
import { TIMESHEET_SIGN_IN_CANCELLED_MESSAGE } from '@shared/timesheet-types';
import { isTimesheetRemoteRowOccupied } from '@shared/timesheet-utils';

import {
  timesheetSheetQueryKey,
  useLoginTimesheet,
  useLookupTimesheetAxisOptions,
  useSaveTimesheet,
  useTimesheetAuthStatus,
  useTimesheetDraft,
  useTimesheetSheet,
  useTimesheetSheets,
} from '@/hooks/use-timesheets';
import { Modal } from '@/common/ui/modal';
import { useToastStore } from '@/stores/toasts';

import {
  AXIS_LABEL_CACHE_KEY,
  DEFAULT_ROLE_KEY,
  MAX_CACHED_AXIS_LABELS,
  PALETTE_WIDTH_KEY,
  PINNED_PROJECTS_KEY,
  PINNED_SUB_AXES_KEY,
  RAIL_WIDTH_KEY,
  usePersistedState,
} from './preferences';
import { clampPaneWidth, PaneResizer } from './pane-resizer';
import {
  cleanEureciaAxisLabel,
  createConcurrencyLimiter,
  deriveAssignments,
  formatDayCount,
  fractionToSlots,
  getAssignmentColor,
  getAssignmentKey,
  getAxisLookupCacheKey,
  getDailyFractionTotals,
  getDaySlotOccupants,
  getOccupiedDailyCapacity,
  getSheetIdentity,
  getWeekChunks,
  hasSheetIdentityChanged,
  type InitializedTimesheetEntry,
  initializeTimesheetEntries,
  isAxisLookupRequestCurrent,
  planSlotPaint,
  resolveSelectedSheet,
  slotsToFraction,
  splitStagedWrites,
  TIMESHEET_SLOTS_PER_DAY,
  type TimesheetAssignment,
} from './utils';
import {
  COMMENT_MAX_LENGTH,
  EntryDetailRail,
  RemoteRowDetailRail,
  WeekSummaryRail,
} from './entry-rail';
import { WeekGrid, type WeekGridEntry } from './week-grid';
import { AssignmentPalette } from './assignment-palette';

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatInclusiveEnd(value: string) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() - 1);
  return formatDate(date.toISOString().slice(0, 10));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected Eurecia error.';
}

/**
 * Closing the Eurecia window without signing in is a deliberate user action, not
 * a failure: fall back to the sign-in screen without an alarming error banner.
 */
function isSignInCancellation(error: unknown) {
  // IPC wraps the message ("Error invoking remote method '...': Error: ..."),
  // so match on the shared constant as a substring rather than by equality.
  return (
    error instanceof Error &&
    error.message.includes(TIMESHEET_SIGN_IN_CANCELLED_MESSAGE)
  );
}

function overlapsRange(
  sheet: TimesheetSheetSummary,
  range: { start: string; end: string },
) {
  return sheet.end >= range.start.slice(0, 10) && sheet.start < range.end.slice(0, 10);
}

function StatusMessage({
  tone = 'muted',
  announce = false,
  children,
}: {
  tone?: 'muted' | 'error' | 'warning';
  announce?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        'rounded-lg border px-3 py-2.5 text-xs leading-relaxed',
        tone === 'error' && 'border-status-fail/35 bg-status-fail/10 text-status-fail',
        tone === 'warning' &&
          'border-status-warning/35 bg-status-warning/10 text-status-warning',
        tone === 'muted' && 'border-line-soft bg-black/15 text-ink-3',
      )}
      role={announce ? (tone === 'error' ? 'alert' : 'status') : undefined}
      aria-live={announce && tone !== 'error' ? 'polite' : undefined}
    >
      {children}
    </div>
  );
}

export function EureciaSyncDialog({
  isOpen,
  onClose,
  range,
}: {
  isOpen: boolean;
  onClose: () => void;
  range: { start: string; end: string };
}) {
  const auth = useTimesheetAuthStatus('eurecia', isOpen);
  const queryClient = useQueryClient();
  const login = useLoginTimesheet();
  const signInCancelled = login.isError && isSignInCancellation(login.error);
  const sheets = useTimesheetSheets(
    'eurecia',
    isOpen && auth.data?.authenticated === true,
  );
  const draft = useTimesheetDraft(
    {
      provider: 'eurecia',
      start: range.start,
      end: range.end,
    },
    isOpen,
  );
  const lookup = useLookupTimesheetAxisOptions();
  const save = useSaveTimesheet();
  const resetSave = save.reset;
  const addToast = useToastStore((state) => state.addToast);
  const [stage, setStage] = useState<'sheet' | 'editor'>('sheet');
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
  const [entries, setEntries] = useState<InitializedTimesheetEntry[]>([]);
  const [ledgerIdentity, setLedgerIdentity] = useState('');
  const [blockedDates, setBlockedDates] = useState<string[]>([]);
  const [axisOptions, setAxisOptions] = useState<
    Array<Record<TimesheetAxisIndex, TimesheetAxisOption[]>>
  >([]);
  const [axisErrors, setAxisErrors] = useState<Record<string, string>>({});
  const [paletteAxisError, setPaletteAxisError] = useState('');
  const [outOfRangeDraftCount, setOutOfRangeDraftCount] = useState(0);
  // Days Eurecia already fills: their Work Activity drafts are not seeded.
  const [fullyDeclaredDates, setFullyDeclaredDates] = useState<string[]>([]);
  const [pendingLookups, setPendingLookups] = useState(0);
  const axisLookupScheduler = useRef(createConcurrencyLimiter(4));
  const initializationKey = useRef('');
  const requestSequences = useRef(new Map<string, number>());
  const axisGeneration = useRef(0);
  const activeSheetIdentity = useRef<string | null>(null);
  const pendingLookupTokens = useRef(new Set<string>());
  const axisLookupCache = useRef(
    new Map<string, Promise<TimesheetAxisLookupResult>>(),
  );
  const attemptedAutoLogin = useRef(false);
  const attemptedAxisLoads = useRef(new Set<string>());
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [selectedEntryIndex, setSelectedEntryIndex] = useState<number | null>(null);
  const [selectedRemoteRow, setSelectedRemoteRow] =
    useState<TimesheetRemoteRow | null>(null);
  // Saved rows staged for removal; Eurecia only applies them on save.
  const [pendingDeletions, setPendingDeletions] = useState<TimesheetRowDeletion[]>(
    [],
  );
  const [weekIndex, setWeekIndex] = useState(0);
  const [paletteAxis, setPaletteAxis] = useState<
    Record<TimesheetAxisIndex, TimesheetAxisOption[]>
  >({ 1: [], 2: [], 3: [] });
  const [axisLabelCache, setAxisLabelCache] = usePersistedState<
    Record<string, string>
  >(AXIS_LABEL_CACHE_KEY, {});
  const [pinnedSubAxes, setPinnedSubAxes] = usePersistedState<
    Record<string, { axis2Id: string; axis3Id: string }>
  >(PINNED_SUB_AXES_KEY, {});
  const [addedProjectIds, setAddedProjectIds] = usePersistedState<string[]>(
    PINNED_PROJECTS_KEY,
    [],
  );
  const [defaultRoleId, setDefaultRoleId] = usePersistedState<string>(
    DEFAULT_ROLE_KEY,
    '',
  );
  const [paletteWidth, setPaletteWidth] = usePersistedState<number>(
    PALETTE_WIDTH_KEY,
    224,
  );
  const [railWidth, setRailWidth] = usePersistedState<number>(RAIL_WIDTH_KEY, 268);

  const selectedSheet = resolveSelectedSheet(sheets.data, selectedSheetId);
  const selectedSheetIdentity = getSheetIdentity(selectedSheet);
  const editor = useTimesheetSheet(
    selectedSheet
      ? {
          provider: 'eurecia',
          sheetId: selectedSheet.id,
          navigationUrl: selectedSheet.navigationUrl,
        }
      : undefined,
    stage !== 'sheet' && !sheets.isFetching,
  );
  const inspectionPending =
    sheets.isFetching ||
    editor.isPending ||
    editor.isFetching ||
    draft.isPending ||
    draft.isFetching;
  const inspectionError = editor.isError || draft.isError;
  const inspectionReady =
    !inspectionPending &&
    !inspectionError &&
    editor.isSuccess &&
    draft.isSuccess;
  const settledEditorData = inspectionReady ? editor.data : undefined;
  const initializationIdentity = selectedSheet
    ? JSON.stringify([
        selectedSheet.id,
        selectedSheet.navigationUrl,
        editor.dataUpdatedAt,
        draft.dataUpdatedAt,
      ])
    : null;
  const inspectionInitializing =
    inspectionReady && ledgerIdentity !== initializationIdentity;
  const inspectionLoading = inspectionPending || inspectionInitializing;
  const looksLikeDraftStatus =
    selectedSheet?.status.toLowerCase().includes('nouvelle') ?? false;
  // Eurecia itself says whether the sheet still accepts writes; the status label
  // is only a fallback for a page whose action buttons could not be read (and
  // for the moment before the sheet is inspected).
  const isSelectedSheetDraft = settledEditorData?.submission.known
    ? settledEditorData.submission.canSave
    : looksLikeDraftStatus;
  // A "Nouvelle" sheet can already hold saved-but-unsubmitted rows, so declared
  // rows come from the parsed grid rather than from the sheet status.
  const occupiedRows = useMemo(
    () => settledEditorData?.rows ?? [],
    [settledEditorData],
  );

  // Rows staged for deletion no longer hold capacity for the day.
  const activeOccupiedRows = useMemo(
    () =>
      occupiedRows.filter(
        (row) =>
          !pendingDeletions.some(
            (deletion) =>
              deletion.rowIndex === row.rowIndex && deletion.date === row.date,
          ),
      ),
    [occupiedRows, pendingDeletions],
  );

  const occupiedCapacity = useMemo(
    () => getOccupiedDailyCapacity(activeOccupiedRows),
    [activeOccupiedRows],
  );
  const dailyTotals = useMemo(
    () => getDailyFractionTotals(entries, occupiedCapacity),
    [entries, occupiedCapacity],
  );
  const axisLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    const add = (axis: TimesheetAxisIndex, options: TimesheetAxisOption[]) => {
      for (const option of options) {
        map.set(`${axis}:${option.id}`, cleanEureciaAxisLabel(option.label));
      }
    };
    if (settledEditorData) {
      add(1, settledEditorData.axisOptions.axis1);
      add(2, settledEditorData.axisOptions.axis2);
      add(3, settledEditorData.axisOptions.axis3);
    }
    add(1, paletteAxis[1]);
    add(2, paletteAxis[2]);
    add(3, paletteAxis[3]);
    for (const record of axisOptions) {
      if (!record) continue;
      add(1, record[1]);
      add(2, record[2]);
      add(3, record[3]);
    }
    return map;
  }, [axisOptions, paletteAxis, settledEditorData]);

  // Eurecia only lists axis options that apply to the open sheet, so a pinned
  // project can outlive the lookup that named it. Labels are remembered.
  useEffect(() => {
    if (axisLabelMap.size === 0) return;
    setAxisLabelCache((current) => {
      let changed = false;
      const next = { ...current };
      for (const [key, label] of axisLabelMap) {
        if (next[key] === label) continue;
        next[key] = label;
        changed = true;
      }
      if (!changed) return current;
      const keys = Object.keys(next);
      if (keys.length <= MAX_CACHED_AXIS_LABELS) return next;
      return Object.fromEntries(
        keys.slice(keys.length - MAX_CACHED_AXIS_LABELS).map((key) => [key, next[key]]),
      );
    });
  }, [axisLabelMap, setAxisLabelCache]);

  // Stable identity: this is passed down to every grid block and rail, so an
  // unstable one would defeat their memoization.
  const labelFor = useCallback(
    (axis: TimesheetAxisIndex, id: string) => {
      if (!id) return 'Unassigned';
      const key = `${axis}:${id}`;
      return (
        axisLabelMap.get(key) ?? axisLabelCache[key] ?? cleanEureciaAxisLabel(id)
      );
    },
    [axisLabelCache, axisLabelMap],
  );

  // Every axis-1 value Eurecia exposed for this sheet, however it reached us.
  const availableAxis1 = useMemo(() => {
    const options = new Map<string, string>();
    const add = (list: TimesheetAxisOption[]) => {
      for (const option of list) {
        if (option.id) options.set(option.id, cleanEureciaAxisLabel(option.label));
      }
    };
    add(settledEditorData?.axisOptions.axis1 ?? []);
    add(paletteAxis[1]);
    for (const record of axisOptions) add(record?.[1] ?? []);
    return options;
  }, [axisOptions, paletteAxis, settledEditorData]);

  /** Every option seen for each axis, used to backfill a row's own lookup. */
  const pooledAxisOptions = useMemo(() => {
    const pools: Record<TimesheetAxisIndex, Map<string, string>> = {
      1: new Map(),
      2: new Map(),
      3: new Map(),
    };
    const add = (axis: TimesheetAxisIndex, list: TimesheetAxisOption[]) => {
      for (const option of list) {
        if (option.id) pools[axis].set(option.id, option.label);
      }
    };
    for (const axis of [1, 2, 3] as const) {
      add(axis, paletteAxis[axis]);
      add(axis, settledEditorData?.axisOptions[`axis${axis}`] ?? []);
      for (const record of axisOptions) add(axis, record?.[axis] ?? []);
    }
    const toOptions = (axis: TimesheetAxisIndex) =>
      [...pools[axis]].map(([id, label]) => ({ id, label }));
    return { 1: toOptions(1), 2: toOptions(2), 3: toOptions(3) } as Record<
      TimesheetAxisIndex,
      TimesheetAxisOption[]
    >;
  }, [axisOptions, paletteAxis, settledEditorData]);

  const roleOptions = useMemo(() => {
    const options = new Map<string, string>();
    // Rows already saved on the sheet name their own role, so offer those too.
    for (const option of settledEditorData?.axisOptions.axis3 ?? []) {
      if (option.id) options.set(option.id, cleanEureciaAxisLabel(option.label));
    }
    for (const option of paletteAxis[3]) {
      if (option.id) options.set(option.id, cleanEureciaAxisLabel(option.label));
    }
    for (const record of axisOptions) {
      for (const option of record?.[3] ?? []) {
        if (option.id) options.set(option.id, cleanEureciaAxisLabel(option.label));
      }
    }
    return [...options]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [axisOptions, paletteAxis, settledEditorData]);

  const assignments = useMemo(() => {
    const used = deriveAssignments([...occupiedRows, ...entries]);
    const usedProjects = new Set(used.map(({ axis1Id }) => axis1Id));
    const added = deriveAssignments(
      addedProjectIds
        .filter((axis1Id) => !usedProjects.has(axis1Id))
        .map((axis1Id) => ({
          axis1Id,
          axis2Id: pinnedSubAxes[axis1Id]?.axis2Id ?? '',
          axis3Id: pinnedSubAxes[axis1Id]?.axis3Id ?? '',
        })),
    );
    return [...used, ...added];
  }, [addedProjectIds, entries, occupiedRows, pinnedSubAxes]);

  // Only hand-added projects can be removed; the rest mirror Eurecia rows.
  const removableProjectIds = useMemo(() => {
    const backed = new Set(
      [...occupiedRows, ...entries].map(({ axis1Id }) => axis1Id),
    );
    return addedProjectIds.filter((axis1Id) => !backed.has(axis1Id));
  }, [addedProjectIds, entries, occupiedRows]);

  const projectOptions = useMemo(() => {
    const takenProjects = new Set(assignments.map(({ axis1Id }) => axis1Id));
    return [...availableAxis1]
      .filter(([id]) => !takenProjects.has(id))
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [assignments, availableAxis1]);

  const weeks = useMemo(() => {
    if (!selectedSheet) return [];
    return getWeekChunks({
      start: selectedSheet.start,
      end: selectedSheet.end,
      activeDates: [
        ...occupiedRows.map(({ date }) => date),
        ...entries.map(({ date }) => date),
      ],
    });
  }, [entries, occupiedRows, selectedSheet]);
  const entryDates = new Set(entries.map(({ date }) => date));
  const invalidTotals = [...dailyTotals].filter(
    ([date, total]) => entryDates.has(date) && (total <= 0 || total > 1),
  );
  const outsideSheetDates = selectedSheet
    ? [...new Set(entries.map(({ date }) => date))].filter(
        (date) => date < selectedSheet.start || date > selectedSheet.end,
      )
    : [];
  const longCommentCount = entries.filter(
    ({ comment }) => comment.length > COMMENT_MAX_LENGTH,
  ).length;
  const isPending = login.isPending || save.isPending;
  const canSave =
    inspectionReady &&
    ledgerIdentity === initializationIdentity &&
    // Removing saved rows is a change on its own, with or without new entries.
    (entries.length > 0 || pendingDeletions.length > 0) &&
    blockedDates.length === 0 &&
    invalidTotals.length === 0 &&
    outsideSheetDates.length === 0 &&
    longCommentCount === 0 &&
    pendingLookups === 0;
  // Submitting saves and submits in one post, so it stays available when there
  // is nothing pending — as long as Eurecia still offers the submit action.
  const canSubmit =
    inspectionReady &&
    ledgerIdentity === initializationIdentity &&
    (settledEditorData?.submission.canSubmit ?? false) &&
    blockedDates.length === 0 &&
    invalidTotals.length === 0 &&
    outsideSheetDates.length === 0 &&
    longCommentCount === 0 &&
    pendingLookups === 0;

  function closeSafely() {
    if (!isPending) onClose();
  }

  // Eurecia only exposes axis-1 values through a row lookup, so prime the
  // palette from the sheet's first free row even before any entry exists.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (
      !settledEditorData ||
      !selectedSheet ||
      !isSelectedSheetDraft ||
      stage === 'sheet' ||
      ledgerIdentity !== initializationIdentity
    ) {
      return;
    }
    const orderedRows = [...settledEditorData.rows].sort(
      (left, right) => left.rowIndex - right.rowIndex,
    );
    // Eurecia builds each dropdown from its own row, so a free row and a declared
    // row can expose different axis-1 values; both are queried and merged.
    const freeRow = orderedRows.find(
      (row) => !row.occupied && !isTimesheetRemoteRowOccupied(row),
    );
    const declaredRow = orderedRows.find(
      (row) => row.occupied || isTimesheetRemoteRowOccupied(row),
    );
    const referenceRow = freeRow ?? orderedRows[0];
    if (!referenceRow) return;
    const extraAxis1Rows = [declaredRow, orderedRows[0]]
      .filter((row): row is TimesheetRemoteRow => !!row)
      .filter((row) => row.rowIndex !== referenceRow.rowIndex)
      .slice(0, 1);
    const requestGeneration = axisGeneration.current;
    const unresolvedPins = addedProjectIds.filter((id) => !pinnedSubAxes[id]);
    const token = `palette:${requestGeneration}:${initializationIdentity}:${unresolvedPins.join(',')}`;
    if (attemptedAxisLoads.current.has(token)) return;
    attemptedAxisLoads.current.add(token);
    const sheetId = selectedSheet.id;
    const navigationUrl = selectedSheet.navigationUrl;
    void (async () => {
      // Eurecia drives one hidden lookup window, so these must not overlap.
      // Linked axes only answer for a chosen parent, so the cascade is seeded
      // from a declared row, falling back to the single option when there is one.
      const seed = {
        axis1Id: declaredRow?.axis1Id ?? '',
        axis2Id: declaredRow?.axis2Id ?? '',
      };
      for (const axis of [1, 2, 3] as const) {
        try {
          const result = await lookup.mutateAsync({
            provider: 'eurecia',
            sheetId,
            navigationUrl,
            rowIndex: referenceRow.rowIndex,
            axis,
            selectedAxisIds: { ...seed, axis3Id: '' },
          });
          if (requestGeneration !== axisGeneration.current) return;
          console.info('[eurecia] palette axis loaded', {
            axis,
            rowIndex: referenceRow.rowIndex,
            count: result.options.length,
          });
          setPaletteAxis((current) => ({ ...current, [axis]: result.options }));
          if (axis === 1 && !seed.axis1Id && result.options.length === 1) {
            seed.axis1Id = result.options[0].id;
          }
          if (axis === 2 && !seed.axis2Id) {
            seed.axis2Id =
              result.options.length === 1
                ? result.options[0].id
                : (result.selectedId ?? '');
          }
        } catch (error) {
          if (requestGeneration !== axisGeneration.current) return;
          console.warn('[eurecia] palette axis lookup failed', {
            axis,
            rowIndex: referenceRow.rowIndex,
            message: getErrorMessage(error),
          });
          setPaletteAxisError(getErrorMessage(error));
        }
      }
      for (const row of extraAxis1Rows) {
        try {
          const result = await lookup.mutateAsync({
            provider: 'eurecia',
            sheetId,
            navigationUrl,
            rowIndex: row.rowIndex,
            axis: 1,
            selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
          });
          if (requestGeneration !== axisGeneration.current) return;
          console.info('[eurecia] palette axis merged', {
            axis: 1,
            rowIndex: row.rowIndex,
            count: result.options.length,
          });
          setPaletteAxis((current) => {
            const merged = new Map(
              [...current[1], ...result.options].map((option) => [
                option.id,
                option,
              ]),
            );
            return { ...current, 1: [...merged.values()] };
          });
        } catch (error) {
          if (requestGeneration !== axisGeneration.current) return;
          console.warn('[eurecia] palette axis merge failed', {
            rowIndex: row.rowIndex,
            message: getErrorMessage(error),
          });
        }
      }

      // A pinned project carries only its axis-1 id. Sub-axes Eurecia leaves no
      // choice about (a single option, or its own default) are adopted so the
      // assignment is usable without opening a row.
      for (const axis1Id of unresolvedPins) {
        const resolved = { axis2Id: '', axis3Id: '' };
        for (const axis of [2, 3] as const) {
          const parentId = axis === 2 ? axis1Id : resolved.axis2Id;
          if (!parentId) break;
          try {
            const result = await lookup.mutateAsync({
              provider: 'eurecia',
              sheetId,
              navigationUrl,
              rowIndex: referenceRow.rowIndex,
              axis,
              selectedAxisIds: {
                axis1Id,
                axis2Id: resolved.axis2Id,
                axis3Id: '',
              },
            });
            if (requestGeneration !== axisGeneration.current) return;
            setPaletteAxis((current) => {
              const merged = new Map(
                [...current[axis], ...result.options].map((option) => [
                  option.id,
                  option,
                ]),
              );
              return { ...current, [axis]: [...merged.values()] };
            });
            const onlyOption =
              result.options.length === 1 ? result.options[0].id : '';
            const chosen = onlyOption || result.selectedId || '';
            console.info('[eurecia] pinned sub-axis resolved', {
              axis,
              optionCount: result.options.length,
              adopted: chosen ? 'yes' : 'no',
            });
            if (axis === 2) resolved.axis2Id = chosen;
            else resolved.axis3Id = chosen;
          } catch (error) {
            if (requestGeneration !== axisGeneration.current) return;
            console.warn('[eurecia] pinned sub-axis lookup failed', {
              axis,
              message: getErrorMessage(error),
            });
            break;
          }
        }
        setPinnedSubAxes((current) => ({ ...current, [axis1Id]: resolved }));
        // Adopting sub-axes changes the assignment key, so a project armed
        // before the lookup returned must follow it.
        const previousKey = getAssignmentKey({
          axis1Id,
          axis2Id: '',
          axis3Id: '',
        });
        const nextKey = getAssignmentKey({ axis1Id, ...resolved });
        setArmedKey((current) => (current === previousKey ? nextKey : current));
      }
    })();
  }, [
    addedProjectIds,
    initializationIdentity,
    isSelectedSheetDraft,
    ledgerIdentity,
    settledEditorData,
    stage,
  ]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const showsEditorStage =
    auth.data?.configured === true &&
    auth.data.authenticated &&
    stage !== 'sheet';

  useEffect(() => {
    if (!isOpen) {
      attemptedAutoLogin.current = false;
      return;
    }
    if (
      attemptedAutoLogin.current ||
      auth.isLoading ||
      !auth.data?.configured ||
      auth.data.authenticated ||
      login.isPending
    ) {
      return;
    }
    attemptedAutoLogin.current = true;
    login.mutate('eurecia');
  }, [auth.data, auth.isLoading, isOpen, login]);

  function resetAxisLookupState(sheetIdentity: string | null) {
    axisGeneration.current += 1;
    activeSheetIdentity.current = sheetIdentity;
    axisLookupScheduler.current.clear(
      new Error('Axis lookup was cancelled because sheet changed.'),
    );
    requestSequences.current.clear();
    pendingLookupTokens.current.clear();
    axisLookupCache.current.clear();
    attemptedAxisLoads.current.clear();
    setPaletteAxis({ 1: [], 2: [], 3: [] });
    setPaletteAxisError('');
    setPendingLookups(0);
    setPendingDeletions([]);
    setSelectedRemoteRow(null);
    setAxisOptions([]);
    setAxisErrors({});
    setSelectedEntryIndex(null);
  }

  function isStagedForDeletion(row: TimesheetRemoteRow) {
    return pendingDeletions.some(
      (deletion) =>
        deletion.rowIndex === row.rowIndex && deletion.date === row.date,
    );
  }

  function deletionOf(row: TimesheetRemoteRow): TimesheetRowDeletion {
    return {
      date: row.date,
      rowIndex: row.rowIndex,
      fraction: row.fraction,
      axis1Id: row.axis1Id,
      axis2Id: row.axis2Id,
      axis3Id: row.axis3Id,
      comment: row.comment,
    };
  }

  /**
   * Editing a declared row stages its removal and adds an editable copy. The
   * copy keeps a `replaces` marker, so the save can rewrite the row in place
   * instead of deleting and recreating it.
   */
  function editRemoteRow(row: TimesheetRemoteRow) {
    if (isStagedForDeletion(row)) return;
    const nextEntries: InitializedTimesheetEntry[] = [
      ...entries,
      {
        date: row.date,
        sourceDraftIds: [],
        sourceDescription: 'Replaces a saved Eurecia row',
        items: [],
        fraction: row.fraction === 0 ? 0.25 : row.fraction,
        comment: row.comment,
        axis1Id: row.axis1Id,
        axis2Id: row.axis2Id,
        axis3Id: row.axis3Id,
        replaces: deletionOf(row),
      },
    ];
    const nextDeletions = [...pendingDeletions, deletionOf(row)];
    setPendingDeletions(nextDeletions);
    setEntries(nextEntries);
    setSelectedRemoteRow(null);
    setSelectedEntryIndex(nextEntries.length - 1);
    resetSaveState();
  }

  const selectEntry = useCallback((index: number | null) => {
    setSelectedRemoteRow(null);
    setSelectedEntryIndex(index);
  }, []);

  function entryInputs(value: InitializedTimesheetEntry[]) {
    return value.map(
      ({
        sourceDescription: _sourceDescription,
        replaces: _replaces,
        ...entry
      }) => entry,
    );
  }

  /** Any ledger edit drops the previous save receipt and backend error. */
  function resetSaveState() {
    resetSave();
  }

  function selectSheet(sheetId: string) {
    const nextSheet = resolveSelectedSheet(sheets.data, sheetId);
    if (!nextSheet || sheetId === selectedSheetId) return;
    resetAxisLookupState(getSheetIdentity(nextSheet));
    initializationKey.current = '';
    setLedgerIdentity('');
    setEntries([]);
    setBlockedDates([]);
    setArmedKey(null);
    setWeekIndex(0);
    resetSaveState();
    setSelectedSheetId(sheetId);
  }

  /* eslint-disable react/react-compiler, react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!isOpen || selectedSheetId || !sheets.data?.length) return;

    const matchingSheet = sheets.data.find((sheet) => overlapsRange(sheet, range));
    if (matchingSheet) {
      selectSheet(matchingSheet.id);
      setStage('editor');
    }
  }, [isOpen, range, selectedSheetId, sheets.data]);
  /* eslint-enable react/react-compiler, react-hooks/exhaustive-deps */

  function referenceRowIndex(entry: InitializedTimesheetEntry) {
    if (entry.rowIndex !== undefined) return entry.rowIndex;
    return settledEditorData?.rows
      .filter(({ date, occupied }) => date === entry.date && !occupied)
      .sort((left, right) => left.rowIndex - right.rowIndex)[0]?.rowIndex;
  }

  function currentSelectedSheetIdentity() {
    const currentSheets = queryClient.getQueryData<TimesheetSheetSummary[]>([
      'timesheets',
      'eurecia',
      'sheets',
    ]);
    return getSheetIdentity(resolveSelectedSheet(currentSheets, selectedSheetId));
  }

  async function loadAxisOptions(
    entryIndex: number,
    axis: TimesheetAxisIndex,
    selectedAxisIds: TimesheetAxisSelection,
  ): Promise<TimesheetAxisLookupResult | null> {
    if (
      !selectedSheet ||
      !inspectionReady ||
      ledgerIdentity !== initializationIdentity
    ) {
      return null;
    }
    const entry = entries[entryIndex];
    if (!entry) return null;
    const rowIndex = referenceRowIndex(entry);
    if (rowIndex === undefined) return null;

    const requestGeneration = axisGeneration.current;
    const requestEditorUpdatedAt = editor.dataUpdatedAt;
    const requestSheetIdentity = getSheetIdentity(selectedSheet);
    if (!requestSheetIdentity) return null;
    const requestKey = `${entryIndex}:${axis}`;
    const sequence = (requestSequences.current.get(requestKey) ?? 0) + 1;
    requestSequences.current.set(requestKey, sequence);
    const pendingToken = `${requestGeneration}:${requestKey}:${sequence}`;
    pendingLookupTokens.current.add(pendingToken);
    setPendingLookups(pendingLookupTokens.current.size);
    setAxisErrors((current) => {
      const next = { ...current };
      delete next[requestKey];
      return next;
    });
    try {
      const cacheKey = getAxisLookupCacheKey({
        generation: requestGeneration,
        rowIndex,
        axis,
        selectedAxisIds,
      });
      let request = axisLookupCache.current.get(cacheKey);
      if (!request) {
        const newRequest = axisLookupScheduler.current.run(() => {
          const editorState = queryClient.getQueryState(
            timesheetSheetQueryKey({
              provider: 'eurecia',
              sheetId: selectedSheet.id,
              navigationUrl: selectedSheet.navigationUrl,
            }),
          );
          if (
            requestGeneration !== axisGeneration.current ||
            requestSheetIdentity !== currentSelectedSheetIdentity() ||
            editorState?.status !== 'success' ||
            editorState.fetchStatus === 'fetching' ||
            editorState.dataUpdatedAt !== requestEditorUpdatedAt
          ) {
            throw new Error(
              'Axis lookup was cancelled because sheet inspection changed.',
            );
          }
          return lookup.mutateAsync({
            provider: 'eurecia',
            sheetId: selectedSheet.id,
            navigationUrl: selectedSheet.navigationUrl,
            rowIndex,
            axis,
            selectedAxisIds,
          });
        });
        request = newRequest;
        axisLookupCache.current.set(cacheKey, newRequest);
        void newRequest.catch(() => {
          if (axisLookupCache.current.get(cacheKey) === newRequest) {
            axisLookupCache.current.delete(cacheKey);
          }
        });
      }
      const result = await request;
      if (
        !isAxisLookupRequestCurrent({
          requestGeneration,
          currentGeneration: axisGeneration.current,
          requestSheetIdentity,
          currentSheetIdentity: currentSelectedSheetIdentity(),
          requestSequence: sequence,
          currentSequence: requestSequences.current.get(requestKey),
        })
      ) {
        return null;
      }
      console.info('[eurecia] axis lookup ok', {
        entryIndex,
        axis,
        rowIndex,
        count: result.options.length,
      });
      setAxisOptions((current) => {
        const next = [...current];
        next[entryIndex] = {
          ...(next[entryIndex] ?? { 1: [], 2: [], 3: [] }),
          [axis]: [...result.options],
        };
        return next;
      });
      return result;
    } catch (error) {
      if (
        !isAxisLookupRequestCurrent({
          requestGeneration,
          currentGeneration: axisGeneration.current,
          requestSheetIdentity,
          currentSheetIdentity: currentSelectedSheetIdentity(),
          requestSequence: sequence,
          currentSequence: requestSequences.current.get(requestKey),
        })
      ) {
          return null;
        }
      console.warn('[eurecia] axis lookup failed', {
        entryIndex,
        axis,
        rowIndex,
        selectedAxisIds,
        message: getErrorMessage(error),
      });
      setAxisErrors((current) => ({
        ...current,
        [requestKey]: getErrorMessage(error),
      }));
      return null;
    } finally {
      if (
        requestGeneration === axisGeneration.current &&
        requestSheetIdentity === currentSelectedSheetIdentity()
      ) {
        pendingLookupTokens.current.delete(pendingToken);
        setPendingLookups(pendingLookupTokens.current.size);
      }
    }
  }

  useEffect(
    () => () => {
      // Active IPC cannot be cancelled, but generation guards prevent all writes.
      axisGeneration.current += 1;
      axisLookupScheduler.current.clear(
        new Error('Axis lookup was cancelled because dialog closed.'),
      );
      requestSequences.current.clear();
      pendingLookupTokens.current.clear();
      axisLookupCache.current.clear();
    },
    [axisLookupScheduler],
  );

  // A refresh can remove a selected sheet or replace its navigation identity.
  /* eslint-disable react/react-compiler, react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!sheets.data || !selectedSheetId) return;
    if (!selectedSheet) {
      resetAxisLookupState(null);
      initializationKey.current = '';
      setLedgerIdentity('');
      setEntries([]);
      setBlockedDates([]);
      resetSaveState();
      setSelectedSheetId(null);
      return;
    }
    if (
      hasSheetIdentityChanged(
        activeSheetIdentity.current,
        selectedSheetIdentity,
      )
    ) {
      resetAxisLookupState(selectedSheetIdentity);
      initializationKey.current = '';
      setLedgerIdentity('');
      setEntries([]);
      setBlockedDates([]);
      resetSaveState();
      setStage('sheet');
    }
  }, [selectedSheet, selectedSheetId, selectedSheetIdentity, sheets.data]);
  /* eslint-enable react/react-compiler, react-hooks/exhaustive-deps */

  // Initialize only from matching, successfully settled inspection and draft results.
  /* eslint-disable react/react-compiler, react-hooks/exhaustive-deps */
  useEffect(() => {
    if (
      !inspectionReady ||
      !editor.data ||
      !draft.data ||
      !selectedSheet ||
      !initializationIdentity ||
      stage === 'sheet'
    ) {
      return;
    }
    if (initializationKey.current === initializationIdentity) return;
    initializationKey.current = initializationIdentity;
    console.info('[eurecia] sheet inspected', {
      sheetId: selectedSheet.id,
      status: selectedSheet.status,
      range: [selectedSheet.start, selectedSheet.end],
      axisLabels: editor.data.axisLabels,
      rowCount: editor.data.rows.length,
      freeRowCount: editor.data.rows.filter((row) => !row.occupied).length,
    });
    resetAxisLookupState(getSheetIdentity(selectedSheet));
    // Submitted sheets are read-only, so seeded drafts could never be painted
    // or saved: they would only render as phantom unassigned rows.
    const sheetDrafts = isSelectedSheetDraft
      ? draft.data.entries.filter(
          ({ date }) => date >= selectedSheet.start && date <= selectedSheet.end,
        )
      : [];
    const skippedDraftCount = isSelectedSheetDraft
      ? draft.data.entries.length - sheetDrafts.length
      : 0;
    if (skippedDraftCount > 0) {
      console.info('[eurecia] draft entries outside sheet range ignored', {
        skippedDraftCount,
        sheetRange: [selectedSheet.start, selectedSheet.end],
      });
    }
    setOutOfRangeDraftCount(skippedDraftCount);
    const initialized = initializeTimesheetEntries(sheetDrafts, editor.data.rows);
    setEntries(initialized.entries);
    setLedgerIdentity(initializationIdentity);
    setBlockedDates(initialized.blockedDates);
    setFullyDeclaredDates(initialized.fullyDeclaredDates);
    setAxisOptions(
      initialized.entries.map(() => ({ 1: [], 2: [], 3: [] })),
    );
    setAxisErrors({});
    resetSaveState();
  }, [
    draft.data,
    editor.data,
    initializationIdentity,
    inspectionReady,
    selectedSheet,
    stage,
  ]);
  /* eslint-enable react/react-compiler, react-hooks/exhaustive-deps */

  async function autoSelectSingleActivity(
    index: number,
    entry: InitializedTimesheetEntry,
  ) {
    const result = await loadAxisOptions(index, 2, {
      axis1Id: entry.axis1Id,
      axis2Id: '',
      axis3Id: '',
    });
    console.info('[eurecia] activity auto-select', {
      index,
      axis1Id: entry.axis1Id,
      optionCount: result?.options.length ?? null,
      applied: result?.options.length === 1,
    });
    if (!result || result.options.length !== 1) return;
    const [activity] = result.options;
    setEntries((current) => {
      const currentEntry = current[index];
      if (!currentEntry || currentEntry.axis1Id !== entry.axis1Id || currentEntry.axis2Id) {
        return current;
      }
      const nextEntries = current.map((value, entryIndex) =>
        entryIndex === index
          ? { ...value, axis2Id: activity.id, axis3Id: '' }
          : value,
      );
      resetSaveState();
      return nextEntries;
    });
    void loadAxisOptions(index, 3, {
      axis1Id: entry.axis1Id,
      axis2Id: activity.id,
      axis3Id: '',
    });
  }

  const entriesAxisSignature = entries
    .map((entry) => `${entry.axis1Id}|${entry.axis2Id}`)
    .join(',');

  useEffect(() => {
    if (
      !inspectionReady ||
      ledgerIdentity !== initializationIdentity ||
      !editor.data ||
      !draft.data ||
      !isSelectedSheetDraft ||
      entries.length === 0
    ) {
      return;
    }
    entries.forEach((entry, index) => {
      if (referenceRowIndex(entry) === undefined) {
        console.warn('[eurecia] no reference row for entry, axis lookups skipped', {
          index,
          date: entry.date,
          rowIndex: entry.rowIndex,
        });
        return;
      }
      const selectedAxisIds = {
        axis1Id: entry.axis1Id,
        axis2Id: entry.axis2Id,
        axis3Id: entry.axis3Id,
      };
      const load = (axis: TimesheetAxisIndex, run?: () => void) => {
        if (axisOptions[index]?.[axis].length) return;
        const token = getAxisLookupCacheKey({
          generation: axisGeneration.current,
          rowIndex: index,
          axis,
          selectedAxisIds,
        });
        if (attemptedAxisLoads.current.has(token)) return;
        attemptedAxisLoads.current.add(token);
        if (run) run();
        else void loadAxisOptions(index, axis, selectedAxisIds);
      };
      load(1);
      // A project without an activity always re-runs resolution, even when this
      // row's activity options are already cached, so the single-option case is
      // auto-selected however the project got set (paint, palette, rail pick).
      if (entry.axis1Id && !entry.axis2Id) {
        const token = getAxisLookupCacheKey({
          generation: axisGeneration.current,
          rowIndex: index,
          axis: 2,
          selectedAxisIds,
        });
        if (!attemptedAxisLoads.current.has(token)) {
          attemptedAxisLoads.current.add(token);
          void autoSelectSingleActivity(index, entry);
        }
      } else if (entry.axis1Id) {
        load(2);
      }
      if (entry.axis2Id) load(3);
    });
    // Initialization and sheet changes are only triggers; request guards handle cascades.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draft.dataUpdatedAt,
    editor.data,
    editor.dataUpdatedAt,
    entriesAxisSignature,
    entries.length,
    initializationIdentity,
    inspectionReady,
    ledgerIdentity,
  ]);

  function commitEntries(nextEntries: InitializedTimesheetEntry[]) {
    setEntries(nextEntries);
    setAxisOptions((current) =>
      nextEntries.map((_, index) => current[index] ?? { 1: [], 2: [], 3: [] }),
    );
    resetSaveState();
  }

  /**
   * Slot layout of a day, in the same order the grid renders it: saved rows
   * first, then draft entries. Used to resolve which block a painted slot hits.
   */
  function dayOccupants(date: string) {
    return getDaySlotOccupants({
      // Rows staged for deletion are already gone from the grid, so they must
      // not shift the drafts that took their place.
      remoteRows: occupiedRows.filter(
        (row) =>
          row.date === date &&
          (row.occupied || isTimesheetRemoteRowOccupied(row)) &&
          !isStagedForDeletion(row),
      ),
      entries: entries.flatMap((entry, index) =>
        entry.date === date ? [{ index, fraction: entry.fraction }] : [],
      ),
    });
  }

  function takeTemplateRow(date: string, taken: Set<number>) {
    const row = settledEditorData?.rows
      .filter((candidate) => candidate.date === date && !candidate.occupied)
      .sort((left, right) => left.rowIndex - right.rowIndex)
      .find((candidate) => !taken.has(candidate.rowIndex));
    if (!row) {
      console.warn('[eurecia] no free template row for painted date', {
        date,
        takenRowIndices: [...taken],
      });
      return {};
    }
    taken.add(row.rowIndex);
    return { rowIndex: row.rowIndex };
  }

  /**
   * Paints an explicit slot range, overriding whatever already occupies it.
   * A saved row is staged for deletion and the parts left outside the painted
   * range come back as editable draft copies, so half-day rows can be
   * overridden one cell at a time. Every painted day is rebuilt from the
   * resolved pieces so draft order keeps matching the slots on screen, and each
   * draft's cached axis options travel with it.
   */
  function paintOverSlots(
    paints: Array<{ date: string; startSlot: number; slots: number }>,
    selection: TimesheetAxisSelection,
  ) {
    if (!settledEditorData) return;
    // The grid emits at most one range per day, so a later paint never has to
    // observe an earlier one on the same date.
    const paintByDate = new Map(
      paints.map(({ date, startSlot, slots }) => [date, { startSlot, slots }]),
    );
    const emptyAxisOptions = (): Record<
      TimesheetAxisIndex,
      TimesheetAxisOption[]
    > => ({ 1: [], 2: [], 3: [] });

    const nextEntries: InitializedTimesheetEntry[] = [];
    const nextAxisOptions: Array<
      Record<TimesheetAxisIndex, TimesheetAxisOption[]>
    > = [];
    const nextDeletions = [...pendingDeletions];
    let paintedIndex: number | null = null;

    // Days nobody painted keep their drafts, and their cached axis options, in
    // place.
    entries.forEach((entry, index) => {
      if (paintByDate.has(entry.date)) return;
      nextEntries.push(entry);
      nextAxisOptions.push(axisOptions[index] ?? emptyAxisOptions());
    });

    for (const [date, { startSlot, slots }] of paintByDate) {
      const plan = planSlotPaint({
        occupants: dayOccupants(date),
        startSlot,
        slots,
      });
      for (const row of plan.deletedRows) {
        const staged = nextDeletions.some(
          (deletion) =>
            deletion.rowIndex === row.rowIndex && deletion.date === row.date,
        );
        if (!staged) nextDeletions.push(deletionOf(row));
      }
      // A draft split in two reuses its row on the first half only; the second
      // half is a fresh draft that needs its own row.
      const reusedEntryIndices = new Set<number>();
      for (const piece of plan.pieces) {
        const fraction = slotsToFraction(piece.slots);
        if (!fraction) continue;
        if (piece.source.kind === 'entry') {
          const { index } = piece.source;
          const base = entries[index];
          if (!base) continue;
          const isSplitTail = reusedEntryIndices.has(index);
          reusedEntryIndices.add(index);
          nextEntries.push(
            isSplitTail
              ? { ...base, fraction, rowIndex: undefined }
              : { ...base, fraction },
          );
          nextAxisOptions.push(axisOptions[index] ?? emptyAxisOptions());
          continue;
        }
        if (piece.source.kind === 'remote') {
          const { row } = piece.source;
          nextEntries.push({
            date,
            sourceDraftIds: [],
            sourceDescription: 'Kept part of a saved Eurecia row',
            items: [],
            fraction,
            comment: row.comment,
            axis1Id: row.axis1Id,
            axis2Id: row.axis2Id,
            axis3Id: row.axis3Id,
            replaces: deletionOf(row),
          });
          nextAxisOptions.push(emptyAxisOptions());
          continue;
        }
        paintedIndex = nextEntries.length;
        nextEntries.push({
          date,
          sourceDraftIds: [],
          sourceDescription: 'Manual Eurecia entry',
          items: [],
          fraction,
          comment: '',
          axis1Id: selection.axis1Id,
          axis2Id: selection.axis2Id,
          axis3Id: selection.axis3Id || defaultRoleId,
        });
        nextAxisOptions.push(emptyAxisOptions());
      }
    }

    // Rows freed by this paint are available again, so seed from what survived.
    const taken = new Set(
      nextEntries
        .map((entry) => entry.rowIndex)
        .filter((rowIndex): rowIndex is number => rowIndex !== undefined),
    );
    const withRows = nextEntries.map((entry) =>
      entry.rowIndex === undefined
        ? { ...entry, ...takeTemplateRow(entry.date, taken) }
        : entry,
    );

    setEntries(withRows);
    setPendingDeletions(nextDeletions);
    setAxisOptions(nextAxisOptions);
    setSelectedRemoteRow(null);
    setSelectedEntryIndex(paintedIndex);
    resetSaveState();
  }

  /** Adds entries for painted slots, reusing the sheet's free row templates. */
  function paintEntries(
    paints: Array<{ date: string; slots: number; startSlot?: number }>,
    selection: TimesheetAxisSelection,
  ) {
    if (!settledEditorData) return;
    if (paints.every((paint) => paint.startSlot !== undefined)) {
      paintOverSlots(
        paints as Array<{ date: string; startSlot: number; slots: number }>,
        selection,
      );
      return;
    }
    const usedRowIndices = new Set(
      entries
        .map((entry) => entry.rowIndex)
        .filter((rowIndex): rowIndex is number => rowIndex !== undefined),
    );
    const totals = new Map(dailyTotals);
    const nextEntries = [...entries];
    for (const { date, slots } of paints) {
      const remaining = 1 - (totals.get(date) ?? 0);
      const fraction = slotsToFraction(
        Math.min(slots, fractionToSlots(Math.max(0, remaining))),
      );
      if (!fraction) continue;
      // Rows staged for deletion are deliberately not reused here: the slot only
      // exists after the save applies the deletion, so the entry stays inferred.
      const templateRow = settledEditorData.rows
        .filter((row) => row.date === date && !row.occupied)
        .sort((left, right) => left.rowIndex - right.rowIndex)
        .find((row) => !usedRowIndices.has(row.rowIndex));
      if (templateRow) usedRowIndices.add(templateRow.rowIndex);
      else {
        console.warn('[eurecia] no free template row for painted date', {
          date,
          candidateDates: [
            ...new Set(settledEditorData.rows.map((row) => row.date)),
          ],
          takenRowIndices: [...usedRowIndices],
        });
      }
      totals.set(date, (totals.get(date) ?? 0) + fraction);
      nextEntries.push({
        date,
        ...(templateRow ? { rowIndex: templateRow.rowIndex } : {}),
        sourceDraftIds: [],
        sourceDescription: 'Manual Eurecia entry',
        items: [],
        fraction,
        comment: '',
        axis1Id: selection.axis1Id,
        axis2Id: selection.axis2Id,
        axis3Id: selection.axis3Id || defaultRoleId,
      });
    }
    if (nextEntries.length === entries.length) return;
    commitEntries(nextEntries);
    setSelectedEntryIndex(nextEntries.length - 1);
  }

  function clearDates(dates: string[]) {
    const removed = new Set(dates);
    commitEntries(entries.filter((entry) => !removed.has(entry.date)));
    setSelectedEntryIndex(null);
  }

  /** Copies a day's entries onto every other day of the same displayed week. */
  function spreadDay(sourceDate: string, weekDates: string[]) {
    const source = entries.filter((entry) => entry.date === sourceDate);
    if (source.length === 0) return;
    const targets = weekDates.filter((date) => date !== sourceDate);
    const kept = entries.filter((entry) => !targets.includes(entry.date));
    const cloned = targets.flatMap((date) =>
      source.map(({ rowIndex: _rowIndex, ...entry }) => ({ ...entry, date })),
    );
    commitEntries([...kept, ...cloned]);
    setSelectedEntryIndex(null);
  }

  function updateEntry(
    index: number,
    values: Partial<Pick<TimesheetEntryInput, 'fraction' | 'comment' | 'axis1Id' | 'axis2Id' | 'axis3Id'>>,
  ) {
    const currentEntry = entries[index];
    if (!currentEntry) return;
    const nextEntry = { ...currentEntry, ...values };
    if ('axis1Id' in values) {
      nextEntry.axis2Id = '';
      nextEntry.axis3Id = '';
    } else if ('axis2Id' in values) {
      nextEntry.axis3Id = '';
    }
    const nextEntries = entries.map((entry, entryIndex) =>
      entryIndex === index ? nextEntry : entry,
    );
    setEntries(nextEntries);
    if ('axis1Id' in values || 'axis2Id' in values) {
      setAxisOptions((current) => {
        const next = [...current];
        next[index] = {
          ...(next[index] ?? { 1: [], 2: [], 3: [] }),
          ...(values.axis1Id !== undefined ? { 2: [], 3: [] } : { 3: [] }),
        };
        return next;
      });
    }
    resetSaveState();
    if (values.axis1Id !== undefined && nextEntry.axis1Id) {
      void autoSelectSingleActivity(index, nextEntry);
    } else if (values.axis2Id !== undefined && nextEntry.axis2Id) {
      void loadAxisOptions(index, 3, {
        axis1Id: nextEntry.axis1Id,
        axis2Id: nextEntry.axis2Id,
        axis3Id: nextEntry.axis3Id,
      });
    }
  }

  function removeEntry(index: number) {
    if (!entries[index]) return;
    const nextEntries = entries.filter((_, entryIndex) => entryIndex !== index);
    setEntries(nextEntries);
    setAxisOptions((current) => current.filter((_, entryIndex) => entryIndex !== index));
    setSelectedEntryIndex((current) =>
      current === null || current === index
        ? null
        : current > index
          ? current - 1
          : current,
    );
    resetSaveState();
  }

  async function commitSave(action: TimesheetAction = 'save') {
    if (!selectedSheet || save.isPending) return;
    if (action === 'save' ? !canSave : !canSubmit) return;
    // Rewritten rows are updated in place, so their staged deletion is dropped.
    const staged = splitStagedWrites({ entries, deletions: pendingDeletions });
    try {
      const result = await save.mutateAsync({
        provider: 'eurecia',
        sheetId: selectedSheet.id,
        entries: entryInputs(staged.entries),
        deletions: staged.deletions,
        updates: staged.updates,
        action,
      });
      const { entryCount, deletedRowCount, updatedRowCount } = result.summary;
      addToast({
        type: 'success',
        message: [
          action === 'submit-for-approval'
            ? `Submitted the sheet for approval${
                entryCount > 0
                  ? ` with ${entryCount} new ${entryCount === 1 ? 'entry' : 'entries'}`
                  : ''
              }`
            : `Saved ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} to Eurecia`,
          updatedRowCount > 0
            ? ` · ${updatedRowCount} ${updatedRowCount === 1 ? 'row' : 'rows'} updated`
            : '',
          deletedRowCount > 0
            ? ` · ${deletedRowCount} ${deletedRowCount === 1 ? 'row' : 'rows'} removed`
            : '',
        ].join(''),
      });
      // The overlay stays open: saving invalidates the sheet queries, so the
      // ledger re-inspects and the written rows come back as saved rows.
    } catch (error) {
      addToast({ type: 'error', message: getErrorMessage(error) });
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeSafely}
      closeOnClickOutside={!isPending}
      closeOnEscape={!isPending}
      title="Eurecia"
      ariaLabel="Prepare Eurecia timesheet"
      size="xl"
      overlayClassName="z-[10001] p-2 sm:p-5"
      panelClassName="h-[min(860px,calc(100vh-16px))] border border-line bg-[linear-gradient(180deg,oklch(0.17_0.012_275),oklch(0.125_0.01_275))] sm:h-[min(860px,calc(100vh-40px))]"
      contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      closeDisabled={isPending}
      closeDisabledReason={
        login.isPending
          ? 'Sign-in is in progress'
          : save.isPending
            ? 'Save is in progress'
            : undefined
      }
    >
      <div className="border-line-soft flex shrink-0 items-center gap-2.5 border-b px-3.5 py-2.5">
        <Clock className="text-status-azure h-4 w-4 shrink-0" />
        <span className="text-ink-0 text-sm font-semibold">Time tracking</span>
        <span className="text-ink-3 font-mono text-[11px]">Eurecia</span>
        {selectedSheet && stage !== 'sheet' ? (
          <span className="bg-status-run-soft text-status-run rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide uppercase">
            {selectedSheet.status}
          </span>
        ) : null}
      </div>

      <div
        className={clsx(
          'flex min-h-0 flex-1 flex-col',
          showsEditorStage
            ? ''
            : 'mx-auto w-full max-w-[1180px] overflow-y-auto p-4 sm:p-6',
        )}
      >
        {auth.isLoading ? (
          <div className="text-ink-3 flex min-h-60 items-center justify-center gap-2 text-sm" role="status" aria-live="polite">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking Eurecia configuration...
          </div>
        ) : auth.isError ? (
          <div className="mx-auto max-w-lg space-y-3 py-12">
            <StatusMessage tone="error" announce>{getErrorMessage(auth.error)}</StatusMessage>
            <button type="button" onClick={() => auth.refetch()} className="border-line text-ink-1 rounded-lg border px-3 py-2 text-sm">
              <RefreshCw className="mr-2 inline h-4 w-4" /> Retry
            </button>
          </div>
        ) : !auth.data?.configured ? (
          <div className="mx-auto max-w-xl py-12">
            <div className="text-status-warning mb-3 font-mono text-xs tracking-widest uppercase">Configuration required</div>
            <h3 className="text-ink-0 text-xl font-semibold">Connect Eurecia before building ledger.</h3>
            <p className="text-ink-3 mt-2 text-sm leading-relaxed">
              Open General Settings &gt; Eurecia and provide tenant configuration. Return here afterward; current Work Activity week remains unchanged.
            </p>
          </div>
        ) : !auth.data.authenticated ? (
          <div className="mx-auto max-w-xl py-12">
            <div className="text-status-azure mb-3 font-mono text-xs tracking-widest uppercase">Secure browser session</div>
            <h3 className="text-ink-0 text-xl font-semibold">Sign in to inspect timesheets.</h3>
            <p className="text-ink-3 mt-2 text-sm">Credentials stay inside Eurecia login window and never enter this draft.</p>
            {signInCancelled ? <div className="mt-4"><StatusMessage announce>You closed the sign-in window before signing in.</StatusMessage></div> : null}
            {login.isError && !signInCancelled ? <div className="mt-4"><StatusMessage tone="error" announce>{getErrorMessage(login.error)}</StatusMessage></div> : null}
            <button
              type="button"
              disabled={login.isPending}
              onClick={() => login.mutate('eurecia')}
              className="bg-status-azure text-bg-0 mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {login.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {login.isPending
                ? 'Signing in...'
                : login.isError && !signInCancelled
                  ? 'Retry sign in'
                  : 'Sign in to Eurecia'}
            </button>
          </div>
        ) : stage === 'sheet' ? (
          <SheetStage
            sheets={sheets.data ?? []}
            isLoading={sheets.isLoading}
            isFetching={sheets.isFetching}
            error={sheets.error}
            range={range}
            selectedSheetId={selectedSheet?.id ?? null}
            onSelect={(sheetId) => {
              selectSheet(sheetId);
              setStage('editor');
            }}
            onRetry={() => sheets.refetch()}
          />
        ) : (
          <EditorStage
            editor={editor}
            draft={draft}
            inspectionLoading={inspectionLoading}
            sheets={sheets.data ?? []}
            selectedSheet={selectedSheet}
            entries={entries}
            occupiedRows={occupiedRows}
            dailyTotals={dailyTotals}
            editable={isSelectedSheetDraft}
            outOfRangeDraftCount={outOfRangeDraftCount}
            fullyDeclaredDates={fullyDeclaredDates}
            workActivityRange={range}
            assignments={assignments}
            armedKey={armedKey}
            onArm={setArmedKey}
            weeks={weeks}
            weekIndex={weekIndex}
            onWeekIndexChange={setWeekIndex}
            selectedEntryIndex={selectedEntryIndex}
            onSelectEntry={selectEntry}
            selectedRemoteRow={selectedRemoteRow}
            pendingDeletions={pendingDeletions}
            onEditRemoteRow={editRemoteRow}
            onToggleRemoteRowDeletion={(row) => {
              setPendingDeletions((current) =>
                current.some(
                  (deletion) =>
                    deletion.rowIndex === row.rowIndex &&
                    deletion.date === row.date,
                )
                  ? current.filter(
                      (deletion) =>
                        !(
                          deletion.rowIndex === row.rowIndex &&
                          deletion.date === row.date
                        ),
                    )
                  : [
                      ...current,
                      {
                        date: row.date,
                        rowIndex: row.rowIndex,
                        fraction: row.fraction,
                        axis1Id: row.axis1Id,
                        axis2Id: row.axis2Id,
                        axis3Id: row.axis3Id,
                        comment: row.comment,
                      },
                    ],
              );
              resetSaveState();
            }}
            onSelectRemoteRow={(row) => {
              setSelectedEntryIndex(null);
              setSelectedRemoteRow((current) =>
                current?.rowIndex === row.rowIndex && current.date === row.date
                  ? null
                  : row,
              );
            }}
            paletteWidth={clampPaneWidth(paletteWidth)}
            onPaletteWidthChange={setPaletteWidth}
            railWidth={clampPaneWidth(railWidth)}
            onRailWidthChange={setRailWidth}
            projectOptions={projectOptions}
            roleOptions={roleOptions}
            paletteAxisError={paletteAxisError}
            defaultRoleId={defaultRoleId}
            onDefaultRoleChange={setDefaultRoleId}
            onAddProject={(axis1Id) => {
              setAddedProjectIds((current) =>
                current.includes(axis1Id) ? current : [...current, axis1Id],
              );
              setArmedKey(getAssignmentKey({ axis1Id, axis2Id: '', axis3Id: '' }));
            }}
            removableProjectIds={removableProjectIds}
            onRemoveProject={(axis1Id) => {
              setAddedProjectIds((current) =>
                current.filter((value) => value !== axis1Id),
              );
              setPinnedSubAxes((current) => {
                const { [axis1Id]: _removed, ...rest } = current;
                return rest;
              });
              setArmedKey((current) =>
                current &&
                assignments.some(
                  (assignment) =>
                    assignment.key === current &&
                    assignment.axis1Id === axis1Id,
                )
                  ? null
                  : current,
              );
            }}
            labelFor={labelFor}
            savePending={save.isPending}
            saveError={save.isError ? getErrorMessage(save.error) : ''}
            canSave={canSave}
            canSubmit={canSubmit}
            onBack={() => {
              setStage('sheet');
              initializationKey.current = '';
              setLedgerIdentity('');
              resetAxisLookupState(getSheetIdentity(selectedSheet));
              setEntries([]);
              setBlockedDates([]);
              setArmedKey(null);
              resetSaveState();
            }}
            onRetryInspect={() => {
              void editor.refetch();
              void draft.refetch();
            }}
            onSelectSheet={selectSheet}
            onSelectSheetEdge={(sheetId, edge) => {
              selectSheet(sheetId);
              // -1 is resolved to the last week of the freshly selected sheet.
              setWeekIndex(edge === 'last' ? -1 : 0);
            }}
            onPaint={paintEntries}
            onClearDates={clearDates}
            onSpreadDay={spreadDay}
            axisOptions={axisOptions}
            axisErrors={axisErrors}
            pendingLookups={pendingLookups}
            pooledAxisOptions={pooledAxisOptions}
            onUpdateEntry={updateEntry}
            onRemoveEntry={removeEntry}
            onSave={() => void commitSave('save')}
            onSubmitForApproval={() => void commitSave('submit-for-approval')}
          />
        )}
      </div>
    </Modal>
  );
}

function SheetStage({
  sheets,
  isLoading,
  isFetching,
  error,
  range,
  selectedSheetId,
  onSelect,
  onRetry,
}: {
  sheets: TimesheetSheetSummary[];
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  range: { start: string; end: string };
  selectedSheetId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  const orderedSheets = useMemo(
    () =>
      [...sheets].sort((left, right) => {
        const leftOverlaps = overlapsRange(left, range);
        const rightOverlaps = overlapsRange(right, range);
        if (leftOverlaps !== rightOverlaps) return leftOverlaps ? -1 : 1;
        return right.start.localeCompare(left.start);
      }),
    [range, sheets],
  );

  if (isLoading) return <div className="text-ink-3 py-16 text-center text-sm" role="status" aria-live="polite">Loading Eurecia sheets...</div>;
  if (error) return <div className="space-y-3"><StatusMessage tone="error" announce>{getErrorMessage(error)}</StatusMessage><button type="button" onClick={onRetry} className="border-line rounded-lg border px-3 py-2 text-sm">Retry</button></div>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-status-azure font-mono text-[11px] tracking-widest uppercase">Explicit target required</div>
          <h3 className="text-ink-0 mt-1 text-xl font-semibold">Select target sheet</h3>
          <p className="text-ink-3 mt-1 text-xs">Current Work Activity week: {formatDate(range.start.slice(0, 10))} - {formatInclusiveEnd(range.end)}</p>
        </div>
        <button type="button" disabled={isFetching} aria-busy={isFetching} onClick={onRetry} className="border-line text-ink-1 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40">
          {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isFetching ? 'Refreshing sheets...' : 'Refresh sheets'}
        </button>
      </div>
      {sheets.length === 0 ? <StatusMessage>No sheets returned by Eurecia.</StatusMessage> : (
        <fieldset className="border-line overflow-hidden rounded-lg border">
          <legend className="sr-only">Eurecia target sheet</legend>
          {orderedSheets.map((sheet) => {
            const overlaps = overlapsRange(sheet, range);
            return (
              <button key={sheet.id} type="button" onClick={() => onSelect(sheet.id)} className={clsx('border-line-soft flex w-full cursor-pointer items-start gap-3 border-b px-3 py-3 text-left last:border-b-0 hover:bg-white/[0.035]', selectedSheetId === sheet.id && 'bg-status-azure/5', overlaps && 'border-l-2 border-l-status-azure')}>
                <span className="min-w-0 flex-1">
                  <span className="text-ink-0 block truncate text-sm font-semibold">{sheet.description || 'Untitled sheet'}</span>
                  <span className="text-ink-3 mt-1 block font-mono text-[11px]">{formatDate(sheet.start)} - {formatDate(sheet.end)}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="border-line text-ink-2 rounded border px-2 py-0.5 font-mono text-[10px] uppercase">{sheet.status}</span>
                  {overlaps ? <span className="text-status-azure text-[10px] font-semibold uppercase">Overlaps week</span> : null}
                </span>
              </button>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}

function WeekRing({ value, max }: { value: number; max: number }) {
  const size = 32;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const percent = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-bg-3"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circumference * percent} ${circumference}`}
        className={percent >= 1 ? 'stroke-status-done' : 'stroke-status-run'}
      />
    </svg>
  );
}

function EditorStage({
  editor,
  draft,
  inspectionLoading,
  sheets,
  selectedSheet,
  entries,
  occupiedRows,
  dailyTotals,
  editable,
  outOfRangeDraftCount,
  fullyDeclaredDates,
  workActivityRange,
  assignments,
  armedKey,
  onArm,
  weeks,
  weekIndex,
  onWeekIndexChange,
  selectedEntryIndex,
  selectedRemoteRow,
  onSelectRemoteRow,
  pendingDeletions,
  onEditRemoteRow,
  onToggleRemoteRowDeletion,
  onSelectEntry,
  paletteWidth,
  onPaletteWidthChange,
  railWidth,
  onRailWidthChange,
  projectOptions,
  roleOptions,
  paletteAxisError,
  defaultRoleId,
  onDefaultRoleChange,
  onAddProject,
  onRemoveProject,
  removableProjectIds,
  labelFor,
  savePending,
  saveError,
  canSave,
  canSubmit,
  onBack,
  onRetryInspect,
  onSelectSheet,
  onSelectSheetEdge,
  onPaint,
  onClearDates,
  onSpreadDay,
  axisOptions,
  axisErrors,
  pendingLookups,
  pooledAxisOptions,
  onUpdateEntry,
  onRemoveEntry,
  onSave,
  onSubmitForApproval,
}: {
  editor: ReturnType<typeof useTimesheetSheet>;
  draft: ReturnType<typeof useTimesheetDraft>;
  inspectionLoading: boolean;
  sheets: TimesheetSheetSummary[];
  selectedSheet?: TimesheetSheetSummary;
  entries: InitializedTimesheetEntry[];
  occupiedRows: TimesheetRemoteRow[];
  dailyTotals: Map<string, number>;
  editable: boolean;
  outOfRangeDraftCount: number;
  fullyDeclaredDates: string[];
  workActivityRange: { start: string; end: string };
  assignments: TimesheetAssignment[];
  armedKey: string | null;
  onArm: (key: string | null) => void;
  weeks: Array<{ weekStart: string; dates: string[] }>;
  weekIndex: number;
  onWeekIndexChange: (index: number) => void;
  selectedEntryIndex: number | null;
  selectedRemoteRow: TimesheetRemoteRow | null;
  onSelectRemoteRow: (row: TimesheetRemoteRow) => void;
  pendingDeletions: TimesheetRowDeletion[];
  onEditRemoteRow: (row: TimesheetRemoteRow) => void;
  onToggleRemoteRowDeletion: (row: TimesheetRemoteRow) => void;
  onSelectEntry: (index: number | null) => void;
  paletteWidth: number;
  onPaletteWidthChange: (width: number) => void;
  railWidth: number;
  onRailWidthChange: (width: number) => void;
  projectOptions: Array<{ value: string; label: string }>;
  roleOptions: Array<{ value: string; label: string }>;
  paletteAxisError: string;
  defaultRoleId: string;
  onDefaultRoleChange: (axis3Id: string) => void;
  onAddProject: (axis1Id: string) => void;
  onRemoveProject: (axis1Id: string) => void;
  removableProjectIds: string[];
  labelFor: (axis: TimesheetAxisIndex, id: string) => string;
  savePending: boolean;
  saveError: string;
  canSave: boolean;
  canSubmit: boolean;
  onBack: () => void;
  onRetryInspect: () => void;
  onSelectSheet: (id: string) => void;
  onSelectSheetEdge: (id: string, edge: 'first' | 'last') => void;
  onPaint: (
    paints: Array<{ date: string; slots: number; startSlot?: number }>,
    selection: TimesheetAxisSelection,
  ) => void;
  onClearDates: (dates: string[]) => void;
  onSpreadDay: (date: string, weekDates: string[]) => void;
  axisOptions: Array<Record<TimesheetAxisIndex, TimesheetAxisOption[]>>;
  axisErrors: Record<string, string>;
  pendingLookups: number;
  pooledAxisOptions: Record<TimesheetAxisIndex, TimesheetAxisOption[]>;
  onUpdateEntry: (
    index: number,
    values: Partial<Pick<TimesheetEntryInput, 'fraction' | 'comment' | 'axis1Id' | 'axis2Id' | 'axis3Id'>>,
  ) => void;
  onRemoveEntry: (index: number) => void;
  onSave: () => void;
  onSubmitForApproval: () => void;
}) {
  const lastWeekIndex = Math.max(0, weeks.length - 1);
  const resolvedWeekIndex =
    weekIndex < 0 ? lastWeekIndex : Math.min(weekIndex, lastWeekIndex);
  const activeWeek = weeks[resolvedWeekIndex];
  const weekDates = useMemo(() => activeWeek?.dates ?? [], [activeWeek]);

  // null = no confirmation open; otherwise the action awaiting confirmation.
  const [confirmingSave, setConfirmingSave] = useState<TimesheetAction | null>(
    null,
  );
  const editorRef = useRef<HTMLDivElement | null>(null);

  const armedSelection = useMemo<TimesheetAxisSelection | null>(() => {
    if (!editable || !armedKey) return null;
    const assignment = assignments.find(({ key }) => key === armedKey);
    if (!assignment) return null;
    return {
      axis1Id: assignment.axis1Id,
      axis2Id: assignment.axis2Id,
      axis3Id: assignment.axis3Id,
    };
  }, [armedKey, assignments, editable]);

  // Kept out of the editing shortcuts below so it also fires from a comment
  // field, and so it stays available while the sheet is read-only.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== 'Enter' ||
        !(event.metaKey || event.ctrlKey) ||
        confirmingSave ||
        savePending ||
        !canSave
      ) {
        return;
      }
      event.preventDefault();
      setConfirmingSave('save');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSave, confirmingSave, savePending]);

  // Escape unwinds the editor one step at a time: it first disarms the picked
  // assignment, then drops the selection, and only then reaches the Modal that
  // closes the overlay. Capture phase, so the Modal never sees a handled key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirmingSave) return;
      if (armedKey) {
        event.preventDefault();
        event.stopPropagation();
        onArm(null);
        return;
      }
      if (selectedEntryIndex !== null || selectedRemoteRow) {
        event.preventDefault();
        event.stopPropagation();
        onSelectEntry(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [
    armedKey,
    confirmingSave,
    onArm,
    onSelectEntry,
    selectedEntryIndex,
    selectedRemoteRow,
  ]);

  useEffect(() => {
    if (!editable) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      ) {
        return;
      }
      const slot = Number(event.key);
      if (Number.isInteger(slot) && slot >= 1 && slot <= 9) {
        const assignment = assignments[slot - 1];
        if (assignment) onArm(assignment.key);
        return;
      }
      if (
        (event.key === 'Backspace' || event.key === 'Delete') &&
        selectedEntryIndex !== null
      ) {
        event.preventDefault();
        onRemoveEntry(selectedEntryIndex);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    assignments,
    editable,
    onArm,
    onRemoveEntry,
    onSelectEntry,
    selectedEntryIndex,
  ]);

  if (!selectedSheet) {
    return (
      <div className="space-y-3 p-6">
        <StatusMessage tone="error" announce>
          Selected sheet is no longer available in current Eurecia results.
        </StatusMessage>
        <button
          type="button"
          onClick={onBack}
          disabled={savePending}
          className="border-line text-ink-1 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <ArrowLeft className="h-4 w-4" /> Select another sheet
        </button>
      </div>
    );
  }
  if (inspectionLoading) {
    return (
      <div className="text-ink-3 flex min-h-60 flex-1 items-center justify-center gap-2 text-sm" role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin" /> Inspecting sheet and building draft...
      </div>
    );
  }
  if (editor.isError || draft.isError) {
    return (
      <div className="space-y-3 p-6">
        <StatusMessage tone="error" announce>{getErrorMessage(editor.error ?? draft.error)}</StatusMessage>
        <button type="button" onClick={onRetryInspect} className="border-line rounded-lg border px-3 py-2 text-sm">Retry inspection</button>
      </div>
    );
  }
  if (!editor.data) {
    return (
      <div className="p-6">
        <StatusMessage tone="error" announce>
          Sheet inspection is unavailable. Return to sheet selection and retry.
        </StatusMessage>
      </div>
    );
  }

  const orderedSheets = [...sheets].sort((left, right) => left.start.localeCompare(right.start));
  const sheetPosition = orderedSheets.findIndex(({ id }) => id === selectedSheet.id);
  const previousSheet =
    sheetPosition > 0 ? orderedSheets[sheetPosition - 1] : undefined;
  const nextSheet =
    sheetPosition >= 0 ? orderedSheets[sheetPosition + 1] : undefined;
  const canGoPreviousWeek = resolvedWeekIndex > 0 || Boolean(previousSheet);
  const canGoNextWeek = resolvedWeekIndex < weeks.length - 1 || Boolean(nextSheet);
  const weekEntries: WeekGridEntry[] = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => weekDates.includes(entry.date));
  const entriesByDate = new Map<string, WeekGridEntry[]>();
  for (const item of weekEntries) {
    entriesByDate.set(item.entry.date, [
      ...(entriesByDate.get(item.entry.date) ?? []),
      item,
    ]);
  }
  const remoteByDate = new Map<string, TimesheetRemoteRow[]>();
  for (const row of occupiedRows) {
    if (!weekDates.includes(row.date)) continue;
    if (!row.occupied && !isTimesheetRemoteRowOccupied(row)) continue;
    // A row staged for deletion leaves the grid right away: its slots are free
    // and any replacement draft already sits in its place.
    const staged = pendingDeletions.some(
      (deletion) =>
        deletion.rowIndex === row.rowIndex && deletion.date === row.date,
    );
    if (staged) continue;
    remoteByDate.set(row.date, [...(remoteByDate.get(row.date) ?? []), row]);
  }
  for (const rows of remoteByDate.values()) {
    rows.sort((left, right) => left.rowIndex - right.rowIndex);
  }

  const weekUsage = new Map<string, number>();
  for (const { entry } of weekEntries) {
    const key = getAssignmentKey(entry);
    weekUsage.set(key, (weekUsage.get(key) ?? 0) + entry.fraction);
  }
  const weekTotal = weekDates.reduce(
    (total, date) => total + (dailyTotals.get(date) ?? 0),
    0,
  );
  const weekTarget = weekDates.length;
  const issues = weekDates
    .map((date) => ({ date, total: dailyTotals.get(date) ?? 0 }))
    .filter(({ total }) => total < 1)
    .map(({ date, total }) => ({
      date,
      label: formatDate(date),
      detail: total === 0 ? 'empty' : `${formatDayCount(1 - total)} missing`,
    }));

  const selectedEntry =
    selectedEntryIndex !== null ? entries[selectedEntryIndex] : undefined;
  const selectedMaxFraction = selectedEntry
    ? Math.min(
        1,
        1 - ((dailyTotals.get(selectedEntry.date) ?? 0) - selectedEntry.fraction),
      )
    : 1;
  const armedColor = armedSelection
    ? getAssignmentColor(armedSelection.axis1Id || 'unassigned')
    : null;
  const previousWeekDates = weeks[resolvedWeekIndex - 1]?.dates ?? [];

  return (
    <div
      ref={editorRef}
      className={clsx(
        'relative flex min-h-0 flex-1 flex-col',
        savePending && 'cursor-wait',
      )}
      style={
        {
          '--eurecia-palette-w': `${paletteWidth}px`,
          '--eurecia-rail-w': `${railWidth}px`,
        } as React.CSSProperties
      }
      aria-busy={savePending}
      inert={savePending ? true : undefined}
    >
      {/* week bar */}
      <div className="border-line-soft bg-bg-1 flex shrink-0 flex-wrap items-center gap-3 border-b px-3.5 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="text-ink-3 hover:text-ink-1 inline-flex cursor-pointer items-center gap-1 text-[11px]"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All sheets
        </button>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Previous week"
            title={
              resolvedWeekIndex <= 0 && previousSheet
                ? `Previous week (${previousSheet.description})`
                : 'Previous week'
            }
            disabled={!canGoPreviousWeek || savePending}
            onClick={() => {
              if (resolvedWeekIndex > 0) {
                onWeekIndexChange(resolvedWeekIndex - 1);
              } else if (previousSheet) {
                onSelectSheetEdge(previousSheet.id, 'last');
              }
            }}
            className="border-line text-ink-2 hover:text-ink-0 cursor-pointer rounded border p-1 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next week"
            title={
              resolvedWeekIndex >= weeks.length - 1 && nextSheet
                ? `Next week (${nextSheet.description})`
                : 'Next week'
            }
            disabled={!canGoNextWeek || savePending}
            onClick={() => {
              if (resolvedWeekIndex < weeks.length - 1) {
                onWeekIndexChange(resolvedWeekIndex + 1);
              } else if (nextSheet) {
                onSelectSheetEdge(nextSheet.id, 'first');
              }
            }}
            className="border-line text-ink-2 hover:text-ink-0 cursor-pointer rounded border p-1 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-w-0">
          <div className="text-ink-0 truncate text-[13px] font-semibold">
            {weekDates.length > 0
              ? `${formatDate(weekDates[0])} - ${formatDate(weekDates[weekDates.length - 1])}`
              : selectedSheet.description}
          </div>
          <div className="text-ink-3 truncate font-mono text-[10px]">
            {selectedSheet.description} · week {Math.min(resolvedWeekIndex + 1, weeks.length)} of {weeks.length}
          </div>
        </div>

        {/* sheet week strip */}
        <div className="hidden items-end gap-[3px] md:flex">
          {weeks.map((week, index) => {
            const total = week.dates.reduce(
              (sum, date) => sum + (dailyTotals.get(date) ?? 0),
              0,
            );
            const ratio = week.dates.length > 0 ? total / week.dates.length : 0;
            return (
              <span
                key={week.weekStart}
                title={`${week.weekStart} — ${formatDayCount(total)}`}
                className={clsx(
                  'w-2 rounded-[2px]',
                  ratio >= 1 ? 'bg-status-done' : 'bg-status-run',
                  index === resolvedWeekIndex ? 'opacity-100 ring-1 ring-white/50' : 'opacity-45',
                )}
                style={{ height: 6 + ratio * 18 }}
              />
            );
          })}
        </div>

        <div className="flex-1" />

        <label className="text-ink-3 text-[10px] font-semibold tracking-wide uppercase">
          Sheet
          <select
            value={selectedSheet.id}
            disabled={savePending}
            onChange={(event) => onSelectSheet(event.target.value)}
            className="border-line bg-bg-0 text-ink-1 ml-2 h-7 min-w-44 rounded-md border px-2 text-[11px] normal-case disabled:cursor-not-allowed disabled:opacity-40"
          >
            {orderedSheets.map((sheet) => (
              <option key={sheet.id} value={sheet.id}>
                {sheet.description || 'Untitled sheet'}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={inspectionLoading || savePending}
          onClick={onRetryInspect}
          className="border-line text-ink-2 hover:text-ink-0 inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
        <div className="flex items-center gap-2">
          <WeekRing value={weekTotal} max={weekTarget} />
          <div>
            <div className="text-ink-0 font-mono text-[13px] leading-tight font-semibold">
              {weekTotal.toFixed(2)}
              <span className="text-ink-3 font-normal"> / {weekTarget} d</span>
            </div>
            <div
              className={clsx(
                'text-[10px]',
                issues.length === 0 ? 'text-status-done' : 'text-status-run',
              )}
            >
              {issues.length === 0
                ? 'complete'
                : `${issues.length} day${issues.length > 1 ? 's' : ''} to fill`}
            </div>
          </div>
        </div>
      </div>

      {(!editable ||
        outOfRangeDraftCount > 0 ||
        fullyDeclaredDates.length > 0) && (
        <div className="border-line-soft shrink-0 space-y-2 border-b px-3.5 py-2">
          {!editable ? (
            <StatusMessage tone="warning">
              This sheet is <strong>{selectedSheet.status}</strong>. Eurecia
              serves submitted sheets read-only, so its rows and their{' '}
              {(editor.data.axisLabels.axis1 || 'project').toLowerCase()} options
              cannot be edited here. Pick a sheet still marked{' '}
              <strong>Nouvelle</strong> to build entries.
            </StatusMessage>
          ) : null}
          {fullyDeclaredDates.length > 0 ? (
            <StatusMessage>
              Eurecia already declares a full day on{' '}
              {fullyDeclaredDates.map(formatDate).join(', ')}, so the Work
              Activity {fullyDeclaredDates.length === 1 ? 'draft' : 'drafts'} for{' '}
              {fullyDeclaredDates.length === 1 ? 'that day' : 'those days'} were
              skipped.
            </StatusMessage>
          ) : null}
          {outOfRangeDraftCount > 0 ? (
            <StatusMessage>
              {outOfRangeDraftCount} Work Activity{' '}
              {outOfRangeDraftCount === 1 ? 'entry falls' : 'entries fall'} outside
              this sheet ({formatDate(selectedSheet.start)} -{' '}
              {formatDate(selectedSheet.end)}) and{' '}
              {outOfRangeDraftCount === 1 ? 'was' : 'were'} ignored. Your Work
              Activity week is {formatDate(workActivityRange.start.slice(0, 10))} -{' '}
              {formatInclusiveEnd(workActivityRange.end)}.
            </StatusMessage>
          ) : null}
        </div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1">
        <AssignmentPalette
          assignments={assignments}
          armedKey={armedKey}
          onArm={onArm}
          usage={weekUsage}
          axisLabels={editor.data.axisLabels}
          labelFor={labelFor}
          disabled={!editable}
          canCopyPreviousWeek={editable && previousWeekDates.length > 0}
          onCopyPreviousWeek={() => {
            const source = entries.filter(({ date }) =>
              previousWeekDates.includes(date),
            );
            if (source.length === 0) return;
            onClearDates(weekDates);
            onPaint(
              source.flatMap((entry) => {
                const offset = previousWeekDates.indexOf(entry.date);
                const target = weekDates[offset];
                return target
                  ? [{ date: target, slots: fractionToSlots(entry.fraction) }]
                  : [];
              }),
              { axis1Id: '', axis2Id: '', axis3Id: '' },
            );
          }}
          onClearWeek={() => onClearDates(weekDates)}
          projectOptions={projectOptions}
          roleOptions={roleOptions}
          paletteAxisError={paletteAxisError}
          defaultRoleId={defaultRoleId}
          onDefaultRoleChange={onDefaultRoleChange}
          onAddProject={onAddProject}
          onRemoveProject={onRemoveProject}
          removableProjectIds={removableProjectIds}
          width="var(--eurecia-palette-w)"
        />
        <PaneResizer
          edge="left"
          width={paletteWidth}
          onWidthChange={onPaletteWidthChange}
          label="Resize assignments pane"
          cssVar="--eurecia-palette-w"
          containerRef={editorRef}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <WeekGrid
            dates={weekDates}
            entriesByDate={entriesByDate}
            remoteByDate={remoteByDate}
            selectedIndex={selectedEntryIndex}
            selectedRemoteRowIndex={
              selectedRemoteRow && weekDates.includes(selectedRemoteRow.date)
                ? selectedRemoteRow.rowIndex
                : null
            }
            onSelectRemote={onSelectRemoteRow}
            armedColor={armedColor}
            editable={editable}
            today={new Date().toISOString().slice(0, 10)}
            labelFor={labelFor}
            onSelect={onSelectEntry}
            onRemove={onRemoveEntry}
            onPaint={(paints) => {
              if (!armedSelection) return;
              onPaint(paints, armedSelection);
            }}
            onFillDay={(date) => {
              if (!armedSelection) return;
              const used = fractionToSlots(dailyTotals.get(date) ?? 0);
              onPaint(
                [{ date, slots: TIMESHEET_SLOTS_PER_DAY - used }],
                armedSelection,
              );
            }}
            onClearDay={(date) => onClearDates([date])}
            onSpreadDay={(date) => onSpreadDay(date, weekDates)}
          />
          <div className="border-line-soft text-ink-4 flex shrink-0 items-center gap-3.5 border-t px-4 py-2 text-[11px]">
            {editable ? (
              <>
                <span>1–9 pick assignment</span>
                <span>drag across = duration · drag down = several days</span>
                <span>⌫ delete</span>
              </>
            ) : (
              <span>
                This sheet is not a new draft — saved rows are read-only here.
              </span>
            )}
          </div>
        </div>

        <PaneResizer
          edge="right"
          width={railWidth}
          onWidthChange={onRailWidthChange}
          label="Resize details pane"
          cssVar="--eurecia-rail-w"
          containerRef={editorRef}
        />
        {selectedEntry && selectedEntryIndex !== null ? (
          <EntryDetailRail
            width="var(--eurecia-rail-w)"
            entry={selectedEntry}
            index={selectedEntryIndex}
            dateLabel={formatDate(selectedEntry.date)}
            maxFraction={selectedMaxFraction}
            axisLabels={editor.data.axisLabels}
            axisOptions={axisOptions[selectedEntryIndex] ?? { 1: [], 2: [], 3: [] }}
            fallbackAxisOptions={pooledAxisOptions}
            axisErrors={axisErrors}
            axisPending={pendingLookups > 0}
            labelFor={labelFor}
            onChange={onUpdateEntry}
            onRemove={onRemoveEntry}
            onClose={() => onSelectEntry(null)}
          />
        ) : selectedRemoteRow ? (
          <RemoteRowDetailRail
            width="var(--eurecia-rail-w)"
            row={selectedRemoteRow}
            dateLabel={formatDate(selectedRemoteRow.date)}
            axisLabels={editor.data.axisLabels}
            labelFor={labelFor}
            markedForDeletion={pendingDeletions.some(
              (deletion) =>
                deletion.rowIndex === selectedRemoteRow.rowIndex &&
                deletion.date === selectedRemoteRow.date,
            )}
            canDelete={editable}
            onEdit={() => onEditRemoteRow(selectedRemoteRow)}
            onToggleDeletion={() => onToggleRemoteRowDeletion(selectedRemoteRow)}
            onClose={() => onSelectRemoteRow(selectedRemoteRow)}
          />
        ) : (
          <WeekSummaryRail
            width="var(--eurecia-rail-w)"
            assignments={assignments}
            usage={weekUsage}
            issues={issues}
            labelFor={labelFor}
            totalFraction={weekTotal}
            targetFraction={weekTarget}
          />
        )}
      </div>

      {/* footer */}
      <div className="border-line-soft bg-bg-1 flex shrink-0 items-center gap-3 border-t px-3.5 py-2.5">
        <span className="text-ink-4 font-mono text-[11px]" aria-live="polite">
          {entries.length} draft {entries.length === 1 ? 'entry' : 'entries'}
          {pendingDeletions.length > 0
            ? ` · ${pendingDeletions.length} removed`
            : ''}
        </span>
        {saveError ? (
          <span
            className="text-status-fail min-w-0 truncate text-[11px]"
            role="alert"
            title={saveError}
          >
            {saveError}
          </span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          disabled={!canSubmit || savePending}
          onClick={() => setConfirmingSave('submit-for-approval')}
          title={
            canSubmit
              ? 'Save pending changes and submit the sheet for approval'
              : 'This sheet cannot be submitted for approval'
          }
          className="border-line text-ink-1 hover:text-ink-0 inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
        >
          <SendHorizontal className="h-4 w-4" />
          Submit for approval
        </button>
        <button
          type="button"
          disabled={!canSave || savePending}
          onClick={() => setConfirmingSave('save')}
          className="bg-status-azure text-bg-0 inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
        >
          {savePending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          {savePending ? 'Saving to Eurecia…' : 'Save to Eurecia'}
          <kbd className="border-bg-0/30 rounded border px-1 font-mono text-[9px]">
            ⌘⏎
          </kbd>
        </button>
      </div>

      {confirmingSave ? (
        <SaveConfirmation
          action={confirmingSave}
          entryCount={entries.length}
          deletionCount={pendingDeletions.length}
          pending={savePending}
          onCancel={() => setConfirmingSave(null)}
          onConfirm={() => {
            const action = confirmingSave;
            setConfirmingSave(null);
            if (action === 'submit-for-approval') onSubmitForApproval();
            else onSave();
          }}
        />
      ) : null}
    </div>
  );
}

function SaveConfirmation({
  action,
  entryCount,
  deletionCount,
  pending,
  onCancel,
  onConfirm,
}: {
  action: TimesheetAction;
  entryCount: number;
  deletionCount: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const isSubmit = action === 'submit-for-approval';

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  // Escape must dismiss the confirmation only. Left to bubble it reaches the
  // dialog's Modal, which would close the whole overlay and drop the ledger.
  // Enter confirms, so the whole dialog is reachable without the mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Enter' || pending) return;
      event.preventDefault();
      event.stopPropagation();
      onConfirm();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, onConfirm, pending]);

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={
        isSubmit ? 'Confirm Eurecia submission' : 'Confirm Eurecia save'
      }
    >
      <div className="border-line bg-bg-1 w-full max-w-md space-y-4 rounded-xl border p-5 shadow-2xl">
        <div>
          <div className="text-status-azure font-mono text-[11px] tracking-widest uppercase">
            Confirm
          </div>
          <h3 className="text-ink-0 mt-1 text-lg font-semibold">
            {isSubmit ? 'Submit sheet for approval?' : 'Save to Eurecia?'}
          </h3>
        </div>
        <p className="text-ink-2 text-sm leading-relaxed">
          This writes {entryCount} {entryCount === 1 ? 'entry' : 'entries'} to
          the Eurecia sheet
          {deletionCount > 0
            ? ` and permanently deletes ${deletionCount} saved ${
                deletionCount === 1 ? 'row' : 'rows'
              }`
            : ''}
          .{' '}
          {isSubmit
            ? 'It then submits the whole sheet for approval, which locks it until a manager or you cancel the submission in Eurecia.'
            : 'It does not submit the sheet for approval.'}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border-line text-ink-1 inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          >
            Cancel
            <kbd className="border-line text-ink-4 rounded border px-1 font-mono text-[9px]">
              esc
            </kbd>
          </button>
          <button
            type="button"
            ref={confirmRef}
            disabled={pending}
            onClick={onConfirm}
            className="bg-status-azure text-bg-0 inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isSubmit ? 'Submit for approval' : 'Save to Eurecia'}
            <kbd className="border-bg-0/30 rounded border px-1 font-mono text-[9px]">
              ⏎
            </kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
