import clsx from 'clsx';
import {
  Bug,
  BookOpen,
  CheckSquare,
  ChevronRight,
  ExternalLink,
  FileText,
  FlaskConical,
  Loader2,
  MessagesSquare,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { Chip } from '@/common/ui/chip';
import { AzureHtmlContent } from '@/features/common/ui-azure-html-content';
import { WorkItemComments } from '@/features/work-item/ui-work-item-comments';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useProject } from '@/hooks/use-projects';
import {
  useRelatedTestCases,
  useWorkItemById,
  useWorkItemComments,
} from '@/hooks/use-work-items';
import type { AzureDevOpsWorkItem } from '@/lib/api';
import { useWorkItemCommentsPaneWidth } from '@/stores/navigation';

type DetailsTab = 'comments' | 'test-cases';

function WorkItemTypeIcon({
  type,
  size = 'md',
}: {
  type: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClass =
    size === 'lg' ? 'h-6 w-6' : size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5';
  switch (type) {
    case 'Bug':
      return <Bug className={`${sizeClass} text-status-fail shrink-0`} />;
    case 'User Story':
    case 'Feature':
      return <BookOpen className={`${sizeClass} text-acc-ink shrink-0`} />;
    case 'Task':
      return (
        <CheckSquare className={`${sizeClass} text-status-done shrink-0`} />
      );
    default:
      return <FileText className={`${sizeClass} text-ink-2 shrink-0`} />;
  }
}

function StateBadge({ state }: { state: string }) {
  let color: 'neutral' | 'blue' | 'yellow' | 'green' = 'neutral';
  let ringClass = '';
  if (state === 'Active') {
    color = 'blue';
    ringClass = 'ring-1 ring-acc/30';
  } else if (state === 'New') {
    color = 'yellow';
    ringClass = 'ring-1 ring-status-run/30';
  } else if (state === 'Resolved' || state === 'Done' || state === 'Closed') {
    color = 'green';
    ringClass = 'ring-1 ring-status-done/30';
  }
  return (
    <Chip size="sm" color={color} className={ringClass}>
      {state}
    </Chip>
  );
}

export function WorkItemDetails({
  projectId,
  workItemId,
}: {
  projectId: string;
  workItemId: number;
}) {
  const { data: project } = useProject(projectId);
  const providerId = project?.workItemProviderId ?? null;
  const projectName = project?.workItemProjectName ?? null;
  const {
    width: commentsPaneWidth,
    setWidth: setCommentsPaneWidth,
    minWidth: minCommentsPaneWidth,
    maxWidth: maxCommentsPaneWidth,
  } = useWorkItemCommentsPaneWidth();

  const {
    data: workItem,
    isLoading,
    error,
  } = useWorkItemById({
    providerId,
    workItemId,
  });
  const {
    data: comments = [],
    isLoading: isLoadingComments,
    error: commentsError,
  } = useWorkItemComments({
    providerId,
    projectName,
    workItemIds: [workItemId],
  });
  const { data: relatedTestCases = [], isLoading: isLoadingTestCases } =
    useRelatedTestCases({
      providerId,
      projectName,
      workItemId,
    });
  const hasTestCases = isLoadingTestCases || relatedTestCases.length > 0;
  const [activeTab, setActiveTab] = useState<DetailsTab>('comments');

  useEffect(() => {
    if (!hasTestCases && activeTab === 'test-cases') {
      setActiveTab('comments');
    }
  }, [hasTestCases, activeTab]);

  const { containerRef, isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: commentsPaneWidth,
    minWidth: minCommentsPaneWidth,
    maxWidth: maxCommentsPaneWidth,
    maxWidthFraction: 0.6,
    direction: 'left',
    onWidthChange: setCommentsPaneWidth,
  });

  const effectiveCommentsPaneWidth = Math.min(
    commentsPaneWidth,
    maxCommentsPaneWidth,
    Math.floor((containerRef.current?.offsetWidth ?? window.innerWidth) * 0.6),
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

  const { fields } = workItem;
  const description = fields.description || fields.reproSteps;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-glass-border/50 shrink-0 border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <WorkItemTypeIcon type={fields.workItemType} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-ink-2 text-sm font-medium">
                #{workItem.id}
              </span>
              <span className="text-ink-4 text-xs">&bull;</span>
              <span className="text-ink-2 text-xs">{fields.workItemType}</span>
            </div>
            <h1 className="text-ink-0 mt-1 text-lg font-semibold">
              {fields.title}
            </h1>
          </div>
          {workItem.url && (
            <a
              href={workItem.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-2 hover:border-glass-border hover:text-ink-1 border-glass-border flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors"
              title="Open in Azure DevOps"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </a>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StateBadge state={fields.state} />
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-3">Assigned to:</span>
            <span className="text-ink-1">
              {fields.assignedTo ?? 'Unassigned'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-3">Project:</span>
            <span className="text-ink-1">{project.name}</span>
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        className={clsx(
          'flex min-h-0 flex-1 overflow-hidden',
          isDragging && 'select-none',
        )}
      >
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-4">
          {description ? (
            <AzureHtmlContent
              html={description}
              providerId={providerId ?? undefined}
              className="text-ink-1 text-sm"
              imageClassName="max-h-96 w-auto object-contain"
              enableImageModal
            />
          ) : (
            <p className="text-ink-3 text-sm italic">
              No description provided.
            </p>
          )}
        </div>

        <div
          onMouseDown={handleMouseDown}
          className={clsx(
            'hover:bg-acc/30 h-full w-1 shrink-0 cursor-col-resize transition-colors',
            isDragging && 'bg-acc/30',
          )}
        />

        <aside
          className="border-glass-border/50 bg-bg-1/20 flex min-w-0 shrink-0 flex-col border-l"
          style={{ width: effectiveCommentsPaneWidth }}
        >
          <div className="border-glass-border flex gap-0 border-b px-3">
            <FeedTabButton
              active={activeTab === 'comments'}
              onClick={() => setActiveTab('comments')}
              icon={<MessagesSquare className="h-3.5 w-3.5" />}
              label="Comments"
              count={comments.length}
            />
            {hasTestCases && (
              <FeedTabButton
                active={activeTab === 'test-cases'}
                onClick={() => setActiveTab('test-cases')}
                icon={<FlaskConical className="h-3.5 w-3.5" />}
                label="Test Cases"
                count={relatedTestCases.length}
              />
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {activeTab === 'comments' && (
              <WorkItemComments
                comments={comments}
                isLoading={isLoadingComments}
                error={
                  commentsError instanceof Error ? commentsError.message : null
                }
                providerId={providerId ?? undefined}
                emptyMessage="No comments on this work item yet."
                hideHeader
              />
            )}

            {activeTab === 'test-cases' && (
              <div className="flex flex-col gap-2">
                {isLoadingTestCases ? (
                  <p className="text-ink-3 text-sm">Loading test cases...</p>
                ) : (
                  relatedTestCases.map((tc) => (
                    <ExpandableTestCase
                      key={tc.id}
                      testCase={tc}
                      providerId={providerId ?? undefined}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
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
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight
          className={`text-ink-3 h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <FlaskConical className="h-3.5 w-3.5 shrink-0 text-purple-400" />
        <span className="text-ink-2 text-xs font-medium">#{testCase.id}</span>
        <span className="text-ink-1 min-w-0 truncate text-sm">
          {testCase.fields.title}
        </span>
        <span className="text-ink-3 ml-auto shrink-0 text-xs">
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
              className="text-ink-2 text-sm"
            />
          )}
          {hasSteps && (
            <div className="mt-1">
              {testCase.testSteps!.map((step, i) => (
                <div
                  key={i}
                  className="border-b py-2 last:border-b-0"
                  style={{ borderColor: 'oklch(1 0 0 / 0.04)' }}
                >
                  <div className="flex gap-2">
                    <span className="text-ink-3 w-5 shrink-0 text-xs">
                      {i + 1}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <AzureHtmlContent
                        html={step.action}
                        providerId={providerId}
                        className="text-ink-1 text-sm"
                      />
                      {step.expectedResult && (
                        <div className="text-ink-3 mt-0.5">
                          <span className="text-xs font-medium">
                            Expected:{' '}
                          </span>
                          <AzureHtmlContent
                            html={step.expectedResult}
                            providerId={providerId}
                            className="text-ink-3 inline text-sm"
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
            <p className="text-ink-3 text-sm italic">No description.</p>
          )}
        </div>
      )}
    </div>
  );
}

function FeedTabButton({
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
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? 'border-accent-1 text-ink-1'
          : 'text-ink-3 hover:text-ink-2 border-transparent'
      }`}
    >
      {icon}
      {label}
      {count > 0 && (
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
