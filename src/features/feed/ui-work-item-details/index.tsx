import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FlaskConical,
  GitPullRequest,
  History,
  Link2,
  Loader2,
  MessagesSquare,
  Paperclip,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import {
  api,
  type AzureDevOpsPullRequestStatus,
  type AzureDevOpsWorkItem,
} from '@/lib/api';
import {
  collectExtraFieldRefNames,
  resolveDetailLayout,
} from '@shared/work-item-display-config-types';
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
  getTags,
  getTeamProject,
  getTitle,
  getWorkItemType,
} from '@shared/work-item-field-types';
import { FindInViewBar, useFindInView } from '@/common/ui/find-in-view';
import {
  getOwnerOptions,
  WorkItemOwnerEditor,
} from '@/features/work-item/ui-work-item-field-editors/work-item-owner-editor';
import {
  useAddWorkItemComment,
  useBoardColumns,
  useCurrentAzureUser,
  useIterations,
  useLinkedPullRequestStatuses,
  useRelatedTestCases,
  useUpdateWorkItemComment,
  useUpdateWorkItemField,
  useWorkItemById,
  useWorkItemComments,
  useWorkItemFieldMetadataMap,
  useWorkItemHistory,
  useWorkItemOwners,
  useWorkItemsByIds,
  useWorkItemStates,
} from '@/hooks/use-work-items';
import {
  WorkItemStateBadge,
  WorkItemStateEditor,
} from '@/features/work-item/ui-work-item-field-editors/work-item-state-editor';
import { AzureHtmlContent } from '@/features/common/ui-azure-html-content';
import { Chip } from '@/common/ui/chip';
import { Kbd } from '@/common/ui/kbd';
import { Modal } from '@/common/ui/modal';
import { PrDetail } from '@/features/pull-request/ui-pr-detail';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useProject } from '@/hooks/use-projects';
import { useRegisterKeyboardBindings } from '@/common/context/keyboard-bindings';
import { useWorkItemCommentsPaneWidth } from '@/stores/navigation';
import { WorkItemBoardColumnEditor } from '@/features/work-item/ui-work-item-board-column-editor';
import { WorkItemComments } from '@/features/work-item/ui-work-item-comments';
import { WorkItemExpandableTestCase } from '@/features/work-item/ui-work-item-expandable-test-case';
import { WorkItemFieldRows } from '@/features/work-item/ui-work-item-field-rows';
import { WorkItemGeneratedSummary } from '@/features/work-item/ui-work-item-generated-summary';
import { WorkItemHistory } from '@/features/work-item/ui-work-item-history';
import { WorkItemIterationEditor } from '@/features/work-item/ui-work-item-field-editors/work-item-iteration-editor';
import { WorkItemMetadataValue } from '@/features/work-item/ui-work-item-field-editors/work-item-metadata-value';
import { WorkItemTabButton } from '@/features/work-item/ui-work-item-tab-button';
import { WorkItemTagEditor } from '@/features/work-item/ui-work-item-tag-editor';
import { WorkItemTypeIcon } from '@/features/work-item/ui-work-item-shared';

type DetailsTab = 'attachments' | 'comments' | 'history' | 'test-cases';

type LinkDetailModal =
  | { type: 'work-item'; workItemId: number }
  | {
      type: 'pull-request';
      pr: NonNullable<AzureDevOpsWorkItem['linkedPrs']>[number];
    };

