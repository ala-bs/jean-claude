import {
  DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG,
  isAiSkillSlotsSetting,
  isMobilePreviewProjectConfig,
} from '@shared/types';
import {
  DEFAULT_PROJECT_MODEL_POLICY,
  PROJECT_MODEL_POLICY_MODES,
  type ProjectModelPolicy,
} from '@shared/model-profiles';
import {
  isWorkItemDisplayConfig,
  type WorkItemDisplayConfig,
} from '@shared/work-item-display-config-types';
import {
  isWorkItemTitleParserSetting,
  type WorkItemTitleParserSetting,
} from '@shared/work-item-title-parser-types';

import { NewProject, ProjectRow, ProjectType, UpdateProject } from '../schema';
import { db } from '../index';
import { dbg } from '../../lib/debug';



const MAX_PROTECTED_BRANCHES = 100;
const MAX_BRANCH_NAME_LENGTH = 256;

function sanitizeBranchList(
  branches: string[] | undefined | null,
): string | null {
  if (!branches || branches.length === 0) return null;
  const sanitized = [
    ...new Set(
      branches.filter(
        (b) =>
          typeof b === 'string' &&
          b.length > 0 &&
          b.length <= MAX_BRANCH_NAME_LENGTH,
      ),
    ),
  ].slice(0, MAX_PROTECTED_BRANCHES);
  return sanitized.length > 0 ? JSON.stringify(sanitized) : null;
}

export function parseWorkItemTitleParser(
  value: string | null,
): WorkItemTitleParserSetting | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isWorkItemTitleParserSetting(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeWorkItemTitleParser(
  setting: WorkItemTitleParserSetting | null,
): string | null {
  if (setting === null) return null;
  if (!isWorkItemTitleParserSetting(setting)) {
    throw new TypeError('Invalid work item title parser setting');
  }
  return JSON.stringify(setting);
}

export function serializeWorkItemTitleParserUpdate(
  setting: WorkItemTitleParserSetting | null | undefined,
): { workItemTitleParser?: string | null } {
  return setting === undefined
    ? {}
    : { workItemTitleParser: serializeWorkItemTitleParser(setting) };
}

export function parseWorkItemDisplayConfig(
  value: string | null,
): WorkItemDisplayConfig | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (isWorkItemDisplayConfig(parsed)) return parsed;
    console.warn(
      '[projects] Ignoring invalid workItemDisplayConfig — falling back to the default layout',
    );
    return null;
  } catch {
    console.warn(
      '[projects] Ignoring malformed workItemDisplayConfig JSON — falling back to the default layout',
    );
    return null;
  }
}

export function serializeWorkItemDisplayConfig(
  config: WorkItemDisplayConfig | null,
): string | null {
  if (config === null) return null;
  if (!isWorkItemDisplayConfig(config)) {
    throw new TypeError('Invalid work item display config');
  }
  return JSON.stringify(config);
}

export function serializeWorkItemDisplayConfigUpdate(
  config: WorkItemDisplayConfig | null | undefined,
): { workItemDisplayConfig?: string | null } {
  return config === undefined
    ? {}
    : { workItemDisplayConfig: serializeWorkItemDisplayConfig(config) };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isProjectModelPolicy(value: unknown): value is ProjectModelPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const policy = value as Record<string, unknown>;
  if (
    !PROJECT_MODEL_POLICY_MODES.includes(
      policy.mode as ProjectModelPolicy['mode'],
    )
  ) {
    return false;
  }
  if (
    policy.allowedBackends !== undefined &&
    !isStringArray(policy.allowedBackends)
  ) {
    return false;
  }
  if (
    policy.allowedProfileIds !== undefined &&
    !isStringArray(policy.allowedProfileIds)
  ) {
    return false;
  }
  if (
    policy.pinnedProfileId !== undefined &&
    typeof policy.pinnedProfileId !== 'string'
  ) {
    return false;
  }
  return true;
}

/**
 * Parses the `projects.modelPolicy` JSON column. Null, malformed or
 * guard-failing values fall back to `{ mode: 'inherit' }`.
 */
export function parseProjectModelPolicy(
  value: string | null,
): ProjectModelPolicy {
  if (!value) return DEFAULT_PROJECT_MODEL_POLICY;
  try {
    const parsed: unknown = JSON.parse(value);
    return isProjectModelPolicy(parsed)
      ? parsed
      : DEFAULT_PROJECT_MODEL_POLICY;
  } catch {
    // Malformed JSON — fall back to the inherit default
    return DEFAULT_PROJECT_MODEL_POLICY;
  }
}

export function serializeProjectModelPolicy(
  policy: ProjectModelPolicy,
): string {
  if (!isProjectModelPolicy(policy)) {
    throw new TypeError('Invalid project model policy');
  }
  return JSON.stringify(policy);
}

