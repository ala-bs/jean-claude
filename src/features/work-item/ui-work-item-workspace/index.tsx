/* eslint-disable sort-imports */
import { ArrowLeft, Bug, ChevronDown, ChevronLeft, ChevronRight, Columns3, Copy, ExternalLink, List, Loader2, RefreshCw, Search, Settings2, X } from 'lucide-react';
import clsx from 'clsx';
import Fuse from 'fuse.js';

import { BoardColorSettingsMenu } from '@/features/work-item/ui-work-item-workspace/color-settings-menu';
import {
  isWorkItemClosedState,
  pushWorkItemStack,
} from '@/features/work-item/ui-work-item-board/utils';
import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { IconButton } from '@/common/ui/icon-button';
import { getOwnerColor, normalizeOwnerName } from '@/features/work-item/utils-owner-color';
import {
  useBoardColumns,
  useIterations,
  useWorkItemById,
  useWorkItems,
  useWorkItemsByIds,
} from '@/hooks/use-work-items';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useCommands } from '@/common/hooks/use-commands';
import { resolveDetailsPaneEscape } from '@/features/work-item/ui-work-item-workspace/details-pane-escape';
import { BoardSplitPane } from '@/features/work-item/ui-work-item-workspace/board-split-pane';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import type {
  AzureDevOpsIteration,
  AzureDevOpsWorkItem,
} from '@/lib/api';
import { formatRelativeTime } from '@/lib/time';
import { Tooltip } from '@/common/ui/tooltip';
import {
  DEFAULT_AZURE_BOARD_FILTERS,
  DEFAULT_AZURE_BOARD_PANEL_WIDTH,
  DEFAULT_WORK_ITEMS_VIEW_MODE,
  EMPTY_AZURE_BOARD_COLUMN_IDS,
  useAzureBoardStore,
  workItemWorkspaceScopeKey,
} from '@/stores/azure-board';
import type {
  AzureBoardFilters,
  WorkItemsViewMode,
  WorkItemWorkspaceSurface,
} from '@/stores/azure-board';
import { useToastStore } from '@/stores/toasts';
import { useQueryClient } from '@tanstack/react-query';
import { UserAvatar } from '@/common/ui/user-avatar';
import { EMPTY_BOARD_COLUMNS, WorkItemBoard } from '@/features/work-item/ui-work-item-board';
import { WorkItemList } from '@/features/work-item/ui-work-item-list';
import { WorkItemPreview } from '@/features/work-item/ui-work-item-preview';
import { ParsedWorkItemTitle } from '@/features/work-item/ui-parsed-work-item-title';
import type { Project } from '@shared/types';
import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';
import {
  buildAzureBoardBaseModel,
  buildAzureBoardRelationshipModel,
  resolveAzureBoardIterationFilter,
} from './build-board-model';

const EMPTY_SELECTED_WORK_ITEM_IDS: string[] = [];
const EMPTY_WORK_ITEMS: AzureDevOpsWorkItem[] = [];
const EMPTY_ITERATIONS: AzureDevOpsIteration[] = [];
export const DEFAULT_WORKSPACE_EXCLUDE_WORK_ITEM_TYPES = [
  'Test Suite',
  'Test Plan',
];
/**
 * Selection surfaces additionally hide the containers you never attach to a
 * task (epics/features) and test cases, which are surfaced separately.
 */
export const WORK_ITEM_SELECTION_EXCLUDE_TYPES = [
  ...DEFAULT_WORKSPACE_EXCLUDE_WORK_ITEM_TYPES,
  'Test Case',
  'Epic',
  'Feature',
];
/** Selection surfaces open on the current iteration, like the old picker did. */
export const CURRENT_ITERATION_DEFAULT_FILTERS = { iterations: ['__current__'] };

export type ConfiguredWorkItemProject = Project & {
  workItemProviderId: string;
  workItemProjectId: string;
  workItemProjectName: string;
};

/**
 * Legacy alias kept so the Azure Board overlay reads naturally at its call site.
 */
export type ConfiguredAzureBoardProject = ConfiguredWorkItemProject;

export type WorkItemWorkspaceSelection = {
  selectedWorkItemIds: string[];
  onToggleSelect: (workItem: AzureDevOpsWorkItem) => void;
  onClearSelection?: () => void;
};

/**
 * A bare numeric search (`123` or `#123`) is treated as a work item id lookup:
 * the id is forwarded to the server verbatim (it ORs id against title) and the
 * matching card is auto-highlighted so "type an id, press enter" keeps working.
 */
