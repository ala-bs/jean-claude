/* eslint-disable sort-imports */
import { ArrowLeft, Bug, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw, Search, X } from 'lucide-react';
import {
  isWorkItemClosedState,
  pushWorkItemStack,
} from '@/features/work-item/ui-work-item-board/utils';
import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { getOwnerColor, normalizeOwnerName } from '@/features/work-item/utils-owner-color';
import {
  useBoardColumns,
  useIterations,
  useWorkItemById,
  useWorkItems,
  useWorkItemsByIds,
} from '@/hooks/use-work-items';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { BoardSplitPane } from '@/features/work-item/ui-azure-board-overlay/board-split-pane';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import { formatRelativeTime } from '@/lib/time';
import { Tooltip } from '@/common/ui/tooltip';
import {
  DEFAULT_AZURE_BOARD_FILTERS,
  EMPTY_AZURE_BOARD_COLUMN_IDS,
  useAzureBoardStore,
} from '@/stores/azure-board';
import { useNavigate } from '@tanstack/react-router';
import { useNewTaskDraftStore } from '@/stores/new-task-draft';
import { useOverlaysStore } from '@/stores/overlays';
import { useQueryClient } from '@tanstack/react-query';
import { UserAvatar } from '@/common/ui/user-avatar';
import { WorkItemBoard } from '@/features/work-item/ui-work-item-board';
import { WorkItemPreview } from '@/features/work-item/ui-work-item-preview';
import type { Project } from '@shared/types';
import {
  buildAzureBoardBaseModel,
  buildAzureBoardRelationshipModel,
  resolveAzureBoardIterationFilter,
} from './build-board-model';

export type ConfiguredAzureBoardProject = Project & {
  workItemProviderId: string;
  workItemProjectId: string;
  workItemProjectName: string;
};

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
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function RelatedBugsPanel({
  story,
  bugs,
  onBack,
  onOpenBug,
}: {
  story: AzureDevOpsWorkItem;
  bugs: AzureDevOpsWorkItem[];
  onBack: () => void;
  onOpenBug: (bugId: number) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-line-soft flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <button type="button" onClick={onBack} className="text-ink-3 hover:bg-bg-3 hover:text-ink-1 -ml-1 p-1" aria-label="Back to work item details">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-ink-3 mb-0.5 font-mono text-[10px]">#{story.id} · related bugs</div>
          <div className="text-ink-0 truncate text-sm font-semibold">{story.fields.title}</div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5">
        {bugs.map((bug) => {
          const isClosed = isWorkItemClosedState(bug.fields.state);
          return (
            <button
              key={bug.id}
              type="button"
              onClick={() => onOpenBug(bug.id)}
              className={isClosed
                ? 'border-line bg-bg-2 hover:bg-bg-3 border-l-status-done flex w-full flex-col border border-l-[3px] px-3 py-2.5 text-left transition-colors'
                : 'border-line bg-bg-2 hover:bg-bg-3 border-l-status-fail flex w-full flex-col border border-l-[3px] px-3 py-2.5 text-left transition-colors'}
            >
              <span className="mb-1.5 flex w-full items-center gap-1.5">
                <Bug className={isClosed ? 'text-status-done h-3 w-3' : 'text-status-fail h-3 w-3'} />
                <span className="text-ink-3 font-mono text-[10px]">#{bug.id}</span>
                <span className={isClosed ? 'bg-status-done/15 text-status-done ml-auto px-1.5 py-0.5 font-mono text-[9px]' : 'bg-status-fail/15 text-status-fail ml-auto px-1.5 py-0.5 font-mono text-[9px]'}>
                  {bug.fields.state}
                </span>
                <ChevronRight className="text-ink-3 h-3 w-3" />
              </span>
              <span className="text-ink-0 mb-1 text-xs font-semibold leading-snug">{bug.fields.title}</span>
              <span className="text-ink-2 line-clamp-3 text-xs leading-relaxed">{workItemSummary(bug)}</span>
            </button>
          );
        })}
        {bugs.length === 0 && <p className="text-ink-3 text-xs italic">No related bugs.</p>}
      </div>
    </div>
  );
}

