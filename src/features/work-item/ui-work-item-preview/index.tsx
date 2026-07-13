import {
  ChevronDown,
  ChevronRight,
  FileText,
  FlaskConical,
  History,
  Link2,
  Loader2,
  MessagesSquare,
} from 'lucide-react';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';


import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { getOwnerColor, normalizeOwnerName } from '@/features/work-item/utils-owner-color';
import {
  useAddWorkItemComment,
  useRelatedTestCases,
  useUpdateWorkItemField,
  useUpdateWorkItemState,
  useWorkItemComments,
  useWorkItemHistory,
  useWorkItemsByIds,
  useWorkItemStates,
} from '@/hooks/use-work-items';
import type { AzureDevOpsWorkItem } from '@/lib/api';
import { AzureHtmlContent } from '@/features/common/ui-azure-html-content';
import { Kbd } from '@/common/ui/kbd';
import { UserAvatar } from '@/common/ui/user-avatar';



import {
  addOpenedCommentsWorkItemId,
  beginMetadataEdit,
  beginMetadataSave,
  cancelMetadataEdit,
  finishMetadataSave,
  getWorkItemPreviewQueryPolicy,
} from './query-policy';
import { WorkItemComments } from '../ui-work-item-comments';
import { WorkItemHistory } from '../ui-work-item-history';
import { WorkItemTagEditor } from '../ui-work-item-tag-editor';
import { WorkItemTypeIcon } from '../ui-work-item-shared';
type DetailsTab = 'content' | 'comments' | 'history' | 'test-cases';

