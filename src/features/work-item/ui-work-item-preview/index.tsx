import {
  ChevronRight,
  FileText,
  FlaskConical,
  MessagesSquare,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { Kbd } from '@/common/ui/kbd';
import { AzureHtmlContent } from '@/features/common/ui-azure-html-content';
import {
  useRelatedTestCases,
  useWorkItemComments,
} from '@/hooks/use-work-items';
import type { AzureDevOpsWorkItem } from '@/lib/api';

import { WorkItemComments } from '../ui-work-item-comments';
import { WorkItemTypeIcon } from '../ui-work-item-shared';

type DetailsTab = 'content' | 'comments' | 'test-cases';

export function WorkItemPreview({
  workItem,
  providerId,
  projectName,
}: {
  workItem: AzureDevOpsWorkItem | null;
  providerId?: string;
  projectName?: string;
}) {
  const workItemId = workItem?.id ?? null;
  const {
    data: comments = [],
    isLoading: isLoadingComments,
    error: commentsError,
  } = useWorkItemComments({
    providerId: providerId ?? null,
    projectName: projectName ?? null,
    workItemIds: workItemId ? [workItemId] : [],
  });

  const { data: relatedTestCases = [], isLoading: isLoadingTestCases } =
    useRelatedTestCases({
      providerId: providerId ?? null,
      projectName: projectName ?? null,
      workItemId,
    });

  const hasTestCases = isLoadingTestCases || relatedTestCases.length > 0;
  const [activeTab, setActiveTab] = useState<DetailsTab>('content');

  useEffect(() => {
    if (!hasTestCases && activeTab === 'test-cases') {
      setActiveTab('content');
    }
  }, [hasTestCases, activeTab]);

  if (!workItem) {
    return (
      <div className="flex h-full min-h-37.5 items-center justify-center">
        <p className="text-ink-3 text-sm">Select a work item to see details</p>
      </div>
    );
  }

  const { id, fields } = workItem;
  const { title, workItemType, state, assignedTo } = fields;
  const hasReproSteps = workItemType === 'Bug' && !!fields.reproSteps;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-2">
        <WorkItemTypeIcon type={workItemType} />
        <span className="text-ink-2 text-sm font-medium">#{id}</span>
        <span className="text-ink-3 ml-auto flex items-center gap-1 text-xs">
          <Kbd shortcut="cmd+shift+o" /> open
        </span>
      </div>

      <h3 className="text-ink-0 mt-2 text-sm font-medium">{title}</h3>

      <div className="border-glass-border mt-3 flex gap-0 border-b">
        <TabButton
          active={activeTab === 'content'}
          onClick={() => setActiveTab('content')}
          icon={<FileText className="h-3.5 w-3.5" />}
          label="Content"
        />
        <TabButton
          active={activeTab === 'comments'}
          onClick={() => setActiveTab('comments')}
          icon={<MessagesSquare className="h-3.5 w-3.5" />}
          label="Comments"
          count={comments.length}
        />
        {hasTestCases && (
          <TabButton
            active={activeTab === 'test-cases'}
            onClick={() => setActiveTab('test-cases')}
            icon={<FlaskConical className="h-3.5 w-3.5" />}
            label="Test Cases"
            count={relatedTestCases.length}
          />
        )}
      </div>

      <div className="mt-3 min-h-0 flex-1">
        {activeTab === 'content' && (
          <div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <div className="flex items-center gap-1">
                <span className="text-ink-3">Assigned:</span>
                <span className="text-ink-1">{assignedTo ?? 'Unassigned'}</span>
              </div>

              <div className="flex items-center gap-1">
                <span className="text-ink-3">State:</span>
                <span className="text-ink-1">{state}</span>
              </div>
            </div>

            {(fields.description || hasReproSteps) && (
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

            {hasReproSteps && (
              <div className={fields.description ? 'mt-4' : undefined}>
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
          />
        )}

        {activeTab === 'test-cases' && (
          <div className="flex flex-col gap-1 pb-2">
            {isLoadingTestCases ? (
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
