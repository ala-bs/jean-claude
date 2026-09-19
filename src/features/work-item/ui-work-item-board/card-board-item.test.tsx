// @vitest-environment happy-dom

/* eslint-disable sort-imports */
import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import {
  FIELD_ASSIGNED_TO,
  FIELD_ITERATION_PATH,
  FIELD_PRIORITY,
  FIELD_TAGS,
} from '@shared/work-item-field-types';
import {
  DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
  type WorkItemDisplayConfig,
  type WorkItemRowConfig,
} from '@shared/work-item-display-config-types';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import {
  type BoardColorSettings,
  DEFAULT_BOARD_COLOR_SETTINGS,
} from '@/features/work-item/utils-board-colors';

import { WorkItemBoardCard } from './card-board-item';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORK_ITEM = {
  id: 4242,
  url: 'https://example.invalid/4242',
  fields: {
    'System.Title': 'Fix the flaky board card',
    'System.WorkItemType': 'Bug',
    'System.State': 'Active',
    'System.AssignedTo': { displayName: 'Ada Lovelace', uniqueName: 'ada@x.io' },
    'System.IterationPath': 'Proj\\Sprint 7',
    'System.Tags': 'infra; flaky',
    'Microsoft.VSTS.Common.Priority': 2,
  },
} as unknown as AzureDevOpsWorkItem;

const PRIORITY_ON: BoardColorSettings = {
  ...DEFAULT_BOARD_COLOR_SETTINGS,
  showPriority: true,
};

function boardConfig(rows: WorkItemRowConfig[]): WorkItemDisplayConfig {
  return { ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG, board: { rows } };
}

function renderCard(props: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <WorkItemBoardCard
        workItem={WORK_ITEM}
        search=""
        variant="default"
        parserSetting={null}
        colorSettings={PRIORITY_ON}
        currentIterationPath="Proj\\Sprint 8"
        currentUserDisplayName="Ada Lovelace"
        isHighlighted={false}
        isExactMatch={false}
        isSelected={false}
        isRelatedBug={false}
        bugClosedCount={null}
        bugTotalCount={null}
        summaryExcerpt={null}
        summaryIsStale={false}
        showSelection={false}
        onHighlight={() => {}}
        {...props}
      />,
    );
  });
  const html = host.innerHTML;
  const tagBlock = host.querySelector('[aria-label="Tags"]');
  const result = {
    html,
    hasAvatar: html.includes('Ada Lovelace'),
    hasPriorityBadge: html.includes('aria-label="Priority 2"'),
    hasOutOfSprintBadge: html.includes('title="Iteration: Proj\\Sprint 7"'),
    tagChips: tagBlock
      ? [...tagBlock.querySelectorAll('span')].map((node) => node.textContent)
      : null,
    badgeOrder: [...host.querySelectorAll('span')]
      .map((node): string | null => {
        if (node.getAttribute('aria-label') === 'Priority 2') return 'priority';
        if (node.getAttribute('title')?.startsWith('Iteration:')) {
          return 'iteration';
        }
        if (node.textContent === 'Exact') return 'exact';
        return null;
      })
      .filter((entry): entry is string => entry !== null),
  };
  act(() => root.unmount());
  host.remove();
  return result;
}

