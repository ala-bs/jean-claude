import {
  ChevronRight,
  ExternalLink,
  FileText,
  FlaskConical,
  History,
  Link2,
  MessagesSquare,
  RefreshCw,
} from 'lucide-react';
import {
  FIELD_ASSIGNED_TO,
  FIELD_BOARD_COLUMN,
  FIELD_ITERATION_PATH,
  FIELD_PRIORITY,
  FIELD_STATE,
  FIELD_STORY_POINTS,
  FIELD_TAGS,
  getAcceptanceCriteriaHtml,
  getAssignee,
  getDescriptionHtml,
  getIterationPath,
  getPriority,
  getReproStepsHtml,
  getState,
  getStoryPoints,
  getStringField,
  getTitle,
  getWorkItemType,
} from '@shared/work-item-field-types';
import {
  memo,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';


import type { AzureDevOpsBoardColumn, AzureDevOpsWorkItem } from '@/lib/api';

import { FindInViewBar, useFindInView } from '@/common/ui/find-in-view';
import {
  useAddWorkItemComment,
  useCurrentAzureUser,
  useRelatedTestCases,
  useUpdateWorkItemComment,
  useUpdateWorkItemField,
  useWorkItemComments,
  useWorkItemHistory,
  useWorkItemOwners,
  useWorkItemsByIds,
  useWorkItemStates,
} from '@/hooks/use-work-items';
import {
  AzureHtmlContent,
  AzureWorkItemDescription,
} from '@/features/common/ui-azure-html-content';
import { canShowWorkItemSummary } from '@/lib/work-item-summary';
import { Kbd } from '@/common/ui/kbd';
import { ParsedWorkItemTitle } from '@/features/work-item/ui-parsed-work-item-title';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useWorkItemCommentsPaneWidth } from '@/stores/navigation';
import { useWorkItemModalStore } from '@/stores/work-item-modal';
import { WorkItemGeneratedSummary } from '@/features/work-item/ui-work-item-generated-summary';



import {
  addOpenedCommentsWorkItemId,
  getWorkItemPreviewQueryPolicy,
} from './query-policy';
import {
  collectExtraFieldRefNames,
  resolveDetailLayout,
} from '@shared/work-item-display-config-types';
import {
  getOwnerOptions,
  WorkItemOwnerEditor,
} from '../ui-work-item-field-editors/work-item-owner-editor';
import { useProject } from '@/hooks/use-projects';
import { useWorkItemFieldMetadataMap } from '@/hooks/use-work-items';
import { WorkItemBoardColumnEditor } from '../ui-work-item-board-column-editor';
import { WorkItemComments } from '../ui-work-item-comments';
import { WorkItemExpandableTestCase } from '../ui-work-item-expandable-test-case';
import { WorkItemFieldRows } from '../ui-work-item-field-rows';
import { WorkItemHistory } from '../ui-work-item-history';
import { WorkItemIterationEditor } from '../ui-work-item-field-editors/work-item-iteration-editor';
import { WorkItemMetadataValue } from '../ui-work-item-field-editors/work-item-metadata-value';
import { WorkItemStateEditor } from '../ui-work-item-field-editors/work-item-state-editor';
import { WorkItemTabButton } from '../ui-work-item-tab-button';
import { WorkItemTagEditor } from '../ui-work-item-tag-editor';
import { WorkItemTypeIcon } from '../ui-work-item-shared';
import {
  AssociatedWorkItemTasks,
  useAssociatedWorkItemTasks,
} from '../ui-associated-work-item-tasks';
type DetailsTab = 'content' | 'comments' | 'history' | 'test-cases';

/**
 * Memoized: this renders the highlighted work item's description through a full
 * markdown/HTML pipeline. It sits beside the work-item search box, so without
 * this it re-parsed the description on every filter keystroke even though none
 * of its props changed.
 */