function getExactWorkItemIdSearch(search: string) {
  const match = search.trim().match(/^#?(\d+)$/);
  return match?.[1] ?? null;
}

function MultiFilterDropdown({
  label,
  allLabel,
  countLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  countLabel: string;
  options: Array<{ value: string; label: string; badge?: string; ownerName?: string }>;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const selectedOption = options.find(
    (option) => normalizeOwnerName(option.value) === normalizeOwnerName(selected[0] ?? ''),
  );
  const selectedLabel = selectedOption?.label;
  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (selectedLabel ?? selected[0])
        : `${selected.length} ${countLabel}`;
  return (
    <Dropdown
      className="max-w-64"
      trigger={
        <button
          type="button"
          aria-label={label}
          className="bg-bg-1 border-line hover:bg-bg-2 text-ink-1 flex h-7 max-w-44 min-w-0 shrink-0 items-center gap-2 rounded-md border px-2.5 text-xs transition-colors"
        >
          {selected.length === 1 && selectedOption?.ownerName && <UserAvatar
            name={selectedOption.ownerName}
            color={getOwnerColor(selectedOption.ownerName)}
          />}
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </button>
      }
    >
      <DropdownItem onClick={() => onChange([])} checked={selected.length === 0}>
        {allLabel}
      </DropdownItem>
      {options.map((option) => (
        <DropdownItem
          key={option.value}
          checked={selected.some(
            (selectedValue) =>
              normalizeOwnerName(selectedValue) === normalizeOwnerName(option.value),
          )}
          onClick={() => {
            const exists = selected.some(
              (selectedValue) =>
                normalizeOwnerName(selectedValue) === normalizeOwnerName(option.value),
            );
            onChange(
              exists
                ? selected.filter(
                    (selectedValue) =>
                      normalizeOwnerName(selectedValue) !==
                      normalizeOwnerName(option.value),
                  )
                : [...selected, option.value],
            );
          }}
        >
          <span className="flex min-w-0 items-center gap-2">
            {option.ownerName && <UserAvatar
              name={option.ownerName}
              color={getOwnerColor(option.ownerName)}
            />}
            <span className="truncate">{option.label}</span>
            {option.badge && (
              <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-1.5 py-px text-[9px] font-semibold tracking-wide text-amber-300 uppercase">
                {option.badge}
              </span>
            )}
          </span>
        </DropdownItem>
      ))}
    </Dropdown>
  );
}

function workItemSummary(workItem: AzureDevOpsWorkItem) {
  const value = workItem.fields.description || workItem.fields.reproSteps;
  if (!value) return 'No summary available.';
  if (!value.includes('<')) return value.trim();
  const element = document.createElement('div');
  element.innerHTML = value;
  element.querySelectorAll('br').forEach((breakElement) => {
    breakElement.replaceWith('\n');
  });
  element
    .querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')
    .forEach((block) => block.append('\n'));
  return (element.textContent ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function RelatedBugsPanel({
  story,
  bugs,
  onBack,
  onClose,
  onOpenBug,
  parserSetting,
}: {
  story: AzureDevOpsWorkItem;
  bugs: AzureDevOpsWorkItem[];
  onBack: () => void;
  onClose: () => void;
  onOpenBug: (bugId: number) => void;
  parserSetting: WorkItemTitleParserSetting | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-line-soft flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <button type="button" onClick={onBack} className="text-ink-3 hover:bg-bg-3 hover:text-ink-1 -ml-1 p-1" aria-label="Back to work item details">
          <ChevronLeft className="h-4 w-4" />
        </button>
         <div className="min-w-0 flex-1">
          <div className="text-ink-3 mb-0.5 font-mono text-[10px]">#{story.id} · related bugs</div>
          <ParsedWorkItemTitle
            title={story.fields.title}
            parserSetting={parserSetting}
            compact
            titleClassName="text-ink-0 truncate text-sm font-semibold"
           />
         </div>
         <IconButton
           size="sm"
           icon={<X />}
           tooltip="Close details pane"
           onClick={onClose}
         />
       </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5">
        {bugs.map((bug) => {
          const isClosed = isWorkItemClosedState(bug.fields.state);
          return (
            <div
              key={bug.id}
              onClick={() => onOpenBug(bug.id)}
              className={isClosed
                ? 'border-line bg-bg-2 hover:bg-bg-3 border-l-status-done flex w-full flex-col rounded-lg border border-l-[3px] px-3 py-2.5 text-left transition-colors'
                : 'border-line bg-bg-2 hover:bg-bg-3 border-l-status-fail flex w-full flex-col rounded-lg border border-l-[3px] px-3 py-2.5 text-left transition-colors'}
            >
              <ParsedWorkItemTitle
                title={bug.fields.title}
                parserSetting={parserSetting}
                compact
                className="mb-1 w-full"
                titleClassName="text-ink-0 text-xs font-semibold leading-snug"
                renderTitle={(title) => <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenBug(bug.id);
                  }}
                  className="flex w-full flex-col text-left"
                >
                  <span className="mb-1.5 flex w-full items-center gap-1.5">
                    <Bug className={isClosed ? 'text-status-done h-3 w-3' : 'text-status-fail h-3 w-3'} />
                    <span className="text-ink-3 font-mono text-[10px]">#{bug.id}</span>
                    <span className={isClosed ? 'bg-status-done/15 text-status-done ml-auto px-1.5 py-0.5 font-mono text-[9px]' : 'bg-status-fail/15 text-status-fail ml-auto px-1.5 py-0.5 font-mono text-[9px]'}>
                      {bug.fields.state}
                    </span>
                    <ChevronRight className="text-ink-3 h-3 w-3" />
                  </span>
                  {title}
                </button>}
              />
              <span className="text-ink-2 line-clamp-3 whitespace-pre-line text-xs leading-relaxed">{workItemSummary(bug)}</span>
            </div>
          );
        })}
        {bugs.length === 0 && <p className="text-ink-3 text-xs italic">No related bugs.</p>}
      </div>
    </div>
  );
}

export function AzureWorkItemActions({
  workItem,
  onCreateTask,
  onClose,
}: {
  workItem: AzureDevOpsWorkItem;
  onCreateTask?: () => void;
  onClose?: () => void;
}) {
  const addToast = useToastStore((state) => state.addToast);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(workItem.url);
      addToast({ message: 'Work item link copied', type: 'success' });
    } catch {
      addToast({ message: 'Failed to copy work item link', type: 'error' });
    }
  };

  return <>
    {onCreateTask && (
      <button type="button" onClick={onCreateTask} className="text-ink-1 hover:bg-bg-3 px-2 py-1 text-xs font-medium" title="Create local task">Create task</button>
    )}
    <IconButton
      size="sm"
      icon={<ExternalLink />}
      tooltip="Open in Azure DevOps"
      onClick={() => {
        window.open(workItem.url, '_blank', 'noopener,noreferrer');
      }}
    />
    <IconButton
      size="sm"
      icon={<Copy />}
      tooltip="Copy work item link"
      onClick={copyLink}
    />
    {onClose && (
      <IconButton
        size="sm"
        icon={<X />}
        tooltip="Close details pane"
        onClick={onClose}
      />
    )}
  </>;
}

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: WorkItemsViewMode;
  onChange: (viewMode: WorkItemsViewMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        aria-label="List view"
        aria-pressed={viewMode === 'list'}
        onClick={() => onChange('list')}
        className={clsx(
          'rounded p-1',
          viewMode === 'list' ? 'bg-bg-3 text-ink-0' : 'text-ink-3 hover:text-ink-1',
        )}
      >
        <List size={16} />
      </button>
      <button
        type="button"
        aria-label="Board view"
        aria-pressed={viewMode === 'board'}
        onClick={() => onChange('board')}
        className={clsx(
          'rounded p-1',
          viewMode === 'board' ? 'bg-bg-3 text-ink-0' : 'text-ink-3 hover:text-ink-1',
        )}
      >
        <Columns3 size={16} />
      </button>
    </div>
  );
}