function parseProjectRow(row: ProjectRow) {
  let aiSkillSlots = null;
  if (row.aiSkillSlots) {
    try {
      const parsed: unknown = JSON.parse(row.aiSkillSlots);
      aiSkillSlots = isAiSkillSlotsSetting(parsed) ? parsed : null;
    } catch {
      // Malformed JSON — fall back to null
    }
  }
  const workItemTitleParser = parseWorkItemTitleParser(row.workItemTitleParser);
  const workItemDisplayConfig = parseWorkItemDisplayConfig(
    row.workItemDisplayConfig,
  );
  let protectedBranches: string[] = [];
  if (row.protectedBranches) {
    try {
      const parsed: unknown = JSON.parse(row.protectedBranches);
      protectedBranches = Array.isArray(parsed)
        ? parsed.filter((b): b is string => typeof b === 'string')
        : [];
    } catch {
      // Malformed JSON — fall back to empty array
    }
  }
  let favoriteBranches: string[] = [];
  if (row.favoriteBranches) {
    try {
      const parsed: unknown = JSON.parse(row.favoriteBranches);
      favoriteBranches = Array.isArray(parsed)
        ? parsed.filter((b): b is string => typeof b === 'string')
        : [];
    } catch {
      // Malformed JSON — fall back to empty
    }
  }
  let mobilePreviewConfig = DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG;
  if (row.mobilePreviewConfig) {
    try {
      const parsed: unknown = JSON.parse(row.mobilePreviewConfig);
      mobilePreviewConfig = isMobilePreviewProjectConfig(parsed)
        ? parsed
        : DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG;
    } catch {
      // Malformed JSON — fall back to default
    }
  }
  return {
    ...row,
    logoSource:
      row.logoSource === 'uploaded' || row.logoSource === 'generated'
        ? row.logoSource
        : null,
    showWorkItemsInFeed: row.showWorkItemsInFeed === 1,
    showPrsInFeed: row.showPrsInFeed === 1,
    autoPullSourceBranch: row.autoPullSourceBranch === 1,
    commitWithNoVerify: row.commitWithNoVerify === 1,
    queuePrAutoComplete: row.queuePrAutoComplete === 1,
    autoAcceptOnTaskCreation: row.autoAcceptOnTaskCreation === 1,
    aiSkillSlots,
    mobilePreviewConfig,
    modelPolicy: parseProjectModelPolicy(row.modelPolicy),
    workItemTitleParser,
    workItemDisplayConfig,
    protectedBranches,
    favoriteBranches,
  };
}