export const WorkItemPreview = memo(function WorkItemPreview({
  workItem,
  projectId,
  providerId,
  workItemProjectId,
  projectName,
  showCommentsAside = false,
  readOnly = false,
  editableMetadata = false,
  iterationOptions = [],
  boardColumns = [],
  tagOptions = [],
  showRelatedWorkItems = false,
  onOpenRelatedWorkItem,
  onOpenInBrowser,
  headerLeading,
  headerActions,
  variant = 'default',
  parserSetting = null,
}: {
  workItem: AzureDevOpsWorkItem | null;
  projectId?: string;
  providerId?: string;
  workItemProjectId?: string;
  projectName?: string;
  showCommentsAside?: boolean;
  readOnly?: boolean;
  editableMetadata?: boolean;
  iterationOptions?: Array<{
    value: string;
    label: string;
    /** Marks the active sprint so the shared dropdown can flag it. */
    isCurrent?: boolean;
  }>;
  boardColumns?: AzureDevOpsBoardColumn[];
  tagOptions?: string[];
  showRelatedWorkItems?: boolean;
  onOpenRelatedWorkItem?: (workItemId: number) => void;
  onOpenInBrowser?: () => void;
  headerLeading?: ReactNode;
  headerActions?: ReactNode;
  variant?: 'default' | 'editorial';
  parserSetting?: WorkItemTitleParserSetting | null;
}) {
  const workItemId = workItem?.id ?? null;
  const {
    tasks: associatedTasks,
    isLoading: isLoadingAssociatedTasks,
    error: associatedTasksError,
  } = useAssociatedWorkItemTasks(workItemId ?? 0);
  const [activeTab, setActiveTab] = useState<DetailsTab>('content');
  const [openedCommentsWorkItemIds, setOpenedCommentsWorkItemIds] = useState(
    () => new Set<number>(),
  );
  const workItemState = workItem ? getState(workItem) : '';
  const assigneeName = workItem ? getAssignee(workItem)?.displayName : undefined;
  const assigneeUniqueName = workItem
    ? getAssignee(workItem)?.uniqueName
    : undefined;
  const {
    width: commentsPaneWidth,
    setWidth: setCommentsPaneWidth,
    minWidth: minCommentsPaneWidth,
    maxWidth: maxCommentsPaneWidth,
  } = useWorkItemCommentsPaneWidth();
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const commentsPaneRef = useRef<HTMLDivElement>(null);
  const contentPaneRef = useRef<HTMLDivElement>(null);
  // The full details modal renders its own find bar on top of this pane; only
  // one ⌘F owner may be active at a time (bindings are LIFO, not scoped).
  const isWorkItemModalOpen = useWorkItemModalStore(
    (state) => state.target !== null,
  );
  const findInputRef = useRef<{ focus: () => void }>(null);
  const find = useFindInView({
    containerRef: contentPaneRef,
    inputRef: findInputRef,
    contentKey: String(workItemId),
    enabled: !isWorkItemModalOpen,
  });
  const isEditorial = variant === 'editorial';
  const { containerRef, isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: commentsPaneWidth,
    minWidth: minCommentsPaneWidth,
    maxWidth: maxCommentsPaneWidth,
    maxWidthFraction: 0.6,
    direction: 'left',
    onWidthChange: setCommentsPaneWidth,
    resizeTargetRef: commentsPaneRef,
  });
  // Per-project display config. A `null` config resolves to each surface's own
  // hardcoded default, so an unconfigured project renders exactly as before.
  // Resolved here, above the `!workItem` bail-out, because the tab visibility
  // it yields also has to gate the comment/history queries below.
  const { data: project } = useProject(projectId ?? '');
  const displayConfig = project?.workItemDisplayConfig ?? null;
  // The preview has two variants with different hardcoded defaults, so each
  // asks for its own surface (decision 24).
  const detailLayout = resolveDetailLayout(
    displayConfig,
    workItem ? getWorkItemType(workItem) : '',
    isEditorial ? 'preview-editorial' : 'preview-readonly',
  );
  // Unknown ids stay visible: a config that predates a tab must not hide it.
  const isTabVisible = (tabId: string) =>
    detailLayout.tabs.find((tab) => tab.id === tabId)?.visible !== false;
  // The aside is the comments tab in another layout, so the config has to gate
  // it too — otherwise hiding Comments removes the tab but leaves the aside
  // rendering (and fetching) the very comments it hid.
  const showCommentsAsidePane = showCommentsAside && isTabVisible('comments');
  const queryPolicy = getWorkItemPreviewQueryPolicy({
    variant,
    showCommentsAside: showCommentsAsidePane,
    commentsTabActive: activeTab === 'comments' && isTabVisible('comments'),
    historyTabActive: activeTab === 'history' && isTabVisible('history'),
    workItemId,
    openedCommentsWorkItemIds,
  });
  const {
    data: comments = [],
    isLoading: isLoadingComments,
    isSuccess: hasLoadedComments,
    error: commentsError,
  } = useWorkItemComments({
    providerId: providerId ?? null,
    projectName: projectName ?? null,
    workItemIds: workItemId ? [workItemId] : [],
    enabled: queryPolicy.comments,
  });
  const {
    data: history = [],
    isLoading: isLoadingHistory,
    error: historyError,
  } = useWorkItemHistory({
    providerId: providerId ?? null,
    projectName: projectName ?? null,
    workItemId,
    enabled: queryPolicy.history,
  });

  const {
    data: relatedTestCases = [],
    isLoading: isLoadingTestCases,
    error: relatedTestCasesError,
    refetch: refetchRelatedTestCases,
  } = useRelatedTestCases({
      providerId: providerId ?? null,
      projectName: projectName ?? null,
      workItemId,
      enabled: queryPolicy.relatedTestCases,
    });
  const { data: availableStates = [] } =
    useWorkItemStates({
      providerId: providerId ?? null,
      projectName: projectName ?? null,
      workItemType: workItem ? getWorkItemType(workItem) : null,
    });
  const { data: currentAzureUser } = useCurrentAzureUser(providerId ?? null);
  // Shared owner option model (decision 28): keyed by uniqueName/email with an
  // explicit "Unassigned" entry. Sourced from the owners query, not from the
  // display-name `assigneeOptions` prop — mixing the two value spaces listed
  // the current owner twice and made the display-name copy write a display
  // name into System.AssignedTo.
  const { data: workItemOwners } = useWorkItemOwners({
    providerId: providerId ?? null,
    projectName: projectName ?? null,
  });
  const ownerDropdownOptions = useMemo(
    () =>
      getOwnerOptions(workItemOwners ?? [], assigneeName, assigneeUniqueName, {
        displayName: currentAzureUser?.displayName,
        uniqueName: currentAzureUser?.emailAddress,
      }),
    [
      workItemOwners,
      assigneeName,
      assigneeUniqueName,
      currentAzureUser?.displayName,
      currentAzureUser?.emailAddress,
    ],
  );
  const fieldMetadata = useWorkItemFieldMetadataMap({
    providerId,
    azureProjectId: workItemProjectId,
  });
  const extraFieldRefNames = useMemo(
    () => collectExtraFieldRefNames(displayConfig),
    [displayConfig],
  );
  const addComment = useAddWorkItemComment();
  const updateComment = useUpdateWorkItemComment();
  const updateField = useUpdateWorkItemField();
  const relatedIds = showRelatedWorkItems
    ? [
        ...(workItem?.parentId ? [workItem.parentId] : []),
        ...(workItem?.childIds ?? []),
        ...(workItem?.relatedWorkItemIds ?? []),
      ]
    : [];
  const {
    data: relatedWorkItems = [],
    isLoading: isLoadingRelatedWorkItems,
    error: relatedWorkItemsError,
  } =
    useWorkItemsByIds({
      providerId: providerId ?? null,
      projectName: projectName ?? null,
      workItemIds: [...new Set(relatedIds)],
      extraFieldRefNames,
    });

  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    if (!workItemId) return;
    setIsRefreshing(true);
    const keys = [
      'work-item',
      'work-items',
      'work-items-by-ids',
      'work-item-comments',
      'work-item-history',
      'related-test-cases',
      'related-test-cases-batch',
      'pull-request-work-items',
    ];
    void queryClient
      .invalidateQueries({
        predicate: (query) => keys.includes(query.queryKey[0] as string),
      })
      .finally(() => setIsRefreshing(false));
  }, [queryClient, workItemId]);

  const hasTestCases = relatedTestCases.length > 0 || !!relatedTestCasesError;
  const canEditMetadata = editableMetadata && !readOnly;

  useEffect(() => {
    if (!hasTestCases && activeTab === 'test-cases') {
      startTransition(() => setActiveTab('content'));
    }
    if (showCommentsAside && activeTab === 'comments') {
      startTransition(() => setActiveTab('content'));
    }
  }, [hasTestCases, activeTab, showCommentsAside]);

  useEffect(() => {
    if (activeTab !== 'comments' || workItemId === null) return;
    startTransition(() => {
      setOpenedCommentsWorkItemIds((openedIds) =>
        addOpenedCommentsWorkItemId(openedIds, workItemId),
      );
    });
  }, [activeTab, workItemId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => setContainerWidth(container.offsetWidth);
    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [containerRef]);

  // Must stay above the `!workItem` bail-out below: a hook called after an
  // early return changes the hook count between renders, and this component
  // legitimately renders with a null work item (the work-activity overlay, and
  // a 404 from getWorkItemById both produce one).
  const iterationEditorOptions = useMemo(
    () =>
      iterationOptions.map((iteration) => ({
        name: iteration.label,
        path: iteration.value,
        isCurrent: iteration.isCurrent ?? false,
      })),
    [iterationOptions],
  );

  if (!workItem) {
    return (
      <div className="flex h-full min-h-37.5 items-center justify-center px-6">
        <p className="text-ink-4 text-center text-xs italic">Select a work item</p>
      </div>
    );
  }

  const { id } = workItem;
  const workItemType = getWorkItemType(workItem);
  const assignedTo = assigneeName;
  const title = getTitle(workItem);
  const description = isTabVisible('description')
    ? getDescriptionHtml(workItem)
    : undefined;
  const acceptanceCriteria = isTabVisible('acceptanceCriteria')
    ? getAcceptanceCriteriaHtml(workItem)
    : undefined;
  const reproSteps = isTabVisible('reproSteps')
    ? getReproStepsHtml(workItem)
    : undefined;
  const iterationPath = getIterationPath(workItem);
  const storyPoints = getStoryPoints(workItem);
  const priority = getPriority(workItem);
  const tags = getStringField(workItem, FIELD_TAGS);
  const hasReproSteps = workItemType === 'Bug' && !!reproSteps;
  const hasContent = !!description || !!acceptanceCriteria || hasReproSteps;
  const showCommentsTab = !showCommentsAsidePane && isTabVisible('comments');
  const showHistoryTab = isTabVisible('history');
  const showTestCases =
    hasTestCases && !isEditorial && isTabVisible('testCases');
  // A tab the config hides must not stay selected — derived rather than
  // corrected in an effect, because everything here runs after the `!workItem`
  // bail-out and a hook below it would change the render's hook count.
  const effectiveTab =
    (activeTab === 'comments' && !showCommentsTab) ||
    (activeTab === 'history' && !showHistoryTab) ||
    (activeTab === 'test-cases' && !showTestCases)
      ? 'content'
      : activeTab;
  const summaryRequest = canShowWorkItemSummary({
    projectId,
    providerId,
    projectName,
    workItemId: id,
  })
    ? {
        projectId: projectId!,
        providerId: providerId!,
        projectName: projectName!,
        workItemId: id,
      }
    : null;
  const commentsPaneMaxWidth = Math.max(
    minCommentsPaneWidth,
    Math.min(maxCommentsPaneWidth, Math.floor(containerWidth * 0.6)),
  );
  const effectiveCommentsPaneWidth = Math.min(
    Math.max(commentsPaneWidth, minCommentsPaneWidth),
    commentsPaneMaxWidth,
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {(editableMetadata || headerLeading || headerActions || !!workItemId) && <div className={isEditorial ? 'border-line border-b px-4 py-3' : 'border-glass-border border-b px-3 py-2.5'}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <WorkItemTypeIcon type={workItemType} size="sm" variant={variant} />
              <span className="text-ink-3 font-mono text-[10px]">#{id} · {workItemType}</span>
            </div>
            <div className="mt-1 flex items-start gap-1.5">
              {headerLeading}
              {canEditMetadata && providerId ? (
                <WorkItemMetadataValue
                  key={`${id}:title:${title}`}
                  value={title}
                  label="Title"
                  className="text-ink-0 block min-w-0 flex-1 text-left text-sm font-semibold leading-snug"
                  displayValue={parserSetting ? (
                    <ParsedWorkItemTitle
                      title={title}
                      parserSetting={parserSetting}
                      titleClassName="text-ink-0 text-sm font-semibold leading-snug"
                      titleElement="span"
                      inline
                    />
                  ) : undefined}
                  fullWidth
                  validate={(value) => value.trim() ? null : 'Title cannot be empty'}
                  onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.Title', value })}
                />
              ) : (
                parserSetting ? <div className="min-w-0 flex-1"><ParsedWorkItemTitle
                  title={title}
                  parserSetting={parserSetting}
                  titleClassName="text-ink-0 text-sm font-medium"
                  titleElement="h3"
                /></div> : <h3 className="text-ink-0 min-w-0 flex-1 text-sm font-medium">{title}</h3>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!!workItemId && (
              <button
                type="button"
                onClick={handleRefresh}
                disabled={isRefreshing}
                title="Refresh work item"
                className="text-ink-3 hover:text-ink-1 flex items-center rounded p-1 transition-colors disabled:opacity-60"
              >
                <RefreshCw
                  className={isRefreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                />
              </button>
            )}
            {headerActions}
          </div>
        </div>
        <div className="min-w-0">
          {isEditorial && (
            <div className="mt-2 space-y-2">
              {/* Config-driven metadata region. Each row hosts the panel's own
                  inline editor, so ordering/visibility is configurable without
                  changing any editing behaviour (decision 22). */}
              <WorkItemFieldRows
                workItem={workItem}
                rows={detailLayout.rows}
                metadata={fieldMetadata}
                variant="detail"
                containerClassName="flex flex-wrap gap-2"
                layout="inline"
                editors={{
                  [FIELD_ASSIGNED_TO]: () =>
                    providerId ? (
                      <WorkItemOwnerEditor
                        key={`${id}:owner`}
                        owner={assignedTo}
                        ownerValue={assigneeUniqueName}
                        options={ownerDropdownOptions}
                        disabled={!canEditMetadata}
                        error={null}
                        onRetry={() => {}}
                        providerId={providerId}
                        workItemId={id}
                      />
                    ) : null,
                  [FIELD_STATE]: () => (
                    <WorkItemStateEditor
                      key={`${id}:state`}
                      state={workItemState}
                      states={availableStates.map((state) => state.name)}
                      providerId={canEditMetadata ? providerId : undefined}
                      workItemId={id}
                    />
                  ),
                  [FIELD_BOARD_COLUMN]: () =>
                    canEditMetadata && providerId && workItemProjectId && projectName && boardColumns.length > 0 ? (
                      <WorkItemBoardColumnEditor
                        key={`${id}:column`}
                        workItem={workItem}
                        providerId={providerId}
                        projectId={workItemProjectId}
                        projectName={projectName}
                        columns={boardColumns}
                      />
                    ) : null,
                  // Decision 30: shown even when the item has no iteration.
                  [FIELD_ITERATION_PATH]: () =>
                    providerId ? (
                      <WorkItemIterationEditor
                        key={`${id}:iteration`}
                        iterationPath={iterationPath}
                        options={iterationEditorOptions}
                        disabled={!canEditMetadata}
                        providerId={providerId}
                        workItemId={id}
                      />
                    ) : null,
                  [FIELD_STORY_POINTS]: () =>
                    canEditMetadata && providerId ? (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-ink-3">Story points:</span>
                        <WorkItemMetadataValue
                          key={`${id}:story-points:${storyPoints ?? ''}`}
                          value={String(storyPoints ?? '')}
                          label="Story points"
                          emptyLabel="None"
                          className="hover:text-acc-ink"
                          validate={(value) => {
                            if (value === '') return null;
                            const points = Number(value);
                            return Number.isInteger(points) && points >= 0
                              ? null
                              : 'Story points must be a non-negative integer';
                          }}
                          onSave={(value) => updateField.mutateAsync({
                            providerId,
                            workItemId: id,
                            field: 'Microsoft.VSTS.Scheduling.StoryPoints',
                            value: value === '' ? null : Number(value),
                          })}
                        />
                      </div>
                    ) : null,
                  [FIELD_PRIORITY]: () =>
                    canEditMetadata && providerId ? (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-ink-3">Priority:</span>
                        <WorkItemMetadataValue
                          key={`${id}:priority:${priority ?? ''}`}
                          value={String(priority ?? '')}
                          label="Priority"
                          emptyLabel="None"
                          className="hover:text-acc-ink"
                          validate={(value) => {
                            const priority = Number(value);
                            return Number.isInteger(priority) && priority >= 1 && priority <= 4
                              ? null
                              : 'Priority must be an integer from 1 to 4';
                          }}
                          onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'Microsoft.VSTS.Common.Priority', value: Number(value) })}
                        />
                      </div>
                    ) : null,
                  // `w-full` reproduces the tag editor's own line below the
                  // wrapping metadata row.
                  [FIELD_TAGS]: () =>
                    providerId && canEditMetadata ? (
                      <div className="w-full">
                        <WorkItemTagEditor
                          key={`${id}:tags:${tags ?? ''}`}
                          value={tags ?? ''}
                          suggestions={tagOptions}
                          onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.Tags', value })}
                        />
                      </div>
                    ) : null,
                }}
              />
            </div>
          )}
          {!isEditorial && providerId && !canEditMetadata && (
            <WorkItemTagEditor
              key={`${id}:tags:${tags ?? ''}`}
              value={tags ?? ''}
              suggestions={tagOptions}
              readOnly
              onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.Tags', value })}
            />
          )}
        </div>
      </div>}
       <div className={isEditorial ? 'border-line flex gap-1 border-b px-3 pt-2' : 'border-glass-border flex gap-0 border-b'}>
        <WorkItemTabButton
          dense
          active={effectiveTab === 'content'}
          onClick={() => setActiveTab('content')}
          icon={<FileText className="h-3.5 w-3.5" />}
          label="Content"
        />
        {showCommentsTab && (
          <WorkItemTabButton
            dense
            active={effectiveTab === 'comments'}
            onClick={() => {
              setOpenedCommentsWorkItemIds((openedIds) =>
                addOpenedCommentsWorkItemId(openedIds, id),
              );
              setActiveTab('comments');
            }}
            icon={<MessagesSquare className="h-3.5 w-3.5" />}
            label="Comments"
            count={
              queryPolicy.comments && hasLoadedComments && !commentsError
                ? comments.length
                : undefined
            }
          />
        )}
        {showHistoryTab && (
          <WorkItemTabButton
            dense
            active={effectiveTab === 'history'}
            onClick={() => setActiveTab('history')}
            icon={<History className="h-3.5 w-3.5" />}
            label="History"
            count={history.length}
          />
        )}
        {showTestCases && (
          <WorkItemTabButton
            dense
            active={effectiveTab === 'test-cases'}
            onClick={() => setActiveTab('test-cases')}
            icon={<FlaskConical className="h-3.5 w-3.5" />}
            label="Test Cases"
            count={relatedTestCases.length}
          />
        )}
        {!isEditorial &&
          (onOpenInBrowser ? (
            <button
              type="button"
              onClick={onOpenInBrowser}
              className="text-ink-3 hover:bg-bg-2 hover:text-ink-1 ml-auto flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors"
              title="Open in Azure DevOps"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Azure
              <Kbd shortcut="cmd+shift+o" />
            </button>
          ) : (
            <span className="text-ink-3 ml-auto flex items-center gap-1 text-xs">
              <Kbd shortcut="cmd+shift+o" /> open
            </span>
          ))}
      </div>

        <div
          ref={containerRef}
          className={`${isEditorial ? 'grid px-4 py-3' : 'mt-3 grid'} min-h-0 flex-1 gap-0 overflow-hidden ${
           showCommentsAsidePane
             ? 'xl:grid-cols-[minmax(0,1fr)_4px_auto]'
             : 'grid-cols-1'
         } ${isDragging ? 'select-none' : ''}`}
        >
        {/* The search bar sits outside `contentPaneRef` on purpose: that element
            is watched by a MutationObserver, and a bar inside it would observe
            its own "N of M" counter updates. */}
        <div className="relative flex min-h-0 min-w-0 flex-col">
          {find.isOpen && (
            <div className="absolute top-1 right-5 z-20">
              <FindInViewBar
                ref={findInputRef}
                query={find.query}
                onQueryChange={find.setQuery}
                currentMatch={find.currentMatch}
                totalMatches={find.matchCount}
                onNext={find.goToNextMatch}
                onPrevious={find.goToPreviousMatch}
                onClose={find.close}
                placeholder="Find in description..."
              />
            </div>
          )}
          <div
            ref={contentPaneRef}
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto xl:pr-4"
          >
          {effectiveTab === 'content' && (
            <div>
              {isEditorial ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" />
              ) : (
                <WorkItemFieldRows
                  workItem={workItem}
                  rows={detailLayout.rows}
                  metadata={fieldMetadata}
                  variant="detail"
                  containerClassName="flex flex-wrap gap-x-4 gap-y-1 text-xs"
                  layout="inline"
                  editors={{
                    [FIELD_ASSIGNED_TO]: () =>
                      canEditMetadata && providerId ? (
                        <WorkItemOwnerEditor
                          key={`${id}:assignee`}
                          owner={assignedTo}
                          ownerValue={assigneeUniqueName}
                          options={ownerDropdownOptions}
                          disabled={false}
                          error={null}
                          onRetry={() => {}}
                          providerId={providerId}
                          workItemId={id}
                        />
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="text-ink-3">Assigned:</span>
                          <span className="text-ink-1">{assignedTo ?? 'Unassigned'}</span>
                        </div>
                      ),
                    [FIELD_STATE]: () => (
                      <div className="flex items-center gap-1">
                        <span className="text-ink-3">State:</span>
                        <WorkItemStateEditor
                          key={`${id}:state`}
                          state={workItemState}
                          states={availableStates.map((state) => state.name)}
                          providerId={providerId && !readOnly ? providerId : undefined}
                          workItemId={id}
                        />
                      </div>
                    ),
                    [FIELD_PRIORITY]: () =>
                      canEditMetadata && providerId ? (
                        <div className="flex items-center gap-1"><span className="text-ink-3">Priority:</span><WorkItemMetadataValue key={`${id}:priority:${priority ?? ''}`} value={String(priority ?? '')} label="Priority" emptyLabel="None" validate={(value) => { const priority = Number(value); return Number.isInteger(priority) && priority >= 1 && priority <= 4 ? null : 'Priority must be an integer from 1 to 4'; }} onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'Microsoft.VSTS.Common.Priority', value: Number(value) })} /></div>
                      ) : null,
                    [FIELD_TAGS]: () =>
                      canEditMetadata && providerId ? (
                        <WorkItemTagEditor key={`${id}:tags:${tags ?? ''}`} value={tags ?? ''} suggestions={tagOptions} onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.Tags', value })} />
                      ) : null,
                  }}
                />
              )}

              {showRelatedWorkItems && relatedIds.length > 0 && (
                <RelatedWorkItems
                  workItem={workItem}
                  items={relatedWorkItems}
                  isLoading={isLoadingRelatedWorkItems}
                  error={relatedWorkItemsError}
                  onOpen={onOpenRelatedWorkItem}
                  parserSetting={parserSetting}
                />
              )}

              {workItem && (
                <AssociatedWorkItemTasks
                  tasks={associatedTasks}
                  isLoading={isLoadingAssociatedTasks}
                  error={associatedTasksError}
                  variant="editorial"
                />
              )}

              {summaryRequest && (
                <WorkItemGeneratedSummary
                  request={summaryRequest}
                  workItemTitle={title}
                  className="mt-3"
                />
              )}

              {hasContent && (
                <div className="border-glass-border my-3 border-t" />
              )}

              {description && (
                <AzureWorkItemDescription
                  content={description}
                  providerId={providerId}
                  className="text-ink-2 text-xs"
                  imageClassName="max-h-72 w-auto object-contain"
                  enableImageModal
                />
              )}

              {acceptanceCriteria && (
                <div className={description ? 'mt-4' : undefined}>
                  <h4 className="text-ink-1 mb-1.5 text-xs font-medium">
                    Acceptance Criteria
                  </h4>
                  <AzureHtmlContent
                    html={acceptanceCriteria}
                    providerId={providerId}
                    className="text-ink-2 text-xs"
                    imageClassName="max-h-72 w-auto object-contain"
                    enableImageModal
                  />
                </div>
              )}

              {hasReproSteps && (
                <div
                  className={
                    description || acceptanceCriteria
                      ? 'mt-4'
                      : undefined
                  }
                >
                  <h4 className="text-ink-1 mb-1.5 text-xs font-medium">
                    Repro Steps
                  </h4>
                  <AzureHtmlContent
                    html={reproSteps!}
                    providerId={providerId}
                    className="text-ink-2 text-xs"
                    imageClassName="max-h-72 w-auto object-contain"
                    enableImageModal
                  />
                </div>
              )}
              {!hasContent && (
                <p className="text-ink-3 mt-3 text-xs">
                  No description, acceptance criteria, or repro steps.
                </p>
              )}
            </div>
          )}

          {effectiveTab === 'comments' && (
            <WorkItemComments
              comments={comments}
              isLoading={isLoadingComments}
              error={
                commentsError instanceof Error ? commentsError.message : null
              }
               providerId={providerId}
               projectName={projectName}
               hideHeader
               isAddingComment={addComment.isPending || updateComment.isPending}
                onUpdateComment={
                  providerId && projectName && !readOnly
                    ? ({ commentId, text }) =>
                        updateComment.mutateAsync({
                          providerId,
                          projectName,
                          workItemId: id,
                          commentId,
                          text,
                        })
                    : undefined
                }
              onAddComment={
                providerId && projectName && !readOnly
                  ? (text) =>
                      addComment.mutateAsync({
                        providerId,
                        projectName,
                        workItemId: id,
                        text,
                      })
                  : undefined
              }
            />
          )}

          {effectiveTab === 'history' && (
            <WorkItemHistory
              history={history}
              isLoading={isLoadingHistory}
              error={historyError instanceof Error ? historyError.message : null}
              providerId={providerId}
            />
          )}

          {effectiveTab === 'test-cases' && (
            <div className="flex flex-col gap-1 pb-2">
              {relatedTestCasesError ? (
                <div>
                  <p role="alert" className="text-status-fail text-xs">
                    Failed to load related test cases: {relatedTestCasesError.message}
                  </p>
                  <button
                    type="button"
                    onClick={() => void refetchRelatedTestCases()}
                    className="border-line bg-bg-2 hover:bg-bg-3 text-ink-1 mt-2 rounded border px-2 py-1 text-xs"
                  >
                    Retry
                  </button>
                </div>
              ) : isLoadingTestCases ? (
                <p className="text-ink-3 text-xs">Loading test cases...</p>
              ) : (
                relatedTestCases.map((tc) => (
                  <WorkItemExpandableTestCase
                    key={tc.id}
                    testCase={tc}
                    providerId={providerId}
                  />
                ))
              )}
            </div>
          )}
          </div>
        </div>

        {showCommentsAsidePane && (
          <>
            <div
              role="separator"
              aria-label="Resize comments pane"
              aria-orientation="vertical"
              aria-valuemin={minCommentsPaneWidth}
              aria-valuemax={commentsPaneMaxWidth}
              aria-valuenow={effectiveCommentsPaneWidth}
              tabIndex={0}
              onMouseDown={handleMouseDown}
              onKeyDown={(event) => {
                const step = 16;
                const direction =
                  event.key === 'ArrowLeft'
                    ? 1
                    : event.key === 'ArrowRight'
                      ? -1
                      : 0;
                if (event.key === 'Home') {
                  event.preventDefault();
                  setCommentsPaneWidth(minCommentsPaneWidth);
                } else if (event.key === 'End') {
                  event.preventDefault();
                  setCommentsPaneWidth(commentsPaneMaxWidth);
                } else if (direction !== 0) {
                  event.preventDefault();
                  setCommentsPaneWidth(
                    Math.min(
                      Math.max(
                        effectiveCommentsPaneWidth + direction * step,
                        minCommentsPaneWidth,
                      ),
                      commentsPaneMaxWidth,
                    ),
                  );
                }
              }}
              className={`hover:bg-acc/30 hidden h-full w-1 cursor-col-resize transition-colors outline-none focus-visible:bg-acc/30 xl:block ${isDragging ? 'bg-acc/30' : ''}`}
            />
            <aside
              ref={commentsPaneRef}
              className="border-glass-border flex min-h-0 min-w-0 max-w-full flex-col border-t pt-3 xl:max-w-none xl:border-t-0 xl:border-l xl:pt-0 xl:pl-4"
              style={{ width: effectiveCommentsPaneWidth }}
            >
            <div className="text-ink-1 mb-2 flex shrink-0 items-center gap-1.5 text-xs font-medium">
              <MessagesSquare className="h-3.5 w-3.5" />
              Comments
              {hasLoadedComments && !commentsError && (
                <span className="text-ink-3 font-normal">
                  ({comments.length})
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <WorkItemComments
                comments={comments}
                isLoading={isLoadingComments}
                error={
                  commentsError instanceof Error ? commentsError.message : null
                }
                 providerId={providerId}
                 projectName={projectName}
                 hideHeader
                 isAddingComment={addComment.isPending || updateComment.isPending}
                  onUpdateComment={
                    providerId && projectName && !readOnly
                      ? ({ commentId, text }) =>
                          updateComment.mutateAsync({
                            providerId,
                            projectName,
                            workItemId: id,
                            commentId,
                            text,
                          })
                      : undefined
                  }
                onAddComment={
                  providerId && projectName && !readOnly
                    ? (text) =>
                        addComment.mutateAsync({
                          providerId,
                          projectName,
                          workItemId: id,
                          text,
                        })
                    : undefined
                }
              />
            </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
});

function RelatedWorkItems({
  workItem,
  items,
  isLoading,
  error,
  onOpen,
  parserSetting,
}: {
  workItem: AzureDevOpsWorkItem;
  items: AzureDevOpsWorkItem[];
  isLoading: boolean;
  error: Error | null;
  onOpen?: (workItemId: number) => void;
  parserSetting: WorkItemTitleParserSetting | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const byId = new Map(items.map((item) => [item.id, item]));
  const groups = [
    { label: 'Parent', ids: workItem.parentId ? [workItem.parentId] : [] },
    { label: 'Children', ids: workItem.childIds ?? [] },
    { label: 'Related', ids: workItem.relatedWorkItemIds ?? [] },
  ].filter((group) => group.ids.length > 0);
  return (
    <section className="border-glass-border border-l-acc-line bg-glass-light mt-4 rounded-lg border border-l-2 p-3 shadow-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className={`text-ink-1 hover:text-ink-0 flex w-full items-center gap-2 text-left text-xs font-medium transition-colors ${expanded ? 'mb-3' : ''}`}
      >
        <ChevronRight
          className={`text-ink-3 h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <Link2 className="text-acc-ink h-3.5 w-3.5" /> Related work items
      </button>
      {expanded && (
        <div className="space-y-2.5">
          {error && (
            <p role="alert" className="text-status-fail text-xs">
              Failed to load related work items: {error.message}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="text-ink-3 mb-1 text-[10px] font-medium uppercase tracking-wide">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.ids.map((id) => {
                  const item = byId.get(id);
                  return item ? (
                    parserSetting ? <div key={id} onClick={() => onOpen?.(id)}>
                      <ParsedWorkItemTitle
                        title={getTitle(item)}
                        parserSetting={parserSetting}
                        compact
                        className="border-glass-border bg-bg-1/60 hover:bg-glass-medium w-full rounded-md border transition-colors"
                        labelsClassName="px-2.5 pb-2"
                        titleClassName="text-ink-1 truncate text-xs"
                        renderTitle={(title) => <button
                          type="button"
                          disabled={!onOpen}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpen?.(id);
                          }}
                          className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
                        >
                          <WorkItemTypeIcon type={getWorkItemType(item)} size="sm" />
                          <span className="text-ink-3 text-[10px]">#{id}</span>
                           <span className="min-w-0 flex-1">{title}</span>
                          <span className="text-ink-3 text-[10px]">{getState(item)}</span>
                        </button>}
                      />
                    </div> : <button
                      key={id}
                      type="button"
                      disabled={!onOpen}
                      onClick={() => onOpen?.(id)}
                      className="border-glass-border bg-bg-1/60 hover:bg-glass-medium flex w-full min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-default"
                    >
                      <WorkItemTypeIcon type={getWorkItemType(item)} size="sm" />
                      <span className="text-ink-3 text-[10px]">#{id}</span>
                      <span className="text-ink-1 min-w-0 flex-1 truncate text-xs">{getTitle(item)}</span>
                      <span className="text-ink-3 text-[10px]">{getState(item)}</span>
                    </button>
                  ) : (
                    <div
                      key={id}
                      className="border-glass-border bg-bg-1/60 text-ink-3 rounded-md border px-2.5 py-2 text-xs"
                    >
                      {isLoading
                        ? `Loading #${id}...`
                        : error
                          ? `Work item #${id} could not be loaded`
                          : `Work item #${id} unavailable`}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
