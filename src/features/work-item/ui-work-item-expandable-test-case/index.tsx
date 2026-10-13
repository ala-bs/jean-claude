import { ChevronRight, FlaskConical } from 'lucide-react';
import {
  getDescriptionHtml,
  getReproStepsHtml,
  getState,
  getTitle,
} from '@shared/work-item-field-types';
import { useState } from 'react';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import { AzureHtmlContent } from '@/features/common/ui-azure-html-content';

/**
 * Collapsible related test case row, shared by the feed detail modal and the
 * work item preview. `variant` keeps the feed modal's roomier type scale and
 * the preview's denser one (the only difference between the two copies).
 */
export function WorkItemExpandableTestCase({
  testCase,
  providerId,
  variant = 'compact',
}: {
  testCase: AzureDevOpsWorkItem;
  providerId?: string;
  variant?: 'compact' | 'comfortable';
}) {
  const [expanded, setExpanded] = useState(false);
  const description = getDescriptionHtml(testCase) || getReproStepsHtml(testCase);
  const hasSteps = testCase.testSteps && testCase.testSteps.length > 0;
  const hasContent = !!description || hasSteps;
  const comfortable = variant === 'comfortable';

  const titleClass = comfortable ? 'text-sm' : 'text-xs';
  const stateClass = comfortable ? 'text-xs' : 'text-[11px]';
  const bodyClass = comfortable ? 'text-sm' : 'text-xs';
  const stepLabelClass = comfortable ? 'text-xs' : 'text-[10px]';

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
        className={`flex w-full items-center px-3 py-2 text-left ${
          comfortable ? 'gap-2.5' : 'gap-2'
        }`}
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight
          className={`text-ink-3 h-3 w-3 shrink-0 transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <FlaskConical className="h-3.5 w-3.5 shrink-0 text-purple-400" />
        <span className="text-ink-2 text-xs font-medium">#{testCase.id}</span>
        <span className={`text-ink-1 min-w-0 truncate ${titleClass}`}>
          {getTitle(testCase)}
        </span>
        <span className={`text-ink-3 ml-auto shrink-0 ${stateClass}`}>
          {getState(testCase)}
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
              className={`text-ink-2 ${bodyClass}`}
            />
          )}
          {hasSteps && (
            <div className="mt-1">
              {testCase.testSteps!.map((step, i) => (
                <div
                  key={i}
                  className={`border-b last:border-b-0 ${
                    comfortable ? 'py-2' : 'py-1.5'
                  }`}
                  style={{ borderColor: 'oklch(1 0 0 / 0.04)' }}
                >
                  <div className="flex gap-2">
                    <span
                      className={`text-ink-3 shrink-0 ${
                        comfortable ? 'w-5 text-xs' : 'w-4 text-[10px]'
                      }`}
                    >
                      {i + 1}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <AzureHtmlContent
                        html={step.action}
                        providerId={providerId}
                        className={`text-ink-1 ${bodyClass}`}
                      />
                      {step.expectedResult && (
                        <div className="text-ink-3 mt-0.5">
                          <span className={`font-medium ${stepLabelClass}`}>
                            Expected:{' '}
                          </span>
                          <AzureHtmlContent
                            html={step.expectedResult}
                            providerId={providerId}
                            className={`text-ink-3 inline ${bodyClass}`}
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
            <p className={`text-ink-3 italic ${bodyClass}`}>No description.</p>
          )}
        </div>
      )}
    </div>
  );
}