/**
 * The shared Azure work item workspace: filter bar, board/list, resizable
 * details pane with drill-down and related bugs.
 *
 * Rendered by the Azure Board overlay (browse mode) and by the new task overlay
 * / task panel link modal (the same thing plus checkbox selection).
 */
export function WorkItemWorkspace({
  project,
  surface,
  onClose,
  headerLeading,
  headerActions,
  escapeInterceptorRef,
  selection,
  onCreateTask,
  onHighlightChange,
  search: controlledSearch,
  onSearchChange,
  defaultFilters,
  excludeWorkItemTypes = DEFAULT_WORKSPACE_EXCLUDE_WORK_ITEM_TYPES,
}: {
  project: ConfiguredWorkItemProject;
  /** Scopes persisted filters, collapsed columns, split width and view mode. */
  surface: WorkItemWorkspaceSurface;
  /** Omit to hide the header close button (embedded surfaces). */
  onClose?: () => void;
  headerLeading?: ReactNode;
  /** Rendered at the right of the header, before the refresh button. */
  headerActions?: ReactNode;
  escapeInterceptorRef?: RefObject<(() => boolean) | null>;
  /** Provide to turn on checkbox multi-select. */
  selection?: WorkItemWorkspaceSelection;
  /** Provide to show a "Create task" action in the details pane. */
  onCreateTask?: (workItem: AzureDevOpsWorkItem) => void;
  onHighlightChange?: (workItemId: string | null) => void;
  /** Controlled search text. When provided the built-in search box is hidden. */
  search?: string;
  onSearchChange?: (search: string) => void;
  /** Applied the first time this scope is used (e.g. default to the current iteration). */
  defaultFilters?: Partial<AzureBoardFilters>;
  excludeWorkItemTypes?: string[];
}) {
  const queryClient = useQueryClient();
  const scopeKey = workItemWorkspaceScopeKey({ surface, projectId: project.id });
  const [workItemStack, setWorkItemStack] = useState<number[]>([]);
  const [highlightedBoardWorkItemId, setHighlightedBoardWorkItemId] = useState<number | null>(null);
  const [bugsForWorkItemId, setBugsForWorkItemId] = useState<number | null>(null);
  const [isRelatedBugsPanelOpen, setIsRelatedBugsPanelOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isColorMenuOpen, setIsColorMenuOpen] = useState(false);
  const [colorMenuTab, setColorMenuTab] = useState<'tags' | 'columns'>('tags');
  const colorMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const detailsPaneRef = useRef<HTMLElement>(null);
  const workItemIdToRefocusRef = useRef<number | null>(null);
  const scopeFilters = useAzureBoardStore(
    (state) => state.filtersByScope[scopeKey],
  );
  const setFiltersAction = useAzureBoardStore((state) => state.setFilters);
  // Seeded once per mount so a surface can start narrowed (e.g. the current
  // iteration) without overriding whatever the user later picks.
  const [seededDefaultFilters] = useState(() =>
    defaultFilters
      ? { ...DEFAULT_AZURE_BOARD_FILTERS, ...defaultFilters }
      : DEFAULT_AZURE_BOARD_FILTERS,
  );
  const storedFilters = scopeFilters ?? seededDefaultFilters;
  const setFilters = useCallback(
    (update: Partial<AzureBoardFilters>) => {
      setFiltersAction(scopeKey, { ...storedFilters, ...update });
    },
    [scopeKey, setFiltersAction, storedFilters],
  );
  // A controlled search box (the new task overlay owns its own input) replaces
  // the persisted one so there is never a second search field on screen.
  const isSearchControlled = controlledSearch !== undefined;
  const filters = useMemo(
    () =>
      isSearchControlled
        ? { ...storedFilters, search: controlledSearch }
        : storedFilters,
    [isSearchControlled, storedFilters, controlledSearch],
  );
  const setSearch = useCallback(
    (search: string) => {
      if (onSearchChange) {
        onSearchChange(search);
        return;
      }
      setFilters({ search });
    },
    [onSearchChange, setFilters],
  );
  const panelWidth = useAzureBoardStore(
    (state) => state.panelWidthByScope[scopeKey] ?? DEFAULT_AZURE_BOARD_PANEL_WIDTH,
  );
  const setPanelWidthAction = useAzureBoardStore((state) => state.setPanelWidth);
  const handlePanelWidthCommit = useCallback(
    (width: number) => setPanelWidthAction(scopeKey, width),
    [scopeKey, setPanelWidthAction],
  );
  const viewMode = useAzureBoardStore(
    (state) => state.viewModeByScope[scopeKey] ?? DEFAULT_WORK_ITEMS_VIEW_MODE,
  );
  const setViewModeAction = useAzureBoardStore((state) => state.setViewMode);
  const handleViewModeChange = useCallback(
    (mode: WorkItemsViewMode) => setViewModeAction(scopeKey, mode),
    [scopeKey, setViewModeAction],
  );
  const scopeCollapsedColumnIds = useAzureBoardStore(
    (state) => state.collapsedColumnIdsByScope[scopeKey],
  );
  const collapsedColumnIds =
    scopeCollapsedColumnIds ?? EMPTY_AZURE_BOARD_COLUMN_IDS;
  const toggleCollapsedColumn = useAzureBoardStore(
    (state) => state.toggleCollapsedColumn,
  );
  const colorSettings = useAzureBoardStore((state) => state.colorSettings);
  const setColorSettings = useAzureBoardStore((state) => state.setColorSettings);
  const resetColorSettings = useAzureBoardStore(
    (state) => state.resetColorSettings,
  );
  const debouncedSearchText = useDebouncedValue(filters.search, 250);
  const params = useMemo(
    () => ({
      providerId: project.workItemProviderId,
      projectId: project.workItemProjectId,
      projectName: project.workItemProjectName,
    }),
    [
      project.workItemProviderId,
      project.workItemProjectId,
      project.workItemProjectName,
    ],
  );
  const baseFilters = useMemo(
    () => ({ excludeWorkItemTypes }),
    [excludeWorkItemTypes],
  );
  // Only feeds the filter dropdown options, so it rides its staleTime rather
  // than refetching the whole project every time a surface mounts. The explicit
  // refresh button still refetches it.
  const metadataQuery = useWorkItems({
    ...params,
    enabled: true,
    filters: baseFilters,
  });
  const metadataItems = metadataQuery.data ?? EMPTY_WORK_ITEMS;
  const iterationsQuery = useIterations({ ...params, refetchOnMount: 'always' });
  const iterations = iterationsQuery.data ?? EMPTY_ITERATIONS;
  const hasUsableIterations = iterationsQuery.data !== undefined;
  const iterationFilter = resolveAzureBoardIterationFilter({
    iterations,
    selectedIterations: filters.iterations,
    iterationsStatus:
      iterationsQuery.isError && hasUsableIterations
        ? 'success'
        : iterationsQuery.status,
  });
  // `#123` is a UI convenience; the server matches a bare id against System.Id.
  const exactSearchWorkItemId = getExactWorkItemIdSearch(debouncedSearchText);
  // Matched against the *undebounced* text too, so "type an id, hit enter"
  // resolves on the keystroke when the item is already loaded instead of
  // waiting 250ms plus a round-trip and acting on the previous highlight.
  const liveSearchWorkItemId = getExactWorkItemIdSearch(filters.search);
  // `no-match` means "Current" was selected but the project has no current
  // iteration; we still fetch (unfiltered) so the surface is usable, and the
  // banner explains why nothing is narrowed.
  const shouldFetchItems =
    iterationFilter.status === 'resolved' ||
    iterationFilter.status === 'partial' ||
    iterationFilter.status === 'no-match';
  const itemsQuery = useWorkItems({
    ...params,
    enabled: shouldFetchItems,
    refetchOnMount: 'always',
    filters: {
      ...baseFilters,
      // Must be `undefined`, not `''`: an empty string stays in the query key
      // and splits this from the identical unfiltered metadata query, running
      // the same unbounded project fetch twice.
      searchText: exactSearchWorkItemId ?? (debouncedSearchText.trim() || undefined),
      workItemTypes:
        filters.workItemTypes.length > 0 ? filters.workItemTypes : undefined,
      iterationPaths:
        iterationFilter.paths.length > 0 ? iterationFilter.paths : undefined,
    },
  });
  const items = shouldFetchItems
    ? (itemsQuery.data ?? EMPTY_WORK_ITEMS)
    : EMPTY_WORK_ITEMS;
  const columnsQuery = useBoardColumns({
    ...params,
    enabled: true,
    refetchOnMount: 'always',
  });
  const columns = columnsQuery.data ?? EMPTY_BOARD_COLUMNS;
  const isLoading =
    iterationFilter.status === 'pending' ||
    (itemsQuery.isLoading && items.length === 0) ||
    (viewMode === 'board' && columnsQuery.isPending);
  const {
    visibleItems,
    types,
    assignees,
    tagOptions,
    iterationOptions,
    storyLinkedWorkItemIds,
  } = useMemo(
    () => buildAzureBoardBaseModel({ metadataItems, items, iterations, filters }),
    [metadataItems, items, iterations, filters],
  );
  // The server already narrowed by `Contains`; this only RANKS what came back so
  // the closest title match leads. It does not re-widen the set, so a typo that
  // the server matched nothing for still returns nothing.
  const rankedVisibleItems = useMemo(() => {
    const query = filters.search.trim();
    if (!query || getExactWorkItemIdSearch(query) || visibleItems.length === 0) {
      return visibleItems;
    }
    const fuse = new Fuse(visibleItems, {
      keys: ['fields.title', 'id'],
      threshold: 0.4,
      ignoreLocation: true,
    });
    const ranked = fuse.search(query).map((result) => result.item);
    if (ranked.length === 0) return visibleItems;
    const rankedIds = new Set(ranked.map((item) => item.id));
    // Anything Fuse scored out still matched on the server, so keep it, just last.
    return [...ranked, ...visibleItems.filter((item) => !rankedIds.has(item.id))];
  }, [visibleItems, filters.search]);
  const exactMatchWorkItemId =
    [liveSearchWorkItemId, exactSearchWorkItemId].find(
      (candidate) =>
        candidate !== null &&
        visibleItems.some((item) => item.id.toString() === candidate),
    ) ?? null;
  const selectedWorkItemId = workItemStack.at(-1) ?? null;
  const rootWorkItemId = workItemStack[0] ?? null;
  const selectedListWorkItem =
    visibleItems.find((item) => item.id === selectedWorkItemId) ?? null;
  const detailedWorkItemQuery = useWorkItemById({
    providerId: project.workItemProviderId,
    workItemId: selectedWorkItemId,
  });
  const detailedWorkItem = detailedWorkItemQuery.data;
  const selectedWorkItem = detailedWorkItem ?? selectedListWorkItem;
  const childWorkItemsQuery = useWorkItemsByIds({
    providerId: project.workItemProviderId,
    projectName: project.workItemProjectName,
    workItemIds: storyLinkedWorkItemIds,
  });
  const blockingBoardError =
    (iterationFilter.status === 'error' ? iterationsQuery.error : null) ??
    (itemsQuery.isError && itemsQuery.data === undefined ? itemsQuery.error : null);
  const boardWarnings = [...new Set([
    iterationsQuery.error && !blockingBoardError ? iterationsQuery.error.message : null,
    itemsQuery.error && itemsQuery.data !== undefined ? itemsQuery.error.message : null,
    metadataQuery.error?.message ?? null,
    columnsQuery.error?.message ?? null,
    childWorkItemsQuery.error && storyLinkedWorkItemIds.length > 0
      ? childWorkItemsQuery.error.message
      : null,
  ].filter((message): message is string => !!message))];
  const childWorkItems = childWorkItemsQuery.data ?? EMPTY_WORK_ITEMS;
  const { childBugProgressByWorkItemId, bugsForWorkItem, relatedBugs } = useMemo(
    () =>
      buildAzureBoardRelationshipModel({
        visibleItems,
        childWorkItems,
        bugsForWorkItemId,
      }),
    [visibleItems, childWorkItems, bugsForWorkItemId],
  );
  const relatedBugWorkItemIds = useMemo(
    () => relatedBugs.map((bug) => bug.id),
    [relatedBugs],
  );
  const currentIterationPath = useMemo(
    () => iterations.find((iteration) => iteration.isCurrent)?.path,
    [iterations],
  );
  const selectedWorkItemIds =
    selection?.selectedWorkItemIds ?? EMPTY_SELECTED_WORK_ITEM_IDS;
  const onToggleSelect = selection?.onToggleSelect;
  const handleBoardHighlight = useCallback((item: AzureDevOpsWorkItem) => {
    setBugsForWorkItemId(null);
    setIsRelatedBugsPanelOpen(false);
    setHighlightedBoardWorkItemId(item.id);
    setWorkItemStack([item.id]);
  }, []);
  const handleBoardModifiedClick = useCallback((item: AzureDevOpsWorkItem) => {
    window.open(item.url, '_blank');
  }, []);
  const handleToggleColumn = useCallback(
    (columnId: string) => {
      toggleCollapsedColumn(scopeKey, columnId);
    },
    [scopeKey, toggleCollapsedColumn],
  );
  const handleOpenChildBugs = useCallback((item: AzureDevOpsWorkItem) => {
    setBugsForWorkItemId(item.id);
    setIsRelatedBugsPanelOpen(true);
    setHighlightedBoardWorkItemId(item.id);
    setWorkItemStack([item.id]);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshingRef.current = false;
    };
  }, []);

  // Typing an id jumps the highlight (and therefore the details pane and any
  // "toggle highlighted" shortcut) straight to that card.
  useEffect(() => {
    if (exactMatchWorkItemId === null) return;
    const workItemId = Number(exactMatchWorkItemId);
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setHighlightedBoardWorkItemId(workItemId);
      setWorkItemStack((stack) =>
        stack.length === 1 && stack[0] === workItemId ? stack : [workItemId],
      );
    });
    return () => {
      cancelled = true;
    };
  }, [exactMatchWorkItemId]);

  // Falls back to the first selected item so a keyboard toggle still has a
  // target when a restored draft arrives with selections but no click yet.
  // Suppressed while searching: there the user is aiming at a specific result,
  // and silently retargeting to an unrelated selection is worse than no target.
  const resolvedHighlightWorkItemId =
    highlightedBoardWorkItemId?.toString() ??
    (filters.search.trim()
      ? null
      : (selectedWorkItemIds.find((workItemId) =>
          visibleItems.some((item) => item.id.toString() === workItemId),
        ) ?? null));
  useEffect(() => {
    onHighlightChange?.(resolvedHighlightWorkItemId);
  }, [resolvedHighlightWorkItemId, onHighlightChange]);
  // Restores the chord the deleted picker owned. Scoped to the workspace and
  // only bound while a work item is open, so it cannot shadow the feed/PR
  // bindings of the same chord when no details pane is showing.
  useCommands('work-item-workspace', [
    selectedWorkItem && {
      label: 'Open Work Item in Azure DevOps',
      section: 'Work Items',
      shortcut: 'cmd+shift+o',
      handler: () => {
        window.open(selectedWorkItem.url, '_blank', 'noopener,noreferrer');
      },
    },
  ]);
  // The details pane is unmounted during load and on a blocking error, so the
  // stack alone is not enough to decide whether escape belongs to us.
  const isDetailsPaneRendered =
    selectedWorkItemId !== null && !isLoading && !blockingBoardError;

  useEffect(() => {
    if (
      itemsQuery.isFetching ||
      rootWorkItemId === null ||
      visibleItems.some((item) => item.id === rootWorkItemId)
    ) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setWorkItemStack([]);
      setHighlightedBoardWorkItemId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [itemsQuery.isFetching, rootWorkItemId, visibleItems]);

  useEffect(() => {
    const workItemId = workItemIdToRefocusRef.current;
    if (selectedWorkItemId !== null || workItemId === null) return;
    workItemIdToRefocusRef.current = null;
    const card = contentRef.current?.querySelector<HTMLElement>(
      `[data-work-item-id="${workItemId}"]`,
    );
    const focusTarget =
      card?.querySelector<HTMLElement>('button, [tabindex="0"]') ?? card;
    focusTarget?.focus({ preventScroll: true });
  }, [selectedWorkItemId]);

  const refreshWorkItems = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    try {
      const [metadataResult, iterationsResult, itemsResult] = await Promise.all([
        metadataQuery.refetch(),
        iterationsQuery.refetch(),
        shouldFetchItems ? itemsQuery.refetch() : Promise.resolve(null),
        queryClient.refetchQueries({
          queryKey: ['work-item', params.providerId],
          type: 'active',
        }, { throwOnError: true }),
        queryClient.refetchQueries({
          queryKey: ['work-items-by-ids', params.providerId],
          type: 'active',
        }, { throwOnError: true }),
      ]);
      if (
        metadataResult.isSuccess &&
        iterationsResult.isSuccess &&
        (itemsResult === null || itemsResult.isSuccess)
      ) {
        if (mountedRef.current) setLastRefreshedAt(new Date());
      }
    } catch {
      // Active queries retain and display their own errors.
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setIsRefreshing(false);
    }
  };

  const openRelatedWorkItem = (workItemId: number) => {
    setWorkItemStack((stack) => pushWorkItemStack(stack, workItemId));
  };
  const closeDetailsPane = () => {
    workItemIdToRefocusRef.current = rootWorkItemId;
    setWorkItemStack([]);
    setHighlightedBoardWorkItemId(null);
    setBugsForWorkItemId(null);
    setIsRelatedBugsPanelOpen(false);
  };
  // Escape steps back one level (mirrors the details pane back button) and
  // only closes the pane at the root level. Returns false when the pane is
  // closed so the host overlay handles escape itself.
  const handleDetailsPaneEscape = () => {
    const action = resolveDetailsPaneEscape({
      // Must track what is actually RENDERED, not just the stack: the pane is
      // unmounted while loading or on a blocking error, and claiming escape
      // there would swallow it and strand a host that defers to us.
      isDetailsPaneOpen: isDetailsPaneRendered,
      workItemStackDepth: workItemStack.length,
      hasRelatedBugsStory: bugsForWorkItem !== null && bugsForWorkItem !== undefined,
      isRelatedBugsPanelOpen,
    });
    switch (action) {
      case 'none':
        return false;
      case 'back-to-related-bugs':
        if (bugsForWorkItem) {
          setWorkItemStack([bugsForWorkItem.id]);
          setIsRelatedBugsPanelOpen(true);
        }
        return true;
      case 'pop-work-item':
        setWorkItemStack((stack) => stack.slice(0, -1));
        return true;
      case 'close-related-bugs':
        setBugsForWorkItemId(null);
        setIsRelatedBugsPanelOpen(false);
        return true;
      default:
        closeDetailsPane();
        return true;
    }
  };
  const handleDetailsPaneEscapeRef = useRef(handleDetailsPaneEscape);
  useEffect(() => {
    handleDetailsPaneEscapeRef.current = handleDetailsPaneEscape;
  });
  useEffect(() => {
    if (!escapeInterceptorRef) return;
    escapeInterceptorRef.current = () => handleDetailsPaneEscapeRef.current();
    return () => {
      escapeInterceptorRef.current = null;
    };
  }, [escapeInterceptorRef]);
  return (
    <div ref={contentRef} className="relative flex min-h-0 flex-1 flex-col">
      <header className="border-line flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2.5">
        {headerLeading && (
          <div className="flex shrink-0 items-center gap-2">{headerLeading}</div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          {!isSearchControlled && (
            <div className="bg-bg-1 border-line flex min-w-40 max-w-80 flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5">
              <Search className="text-ink-3 h-3.5 w-3.5 shrink-0" />
              <input aria-label="Search work items" value={filters.search} onChange={(event) => setSearch(event.target.value)} placeholder="Search work items..." className="text-ink-1 min-w-0 flex-1 bg-transparent text-xs outline-none" />
              {filters.search && <button type="button" onClick={() => setSearch('')} className="text-ink-3 hover:text-ink-1" aria-label="Clear search"><X className="h-3 w-3" /></button>}
            </div>
          )}
          <MultiFilterDropdown label="Filter by assignees" allLabel="All assignees" countLabel="assignees" options={assignees.map((assignee) => ({ value: assignee, label: assignee, ownerName: assignee }))} selected={filters.assignees} onChange={(assignees) => setFilters({ assignees })} />
          <MultiFilterDropdown label="Filter by work item types" allLabel="All types" countLabel="types" options={types.map((type) => ({ value: type, label: type }))} selected={filters.workItemTypes} onChange={(workItemTypes) => setFilters({ workItemTypes })} />
          <MultiFilterDropdown label="Filter by iterations" allLabel="All iterations" countLabel="iterations" options={iterationOptions} selected={filters.iterations} onChange={(iterations) => setFilters({ iterations })} />
          <MultiFilterDropdown label="Filter by tags" allLabel="All tags" countLabel="tags" options={tagOptions.map((tag) => ({ value: tag, label: tag }))} selected={filters.tags} onChange={(tags) => setFilters({ tags })} />
          {selectedWorkItemIds.length > 0 && (
            <span className="text-ink-2 flex shrink-0 items-center gap-2 text-xs">
              <span className="bg-acc/20 text-acc-ink rounded-full px-2 py-0.5 font-medium">
                {selectedWorkItemIds.length} selected
              </span>
              {selection?.onClearSelection && (
                <button type="button" className="hover:text-ink-1 underline" onClick={selection.onClearSelection}>
                  Clear
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          <ViewModeToggle viewMode={viewMode} onChange={handleViewModeChange} />
          {viewMode === 'board' && (
            <Tooltip align="right" content="Board colours">
              <button
                ref={colorMenuTriggerRef}
                type="button"
                onClick={() => setIsColorMenuOpen((open) => !open)}
                aria-label="Board colours"
                aria-expanded={isColorMenuOpen}
                className={clsx(
                  'hover:text-ink-1 rounded p-1',
                  isColorMenuOpen ? 'bg-bg-3 text-ink-0' : 'text-ink-3',
                )}
              >
                <Settings2 size={17} />
              </button>
            </Tooltip>
          )}
          <Tooltip
            align="right"
            content={
              lastRefreshedAt ? (
                <div>
                  <div>{formatRelativeTime(lastRefreshedAt.toISOString())}</div>
                  <div className="text-ink-3 text-[10px]">
                    {lastRefreshedAt.toLocaleString()}
                  </div>
                </div>
              ) : (
                'Not refreshed yet'
              )
            }
          >
            <button
              type="button"
              onClick={() => void refreshWorkItems()}
              disabled={isRefreshing}
              className="text-ink-3 hover:text-ink-1 rounded p-1 disabled:opacity-50"
              aria-label={isRefreshing ? 'Refreshing work items' : 'Refresh work items'}
            >
              <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} size={17} />
            </button>
          </Tooltip>
          {onClose && (
            <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink-1 rounded p-1" aria-label="Close Azure Board">
              <X size={17} />
            </button>
          )}
        </div>
      </header>
          {isColorMenuOpen && (
            <BoardColorSettingsMenu
              settings={colorSettings}
              onChange={setColorSettings}
              onReset={resetColorSettings}
              onClose={() => setIsColorMenuOpen(false)}
              tagOptions={tagOptions}
              columnNames={columns.map((column) => column.name)}
              activeTab={colorMenuTab}
              onActiveTabChange={setColorMenuTab}
              triggerRef={colorMenuTriggerRef}
            />
          )}
          {blockingBoardError ? (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div>
                <p role="alert" className="text-status-fail text-sm font-medium">
                  Failed to load Azure Board
                </p>
                <p className="text-ink-3 mt-1 max-w-lg text-xs">{blockingBoardError.message}</p>
                <button
                  type="button"
                  onClick={() => void refreshWorkItems()}
                  className="border-line bg-bg-2 hover:bg-bg-3 text-ink-1 mt-3 rounded border px-3 py-1.5 text-xs"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : isLoading ? (
            <div role="status" aria-label="Loading Azure Board" className="grid flex-1 place-items-center"><Loader2 aria-hidden="true" className="text-acc-ink h-6 w-6 animate-spin" /></div>
          ) : (
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {(boardWarnings.length > 0 || iterationFilter.status === 'partial' || iterationFilter.status === 'no-match') && (
              <div className="border-line bg-bg-2 text-ink-2 absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b px-3 py-1 text-xs">
                <span role={boardWarnings.length > 0 ? 'alert' : 'status'}>
                  {boardWarnings.length > 0
                    ? `Refresh failed: ${boardWarnings.join('; ')}`
                    : iterationFilter.status === 'partial'
                      ? 'Showing explicit iterations while current iteration is unresolved.'
                      : 'No current iteration is configured — showing all iterations.'}
                </span>
                {boardWarnings.length > 0 && (
                  <button type="button" onClick={() => void refreshWorkItems()} className="text-acc-ink ml-auto underline">
                    Retry
                  </button>
                )}
              </div>
            )}
            <BoardSplitPane
              initialBoardWidth={panelWidth}
              onBoardWidthCommit={handlePanelWidthCommit}
              board={
                viewMode === 'list' ? (
                  <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                    <WorkItemList
                      workItems={rankedVisibleItems}
                      highlightedWorkItemId={resolvedHighlightWorkItemId}
                      exactMatchWorkItemId={exactMatchWorkItemId}
                      selectedWorkItemIds={selectedWorkItemIds}
                      providerId={params.providerId}
                      search={filters.search}
                      showSelection={onToggleSelect !== undefined}
                      onToggleSelect={onToggleSelect}
                      onHighlight={handleBoardHighlight}
                    />
                  </div>
                ) : (
                  <WorkItemBoard
                    workItems={rankedVisibleItems}
                    boardColumns={columns}
                    highlightedWorkItemId={resolvedHighlightWorkItemId}
                    exactMatchWorkItemId={exactMatchWorkItemId}
                    selectedWorkItemIds={selectedWorkItemIds}
                    providerId={params.providerId}
                    search={filters.search}
                    currentIterationPath={currentIterationPath}
                    showSelection={onToggleSelect !== undefined}
                    onToggleSelect={onToggleSelect}
                    onHighlight={handleBoardHighlight}
                    onModifiedClick={handleBoardModifiedClick}
                    collapsedColumnIds={collapsedColumnIds}
                    onToggleColumn={handleToggleColumn}
                    childBugProgressByWorkItemId={childBugProgressByWorkItemId}
                    relatedBugWorkItemIds={relatedBugWorkItemIds}
                    onOpenChildBugs={handleOpenChildBugs}
                    variant="editorial"
                    parserSetting={project.workItemTitleParser}
                    colorSettings={colorSettings}
                  />
                )
              }
              details={selectedWorkItemId !== null ? (
                <aside
                 ref={detailsPaneRef}
                 tabIndex={-1}
                 aria-label="Work item details"
                 className="bg-bg-1 min-w-0 flex-1 overflow-hidden outline-none"
               >
                    {bugsForWorkItem && isRelatedBugsPanelOpen ? <RelatedBugsPanel
                      story={bugsForWorkItem}
                       bugs={relatedBugs}
                       parserSetting={project.workItemTitleParser}
                       onClose={closeDetailsPane}
                       onBack={() => {
                        setBugsForWorkItemId(null);
                        setIsRelatedBugsPanelOpen(false);
                       }}
                       onOpenBug={(bugId) => {
                         detailsPaneRef.current?.focus({ preventScroll: true });
                         setIsRelatedBugsPanelOpen(false);
                         setWorkItemStack([bugsForWorkItem.id, bugId]);
                       }}
                    /> : selectedWorkItem ? <div className="relative h-full">
                      {(detailedWorkItemQuery.isFetching || detailedWorkItemQuery.error) && (
                        <div className="border-line bg-bg-2 text-ink-3 absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b px-3 py-1 text-[10px]">
                          {detailedWorkItemQuery.error
                            ? `Could not refresh details: ${detailedWorkItemQuery.error.message}`
                            : 'Loading full details...'}
                          {detailedWorkItemQuery.error && (
                            <button type="button" onClick={() => void detailedWorkItemQuery.refetch()} className="text-acc-ink ml-auto underline">Retry</button>
                          )}
                        </div>
                      )}
                      <WorkItemPreview
                      workItem={selectedWorkItem}
                      projectId={project.id}
                      providerId={params.providerId}
                      workItemProjectId={params.projectId}
                      projectName={params.projectName}
                        editableMetadata
                        assigneeOptions={assignees}
                        iterationOptions={iterations.map((iteration) => ({
                          value: iteration.path,
                          label: iteration.name,
                        }))}
                        boardColumns={columns}
                        tagOptions={tagOptions}
                       showRelatedWorkItems
                       parserSetting={project.workItemTitleParser}
                      variant="editorial"
                      headerLeading={workItemStack.length > 1 ? <button
                        type="button"
                        onClick={() => {
                          if (bugsForWorkItem) {
                            setWorkItemStack([bugsForWorkItem.id]);
                            setIsRelatedBugsPanelOpen(true);
                            return;
                          }
                          setWorkItemStack((stack) => stack.slice(0, -1));
                        }}
                        className="text-ink-3 hover:bg-bg-3 hover:text-ink-1 -ml-1 shrink-0 p-1.5"
                        title={bugsForWorkItem ? 'Back to related bugs' : 'Back to previous work item'}
                        aria-label={bugsForWorkItem ? 'Back to related bugs' : 'Back to previous work item'}
                      >
                        <ArrowLeft size={14} />
                      </button> : undefined}
                      onOpenRelatedWorkItem={openRelatedWorkItem}
                      headerActions={selectedWorkItem && <AzureWorkItemActions workItem={selectedWorkItem} onCreateTask={onCreateTask ? () => onCreateTask(selectedWorkItem) : undefined} onClose={closeDetailsPane} />}
                      />
                     </div> : selectedWorkItemId !== null ? (
                      <div className="flex h-full flex-col">
                        <div className="border-line flex justify-end border-b px-4 py-3">
                          <IconButton size="sm" icon={<X />} tooltip="Close details pane" onClick={closeDetailsPane} />
                        </div>
                        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
                          {detailedWorkItemQuery.error ? <div>
                            <p role="alert" className="text-status-fail text-xs">Failed to load work item details: {detailedWorkItemQuery.error.message}</p>
                            <button type="button" onClick={() => void detailedWorkItemQuery.refetch()} className="border-line bg-bg-2 hover:bg-bg-3 text-ink-1 mt-2 rounded border px-2 py-1 text-xs">Retry</button>
                          </div> : detailedWorkItemQuery.isLoading ? (
                            <p className="text-ink-3 text-xs">Loading work item details...</p>
                          ) : (
                            <p role="alert" className="text-status-fail text-xs">Work item details are unavailable.</p>
                          )}
                        </div>
                      </div>
                    ) : <WorkItemPreview workItem={null} variant="editorial" />}
                </aside>
              ) : undefined}
            />
            </div>
          )}
    </div>
  );
}