describe('WorkItemBoardCard display config', () => {
  it('renders today s card when the config is null', () => {
    // The stronger property — that a null config is byte-identical to the
    // pre-change component — was verified by diffing full innerHTML across 14
    // prop combinations before and after the change. This pins the elements.
    const card = renderCard({ displayConfig: null });

    expect(card.hasAvatar).toBe(true);
    expect(card.hasPriorityBadge).toBe(true);
    expect(card.hasOutOfSprintBadge).toBe(true);
    expect(card.tagChips).toEqual(['infra', 'flaky']);
    expect(card.badgeOrder).toEqual(['priority', 'iteration']);
  });

  it('keeps the existing gates under a null config', () => {
    expect(
      renderCard({ displayConfig: null, colorSettings: DEFAULT_BOARD_COLOR_SETTINGS })
        .hasPriorityBadge,
    ).toBe(false);
    // Iteration badge is out-of-sprint only.
    expect(
      renderCard({ displayConfig: null, currentIterationPath: undefined })
        .hasOutOfSprintBadge,
    ).toBe(false);
    expect(
      renderCard({
        displayConfig: null,
        workItem: {
          ...WORK_ITEM,
          fields: { ...WORK_ITEM.fields, 'System.AssignedTo': undefined },
        } as unknown as AzureDevOpsWorkItem,
      }).hasAvatar,
    ).toBe(false);
    expect(
      renderCard({
        displayConfig: null,
        workItem: {
          ...WORK_ITEM,
          fields: { ...WORK_ITEM.fields, 'System.Tags': '' },
        } as unknown as AzureDevOpsWorkItem,
      }).tagChips,
    ).toBeNull();
  });

  it('renders the same card for an explicit default config', () => {
    expect(renderCard({ displayConfig: DEFAULT_WORK_ITEM_DISPLAY_CONFIG }).html).toBe(
      renderCard({ displayConfig: null }).html,
    );
  });

  it('hides only the tag chips when System.Tags is hidden', () => {
    const card = renderCard({
      displayConfig: boardConfig([
        { refName: FIELD_ASSIGNED_TO, visible: true },
        { refName: FIELD_PRIORITY, visible: true },
        { refName: FIELD_ITERATION_PATH, visible: true },
        { refName: FIELD_TAGS, visible: false },
      ]),
    });

    expect(card.tagChips).toBeNull();
    expect(card.hasAvatar).toBe(true);
    expect(card.hasPriorityBadge).toBe(true);
    expect(card.hasOutOfSprintBadge).toBe(true);
  });

  it('hides the avatar, the priority badge and the iteration badge on request', () => {
    const card = renderCard({
      displayConfig: boardConfig([
        { refName: FIELD_ASSIGNED_TO, visible: false },
        { refName: FIELD_PRIORITY, visible: false },
        { refName: FIELD_ITERATION_PATH, visible: false },
        { refName: FIELD_TAGS, visible: true },
      ]),
    });

    expect(card.hasAvatar).toBe(false);
    expect(card.hasPriorityBadge).toBe(false);
    expect(card.hasOutOfSprintBadge).toBe(false);
    expect(card.tagChips).toEqual(['infra', 'flaky']);
  });

  it('follows the configured badge order', () => {
    const card = renderCard({
      isExactMatch: true,
      displayConfig: boardConfig([
        { refName: FIELD_ITERATION_PATH, visible: true },
        { refName: FIELD_PRIORITY, visible: true },
      ]),
    });

    expect(card.badgeOrder).toEqual(['iteration', 'priority', 'exact']);
  });

  it('keeps the Exact badge leading when priority has no slot', () => {
    const card = renderCard({
      isExactMatch: true,
      displayConfig: boardConfig([
        { refName: FIELD_ITERATION_PATH, visible: true },
      ]),
    });

    expect(card.badgeOrder).toEqual(['exact', 'iteration']);
  });

  it('ignores a configured refName that has no card element', () => {
    const card = renderCard({
      displayConfig: boardConfig([
        { refName: 'Custom.Severity', visible: true },
        { refName: 'System.State', visible: true },
        { refName: FIELD_TAGS, visible: true },
      ]),
    });

    expect(card.tagChips).toEqual(['infra', 'flaky']);
    expect(card.hasAvatar).toBe(false);
    expect(card.hasPriorityBadge).toBe(false);
    expect(card.hasOutOfSprintBadge).toBe(false);
    expect(card.html).not.toContain('Custom.Severity');
    expect(card.badgeOrder).toEqual([]);
  });

  it('gates the editorial card avatar and out-of-sprint label too', () => {
    const hidden = renderCard({
      variant: 'editorial',
      displayConfig: boardConfig([
        { refName: FIELD_ASSIGNED_TO, visible: false },
        { refName: FIELD_ITERATION_PATH, visible: false },
      ]),
    });
    const shown = renderCard({ variant: 'editorial', displayConfig: null });

    expect(hidden.hasAvatar).toBe(false);
    expect(hidden.hasOutOfSprintBadge).toBe(false);
    expect(shown.hasAvatar).toBe(true);
    expect(shown.hasOutOfSprintBadge).toBe(true);
  });
});
