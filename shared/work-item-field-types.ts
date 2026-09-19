/**
 * The refName value model for Azure Boards work items.
 *
 * Work item payloads are normalized to Azure's own field model: a record keyed
 * by field reference name. This module owns the core refName constants, the
 * built-in metadata for those fields, and the typed accessors every consumer
 * uses instead of indexing the record by hand.
 *
 * No React, no IPC, no Node APIs.
 */

/** An Azure field reference name, e.g. `'System.Title'` or `'Custom.Severity'`. */
export type AzureFieldRefName = string;

export interface WorkItemIdentity {
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
}

export type WorkItemFieldValue =
  | string
  | number
  | boolean
  | WorkItemIdentity
  | null;

export type WorkItemFieldType =
  | 'string'
  | 'plainText'
  | 'html'
  | 'integer'
  | 'double'
  | 'dateTime'
  | 'boolean'
  | 'identity'
  | 'treePath'
  | 'picklistString';

export interface WorkItemFieldMetadata {
  refName: AzureFieldRefName;
  name: string;
  type: WorkItemFieldType;
  readOnly: boolean;
  /** Work item types the field is valid for. Empty array means "all types". */
  validWorkItemTypes: string[];
}

/**
 * Structural shape the accessors need. `AzureDevOpsWorkItem` satisfies it, so
 * `shared/` never has to import from `electron/`.
 */
export interface WorkItemFieldsHolder {
  fields: Record<AzureFieldRefName, WorkItemFieldValue>;
}

export const FIELD_TITLE = 'System.Title';
export const FIELD_WORK_ITEM_TYPE = 'System.WorkItemType';
export const FIELD_TEAM_PROJECT = 'System.TeamProject';
export const FIELD_STATE = 'System.State';
export const FIELD_ASSIGNED_TO = 'System.AssignedTo';
export const FIELD_DESCRIPTION = 'System.Description';
export const FIELD_ACCEPTANCE_CRITERIA =
  'Microsoft.VSTS.Common.AcceptanceCriteria';
export const FIELD_REPRO_STEPS = 'Microsoft.VSTS.TCM.ReproSteps';
export const FIELD_STEPS = 'Microsoft.VSTS.TCM.Steps';
export const FIELD_CHANGED_DATE = 'System.ChangedDate';
export const FIELD_BOARD_COLUMN = 'System.BoardColumn';
export const FIELD_BOARD_COLUMN_DONE = 'System.BoardColumnDone';
export const FIELD_TAGS = 'System.Tags';
export const FIELD_PRIORITY = 'Microsoft.VSTS.Common.Priority';
export const FIELD_STACK_RANK = 'Microsoft.VSTS.Common.StackRank';
export const FIELD_STORY_POINTS = 'Microsoft.VSTS.Scheduling.StoryPoints';
export const FIELD_ITERATION_PATH = 'System.IterationPath';

/** Always fetched, regardless of display config (decision 7). */
export const CORE_FIELD_REFNAMES: readonly AzureFieldRefName[] = [
  FIELD_TITLE,
  FIELD_WORK_ITEM_TYPE,
  FIELD_TEAM_PROJECT,
  FIELD_STATE,
  FIELD_ASSIGNED_TO,
  FIELD_DESCRIPTION,
  FIELD_ACCEPTANCE_CRITERIA,
  FIELD_REPRO_STEPS,
  FIELD_STEPS,
  FIELD_CHANGED_DATE,
  FIELD_BOARD_COLUMN,
  FIELD_BOARD_COLUMN_DONE,
  FIELD_TAGS,
  FIELD_PRIORITY,
  FIELD_STACK_RANK,
  FIELD_STORY_POINTS,
  FIELD_ITERATION_PATH,
];

/** Inline-editable in v1 (decision 12). */
export const EDITABLE_FIELD_REFNAMES: readonly AzureFieldRefName[] = [
  FIELD_TITLE,
  FIELD_ASSIGNED_TO,
  FIELD_STATE,
  FIELD_ITERATION_PATH,
  FIELD_STORY_POINTS,
  FIELD_PRIORITY,
  FIELD_TAGS,
];

/** Built-in metadata for the core fields, used when Azure metadata is unavailable (F4). */
export const CORE_FIELD_METADATA: Readonly<
  Record<AzureFieldRefName, WorkItemFieldMetadata>