export function WorkItemPreview({
  workItem,
  providerId,
  projectName,
  showCommentsAside = false,
  readOnly = false,
  editableMetadata = false,
  assigneeOptions = [],
  iterationOptions = [],
  tagOptions = [],
  showRelatedWorkItems = false,
  onOpenRelatedWorkItem,
  headerLeading,
  headerActions,
  variant = 'default',
}: {
  workItem: AzureDevOpsWorkItem | null;
  providerId?: string;
  projectName?: string;
  showCommentsAside?: boolean;
  readOnly?: boolean;
  editableMetadata?: boolean;
  assigneeOptions?: string[];
  iterationOptions?: Array<{ value: string; label: string }>;
  tagOptions?: string[];
  showRelatedWorkItems?: boolean;
  onOpenRelatedWorkItem?: (workItemId: number) => void;
  headerLeading?: ReactNode;
  headerActions?: ReactNode;
  variant?: 'default' | 'editorial';
}) {
  const workItemId = workItem?.id ?? null;
  const [activeTab, setActiveTab] = useState<DetailsTab>('content');
  const [openedCommentsWorkItemIds, setOpenedCommentsWorkItemIds] = useState(
    () => new Set<number>(),
  );
  const [currentState, setCurrentState] = useState(
    workItem?.fields.state ?? '',
  );
  const workItemIdRef = useRef(workItemId);
  const isEditorial = variant === 'editorial';
  const queryPolicy = getWorkItemPreviewQueryPolicy({
    variant,
    showCommentsAside,
    commentsTabActive: activeTab === 'comments',
    historyTabActive: activeTab === 'history',
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
  const { data: availableStates = [], isLoading: isLoadingStates } =
    useWorkItemStates({
      providerId: providerId ?? null,
      projectName: projectName ?? null,
      workItemType: workItem?.fields.workItemType ?? null,
    });
  const addComment = useAddWorkItemComment();
  const updateState = useUpdateWorkItemState();
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
    });

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
    startTransition(() => setCurrentState(workItem?.fields.state ?? ''));
    workItemIdRef.current = workItem?.id ?? null;
  }, [workItem?.id, workItem?.fields.state]);

  if (!workItem) {
    return (
      <div className="flex h-full min-h-37.5 items-center justify-center px-6">
        <p className="text-ink-4 text-center text-xs italic">Select a work item</p>
      </div>
    );
  }

  const { id, fields } = workItem;
  const { workItemType, assignedTo } = fields;
  const hasReproSteps = workItemType === 'Bug' && !!fields.reproSteps;
  const hasContent = !!fields.description || !!fields.acceptanceCriteria || hasReproSteps;
  const showTestCases = hasTestCases && !isEditorial;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {(editableMetadata || headerLeading || headerActions) && <div className={isEditorial ? 'border-line flex items-start gap-2 border-b px-4 py-3' : 'border-glass-border flex items-start gap-2 border-b px-3 py-2.5'}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <WorkItemTypeIcon type={workItemType} size="sm" variant={variant} />
            <span className="text-ink-3 font-mono text-[10px]">#{id} · {workItemType}</span>
          </div>
          <div className="mt-1 flex items-start gap-1.5">
            {headerLeading}
            {canEditMetadata && providerId ? (
              <EditableMetadataValue
                key={`${id}:title:${fields.title}`}
                value={fields.title}
                label="Title"
                className="text-ink-0 block min-w-0 flex-1 text-left text-sm font-semibold leading-snug"
                fullWidth
                validate={(value) => value.trim() ? null : 'Title cannot be empty'}
                onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.Title', value })}
              />
            ) : (
              <h3 className="text-ink-0 min-w-0 flex-1 text-sm font-medium">{fields.title}</h3>
            )}
          </div>
          {isEditorial && (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-2">
                <MetadataDropdown
                  key={`${id}:owner`}
                  label="Owner"
                  value={assignedTo ?? ''}
                  emptyLabel="Unassigned"
                  options={[
                    '',
                    ...(assignedTo ? [assignedTo] : []),
                    ...assigneeOptions.filter(
                      (assignee) => normalizeOwnerName(assignee) !== normalizeOwnerName(assignedTo ?? ''),
                    ),
                  ]}
                  colorizeOwners
                  disabled={!canEditMetadata || !providerId}
                  onSave={(value) => updateField.mutateAsync({ providerId: providerId!, workItemId: id, field: 'System.AssignedTo', value })}
                />
                <MetadataDropdown
                  key={`${id}:state`}
                  label="State"
                  value={currentState}
                  options={[...new Set([currentState, ...availableStates.map((state) => state.name)])]}
                  disabled={!canEditMetadata || !providerId}
                  onSave={(value) => updateField.mutateAsync({ providerId: providerId!, workItemId: id, field: 'System.State', value })}
                />
                {fields.iterationPath && (
                  <MetadataDropdown
                    key={`${id}:iteration`}
                    label="Iteration"
                    value={fields.iterationPath}
                    options={[
                      fields.iterationPath,
                      ...iterationOptions
                        .map((iteration) => iteration.value)
                        .filter((path) => path !== fields.iterationPath),
                    ]}
                    optionLabels={{
                      [fields.iterationPath]:
                        fields.iterationPath.split(/[\\/]/).at(-1) ?? fields.iterationPath,
                      ...Object.fromEntries(
                        iterationOptions.map((iteration) => [iteration.value, iteration.label]),
                      ),
                    }}
                    disabled={!canEditMetadata || !providerId}
                    onSave={(value) => updateField.mutateAsync({ providerId: providerId!, workItemId: id, field: 'System.IterationPath', value })}
                  />
                )}
                {canEditMetadata && providerId && (
                  <div className="border-glass-border bg-glass-light text-ink-1 focus-within:border-acc-line flex min-h-8 items-center gap-2 rounded-md border px-3 py-1 text-xs transition-colors">
                    <span className="text-ink-3">Priority</span>
                    <EditableMetadataValue
                      key={`${id}:priority:${fields.priority ?? ''}`}
                      value={String(fields.priority ?? '')}
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
                )}
              </div>
              {canEditMetadata && providerId && (
                <WorkItemTagEditor
                  key={`${id}:tags:${fields.tags ?? ''}`}
                  value={fields.tags ?? ''}
                  suggestions={tagOptions}
                  onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.Tags', value })}
                />
              )}
            </div>
          )}
        </div>
        {headerActions && <div className="flex shrink-0 items-center gap-1">{headerActions}</div>}
      </div>}
       <div className={isEditorial ? 'border-line flex gap-1 border-b px-3 pt-2' : 'border-glass-border flex gap-0 border-b'}>
        <TabButton
          active={activeTab === 'content'}
          onClick={() => setActiveTab('content')}
          icon={<FileText className="h-3.5 w-3.5" />}
          label="Content"
        />
        {!showCommentsAside && (
          <TabButton
            active={activeTab === 'comments'}
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
        <TabButton
          active={activeTab === 'history'}
          onClick={() => setActiveTab('history')}
          icon={<History className="h-3.5 w-3.5" />}
          label="History"
          count={history.length}
        />
        {showTestCases && (
          <TabButton
            active={activeTab === 'test-cases'}
            onClick={() => setActiveTab('test-cases')}
            icon={<FlaskConical className="h-3.5 w-3.5" />}
            label="Test Cases"
            count={relatedTestCases.length}
          />
        )}
        {!isEditorial && <span className="text-ink-3 ml-auto flex items-center gap-1 text-xs">
          <Kbd shortcut="cmd+shift+o" /> open
        </span>}
      </div>

       <div
         className={`${isEditorial ? 'grid px-4 py-3' : 'mt-3 grid'} min-h-0 flex-1 gap-4 overflow-hidden ${
          showCommentsAside
            ? 'xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]'
            : 'grid-cols-1'
        }`}
      >
        <div className="min-h-0 overflow-y-auto">
          {activeTab === 'content' && (
            <div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {!isEditorial && <>
                <div className="flex items-center gap-1">
                  <span className="text-ink-3">Assigned:</span>
                  {canEditMetadata && providerId ? <EditableMetadataValue key={`${id}:assignee:${assignedTo ?? ''}`} value={assignedTo ?? ''} label="Assignee" emptyLabel="Unassigned" onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.AssignedTo', value })} /> : <span className="text-ink-1">{assignedTo ?? 'Unassigned'}</span>}
                </div>

                <div className="flex items-center gap-1">
                  <span className="text-ink-3">State:</span>
                  {providerId && canEditMetadata ? (
                    <EditableMetadataValue
                      key={`${id}:state:${currentState}`}
                      value={currentState}
                      label="State"
                      options={availableStates.map((state) => state.name)}
                      onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.State', value })}
                    />
                  ) : providerId && !readOnly ? (
                    <EditableStateValue
                      state={currentState}
                      states={availableStates.map((s) => s.name)}
                      isPending={updateState.isPending}
                      isLoading={isLoadingStates}
                      onChange={(nextState) => {
                        const previousState = currentState;
                        setCurrentState(nextState);
                        updateState.mutate(
                          { providerId, workItemId: id, state: nextState },
                          {
                            onError: () => {
                              if (workItemIdRef.current === id) {
                                setCurrentState(previousState);
                              }
                            },
                          },
                        );
                      }}
                    />
                  ) : (
                    <span className="text-ink-1">{currentState}</span>
                  )}
                </div>
                </>}
                {!isEditorial && canEditMetadata && providerId && (
                  <>
                    <div className="flex items-center gap-1"><span className="text-ink-3">Priority:</span><EditableMetadataValue key={`${id}:priority:${fields.priority ?? ''}`} value={String(fields.priority ?? '')} label="Priority" emptyLabel="None" validate={(value) => { const priority = Number(value); return Number.isInteger(priority) && priority >= 1 && priority <= 4 ? null : 'Priority must be an integer from 1 to 4'; }} onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'Microsoft.VSTS.Common.Priority', value: Number(value) })} /></div>
                    <WorkItemTagEditor key={`${id}:tags:${fields.tags ?? ''}`} value={fields.tags ?? ''} suggestions={tagOptions} onSave={(value) => updateField.mutateAsync({ providerId, workItemId: id, field: 'System.Tags', value })} />
                  </>
                )}
              </div>

              {showRelatedWorkItems && relatedIds.length > 0 && (
                <RelatedWorkItems
                  workItem={workItem}
                  items={relatedWorkItems}
                  isLoading={isLoadingRelatedWorkItems}
                  error={relatedWorkItemsError}
                  onOpen={onOpenRelatedWorkItem}
                />
              )}

              {hasContent && (
                <div className="border-glass-border my-3 border-t" />
              )}

              {fields.description && (
                <AzureHtmlContent
                  html={fields.description}
                  providerId={providerId}
                  className="text-ink-2 text-xs"
                  imageClassName="max-h-72 w-auto object-contain"
                  enableImageModal
                />
              )}

              {fields.acceptanceCriteria && (
                <div className={fields.description ? 'mt-4' : undefined}>
                  <h4 className="text-ink-1 mb-1.5 text-xs font-medium">
                    Acceptance Criteria
                  </h4>
                  <AzureHtmlContent
                    html={fields.acceptanceCriteria}
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
                    fields.description || fields.acceptanceCriteria
                      ? 'mt-4'
                      : undefined
                  }
                >
                  <h4 className="text-ink-1 mb-1.5 text-xs font-medium">
                    Repro Steps
                  </h4>
                  <AzureHtmlContent
                    html={fields.reproSteps!}
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

          {activeTab === 'comments' && (
            <WorkItemComments
              comments={comments}
              isLoading={isLoadingComments}
              error={
                commentsError instanceof Error ? commentsError.message : null
              }
              providerId={providerId}
              hideHeader
              isAddingComment={addComment.isPending}
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

          {activeTab === 'history' && (
            <WorkItemHistory
              history={history}
              isLoading={isLoadingHistory}
              error={historyError instanceof Error ? historyError.message : null}
              providerId={providerId}
            />
          )}

          {activeTab === 'test-cases' && (
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
                  <ExpandableTestCase
                    key={tc.id}
                    testCase={tc}
                    providerId={providerId}
                  />
                ))
              )}
            </div>
          )}
        </div>

        {showCommentsAside && (
          <aside className="border-glass-border flex min-h-0 flex-col border-t pt-3 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-4">
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
                hideHeader
                isAddingComment={addComment.isPending}
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
        )}
      </div>
    </div>
  );
}