export function AzureBoardProjectContent({
  project,
  onClose,
  headerLeading,
}: {
  project: ConfiguredAzureBoardProject;
  onClose: () => void;
  headerLeading: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [workItemStack, setWorkItemStack] = useState<number[]>([]);
  const [highlightedBoardWorkItemId, setHighlightedBoardWorkItemId] = useState<number | null>(null);
  const [bugsForWorkItemId, setBugsForWorkItemId] = useState<number | null>(null);
  const [isRelatedBugsPanelOpen, setIsRelatedBugsPanelOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);
  const detailsPaneRef = useRef<HTMLElement>(null);
  const projectFilters = useAzureBoardStore(
    (state) => state.filtersByProject[project.id],
  );
  const filters = projectFilters ?? DEFAULT_AZURE_BOARD_FILTERS;
  const setFilters = useAzureBoardStore((state) => state.setFilters);
  const panelWidth = useAzureBoardStore((state) => state.panelWidth);
  const setPanelWidth = useAzureBoardStore((state) => state.setPanelWidth);
  const projectCollapsedColumnIds = useAzureBoardStore(
    (state) => state.collapsedColumnIdsByProject[project.id],
  );
  const collapsedColumnIds =
    projectCollapsedColumnIds ?? EMPTY_AZURE_BOARD_COLUMN_IDS;
  const toggleCollapsedColumn = useAzureBoardStore(
    (state) => state.toggleCollapsedColumn,
  );
  const debouncedSearchText = useDebouncedValue(filters.search, 250);
  const params = {
    providerId: project.workItemProviderId,
    projectId: project.workItemProjectId,
    projectName: project.workItemProjectName,
  };
  const baseFilters = { excludeWorkItemTypes: ['Test Suite', 'Test Plan'] };
  const metadataQuery = useWorkItems({
    ...params,
    enabled: true,
    refetchOnMount: 'always',
    filters: baseFilters,
  });
  const metadataItems = metadataQuery.data ?? [];
  const iterationsQuery = useIterations({ ...params, refetchOnMount: 'always' });
  const iterations = iterationsQuery.data ?? [];
  const hasUsableIterations = iterationsQuery.data !== undefined;
  const iterationFilter = resolveAzureBoardIterationFilter({
    iterations,
    selectedIterations: filters.iterations,
    iterationsStatus:
      iterationsQuery.isError && hasUsableIterations
        ? 'success'
        : iterationsQuery.status,
  });
  const itemsQuery = useWorkItems({
    ...params,
    enabled:
      iterationFilter.status === 'resolved' || iterationFilter.status === 'partial',
    refetchOnMount: 'always',
    filters: {
      ...baseFilters,
      searchText: debouncedSearchText || undefined,
      workItemTypes:
        filters.workItemTypes.length > 0 ? filters.workItemTypes : undefined,
      iterationPaths:
        iterationFilter.paths.length > 0 ? iterationFilter.paths : undefined,
    },
  });
  const items =
    iterationFilter.status === 'resolved' || iterationFilter.status === 'partial'
      ? (itemsQuery.data ?? [])
      : [];
  const isLoading =
    iterationFilter.status === 'pending' ||
    (itemsQuery.isLoading && items.length === 0);
  const columnsQuery = useBoardColumns({
    ...params,
    enabled: true,
    refetchOnMount: 'always',
  });
  const columns = columnsQuery.data ?? [];
  const {
    visibleItems,
    types,
    assignees,
    tagOptions,
    iterationOptions,
    storyLinkedWorkItemIds,
  } = buildAzureBoardBaseModel({ metadataItems, items, iterations, filters });
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
  const { childBugProgressByWorkItemId, bugsForWorkItem, relatedBugs } =
    buildAzureBoardRelationshipModel({
      visibleItems,
      childWorkItems: childWorkItemsQuery.data ?? [],
      bugsForWorkItemId,
    });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      itemsQuery.isFetching ||
      rootWorkItemId === null ||
      visibleItems.some((item) => item.id === rootWorkItemId)
    ) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setWorkItemStack([]);
    });
    return () => {
      cancelled = true;
    };
  }, [itemsQuery.isFetching, rootWorkItemId, visibleItems]);

  const refreshWorkItems = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    try {
      const [metadataResult, iterationsResult, itemsResult] = await Promise.all([
        metadataQuery.refetch(),
        iterationsQuery.refetch(),
        iterationFilter.status === 'resolved' || iterationFilter.status === 'partial'
          ? itemsQuery.refetch()
          : Promise.resolve(null),
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

  const createTask = (item: AzureDevOpsWorkItem) => {
    const draft = useNewTaskDraftStore.getState();
    draft.setSelectedProjectId(project.id);
    draft.setDraft(project.id, {
      inputMode: 'search',
      searchStep: 'compose',
      workItemIds: [String(item.id)],
    });
    useOverlaysStore.getState().open('new-task');
  };
  const openDetails = (item: AzureDevOpsWorkItem) => {
    onClose();
    void navigate({
      to: '/all/work-items/$projectId/$workItemId',
      params: { projectId: project.id, workItemId: String(item.id) },
    });
  };
  const openRelatedWorkItem = (workItemId: number) => {
    setWorkItemStack((stack) => pushWorkItemStack(stack, workItemId));
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-line flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <div className="flex shrink-0 items-center gap-2">{headerLeading}</div>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <div className="bg-bg-1 border-line flex min-w-40 max-w-80 flex-1 items-center gap-2 rounded-md border px-2.5 py-1.5">
            <Search className="text-ink-3 h-3.5 w-3.5 shrink-0" />
            <input aria-label="Search work items" value={filters.search} onChange={(event) => setFilters(project.id, { search: event.target.value })} placeholder="Search work items..." className="text-ink-1 min-w-0 flex-1 bg-transparent text-xs outline-none" />
            {filters.search && <button type="button" onClick={() => setFilters(project.id, { search: '' })} className="text-ink-3 hover:text-ink-1" aria-label="Clear search"><X className="h-3 w-3" /></button>}
          </div>
          <MultiFilterDropdown label="Filter by assignees" allLabel="All assignees" countLabel="assignees" options={assignees.map((assignee) => ({ value: assignee, label: assignee, ownerName: assignee }))} selected={filters.assignees} onChange={(assignees) => setFilters(project.id, { assignees })} />
          <MultiFilterDropdown label="Filter by work item types" allLabel="All types" countLabel="types" options={types.map((type) => ({ value: type, label: type }))} selected={filters.workItemTypes} onChange={(workItemTypes) => setFilters(project.id, { workItemTypes })} />
          <MultiFilterDropdown label="Filter by iterations" allLabel="All iterations" countLabel="iterations" options={iterationOptions} selected={filters.iterations} onChange={(iterations) => setFilters(project.id, { iterations })} />
          <MultiFilterDropdown label="Filter by tags" allLabel="All tags" countLabel="tags" options={tagOptions.map((tag) => ({ value: tag, label: tag }))} selected={filters.tags} onChange={(tags) => setFilters(project.id, { tags })} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink-1 rounded p-1" aria-label="Close Azure Board">
            <X size={17} />
          </button>
        </div>
      </header>
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
            <div className="grid flex-1 place-items-center"><Loader2 className="text-acc-ink h-6 w-6 animate-spin" /></div>
          ) : (
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {(boardWarnings.length > 0 || iterationFilter.status === 'partial' || iterationFilter.status === 'no-match') && (
              <div className="border-line bg-bg-2 text-ink-2 absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b px-3 py-1 text-xs">
                <span role={boardWarnings.length > 0 ? 'alert' : 'status'}>
                  {boardWarnings.length > 0
                    ? `Refresh failed: ${boardWarnings.join('; ')}`
                    : iterationFilter.status === 'partial'
                      ? 'Showing explicit iterations while current iteration is unresolved.'
                      : 'No current iteration is configured.'}
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
              onBoardWidthCommit={setPanelWidth}
              board={
                <WorkItemBoard
                  workItems={visibleItems}
                  boardColumns={columns}
                  highlightedWorkItemId={highlightedBoardWorkItemId?.toString() ?? null}
                  selectedWorkItemIds={[]}
                  providerId={params.providerId}
                  search={filters.search}
                  showSelection={false}
                  onHighlight={(item) => {
                    setBugsForWorkItemId(null);
                    setIsRelatedBugsPanelOpen(false);
                    setHighlightedBoardWorkItemId(item.id);
                    setWorkItemStack([item.id]);
                  }}
                  onModifiedClick={(item) => window.open(item.url, '_blank')}
                  collapsedColumnIds={
                     collapsedColumnIds
                   }
                   onToggleColumn={(columnId) => {
                      toggleCollapsedColumn(project.id, columnId);
                   }}
                  childBugProgressByWorkItemId={childBugProgressByWorkItemId}
                  relatedBugWorkItemIds={relatedBugs.map((bug) => bug.id)}
                  onOpenChildBugs={(item) => {
                    setBugsForWorkItemId(item.id);
                    setIsRelatedBugsPanelOpen(true);
                    setHighlightedBoardWorkItemId(item.id);
                    setWorkItemStack([item.id]);
                  }}
                  variant="editorial"
                />
              }
              details={
                <aside
                 ref={detailsPaneRef}
                 tabIndex={-1}
                 aria-label="Work item details"
                 className="bg-bg-1 min-w-0 flex-1 overflow-hidden outline-none"
               >
                    {bugsForWorkItem && isRelatedBugsPanelOpen ? <RelatedBugsPanel
                      story={bugsForWorkItem}
                      bugs={relatedBugs}
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
                      providerId={params.providerId}
                      projectName={params.projectName}
                      editableMetadata
                      assigneeOptions={assignees}
                      showRelatedWorkItems
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
                      headerActions={selectedWorkItem && <><button type="button" onClick={() => createTask(selectedWorkItem)} className="text-ink-1 hover:bg-bg-3 px-2 py-1 text-xs font-medium" title="Create local task">Create task</button><button type="button" onClick={() => openDetails(selectedWorkItem)} className="text-ink-3 hover:bg-bg-3 hover:text-ink-1 p-1.5" title="Open full details" aria-label="Open full details"><ExternalLink size={14} /></button></>}
                     />
                    </div> : selectedWorkItemId !== null ? (
                      <div className="grid h-full place-items-center px-6 text-center">
                        {detailedWorkItemQuery.error ? <div>
                          <p role="alert" className="text-status-fail text-xs">Failed to load work item details: {detailedWorkItemQuery.error.message}</p>
                          <button type="button" onClick={() => void detailedWorkItemQuery.refetch()} className="border-line bg-bg-2 hover:bg-bg-3 text-ink-1 mt-2 rounded border px-2 py-1 text-xs">Retry</button>
                        </div> : detailedWorkItemQuery.isLoading ? (
                          <p className="text-ink-3 text-xs">Loading work item details...</p>
                        ) : (
                          <p role="alert" className="text-status-fail text-xs">Work item details are unavailable.</p>
                        )}
                      </div>
                    ) : <WorkItemPreview workItem={null} variant="editorial" />}
                </aside>
              }
            />
            </div>
          )}
    </div>
  );
}