> = {
  [FIELD_TITLE]: {
    refName: FIELD_TITLE,
    name: 'Title',
    type: 'string',
    readOnly: false,
    validWorkItemTypes: [],
  },
  [FIELD_WORK_ITEM_TYPE]: {
    refName: FIELD_WORK_ITEM_TYPE,
    name: 'Work Item Type',
    type: 'string',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_TEAM_PROJECT]: {
    refName: FIELD_TEAM_PROJECT,
    name: 'Team Project',
    type: 'string',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_STATE]: {
    refName: FIELD_STATE,
    name: 'State',
    type: 'string',
    readOnly: false,
    validWorkItemTypes: [],
  },
  [FIELD_ASSIGNED_TO]: {
    refName: FIELD_ASSIGNED_TO,
    name: 'Assigned To',
    type: 'identity',
    readOnly: false,
    validWorkItemTypes: [],
  },
  [FIELD_DESCRIPTION]: {
    refName: FIELD_DESCRIPTION,
    name: 'Description',
    type: 'html',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_ACCEPTANCE_CRITERIA]: {
    refName: FIELD_ACCEPTANCE_CRITERIA,
    name: 'Acceptance Criteria',
    type: 'html',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_REPRO_STEPS]: {
    refName: FIELD_REPRO_STEPS,
    name: 'Repro Steps',
    type: 'html',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_STEPS]: {
    refName: FIELD_STEPS,
    name: 'Steps',
    type: 'html',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_CHANGED_DATE]: {
    refName: FIELD_CHANGED_DATE,
    name: 'Changed Date',
    type: 'dateTime',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_BOARD_COLUMN]: {
    refName: FIELD_BOARD_COLUMN,
    name: 'Board Column',
    type: 'string',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_BOARD_COLUMN_DONE]: {
    refName: FIELD_BOARD_COLUMN_DONE,
    name: 'Board Column Done',
    type: 'boolean',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_TAGS]: {
    refName: FIELD_TAGS,
    name: 'Tags',
    type: 'string',
    readOnly: false,
    validWorkItemTypes: [],
  },
  [FIELD_PRIORITY]: {
    refName: FIELD_PRIORITY,
    name: 'Priority',
    type: 'integer',
    readOnly: false,
    validWorkItemTypes: [],
  },
  [FIELD_STACK_RANK]: {
    refName: FIELD_STACK_RANK,
    name: 'Stack Rank',
    type: 'double',
    readOnly: true,
    validWorkItemTypes: [],
  },
  [FIELD_STORY_POINTS]: {
    refName: FIELD_STORY_POINTS,
    name: 'Story Points',
    type: 'double',
    readOnly: false,
    validWorkItemTypes: [],
  },
  [FIELD_ITERATION_PATH]: {
    refName: FIELD_ITERATION_PATH,
    name: 'Iteration Path',
    type: 'treePath',
    readOnly: false,
    validWorkItemTypes: [],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Normalizes one raw Azure field value (identity objects → WorkItemIdentity). */
export function normalizeFieldValue(raw: unknown): WorkItemFieldValue {
  if (raw === null || raw === undefined) return null;
  if (
    typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'boolean'
  ) {
    return raw;
  }
  if (isRecord(raw) && typeof raw.displayName === 'string') {
    const identity: WorkItemIdentity = { displayName: raw.displayName };
    if (typeof raw.uniqueName === 'string') identity.uniqueName = raw.uniqueName;
    if (typeof raw.imageUrl === 'string') identity.imageUrl = raw.imageUrl;
    return identity;
  }
  return null;
}

export function getFieldValue(
  item: WorkItemFieldsHolder,
  ref: AzureFieldRefName,
): WorkItemFieldValue {
  return item.fields[ref] ?? null;
}

export function getStringField(
  item: WorkItemFieldsHolder,
  ref: AzureFieldRefName,
): string | undefined {
  const value = item.fields[ref];
  return typeof value === 'string' ? value : undefined;
}

export function getNumberField(
  item: WorkItemFieldsHolder,
  ref: AzureFieldRefName,
): number | undefined {
  const value = item.fields[ref];
  return typeof value === 'number' ? value : undefined;
}

export function getBooleanField(
  item: WorkItemFieldsHolder,
  ref: AzureFieldRefName,
): boolean | undefined {
  const value = item.fields[ref];
  return typeof value === 'boolean' ? value : undefined;
}

export function getIdentityField(
  item: WorkItemFieldsHolder,
  ref: AzureFieldRefName,
): WorkItemIdentity | undefined {
  const value = item.fields[ref];
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof value.displayName === 'string'
  ) {
    return value;
  }
  return undefined;
}

export function getTitle(item: WorkItemFieldsHolder): string {
  return getStringField(item, FIELD_TITLE) ?? '';
}

export function getWorkItemType(item: WorkItemFieldsHolder): string {
  return getStringField(item, FIELD_WORK_ITEM_TYPE) ?? '';
}

export function getState(item: WorkItemFieldsHolder): string {
  return getStringField(item, FIELD_STATE) ?? '';
}

export function getTeamProject(item: WorkItemFieldsHolder): string | undefined {
  return getStringField(item, FIELD_TEAM_PROJECT);
}

export function getAssignee(
  item: WorkItemFieldsHolder,
): WorkItemIdentity | undefined {
  return getIdentityField(item, FIELD_ASSIGNED_TO);
}

export function getDescriptionHtml(
  item: WorkItemFieldsHolder,
): string | undefined {
  return getStringField(item, FIELD_DESCRIPTION);
}

export function getAcceptanceCriteriaHtml(
  item: WorkItemFieldsHolder,
): string | undefined {
  return getStringField(item, FIELD_ACCEPTANCE_CRITERIA);
}

export function getReproStepsHtml(
  item: WorkItemFieldsHolder,
): string | undefined {
  return getStringField(item, FIELD_REPRO_STEPS);
}

export function getChangedDate(item: WorkItemFieldsHolder): string | undefined {
  return getStringField(item, FIELD_CHANGED_DATE);
}

export function getBoardColumn(item: WorkItemFieldsHolder): string | undefined {
  return getStringField(item, FIELD_BOARD_COLUMN);
}

export function getBoardColumnDone(
  item: WorkItemFieldsHolder,
): boolean | undefined {
  return getBooleanField(item, FIELD_BOARD_COLUMN_DONE);
}

/** Splits the raw Azure `'a; b'` tag string (decision 21). */
export function getTags(item: WorkItemFieldsHolder): string[] {
  const raw = getStringField(item, FIELD_TAGS);
  if (!raw) return [];
  return raw
    .split(';')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function getPriority(item: WorkItemFieldsHolder): number | undefined {
  return getNumberField(item, FIELD_PRIORITY);
}

export function getStackRank(item: WorkItemFieldsHolder): number | undefined {
  return getNumberField(item, FIELD_STACK_RANK);
}

export function getStoryPoints(item: WorkItemFieldsHolder): number | undefined {
  return getNumberField(item, FIELD_STORY_POINTS);
}

export function getIterationPath(
  item: WorkItemFieldsHolder,
): string | undefined {
  return getStringField(item, FIELD_ITERATION_PATH);
}