export function WorkItemDetails({
  projectId,
  workItemId,
  onClose,
}: {
  projectId: string;
  workItemId: number;
  onClose?: () => void;
}) {
  const { data: project } = useProject(projectId);
  const providerId = project?.workItemProviderId ?? null;
  const configuredProjectName = project?.workItemProjectName ?? null;
  const {
    width: commentsPaneWidth,
    setWidth: setCommentsPaneWidth,
    minWidth: minCommentsPaneWidth,
    maxWidth: maxCommentsPaneWidth,
  } = useWorkItemCommentsPaneWidth();

  // Per-project display config. A `null` config resolves to this surface's own
  // hardcoded default, so an unconfigured project renders exactly as before.
  const displayConfig = project?.workItemDisplayConfig ?? null;
  const extraFieldRefNames = useMemo(
    () => collectExtraFieldRefNames(displayConfig),
    [displayConfig],
  );
  const fieldMetadata = useWorkItemFieldMetadataMap({
    providerId: providerId ?? undefined,
    azureProjectId: project?.workItemProjectId ?? undefined,
  });
  const {
    data: workItem,
    isLoading,
    error,
    refetch: refetchWorkItem,
  } = useWorkItemById({
    providerId,
    workItemId,
    extraFieldRefNames,
  });
  const projectName =
    (workItem ? getTeamProject(workItem) : undefined) ?? configuredProjectName;
  const { data: boardColumns = [] } = useBoardColumns({
    providerId: providerId ?? '',
    projectId: project?.workItemProjectId ?? '',
    projectName: projectName ?? '',
    enabled: !!providerId && !!project?.workItemProjectId && !!projectName,
  });
  const { data: availableStates = [] } = useWorkItemStates({
    providerId,
    projectName,
    workItemType: (workItem ? getWorkItemType(workItem) : '') || null,
  });
  const ownerQuery = useWorkItemOwners({
    providerId,
    projectName,
  });
  const { data: currentUser } = useCurrentAzureUser(providerId ?? null);
  const assignee = workItem ? getAssignee(workItem) : undefined;
  const assigneeDisplayName = assignee?.displayName;
  const assigneeUniqueName = assignee?.uniqueName;
  const ownerOptions = useMemo(
    () =>
      getOwnerOptions(
        ownerQuery.data ?? [],
        assigneeDisplayName,
        assigneeUniqueName,
        currentUser
          ? {
              displayName: currentUser.displayName,
              uniqueName: currentUser.emailAddress,
            }
          : undefined,
      ),
    [ownerQuery.data, assigneeDisplayName, assigneeUniqueName, currentUser],
  );
  const { data: iterations } = useIterations({
    providerId: providerId ?? '',
    projectName: projectName ?? '',
  });
  const workItemIterationPath = workItem ? getIterationPath(workItem) : undefined;
  const iterationOptions = useMemo(() => {
    const options = [...(iterations ?? [])];
    const currentPath = workItemIterationPath;
    if (currentPath && !options.some((option) => option.path === currentPath)) {
      options.unshift({
        id: currentPath,
        name: currentPath.split('\\').at(-1) ?? currentPath,
        path: currentPath,
        startDate: null,
        finishDate: null,
        isCurrent: false,
      });
    }
    return options.reverse();
  }, [iterations, workItemIterationPath]);
  const {
    data: comments = [],
    isLoading: isLoadingComments,
    error: commentsError,
    refetch: refetchComments,
  } = useWorkItemComments({
    providerId,
    projectName,
    workItemIds: [workItemId],
  });
  const {
    data: history = [],
    isLoading: isLoadingHistory,
    error: historyError,
    refetch: refetchHistory,
  } = useWorkItemHistory({
    providerId,
    projectName,
    workItemId,
  });
  const {
    data: relatedTestCases = [],
    isLoading: isLoadingTestCases,
    refetch: refetchTestCases,
  } = useRelatedTestCases({
    providerId,
    projectName,
    workItemId,
  });
  const linkedPrs = workItem?.linkedPrs ?? [];
  const {
    data: linkedPullRequestStatuses = [],
    isLoading: isLoadingPullRequestStatuses,
  } = useLinkedPullRequestStatuses({
    providerId,
    linkedPrs,
  });
  const linkedWorkItemIds = getLinkedWorkItemIds(workItem);
  const {
    data: linkedWorkItems = [],
    isLoading: isLoadingLinkedWorkItems,
    refetch: refetchLinkedWorkItems,
  } = useWorkItemsByIds({
    providerId,
    projectName,
    workItemIds: linkedWorkItemIds,
  });
  // Tag autocomplete (decision 30). The board's `tagOptions` come from a whole
  // loaded board model, which this modal never fetches; the only tag corpus
  // available here without adding a query is the work item itself plus the
  // items it already loads (linked work items and related test cases).
  const tagSuggestions = useMemo(() => {
    const byKey = new Map<string, string>();
    const sources = [
      ...(workItem ? [workItem] : []),
      ...linkedWorkItems,
      ...relatedTestCases,
    ];
    for (const item of sources) {
      for (const tag of getTags(item)) {
        const key = tag.toLocaleLowerCase();
        if (!byKey.has(key)) byKey.set(key, tag);
      }
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  }, [workItem, linkedWorkItems, relatedTestCases]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void Promise.allSettled([
      refetchWorkItem(),
      refetchComments(),
      refetchHistory(),
      refetchTestCases(),
      refetchLinkedWorkItems(),
      ownerQuery.refetch(),
    ]).finally(() => setIsRefreshing(false));
  }, [
    refetchWorkItem,
    refetchComments,
    refetchHistory,
    refetchTestCases,
    refetchLinkedWorkItems,
    ownerQuery,
  ]);
  const workItemUrl = workItem?.url ?? null;
  const copiedTimeoutRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimeoutRef.current) window.clearTimeout(copiedTimeoutRef.current);
    },
    [],
  );
  const handleCopyLink = useCallback(() => {
    if (!workItemUrl) return;
    void navigator.clipboard
      .writeText(workItemUrl)
      .then(() => {
        setCopiedLink(true);
        if (copiedTimeoutRef.current)
          window.clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = window.setTimeout(
          () => setCopiedLink(false),
          1500,
        );
      })
      .catch(() => setCopiedLink(false));
  }, [workItemUrl]);
  const handleOpenInAzure = useCallback(() => {
    if (!workItemUrl) return;
    window.open(workItemUrl, '_blank', 'noopener,noreferrer');
  }, [workItemUrl]);

  async function handleAttachDocuments(files: FileList | null) {
      if (!files || !providerId || !projectName || isUploadingAttachments) return;
      setAttachmentError(null);
      setIsUploadingAttachments(true);
      const failures: string[] = [];
      try {
        for (const file of [...files]) {
          if (file.size === 0) {
            failures.push(`${file.name}: empty files cannot be attached`);
            continue;
          }
          if (file.size > 50 * 1024 * 1024) {
            failures.push(`${file.name}: files must be 50 MB or smaller`);
            continue;
          }
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = '';
            const chunkSize = 0x8000;
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
              binary += String.fromCharCode(
                ...bytes.subarray(offset, offset + chunkSize),
              );
            }
            await api.azureDevOps.uploadWorkItemAttachment({
              providerId,
              projectName,
              workItemId,
              filename: file.name,
              mimeType: file.type || 'application/octet-stream',
              base64: btoa(binary),
            });
          } catch (error) {
            failures.push(
              `${file.name}: ${error instanceof Error ? error.message : 'upload failed'}`,
            );
          }
        }
        await refetchWorkItem();
      } finally {
        setIsUploadingAttachments(false);
        if (failures.length > 0) setAttachmentError(failures.join('\n'));
      }
  }

  useRegisterKeyboardBindings(`work-item-details:${workItemId}`, {
    'cmd+shift+c': () => {
      handleCopyLink();
      return true;
    },
    'cmd+shift+o': () => {
      handleOpenInAzure();
      return true;
    },
  });

  const addComment = useAddWorkItemComment();
  const updateComment = useUpdateWorkItemComment();
  const updateField = useUpdateWorkItemField();
  const hasTestCases = isLoadingTestCases || relatedTestCases.length > 0;
  const [activeTab, setActiveTab] = useState<DetailsTab>('comments');
  const [linkDetailModal, setLinkDetailModal] = useState<LinkDetailModal | null>(
    null,
  );
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const commentsPaneRef = useRef<HTMLElement>(null);
  const contentPaneRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<{ focus: () => void }>(null);
  const find = useFindInView({
    containerRef: contentPaneRef,
    inputRef: findInputRef,
    contentKey: String(workItem?.id ?? ''),
  });

  useEffect(() => {
    if (!hasTestCases && activeTab === 'test-cases') {
      startTransition(() => setActiveTab('comments'));
    }
  }, [hasTestCases, activeTab]);

  const { containerRef, isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: commentsPaneWidth,
    minWidth: minCommentsPaneWidth,
    maxWidth: maxCommentsPaneWidth,
    maxWidthFraction: 0.6,
    direction: 'left',
    onWidthChange: setCommentsPaneWidth,
    resizeTargetRef: commentsPaneRef,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => setContainerWidth(container.offsetWidth);
    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [containerRef]);

  const effectiveCommentsPaneWidth = Math.min(
    commentsPaneWidth,
    maxCommentsPaneWidth,
    Math.floor(containerWidth * 0.6),
  );

  if (isLoading || !project) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-ink-3 h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error || !workItem) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-ink-3 text-sm">
          {error ? 'Failed to load work item' : 'Work item not found'}
        </p>
      </div>
    );
  }

  const workItemType = getWorkItemType(workItem);
  const title = getTitle(workItem);
  const state = getState(workItem);
  const ownerDisplayName = getAssignee(workItem)?.displayName;
  const ownerUniqueName = getAssignee(workItem)?.uniqueName;
  const storyPoints = getStoryPoints(workItem);
  const priority = getPriority(workItem);
  const iterationPath = getIterationPath(workItem);
  const tagsValue = getStringField(workItem, FIELD_TAGS) ?? '';
  const detailLayout = resolveDetailLayout(
    displayConfig,
    workItemType,
    'feed-modal',
  );
  // Unknown ids stay visible: a config that predates a tab must not hide it.
  const isTabVisible = (tabId: string) =>
    detailLayout.tabs.find((tab) => tab.id === tabId)?.visible !== false;
  const description = isTabVisible('description')
    ? getDescriptionHtml(workItem)
    : undefined;
  const acceptanceCriteria = isTabVisible('acceptanceCriteria')
    ? getAcceptanceCriteriaHtml(workItem)
    : undefined;
  const reproSteps = isTabVisible('reproSteps')
    ? getReproStepsHtml(workItem)
    : undefined;
  const hasReproSteps = workItemType === 'Bug' && !!reproSteps;
  const hasContent = !!description || !!acceptanceCriteria || hasReproSteps;
  const showCommentsTab = isTabVisible('comments');
  const showHistoryTab = isTabVisible('history');
  const showTestCasesTab = hasTestCases && isTabVisible('testCases');
  const showAttachmentsTab = isTabVisible('attachments');
  // A tab the config hides must not stay selected. Derived rather than fixed in
  // an effect: everything here runs after the loading/error bail-outs, so a
  // hook at this point would change the render's hook count.
  const visibleTabs = (
    [
      showAttachmentsTab ? 'attachments' : null,
      showCommentsTab ? 'comments' : null,
      showHistoryTab ? 'history' : null,
      showTestCasesTab ? 'test-cases' : null,
    ] as const
  ).filter((tab): tab is DetailsTab => tab !== null);
  // `null` when the config hides every tab: falling back to the selected tab
  // would render its pane under an empty strip — i.e. show exactly the tab the
  // config hid.
  const effectiveTab: DetailsTab | null = visibleTabs.includes(activeTab)
    ? activeTab
    : (visibleTabs[0] ?? null);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-glass-border/50 shrink-0 border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <WorkItemTypeIcon type={workItemType} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-ink-2 text-sm font-medium">
                #{workItem.id}
              </span>
              <span className="text-ink-4 text-xs">&bull;</span>
              <span className="text-ink-2 text-xs">{workItemType}</span>
            </div>
            {/* Inline title editing (decision 30). `className` carries the
                heading typography so the editor's default `text-sm` doesn't
                shrink it. */}
            {providerId ? (
              <div className="mt-1 flex min-w-0">
                <WorkItemMetadataValue
                  key={`${workItem.id}:title:${title}`}
                  value={title}
                  label="Title"
                  className="text-ink-0 block min-w-0 flex-1 rounded text-left text-lg font-semibold"
                  fullWidth
                  validate={(value) =>
                    value.trim() ? null : 'Title cannot be empty'
                  }
                  onSave={(value) =>
                    updateField.mutateAsync({
                      providerId,
                      workItemId: workItem.id,
                      field: 'System.Title',
                      value,
                    })
                  }
                />
              </div>
            ) : (
              <h1 className="text-ink-0 mt-1 text-lg font-semibold">{title}</h1>
            )}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="text-ink-2 hover:border-glass-border hover:text-ink-1 border-glass-border flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-60"
            title="Refresh work item"
          >
            <RefreshCw
              className={clsx('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
            />
            Refresh
          </button>
          {workItem.url && (
            <button
              type="button"
              onClick={handleCopyLink}
              className="text-ink-2 hover:border-glass-border hover:text-ink-1 border-glass-border flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors"
              title="Copy work item link (⌘⇧C)"
            >
              {copiedLink ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              {copiedLink ? 'Copied' : 'Copy link'}
              <Kbd shortcut="cmd+shift+c" />
            </button>
          )}
          {workItem.url && (
            <a
              href={workItem.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-2 hover:border-glass-border hover:text-ink-1 border-glass-border flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors"
              title="Open in Azure DevOps (⌘⇧O)"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
              <Kbd shortcut="cmd+shift+o" />
            </a>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="text-ink-2 hover:bg-glass-medium hover:text-ink-1 shrink-0 rounded p-1"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>

        {/* Config-driven metadata region. Each row hosts this panel's own
            inline editor, so ordering/visibility is configurable without
            changing any editing behaviour (decision 22). */}
        <WorkItemFieldRows
          workItem={workItem}
          rows={detailLayout.rows}
          metadata={fieldMetadata}
          variant="detail"
          containerClassName="mt-3 flex flex-wrap items-center gap-3"
          layout="inline"
          editors={{
            [FIELD_STATE]: () =>
              providerId ? (
                <WorkItemStateEditor
                  state={state}
                  states={availableStates.map((s) => s.name)}
                  providerId={providerId}
                  workItemId={workItem.id}
                />
              ) : (
                <WorkItemStateBadge state={state} />
              ),
            [FIELD_BOARD_COLUMN]: () =>
              providerId && project.workItemProjectId && projectName && boardColumns.length > 0 ? (
                <WorkItemBoardColumnEditor
                  key={`${workItem.id}:column`}
                  workItem={workItem}
                  providerId={providerId}
                  projectId={project.workItemProjectId}
                  projectName={projectName}
                  columns={boardColumns}
                  variant="details"
                />
              ) : null,
            [FIELD_ASSIGNED_TO]: () =>
              providerId ? (
                <WorkItemOwnerEditor
                  owner={ownerDisplayName}
                  ownerValue={ownerUniqueName}
                  options={ownerOptions}
                  disabled={ownerQuery.data === undefined}
                  error={ownerQuery.error?.message ?? null}
                  onRetry={() => void ownerQuery.refetch()}
                  providerId={providerId}
                  workItemId={workItem.id}
                />
              ) : (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-ink-1" title="Assigned to">
                    {ownerDisplayName ?? 'Unassigned'}
                  </span>
                </div>
              ),
            [FIELD_STORY_POINTS]: () =>
              providerId ? (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-ink-3">Story points:</span>
                  <WorkItemMetadataValue
                    key={`${workItem.id}:story-points:${storyPoints ?? ''}`}
                    value={String(storyPoints ?? '')}
                    label="Story points"
                    emptyLabel="None"
                    validate={(value) => {
                      if (value === '') return null;
                      const points = Number(value);
                      return Number.isInteger(points) && points >= 0
                        ? null
                        : 'Story points must be a non-negative integer';
                    }}
                    onSave={(value) =>
                      updateField.mutateAsync({
                        providerId,
                        workItemId: workItem.id,
                        field: 'Microsoft.VSTS.Scheduling.StoryPoints',
                        value: value === '' ? null : Number(value),
                      })
                    }
                  />
                </div>
              ) : null,
            // Decision 30: the modal gains Priority editing, with the same
            // 1–4 integer validation the preview uses.
            [FIELD_PRIORITY]: () =>
              providerId ? (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-ink-3">Priority:</span>
                  <WorkItemMetadataValue
                    key={`${workItem.id}:priority:${priority ?? ''}`}
                    value={String(priority ?? '')}
                    label="Priority"
                    emptyLabel="None"
                    validate={(value) => {
                      const nextPriority = Number(value);
                      return Number.isInteger(nextPriority) &&
                        nextPriority >= 1 &&
                        nextPriority <= 4
                        ? null
                        : 'Priority must be an integer from 1 to 4';
                    }}
                    onSave={(value) =>
                      updateField.mutateAsync({
                        providerId,
                        workItemId: workItem.id,
                        field: FIELD_PRIORITY,
                        value: Number(value),
                      })
                    }
                  />
                </div>
              ) : null,
            [FIELD_ITERATION_PATH]: () =>
              providerId && projectName ? (
                <WorkItemIterationEditor
                  iterationPath={iterationPath}
                  options={iterationOptions}
                  disabled={iterations === undefined}
                  providerId={providerId}
                  workItemId={workItem.id}
                />
              ) : null,
            [FIELD_TAGS]: () =>
              providerId ? (
                <WorkItemTagEditor
                  key={`${workItem.id}:tags:${tagsValue}`}
                  value={tagsValue}
                  suggestions={tagSuggestions}
                  onSave={(value) =>
                    updateField.mutateAsync({
                      providerId,
                      workItemId: workItem.id,
                      field: 'System.Tags',
                      value,
                    })
                  }
                />
              ) : null,
          }}
        />
      </div>

      <div
        ref={containerRef}
        className={clsx(
          'flex min-h-0 flex-1 overflow-hidden',
          isDragging && 'select-none',
        )}
      >
        {/* The search bar sits outside `contentPaneRef` on purpose: that
            element is watched by a MutationObserver, and a bar inside it would
            observe its own "N of M" counter updates. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {find.isOpen && (
            <div className="absolute top-2 right-4 z-20">
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
            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-4"
          >
          {providerId && projectName && (
            <WorkItemGeneratedSummary
              request={{
                projectId,
                providerId,
                projectName,
                workItemId: workItem.id,
              }}
              workItemTitle={title}
              className="mb-5"
            />
          )}
          {hasContent ? (
            <div className="w-full">
              {description && (
                <AzureHtmlContent
                  html={description}
                  providerId={providerId ?? undefined}
                  className="text-ink-1 text-sm"
                  imageClassName="max-h-96 w-auto object-contain"
                  enableImageModal
                />
              )}

              {acceptanceCriteria && (
                <div className={description ? 'mt-6' : undefined}>
                  <h2 className="text-ink-0 mb-2 text-sm font-semibold">
                    Acceptance Criteria
                  </h2>
                  <AzureHtmlContent
                    html={acceptanceCriteria}
                    providerId={providerId ?? undefined}
                    className="text-ink-1 text-sm"
                    imageClassName="max-h-96 w-auto object-contain"
                    enableImageModal
                  />
                </div>
              )}

              {hasReproSteps && (
                <div
                  className={
                    description || acceptanceCriteria
                      ? 'mt-6'
                      : undefined
                  }
                >
                  <h2 className="text-ink-0 mb-2 text-sm font-semibold">
                    Repro Steps
                  </h2>
                  <AzureHtmlContent
                    html={reproSteps!}
                    providerId={providerId ?? undefined}
                    className="text-ink-1 text-sm"
                    imageClassName="max-h-96 w-auto object-contain"
                    enableImageModal
                  />
                </div>
              )}
            </div>
          ) : (
            <p className="text-ink-3 w-full text-sm italic">
              No description provided.
            </p>
          )}
          </div>
        </div>

        <div
          onMouseDown={handleMouseDown}
          className={clsx(
            'hover:bg-acc/30 h-full w-1 shrink-0 cursor-col-resize transition-colors',
            isDragging && 'bg-acc/30',
          )}
        />

        <aside
          ref={commentsPaneRef}
          className="border-glass-border/50 bg-bg-1/20 flex min-w-0 shrink-0 flex-col border-l"
          style={{ width: effectiveCommentsPaneWidth }}
        >
          <WorkItemLinks
            workItem={workItem}
            linkedWorkItems={linkedWorkItems}
            linkedPullRequestStatuses={linkedPullRequestStatuses}
            isLoadingWorkItems={isLoadingLinkedWorkItems}
            isLoadingPullRequestStatuses={isLoadingPullRequestStatuses}
            onOpenWorkItem={(id) =>
              setLinkDetailModal({ type: 'work-item', workItemId: id })
            }
            onOpenPullRequest={(pr) =>
              setLinkDetailModal({ type: 'pull-request', pr })
            }
          />

          <div className="border-glass-border flex gap-0 border-b px-3">
            {showAttachmentsTab && (
              <WorkItemTabButton
                active={effectiveTab === 'attachments'}
                onClick={() => setActiveTab('attachments')}
                icon={<Paperclip className="h-3.5 w-3.5" />}
                label="Attachments"
                count={workItem.attachments?.length ?? 0}
              />
            )}
            {showCommentsTab && (
              <WorkItemTabButton
                active={effectiveTab === 'comments'}
                onClick={() => setActiveTab('comments')}
                icon={<MessagesSquare className="h-3.5 w-3.5" />}
                label="Comments"
                count={comments.length}
              />
            )}
            {showHistoryTab && (
              <WorkItemTabButton
                active={effectiveTab === 'history'}
                onClick={() => setActiveTab('history')}
                icon={<History className="h-3.5 w-3.5" />}
                label="History"
                count={history.length}
              />
            )}
            {showTestCasesTab && (
              <WorkItemTabButton
                active={effectiveTab === 'test-cases'}
                onClick={() => setActiveTab('test-cases')}
                icon={<FlaskConical className="h-3.5 w-3.5" />}
                label="Test Cases"
                count={relatedTestCases.length}
              />
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {effectiveTab === 'attachments' && (
              <WorkItemAttachments
                attachments={workItem.attachments ?? []}
                disabled={!providerId || !projectName || isUploadingAttachments}
                isUploading={isUploadingAttachments}
                error={attachmentError}
                onSelect={handleAttachDocuments}
              />
            )}
            {effectiveTab === 'comments' && (
              <WorkItemComments
                comments={comments}
                isLoading={isLoadingComments}
                error={
                  commentsError instanceof Error ? commentsError.message : null
                }
                providerId={providerId ?? undefined}
                projectName={projectName ?? undefined}
                emptyMessage="No comments on this work item yet."
                hideHeader
                isAddingComment={addComment.isPending || updateComment.isPending}
                onUpdateComment={({ commentId, text }) => updateComment.mutateAsync({ providerId: providerId!, projectName: projectName!, workItemId, commentId, text })}
                onAddComment={
                  providerId && projectName
                    ? (text) =>
                        addComment.mutateAsync({
                          providerId,
                          projectName,
                          workItemId,
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
                error={
                  historyError instanceof Error ? historyError.message : null
                }
                providerId={providerId ?? undefined}
              />
            )}

            {effectiveTab === 'test-cases' && (
              <div className="flex flex-col gap-2">
                {isLoadingTestCases ? (
                  <p className="text-ink-3 text-sm">Loading test cases...</p>
                ) : (
                  relatedTestCases.map((tc) => (
                    <WorkItemExpandableTestCase
                      key={tc.id}
                      testCase={tc}
                      providerId={providerId ?? undefined}
                      variant="comfortable"
                      />
                  ))
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      <LinkedDetailModal
        projectId={projectId}
        providerId={providerId}
        modal={linkDetailModal}
        onClose={() => setLinkDetailModal(null)}
      />
    </div>
  );
}

function WorkItemAttachments({
  attachments,
  disabled,
  isUploading,
  error,
  onSelect,
}: {
  attachments: Array<{ name: string; url: string }>;
  disabled: boolean;
  isUploading: boolean;
  error: string | null;
  onSelect: (files: FileList | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <section className="border-glass-border/50 shrink-0 border-b px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-ink-1 flex items-center gap-1.5 text-xs font-semibold">
          <Paperclip className="h-3.5 w-3.5" />
          Attachments
          {attachments.length > 0 && (
            <span className="text-ink-4">({attachments.length})</span>
          )}
        </h2>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            onSelect(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="text-ink-2 hover:text-ink-1 disabled:text-ink-4 flex items-center gap-1 rounded px-1.5 py-1 text-[11px] disabled:cursor-default"
        >
          <Paperclip className="h-3 w-3" />
          {isUploading ? 'Uploading…' : 'Attach document'}
        </button>
      </div>
      {attachments.length > 0 ? (
        <div className="flex flex-col gap-1">
          {attachments.map((attachment) => (
            <a
              key={attachment.url}
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-acc-ink hover:text-acc flex min-w-0 items-center gap-1.5 truncate text-xs"
              title={attachment.name}
            >
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{attachment.name}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          ))}
        </div>
      ) : (
        <p className="text-ink-4 text-[11px]">No documents attached.</p>
      )}
      {error && (
        <p className="text-danger mt-2 whitespace-pre-line text-[11px]">{error}</p>
      )}
    </section>
  );
}

function getLinkedWorkItemIds(workItem?: AzureDevOpsWorkItem | null): number[] {
  if (!workItem) return [];
  return Array.from(
    new Set([
      ...(workItem.parentId ? [workItem.parentId] : []),
      ...(workItem.childIds ?? []),
      ...(workItem.relatedWorkItemIds ?? []),
    ]),
  );
}

function WorkItemLinks({
  workItem,
  linkedWorkItems,
  linkedPullRequestStatuses,
  isLoadingWorkItems,
  isLoadingPullRequestStatuses,
  onOpenWorkItem,
  onOpenPullRequest,
}: {
  workItem: AzureDevOpsWorkItem;
  linkedWorkItems: AzureDevOpsWorkItem[];
  linkedPullRequestStatuses: AzureDevOpsPullRequestStatus[];
  isLoadingWorkItems: boolean;
  isLoadingPullRequestStatuses: boolean;
  onOpenWorkItem: (workItemId: number) => void;
  onOpenPullRequest: (
    pr: NonNullable<AzureDevOpsWorkItem['linkedPrs']>[number],
  ) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const findWorkItem = (id: number) => linkedWorkItems.find((wi) => wi.id === id);
  const findPullRequestStatus = (
    pr: NonNullable<AzureDevOpsWorkItem['linkedPrs']>[number],
  ) =>
    linkedPullRequestStatuses.find(
      (status) => status.key === getLinkedPrKey(pr),
    );

  return (
    <section className="border-glass-border border-b bg-white/[0.018]">
      <button
        type="button"
        className="hover:bg-white/[0.025] flex w-full items-center gap-2 px-5 py-3 text-left transition-colors"
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? (
          <ChevronRight className="text-ink-3 h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="text-ink-3 h-3.5 w-3.5" />
        )}
        <Link2 className="text-ink-3 h-3.5 w-3.5" />
        <h2 className="text-ink-1 flex-1 text-sm font-semibold">Links</h2>
        <span className="bg-ink-4/20 text-ink-3 rounded-full px-1.5 py-0.5 text-[10px]">
          {getLinkCount(workItem)}
        </span>
      </button>

      {!collapsed && <div className="flex flex-col gap-2.5 px-5 pb-3">
        <LinkGroup label="Pull Requests">
          {workItem.linkedPrs?.length ? (
            workItem.linkedPrs.map((pr) => (
              <LinkedPrChip
                key={`${pr.projectId}-${pr.repoId}-${pr.prId}`}
                pr={pr}
                status={findPullRequestStatus(pr)}
                isLoadingStatus={isLoadingPullRequestStatuses}
                onOpen={() => onOpenPullRequest(pr)}
              />
            ))
          ) : (
            <span className="text-ink-3 flex items-center gap-1.5 py-1 text-xs italic">
              <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
              No pull request associated
            </span>
          )}
        </LinkGroup>

        {workItem.parentId && (
          <LinkGroup label="Parent">
            <LinkedWorkItemChip
              workItemId={workItem.parentId}
              workItem={findWorkItem(workItem.parentId)}
              isLoading={isLoadingWorkItems}
              onOpen={() => onOpenWorkItem(workItem.parentId ?? 0)}
            />
          </LinkGroup>
        )}

        {!!workItem.childIds?.length && (
          <LinkGroup label="Children">
            {workItem.childIds.map((id) => (
              <LinkedWorkItemChip
                key={id}
                workItemId={id}
                workItem={findWorkItem(id)}
                isLoading={isLoadingWorkItems}
                onOpen={() => onOpenWorkItem(id)}
              />
            ))}
          </LinkGroup>
        )}

        {!!workItem.relatedWorkItemIds?.length && (
          <LinkGroup label="Related">
            {workItem.relatedWorkItemIds.map((id) => (
              <LinkedWorkItemChip
                key={id}
                workItemId={id}
                workItem={findWorkItem(id)}
                isLoading={isLoadingWorkItems}
                onOpen={() => onOpenWorkItem(id)}
              />
            ))}
          </LinkGroup>
        )}
      </div>}
    </section>
  );
}

function getLinkCount(workItem: AzureDevOpsWorkItem): number {
  return (
    (workItem.linkedPrs?.length ?? 0) +
    (workItem.parentId ? 1 : 0) +
    (workItem.childIds?.length ?? 0) +
    (workItem.relatedWorkItemIds?.length ?? 0)
  );
}

function getLinkedPrKey(
  pr: NonNullable<AzureDevOpsWorkItem['linkedPrs']>[number],
): string {
  return `${pr.projectId}:${pr.repoId}:${pr.prId}`;
}

function LinkGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3">
      <span className="text-ink-3 pt-1 text-xs font-medium">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-2">{children}</div>
    </div>
  );
}

function LinkedPrChip({
  pr,
  status,
  isLoadingStatus,
  onOpen,
}: {
  pr: NonNullable<AzureDevOpsWorkItem['linkedPrs']>[number];
  status?: AzureDevOpsPullRequestStatus;
  isLoadingStatus: boolean;
  onOpen: () => void;
}) {
  const state = getPullRequestState(status);
  const content = (
    <>
      <GitPullRequest className="text-acc-ink h-3.5 w-3.5 shrink-0" />
      <span>PR #{pr.prId}</span>
      {state ? (
        <Chip size="xs" color={state.color} pill className={state.className}>
          {state.label}
        </Chip>
      ) : isLoadingStatus ? (
        <span className="bg-ink-4/20 h-3.5 w-12 shrink-0 animate-pulse rounded-full" />
      ) : (
        <Chip size="xs" color="neutral" pill title="Pull request state unavailable">
          Unknown
        </Chip>
      )}
    </>
  );

  return (
    <LinkChip
      onClick={onOpen}
      title={
        state ? `Open PR #${pr.prId} (${state.label})` : `Open PR #${pr.prId}`
      }
    >
      {content}
    </LinkChip>
  );
}

// Mirrors the PR header badge mapping (src/features/pull-request/ui-pr-header).
function getPullRequestState(status?: AzureDevOpsPullRequestStatus):
  | {
      label: string;
      color: 'green' | 'purple' | 'red' | 'neutral';
      className?: string;
    }
  | null {
  if (!status) return null;
  if (status.isDraft && status.status === 'active') {
    return {
      label: 'Draft',
      color: 'neutral',
      className: '!bg-amber-300 !font-semibold !text-amber-950',
    };
  }
  switch (status.status) {
    case 'completed':
      return { label: 'Merged', color: 'purple' };
    case 'abandoned':
      return { label: 'Closed', color: 'red' };
    default:
      return { label: 'Open', color: 'green' };
  }
}

function LinkedWorkItemChip({
  workItemId,
  workItem,
  isLoading,
  onOpen,
}: {
  workItemId: number;
  workItem?: AzureDevOpsWorkItem;
  isLoading: boolean;
  onOpen: () => void;
}) {
  const title = workItem
    ? `#${workItem.id} ${getTitle(workItem)}`
    : `#${workItemId}`;
  const content = (
    <>
      {workItem ? (
        <WorkItemTypeIcon type={getWorkItemType(workItem)} size="md" />
      ) : isLoading ? (
        <Loader2 className="text-ink-3 h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <FileText className="text-ink-3 h-3.5 w-3.5 shrink-0" />
      )}
      <span className="text-ink-2 shrink-0 text-xs font-medium">
        #{workItemId}
      </span>
      {workItem && (
        <span className="min-w-0 truncate">{getTitle(workItem)}</span>
      )}
    </>
  );

  return (
    <LinkChip onClick={onOpen} title={title}>
      {content}
    </LinkChip>
  );
}

function LinkChip({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  const className =
    'border-glass-border/70 text-ink-1 hover:border-glass-border hover:bg-white/[0.04] flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-white/[0.025] px-2 py-1 text-left text-xs transition-colors';

  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      title={title}
    >
      {children}
    </button>
  );
}

function LinkedDetailModal({
  projectId,
  providerId,
  modal,
  onClose,
}: {
  projectId: string;
  providerId: string | null;
  modal: LinkDetailModal | null;
  onClose: () => void;
}) {
  if (modal?.type === 'work-item') {
    return (
      <Modal
        isOpen
        onClose={onClose}
        title={`Work Item #${modal.workItemId}`}
        size="xl"
        contentClassName="min-h-0 overflow-hidden p-0"
        panelClassName="h-[85vh]"
      >
        <WorkItemDetails projectId={projectId} workItemId={modal.workItemId} />
      </Modal>
    );
  }

  if (modal?.type === 'pull-request') {
    if (!providerId) {
      return (
        <Modal
          isOpen
          onClose={onClose}
          title={`Pull Request #${modal.pr.prId}`}
          size="lg"
        >
          <p className="text-status-fail text-sm">
            Work item provider is required to load pull request details.
          </p>
        </Modal>
      );
    }

    return (
      <Modal
        isOpen
        onClose={onClose}
        title={`Pull Request #${modal.pr.prId}`}
        size="xl"
        contentClassName="min-h-0 overflow-hidden p-0"
        panelClassName="h-[85vh]"
      >
        <PrDetail
          projectId={projectId}
          prId={modal.pr.prId}
          repoInfo={{
            projectName: '',
            providerId,
            projectId: modal.pr.projectId,
            repoId: modal.pr.repoId,
          }}
          readOnly
        />
      </Modal>
    );
  }

  return null;
}
