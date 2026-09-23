/**
 * The per-project work item display configuration: its saved shape, its type
 * guard, layout resolution, extras collection and the query-key hash.
 *
 * A `null` config means "use today's hardcoded layout". Because the three
 * detail surfaces do not share one hardcoded layout, that default is
 * per-surface (`DEFAULT_DETAIL_LAYOUT_*`, decisions 23/24), so projects that
 * never touch the setting keep their current behaviour everywhere. Once a
 * config exists, every surface resolves the same `config.detail`.
 */

import {
  type AzureFieldRefName,
  CORE_FIELD_REFNAMES,
  FIELD_ASSIGNED_TO,
  FIELD_BOARD_COLUMN,
  FIELD_ITERATION_PATH,
  FIELD_PRIORITY,
  FIELD_STATE,
  FIELD_STORY_POINTS,
  FIELD_TAGS,
} from './work-item-field-types';

export const WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS = 40;
export const WORK_ITEM_DISPLAY_CONFIG_MAX_OVERRIDES = 20;
export const WORK_ITEM_DISPLAY_CONFIG_MAX_REFNAME_LENGTH = 200;

const REFNAME_PATTERN = /^[A-Za-z0-9_.]{1,200}$/;

export type WorkItemTabId =
  | 'description'
  | 'acceptanceCriteria'
  | 'reproSteps'
  | 'comments'
  | 'history'
  | 'testCases';

const WORK_ITEM_TAB_IDS: readonly WorkItemTabId[] = [
  'description',
  'acceptanceCriteria',
  'reproSteps',
  'comments',
  'history',
  'testCases',
];

export interface WorkItemRowConfig {
  refName: AzureFieldRefName;
  visible: boolean;
}

export interface WorkItemTabConfig {
  id: WorkItemTabId;
  visible: boolean;
}

export interface WorkItemDetailLayout {
  rows: WorkItemRowConfig[];
  tabs: WorkItemTabConfig[];
}

export interface WorkItemDisplayConfig {
  version: 1;
  detail: WorkItemDetailLayout;
  board: { rows: WorkItemRowConfig[] };
  /** Absent key ⇒ inherit `detail`. */
  overridesByType: Record<string, WorkItemDetailLayout>;
}

/**
 * Which detail surface is asking. Used only to pick the default layout when a
 * project has no saved config — once a config exists, every surface resolves
 * the same `config.detail` (decisions 23/24).
 */
export type WorkItemDisplaySurface =
  | 'preview-editorial'
  | 'preview-readonly'
  | 'feed-modal';

/** Tab chrome convergence is out of scope, so all surfaces share this list. */
const DEFAULT_TABS: WorkItemTabConfig[] = [
  { id: 'description', visible: true },
  { id: 'acceptanceCriteria', visible: true },
  { id: 'reproSteps', visible: true },
  { id: 'comments', visible: true },
  { id: 'history', visible: true },
  { id: 'testCases', visible: true },
];

/**
 * Transcribed from `ui-work-item-preview/index.tsx` editorial metadata region:
 * Owner, State, board column editor, Iteration, Story points, Priority, Tags.
 */
export const DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL: WorkItemDetailLayout = {
  rows: [
    { refName: FIELD_ASSIGNED_TO, visible: true },
    { refName: FIELD_STATE, visible: true },
    { refName: FIELD_BOARD_COLUMN, visible: true },
    { refName: FIELD_ITERATION_PATH, visible: true },
    { refName: FIELD_STORY_POINTS, visible: true },
    { refName: FIELD_PRIORITY, visible: true },
    { refName: FIELD_TAGS, visible: true },
  ],
  tabs: DEFAULT_TABS,
};

/**
 * Transcribed from `ui-work-item-preview/index.tsx` non-editorial content
 * header: Assigned, State, Priority, Tags.
 */
export const DEFAULT_DETAIL_LAYOUT_PREVIEW_READONLY: WorkItemDetailLayout = {
  rows: [
    { refName: FIELD_ASSIGNED_TO, visible: true },
    { refName: FIELD_STATE, visible: true },
    { refName: FIELD_PRIORITY, visible: true },
    { refName: FIELD_TAGS, visible: true },
  ],
  tabs: DEFAULT_TABS,
};

/**
 * Transcribed from `feed/ui-work-item-details/index.tsx` metadata row: state
 * badge, board column, owner, story points, iteration, priority, tags.
 */
export const DEFAULT_DETAIL_LAYOUT_FEED_MODAL: WorkItemDetailLayout = {
  rows: [
    { refName: FIELD_STATE, visible: true },
    { refName: FIELD_BOARD_COLUMN, visible: true },
    { refName: FIELD_ASSIGNED_TO, visible: true },
    { refName: FIELD_STORY_POINTS, visible: true },
    { refName: FIELD_ITERATION_PATH, visible: true },
    { refName: FIELD_PRIORITY, visible: true },
    { refName: FIELD_TAGS, visible: true },
  ],
  tabs: DEFAULT_TABS,
};