export const ProjectRepository = {
  findAll: async () => {
    const rows = await db
      .selectFrom('projects')
      .selectAll()
      .where('type', '!=', 'system')
      .orderBy('sortOrder', 'asc')
      .execute();
    return rows.map(parseProjectRow);
  },

  findById: async (id: string) => {
    const row = await db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? parseProjectRow(row) : undefined;
  },

  findByType: async (type: ProjectType) => {
    const row = await db
      .selectFrom('projects')
      .selectAll()
      .where('type', '=', type)
      .executeTakeFirst();
    return row ? parseProjectRow(row) : undefined;
  },

  create: async (data: NewProject) => {
    dbg.db('projects.create name=%s, path=%s', data.name, data.path);
    // Get max sortOrder and add 1 for new project
    const result = await db
      .selectFrom('projects')
      .select(db.fn.max('sortOrder').as('maxOrder'))
      .executeTakeFirst();

    const nextSortOrder = ((result?.maxOrder as number | null) ?? -1) + 1;

    const {
      showWorkItemsInFeed,
      showPrsInFeed,
      autoPullSourceBranch,
      commitWithNoVerify,
      queuePrAutoComplete,
      autoAcceptOnTaskCreation,
      aiSkillSlots,
      mobilePreviewConfig,
      workItemTitleParser,
      workItemDisplayConfig,
      protectedBranches,
      favoriteBranches,
      ...rest
    } = data;
    const row = await db
      .insertInto('projects')
      .values({
        ...rest,
        sortOrder: data.sortOrder ?? nextSortOrder,
        prPriority: data.prPriority ?? 'normal',
        workItemPriority: data.workItemPriority ?? 'normal',
        showWorkItemsInFeed: showWorkItemsInFeed === false ? 0 : 1,
        showPrsInFeed: showPrsInFeed === false ? 0 : 1,
        autoPullSourceBranch: autoPullSourceBranch === true ? 1 : 0,
        commitWithNoVerify: commitWithNoVerify === true ? 1 : 0,
        queuePrAutoComplete: queuePrAutoComplete === true ? 1 : 0,
        autoAcceptOnTaskCreation: autoAcceptOnTaskCreation === true ? 1 : 0,
        aiSkillSlots: aiSkillSlots ? JSON.stringify(aiSkillSlots) : null,
        mobilePreviewConfig: mobilePreviewConfig
          ? JSON.stringify(mobilePreviewConfig)
          : null,
        workItemTitleParser: serializeWorkItemTitleParser(
          workItemTitleParser ?? null,
        ),
        workItemDisplayConfig: serializeWorkItemDisplayConfig(
          workItemDisplayConfig ?? null,
        ),
        protectedBranches: sanitizeBranchList(protectedBranches),
        favoriteBranches: sanitizeBranchList(favoriteBranches),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    dbg.db('projects.create created id=%s', row.id);
    return parseProjectRow(row);
  },

  update: async (id: string, data: UpdateProject) => {
    dbg.db('projects.update id=%s %o', id, Object.keys(data));
    const {
      showWorkItemsInFeed,
      showPrsInFeed,
      autoPullSourceBranch,
      commitWithNoVerify,
      queuePrAutoComplete,
      autoAcceptOnTaskCreation,
      aiSkillSlots,
      mobilePreviewConfig,
      workItemTitleParser,
      workItemDisplayConfig,
      protectedBranches,
      favoriteBranches,
      ...rest
    } = data;
    const row = await db
      .updateTable('projects')
      .set({
        ...rest,
        ...(showWorkItemsInFeed !== undefined && {
          showWorkItemsInFeed: showWorkItemsInFeed ? 1 : 0,
        }),
        ...(showPrsInFeed !== undefined && {
          showPrsInFeed: showPrsInFeed ? 1 : 0,
        }),
        ...(autoPullSourceBranch !== undefined && {
          autoPullSourceBranch: autoPullSourceBranch ? 1 : 0,
        }),
        ...(commitWithNoVerify !== undefined && {
          commitWithNoVerify: commitWithNoVerify ? 1 : 0,
        }),
        ...(queuePrAutoComplete !== undefined && {
          queuePrAutoComplete: queuePrAutoComplete ? 1 : 0,
        }),
        ...(autoAcceptOnTaskCreation !== undefined && {
          autoAcceptOnTaskCreation: autoAcceptOnTaskCreation ? 1 : 0,
        }),
        ...(aiSkillSlots !== undefined && {
          aiSkillSlots: aiSkillSlots ? JSON.stringify(aiSkillSlots) : null,
        }),
        ...(mobilePreviewConfig !== undefined && {
          mobilePreviewConfig: mobilePreviewConfig
            ? JSON.stringify(mobilePreviewConfig)
            : null,
        }),
        ...serializeWorkItemTitleParserUpdate(workItemTitleParser),
        ...serializeWorkItemDisplayConfigUpdate(workItemDisplayConfig),
        ...(protectedBranches !== undefined && {
          protectedBranches: sanitizeBranchList(protectedBranches),
        }),
        ...(favoriteBranches !== undefined && {
          favoriteBranches: sanitizeBranchList(favoriteBranches),
        }),
        updatedAt: new Date().toISOString(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return parseProjectRow(row);
  },

  setModelPolicy: async (id: string, policy: ProjectModelPolicy) => {
    dbg.db('projects.setModelPolicy id=%s mode=%s', id, policy.mode);
    const row = await db
      .updateTable('projects')
      .set({
        modelPolicy: serializeProjectModelPolicy(policy),
        updatedAt: new Date().toISOString(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return parseProjectRow(row);
  },

  updateSummaryIfBlank: async (id: string, summary: string) => {
    dbg.db('projects.updateSummaryIfBlank id=%s', id);
    const row = await db
      .updateTable('projects')
      .set({
        summary,
        updatedAt: new Date().toISOString(),
      })
      .where('id', '=', id)
      .where((eb) => eb.or([eb('summary', 'is', null), eb('summary', '=', '')]))
      .returningAll()
      .executeTakeFirst();

    if (row) return parseProjectRow(row);
    return ProjectRepository.findById(id);
  },

  delete: async (id: string) => {
    dbg.db('projects.delete id=%s', id);
    // Explicit rather than relying on ON DELETE CASCADE: SQLite enforces
    // foreign keys per-connection and this app never sets `PRAGMA
    // foreign_keys = ON`, so the cascade would not fire and the project's
    // encrypted secrets would linger in the database indefinitely.
    await db
      .deleteFrom('project_env_vars')
      .where('projectId', '=', id)
      .execute();
    return db.deleteFrom('projects').where('id', '=', id).execute();
  },

  reorder: async (orderedIds: string[]) => {
    dbg.db('projects.reorder %d projects', orderedIds.length);
    const now = new Date().toISOString();
    const orderedIdSet = new Set(orderedIds);
    const existingProjects = await db
      .selectFrom('projects')
      .select(['id', 'sortOrder'])
      .where('type', '!=', 'system')
      .orderBy('sortOrder', 'asc')
      .execute();
    const mergedOrderedIds = [
      ...orderedIds,
      ...existingProjects
        .filter((project) => !orderedIdSet.has(project.id))
        .map((project) => project.id),
    ];

    // Update each project's sortOrder based on position in array
    for (let i = 0; i < mergedOrderedIds.length; i++) {
      await db
        .updateTable('projects')
        .set({ sortOrder: i, updatedAt: now })
        .where('id', '=', mergedOrderedIds[i])
        .execute();
    }

    // Return all projects in new order (excluding system projects)
    const rows = await db
      .selectFrom('projects')
      .selectAll()
      .where('type', '!=', 'system')
      .orderBy('sortOrder', 'asc')
      .execute();
    return rows.map(parseProjectRow);
  },
};