function RelatedWorkItems({
  workItem,
  items,
  isLoading,
  error,
  onOpen,
}: {
  workItem: AzureDevOpsWorkItem;
  items: AzureDevOpsWorkItem[];
  isLoading: boolean;
  error: Error | null;
  onOpen?: (workItemId: number) => void;
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
                    <button
                      key={id}
                      type="button"
                      disabled={!onOpen}
                      onClick={() => onOpen?.(id)}
                      className="border-glass-border bg-bg-1/60 hover:bg-glass-medium flex w-full min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-default"
                    >
                      <WorkItemTypeIcon type={item.fields.workItemType} size="sm" />
                      <span className="text-ink-3 text-[10px]">#{id}</span>
                      <span className="text-ink-1 min-w-0 flex-1 truncate text-xs">
                        {item.fields.title}
                      </span>
                      <span className="text-ink-3 text-[10px]">{item.fields.state}</span>
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

function MetadataDropdown({
  label,
  value,
  emptyLabel = label,
  options,
  optionLabels = {},
  colorizeOwners = false,
  disabled,
  onSave,
}: {
  label: string;
  value: string;
  emptyLabel?: string;
  options: string[];
  optionLabels?: Record<string, string>;
  colorizeOwners?: boolean;
  disabled?: boolean;
  onSave: (value: string) => Promise<unknown>;
}) {
  const dropdownRef = useRef<{ toggle: () => void } | null>(null);
  const [displayValue, setDisplayValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncedValueRef = useRef(value);
  const lifecycleRef = useRef({
    generation: 0,
    cancelled: false,
    inFlight: false,
  });

  useEffect(() => {
    beginMetadataEdit(lifecycleRef.current);
    syncedValueRef.current = value;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setDisplayValue(value);
      setIsSaving(false);
      setError(null);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const select = async (nextValue: string) => {
    dropdownRef.current?.toggle();
    if (
      nextValue === displayValue ||
      (syncedValueRef.current !== value && nextValue === value)
    ) return;
    const generation = beginMetadataSave(lifecycleRef.current);
    if (generation === null) return;
    const previousValue = displayValue;
    setDisplayValue(nextValue);
    setError(null);
    setIsSaving(true);
    try {
      await onSave(nextValue);
      if (finishMetadataSave(lifecycleRef.current, generation)) {
        setIsSaving(false);
      }
    } catch (saveError) {
      if (finishMetadataSave(lifecycleRef.current, generation)) {
        setDisplayValue(previousValue);
        setError(saveError instanceof Error ? saveError.message : 'Save failed');
        setIsSaving(false);
      }
    }
  };

  const displayLabel = optionLabels[displayValue] ?? (displayValue || emptyLabel);
  return (
    <div className="relative min-w-0">
      <Dropdown
        dropdownRef={dropdownRef}
        className="min-w-52"
        trigger={
          <button
            type="button"
            disabled={disabled || isSaving || options.length <= 1}
            className="border-glass-border bg-glass-light hover:bg-glass-medium focus:border-acc-line text-ink-1 flex h-8 min-w-0 items-center gap-2 rounded-md border px-3 text-xs transition-colors focus:outline-none disabled:cursor-default disabled:opacity-50"
            aria-label={`Edit ${label.toLocaleLowerCase()}`}
          >
            <span className="text-ink-3">{label}</span>
            {colorizeOwners && displayValue && <UserAvatar
              name={displayValue}
              color={getOwnerColor(displayValue)}
            />}
            <span className="max-w-32 truncate">{displayLabel}</span>
            {isSaving
              ? <Loader2 className="text-ink-3 ml-auto h-3 w-3 animate-spin" />
              : !disabled && <ChevronDown className="text-ink-3 ml-auto h-3 w-3" />}
          </button>
        }
      >
        {options.map((option) => {
          const optionLabel = optionLabels[option] ?? (option || emptyLabel);
          return (
            <DropdownItem
              key={option || '__empty__'}
              checked={option === displayValue}
              onClick={() => void select(option)}
            >
              <span className="flex items-center gap-2">
                {colorizeOwners && option && <UserAvatar
                  name={option}
                  color={getOwnerColor(option)}
                />}
                {optionLabel}
              </span>
            </DropdownItem>
          );
        })}
      </Dropdown>
      {error && <span role="alert" className="text-status-fail absolute top-full left-0 z-10 mt-1 text-[10px]">{error}</span>}
    </div>
  );
}

function EditableMetadataValue({
  value,
  label,
  emptyLabel = label,
  options,
  className = 'text-ink-1 hover:text-acc-ink rounded px-1 py-0.5 text-xs',
  fullWidth = false,
  validate,
  onSave,
}: {
  value: string;
  label: string;
  emptyLabel?: string;
  options?: string[];
  className?: string;
  fullWidth?: boolean;
  validate?: (value: string) => string | null;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const lifecycleRef = useRef({
    generation: 0,
    cancelled: false,
    inFlight: false,
  });
  const selectCommitRef = useRef(false);
  const save = async (nextValue = draft) => {
    const generation = beginMetadataSave(lifecycleRef.current);
    if (generation === null) return;
    const normalized = nextValue.trim();
    if (normalized === value) {
      if (finishMetadataSave(lifecycleRef.current, generation)) setEditing(false);
      return;
    }
    const validationError = validate?.(normalized);
    if (validationError) {
      if (finishMetadataSave(lifecycleRef.current, generation)) {
        setError(validationError);
      }
      return;
    }
    try {
      await onSave(normalized);
      if (finishMetadataSave(lifecycleRef.current, generation)) {
        setError(null);
        setEditing(false);
      }
    } catch (saveError) {
      if (finishMetadataSave(lifecycleRef.current, generation)) {
        setError(saveError instanceof Error ? saveError.message : 'Save failed');
      }
    }
  };

  if (!editing) {
    return <button type="button" className={className} onClick={() => { beginMetadataEdit(lifecycleRef.current); setDraft(value); setError(null); setEditing(true); }}>{value || emptyLabel}</button>;
  }

  const inputClassName = `bg-bg-2 text-ink-1 min-w-0 rounded border border-white/10 px-1.5 py-1 text-xs outline-none${fullWidth ? ' w-full' : ''}`;
  return (
    <span className={`inline-flex min-w-0 flex-col${fullWidth ? ' flex-1' : ''}`}>
      {options ? <select autoFocus aria-label={label} aria-invalid={!!error} value={draft} className={inputClassName} onChange={(event) => { selectCommitRef.current = true; setDraft(event.target.value); void save(event.target.value).finally(() => { selectCommitRef.current = false; }); }} onBlur={() => { if (!selectCommitRef.current) setEditing(false); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); cancelMetadataEdit(lifecycleRef.current); setDraft(value); setError(null); setEditing(false); } }}>{options.map((option) => <option key={option}>{option}</option>)}</select> : <input autoFocus aria-label={label} aria-invalid={!!error} value={draft} className={inputClassName} onChange={(event) => setDraft(event.target.value)} onBlur={() => void save()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.stopPropagation(); cancelMetadataEdit(lifecycleRef.current); setDraft(value); setError(null); setEditing(false); } }} />}
      {error && <span role="alert" className="mt-0.5 text-[10px] leading-tight text-red-400">{error}</span>}
    </span>
  );
}

function EditableStateValue({
  state,
  states: availableStates,
  isPending,
  isLoading,
  onChange,
}: {
  state: string;
  states: string[];
  isPending: boolean;
  isLoading: boolean;
  onChange: (state: string) => void;
}) {
  const dropdownRef = useRef<{ toggle: () => void } | null>(null);
  const states = availableStates.includes(state)
    ? availableStates
    : [state, ...availableStates];

  const handleSelect = useCallback(
    (nextState: string) => {
      dropdownRef.current?.toggle();
      if (nextState !== state) onChange(nextState);
    },
    [onChange, state],
  );

  return (
    <Dropdown
      dropdownRef={dropdownRef}
      trigger={
        <button
          type="button"
          disabled={isPending || states.length <= 1}
          className="text-ink-1 hover:text-acc-ink flex items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors disabled:opacity-60"
        >
          {(isPending || isLoading) && (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          {state}
          {states.length > 1 && <ChevronDown className="h-3 w-3 opacity-60" />}
        </button>
      }
    >
      {states.map((nextState) => (
        <DropdownItem
          key={nextState}
          onClick={() => handleSelect(nextState)}
          checked={nextState === state}
        >
          {nextState}
        </DropdownItem>
      ))}
    </Dropdown>
  );
}

function ExpandableTestCase({
  testCase,
  providerId,
}: {
  testCase: AzureDevOpsWorkItem;
  providerId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const description = testCase.fields.description || testCase.fields.reproSteps;
  const hasSteps = testCase.testSteps && testCase.testSteps.length > 0;
  const hasContent = !!description || hasSteps;

  return (
    <div
      className="rounded-md border"
      style={{
        borderColor: 'oklch(1 0 0 / 0.06)',
        background: 'oklch(1 0 0 / 0.02)',
      }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight
          className={`text-ink-3 h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <FlaskConical className="h-3.5 w-3.5 shrink-0 text-purple-400" />
        <span className="text-ink-2 text-xs font-medium">#{testCase.id}</span>
        <span className="text-ink-1 min-w-0 truncate text-xs">
          {testCase.fields.title}
        </span>
        <span className="text-ink-3 ml-auto shrink-0 text-[11px]">
          {testCase.fields.state}
        </span>
      </button>
      {expanded && (
        <div
          className="border-t px-3 py-2"
          style={{ borderColor: 'oklch(1 0 0 / 0.06)' }}
        >
          {description && (
            <AzureHtmlContent
              html={description}
              providerId={providerId}
              className="text-ink-2 text-xs"
            />
          )}
          {hasSteps && (
            <div className="mt-1">
              {testCase.testSteps!.map((step, i) => (
                <div
                  key={i}
                  className="border-b py-1.5 last:border-b-0"
                  style={{ borderColor: 'oklch(1 0 0 / 0.04)' }}
                >
                  <div className="flex gap-2">
                    <span className="text-ink-3 w-4 shrink-0 text-[10px]">
                      {i + 1}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <AzureHtmlContent
                        html={step.action}
                        providerId={providerId}
                        className="text-ink-1 text-xs"
                      />
                      {step.expectedResult && (
                        <div className="text-ink-3 mt-0.5">
                          <span className="text-[10px] font-medium">
                            Expected:{' '}
                          </span>
                          <AzureHtmlContent
                            html={step.expectedResult}
                            providerId={providerId}
                            className="text-ink-3 inline text-xs"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!hasContent && (
            <p className="text-ink-3 text-xs italic">No description.</p>
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'border-accent-1 text-ink-1'
          : 'text-ink-3 hover:text-ink-2 border-transparent'
      }`}
    >
      {icon}
      {label}
      {count != null && count > 0 && (
        <span
          className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] ${
            active ? 'bg-accent-1/10 text-accent-1' : 'bg-ink-4/20 text-ink-3'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
