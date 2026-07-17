import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';

import { HighlightedSearchText } from '@/features/work-item/ui-work-item-shared';
import { parseWorkItemTitle } from '@/lib/work-item-title-parser';
import { Tooltip } from '@/common/ui/tooltip';

const COMPACT_LABEL_LIMIT = 5;

export function ParsedWorkItemTitle({
  title,
  parserSetting,
  compact = false,
  titleClassName,
  titleElement = 'span',
  search,
  className,
  labelsClassName,
  renderTitle,
  inline = false,
}: {
  title: string;
  parserSetting: WorkItemTitleParserSetting | null;
  compact?: boolean;
  titleClassName?: string;
  titleElement?: 'span' | 'h3';
  search?: string;
  className?: string;
  labelsClassName?: string;
  renderTitle?: (title: ReactNode) => ReactNode;
  inline?: boolean;
}) {
  const parsed = parseWorkItemTitle({ title, setting: parserSetting });
  const visibleLabels = compact
    ? parsed.labels.slice(0, COMPACT_LABEL_LIMIT)
    : parsed.labels;
  const hiddenLabelCount = parsed.labels.length - visibleLabels.length;
  const renderedTitle = search ? (
    <HighlightedSearchText text={parsed.displayTitle} search={search} />
  ) : (
    parsed.displayTitle
  );
  const TitleElement = inline ? 'span' : titleElement;
  const RootElement = inline ? 'span' : 'div';
  const LabelsElement = inline ? 'span' : 'div';
  const titleNode = <TitleElement className={titleClassName}>{renderedTitle}</TitleElement>;
  const renderedTitleNode = renderTitle ? renderTitle(titleNode) : titleNode;

  if (!parsed.matched) {
    return (
      <RootElement className={clsx('min-w-0', className)}>
        {renderedTitleNode}
      </RootElement>
    );
  }

  return (
    <RootElement className={clsx('min-w-0', className)}>
      {renderedTitleNode}
      {parsed.labels.length > 0 && (
        <LabelsElement
          className={clsx(
            'mt-1 flex min-w-0 flex-wrap items-center gap-1',
            labelsClassName,
          )}
          aria-label="Extracted labels"
        >
          {visibleLabels.map((label) => (
            <span
              key={label.toLocaleLowerCase()}
              title={label}
              className="border-acc/25 bg-acc/10 text-acc-ink max-w-full truncate rounded-full border px-1.5 py-px font-mono text-[9px] leading-3.5 tracking-[0.03em]"
            >
              {label}
            </span>
          ))}
          {hiddenLabelCount > 0 && (
            <Tooltip
              content={
                <div>
                  <div className="text-ink-3 mb-1 font-mono text-[9px] uppercase tracking-wide">
                    Extracted labels
                  </div>
                  <div className="flex max-w-64 flex-wrap gap-1">
                    {parsed.labels.map((label) => (
                      <span
                        key={label.toLocaleLowerCase()}
                        className="border-acc/25 bg-acc/10 text-acc-ink rounded-full border px-1.5 py-px font-mono text-[9px]"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              }
            >
              <span
                tabIndex={0}
                aria-label={`Show all extracted labels: ${parsed.labels.join(', ')}`}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                }}
                className={clsx(
                  'border-line-soft bg-bg-2 text-ink-2 focus-visible:border-acc-line focus-visible:text-acc-ink cursor-default rounded-full border px-1.5 py-px font-mono text-[9px] leading-3.5 outline-none',
                  'hover:border-acc/25 hover:text-ink-1',
                )}
              >
                +{hiddenLabelCount}
              </span>
            </Tooltip>
          )}
        </LabelsElement>
      )}
    </RootElement>
  );
}
