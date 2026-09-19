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

import { WorkItemBoardReadableCard } from './card-readable';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORK_ITEM = {
  id: 4242,
  url: 'https://example.invalid/4242',
  fields: {
    'System.Title': '[api][web] Fix the flaky board card',
    'System.WorkItemType': 'Bug',
    'System.State': 'Active',
    'System.AssignedTo': { displayName: 'Ada Lovelace', uniqueName: 'ada@x.io' },
    'System.IterationPath': 'Proj\\Sprint 7',
    'System.Tags': 'blocked; infra',
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
      <WorkItemBoardReadableCard
        workItem={WORK_ITEM}
        colorSettings={PRIORITY_ON}
        search=""
        parserSetting={null}
        avatar={<span>Ada Lovelace</span>}
        summaryExcerpt={null}
        summaryIsStale={false}
        outOfSprintLabel="S7"
        isExactMatch={false}
        onOpen={() => {}}
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
    hasOutOfSprintLabel: html.includes('title="Iteration: Proj\\Sprint 7"'),
    tagText: tagBlock ? tagBlock.textContent : null,
    scopeLabels: [
      ...(host.querySelector('[aria-label="Extracted labels"]')?.children ?? []),
    ].map((node) => node.textContent),
  };
  act(() => root.unmount());
  host.remove();
  return result;
}

describe('WorkItemBoardReadableCard display config', () => {
  it('renders today s card when the config is null', () => {
    // The stronger property — that a null config is byte-identical to the
    // pre-change component — was verified by diffing full innerHTML across
    // every prop combination below before and after the change.
    const card = renderCard({ displayConfig: null });

    expect(card.hasAvatar).toBe(true);
    expect(card.hasPriorityBadge).toBe(true);
    expect(card.hasOutOfSprintLabel).toBe(true);
    expect(card.tagText).toBe('blocked+1');
  });

  it('renders the same card for an explicit default config', () => {
    expect(
      renderCard({ displayConfig: DEFAULT_WORK_ITEM_DISPLAY_CONFIG }).html,
    ).toBe(renderCard({ displayConfig: null }).html);
  });

  it('keeps the existing priority gate under a null config', () => {
    expect(
      renderCard({
        displayConfig: null,
        colorSettings: DEFAULT_BOARD_COLOR_SETTINGS,
      }).hasPriorityBadge,
    ).toBe(false);
  });

  it('hides only the priority badge when the priority field is hidden', () => {
    const base = renderCard({ displayConfig: null });
    const card = renderCard({
      displayConfig: boardConfig([
        { refName: FIELD_ASSIGNED_TO, visible: true },
        { refName: FIELD_PRIORITY, visible: false },
        { refName: FIELD_ITERATION_PATH, visible: true },
        { refName: FIELD_TAGS, visible: true },
      ]),
    });

    expect(card.hasPriorityBadge).toBe(false);
    expect(card.hasAvatar).toBe(true);
    expect(card.hasOutOfSprintLabel).toBe(true);
    expect(card.tagText).toEqual(base.tagText);
    expect(card.scopeLabels).toEqual(base.scopeLabels);
  });

  it('hides every tag, including colour-rule badges, when the tags field is hidden', () => {
    // The fixture's tags are 'blocked; infra' and `blocked` is a default
    // colour rule, so this also pins the decision that hiding System.Tags
    // hides the red "blocked" badge: a colour-rule badge IS a tag. Non-tag
    // chrome — title-derived scope labels, priority, avatar, the
    // out-of-sprint badge — must be untouched.
    const base = renderCard({ displayConfig: null });
    expect(base.tagText).toContain('blocked');
    const card = renderCard({
      displayConfig: boardConfig([
        { refName: FIELD_ASSIGNED_TO, visible: true },
        { refName: FIELD_PRIORITY, visible: true },
        { refName: FIELD_ITERATION_PATH, visible: true },
        { refName: FIELD_TAGS, visible: false },
      ]),
    });

    expect(card.tagText).toBeNull();
    expect(card.hasPriorityBadge).toBe(true);
    expect(card.hasAvatar).toBe(true);
    expect(card.hasOutOfSprintLabel).toBe(true);
    expect(card.scopeLabels).toEqual(base.scopeLabels);
  });

  it('ignores unknown refNames in the board rows', () => {
    const card = renderCard({
      displayConfig: boardConfig([
        { refName: 'Custom.Whatever', visible: true },
        { refName: FIELD_PRIORITY, visible: true },
        { refName: FIELD_TAGS, visible: true },
      ]),
    });

    expect(card.hasPriorityBadge).toBe(true);
    expect(card.tagText).toBe('blocked+1');
  });
});