const DEFAULT_DETAIL_LAYOUT_BY_SURFACE: Record<
  WorkItemDisplaySurface,
  WorkItemDetailLayout
> = {
  'preview-editorial': DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL,
  'preview-readonly': DEFAULT_DETAIL_LAYOUT_PREVIEW_READONLY,
  'feed-modal': DEFAULT_DETAIL_LAYOUT_FEED_MODAL,
};

/**
 * The starting point the settings pane presents when a project has no saved
 * config. Uses the richest detail layout (preview-editorial) so nothing is
 * silently dropped when the user first saves.
 */
export const DEFAULT_WORK_ITEM_DISPLAY_CONFIG: WorkItemDisplayConfig = {
  version: 1,
  detail: DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL,
  board: {
    rows: [
      { refName: FIELD_ASSIGNED_TO, visible: true },
      { refName: FIELD_PRIORITY, visible: true },
      { refName: FIELD_ITERATION_PATH, visible: true },
      { refName: FIELD_TAGS, visible: true },
    ],
  },
  overridesByType: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRowConfig(value: unknown): value is WorkItemRowConfig {
  return (
    isRecord(value) &&
    typeof value.refName === 'string' &&
    value.refName.length <= WORK_ITEM_DISPLAY_CONFIG_MAX_REFNAME_LENGTH &&
    REFNAME_PATTERN.test(value.refName) &&
    typeof value.visible === 'boolean'
  );
}

function isTabConfig(value: unknown): value is WorkItemTabConfig {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (WORK_ITEM_TAB_IDS as readonly string[]).includes(value.id) &&
    typeof value.visible === 'boolean'
  );
}

function isRowList(value: unknown): value is WorkItemRowConfig[] {
  return (
    Array.isArray(value) &&
    value.length <= WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS &&
    value.every((row) => isRowConfig(row))
  );
}

function isDetailLayout(value: unknown): value is WorkItemDetailLayout {
  if (!isRecord(value)) return false;
  if (!isRowList(value.rows)) return false;
  return (
    Array.isArray(value.tabs) &&
    value.tabs.length <= WORK_ITEM_TAB_IDS.length &&
    value.tabs.every((tab) => isTabConfig(tab))
  );
}

export function isWorkItemDisplayConfig(
  value: unknown,
): value is WorkItemDisplayConfig {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isDetailLayout(value.detail)) return false;
  if (!isRecord(value.board) || !isRowList(value.board.rows)) return false;
  if (!isRecord(value.overridesByType)) return false;

  const overrideKeys = Object.keys(value.overridesByType);
  if (overrideKeys.length > WORK_ITEM_DISPLAY_CONFIG_MAX_OVERRIDES) {
    return false;
  }
  for (const key of overrideKeys) {
    if (key.length === 0) return false;
    if (!isDetailLayout(value.overridesByType[key])) return false;
  }
  return true;
}

export function resolveDetailLayout(
  config: WorkItemDisplayConfig | null,
  workItemType: string,
  surface: WorkItemDisplaySurface,
): WorkItemDetailLayout {
  if (!config) return DEFAULT_DETAIL_LAYOUT_BY_SURFACE[surface];
  // Object.hasOwn, not `??`: overridesByType comes from JSON.parse of a DB
  // column and still inherits Object.prototype, so a work item type named
  // 'toString'/'constructor'/'valueOf' would otherwise resolve to the
  // inherited function instead of falling back to config.detail.
  return Object.hasOwn(config.overridesByType, workItemType)
    ? config.overridesByType[workItemType]
    : config.detail;
}

export function resolveBoardRows(
  config: WorkItemDisplayConfig | null,
): WorkItemRowConfig[] {
  if (!config) return DEFAULT_WORK_ITEM_DISPLAY_CONFIG.board.rows;
  return config.board.rows;
}

/**
 * Every configured refName that is visible somewhere and is not part of the
 * always-fetched core set. Hidden-everywhere refNames are excluded.
 */
export function collectExtraFieldRefNames(
  config: WorkItemDisplayConfig | null,
): AzureFieldRefName[] {
  if (!config) return [];

  const core = new Set<AzureFieldRefName>(CORE_FIELD_REFNAMES);
  const extras: AzureFieldRefName[] = [];
  const seen = new Set<AzureFieldRefName>();

  const collect = (rows: WorkItemRowConfig[]): void => {
    for (const row of rows) {
      if (!row.visible) continue;
      if (core.has(row.refName) || seen.has(row.refName)) continue;
      seen.add(row.refName);
      extras.push(row.refName);
    }
  };

  collect(config.detail.rows);
  collect(config.board.rows);
  for (const layout of Object.values(config.overridesByType)) {
    collect(layout.rows);
  }

  return extras;
}

/** Order-independent, stable hash used as a React Query key segment. */
export function hashRefNames(refNames: AzureFieldRefName[]): string {
  if (refNames.length === 0) return 'none';
  const joined = [...new Set(refNames)].sort().join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
