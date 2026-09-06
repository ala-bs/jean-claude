import { sql } from 'kysely';

import {
  flattenCommandGroupStages,
  MAX_COMMAND_GROUP_STAGE_DELAY_MS,
} from '@shared/run-command-types';
import type {
  NewProjectCommandGroup,
  ProjectCommandGroup,
  ProjectCommandGroupStage,
  UpdateProjectCommandGroup,
} from '@shared/run-command-types';

import { db } from '../index';

function parseStages(raw: string): ProjectCommandGroupStage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((stage): ProjectCommandGroupStage[] => {
    if (typeof stage !== 'object' || stage === null) return [];
    const { id, entries, delayMs } = stage as Partial<ProjectCommandGroupStage>;
    if (typeof id !== 'string' || !Array.isArray(entries)) return [];

    return [
      {
        id,
        delayMs:
          typeof delayMs === 'number' && delayMs > 0
            ? Math.min(delayMs, MAX_COMMAND_GROUP_STAGE_DELAY_MS)
            : 0,
        entries: entries.flatMap((entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.commandId === 'string'
            ? [{ commandId: entry.commandId, waitForExit: !!entry.waitForExit }]
            : [],
        ),
      },
    ];
  });
}

/**
 * Normalizes a stage plan before it is stored. The renderer is not trusted:
 * out-of-range delays, duplicate stage ids (which would make the editor update
 * two stages at once), and repeated commands within a single stage (which the
 * executor drops silently) are all corrected here.
 */
function normalizeStages(
  stages: ProjectCommandGroupStage[],
): ProjectCommandGroupStage[] {
  const seenStageIds = new Set<string>();

  return stages.map((stage) => {
    const id = seenStageIds.has(stage.id) ? crypto.randomUUID() : stage.id;
    seenStageIds.add(id);

    const seenCommandIds = new Set<string>();
    return {
      id,
      delayMs:
        Number.isFinite(stage.delayMs) && stage.delayMs > 0
          ? Math.min(stage.delayMs, MAX_COMMAND_GROUP_STAGE_DELAY_MS)
          : 0,
      entries: stage.entries.filter((entry) => {
        if (seenCommandIds.has(entry.commandId)) return false;
        seenCommandIds.add(entry.commandId);
        return true;
      }),
    };
  });
}

function parseCommandIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseRow(row: {
  id: string;
  projectId: string;
  name: string;
  stages: string;
  commandIds: string;
  sortOrder: number;
  createdAt: string;
}): ProjectCommandGroup {
  let stages = parseStages(row.stages);

  // Self-heal rather than presenting the group as empty. `stages` can be empty
  // while `commandIds` is populated if the row was written by a build predating
  // migration 087 (this repo runs many worktrees, so downgrades happen), or if
  // the stored JSON was corrupted. Rebuilding one all-at-once stage matches the
  // migration's backfill and the pre-stages behavior.
  if (stages.length === 0) {
    const legacyCommandIds = parseCommandIds(row.commandIds);
    if (legacyCommandIds.length > 0) {
      stages = [
        {
          id: crypto.randomUUID(),
          delayMs: 0,
          entries: legacyCommandIds.map((commandId) => ({
            commandId,
            waitForExit: false,
          })),
        },
      ];
    }
  }

  return {
    ...row,
    stages,
    // `commandIds` is denormalized; recompute so a stale column can never
    // disagree with the stages that actually run.
    commandIds: flattenCommandGroupStages(stages),
  };
}

export const ProjectCommandGroupRepository = {
  findById: async (id: string): Promise<ProjectCommandGroup | undefined> => {
    const row = await db
      .selectFrom('project_command_groups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? parseRow(row) : undefined;
  },

  findByProjectId: async (
    projectId: string,
  ): Promise<ProjectCommandGroup[]> => {
    const rows = await db
      .selectFrom('project_command_groups')
      .selectAll()
      .where('projectId', '=', projectId)
      .orderBy('sortOrder', 'asc')
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(parseRow);
  },

  create: async (
    data: NewProjectCommandGroup,
  ): Promise<ProjectCommandGroup> => {
    const id = crypto.randomUUID();

    const row = await db
      .insertInto('project_command_groups')
      .values({
        id,
        projectId: data.projectId,
        name: data.name,
        stages: JSON.stringify(normalizeStages(data.stages)),
        commandIds: JSON.stringify(flattenCommandGroupStages(data.stages)),
        sortOrder: sql<number>`(
          SELECT MAX(
            COALESCE((SELECT MAX(sortOrder) FROM project_commands WHERE projectId = ${data.projectId}), -1),
            COALESCE((SELECT MAX(sortOrder) FROM project_command_groups WHERE projectId = ${data.projectId}), -1)
          ) + 1
        )`,
        createdAt: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return parseRow(row);
  },

  update: async (
    id: string,
    data: UpdateProjectCommandGroup,
  ): Promise<ProjectCommandGroup> => {
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.stages !== undefined) {
      const stages = normalizeStages(data.stages);
      updateData.stages = JSON.stringify(stages);
      updateData.commandIds = JSON.stringify(flattenCommandGroupStages(stages));
    }

    const row = await db
      .updateTable('project_command_groups')
      .set(updateData)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return parseRow(row);
  },

  delete: async (id: string): Promise<void> => {
    await db
      .deleteFrom('project_command_groups')
      .where('id', '=', id)
      .execute();
  },

  reorder: async (projectId: string, groupIds: string[]): Promise<void> => {
    await db.transaction().execute(async (trx) => {
      for (let i = 0; i < groupIds.length; i++) {
        await trx
          .updateTable('project_command_groups')
          .set({ sortOrder: i })
          .where('id', '=', groupIds[i])
          .where('projectId', '=', projectId)
          .execute();
      }
    });
  },

  removeCommandFromAllGroups: async ({
    projectId,
    commandId,
  }: {
    projectId: string;
    commandId: string;
  }): Promise<void> => {
    const rows = await db
      .selectFrom('project_command_groups')
      .select(['id', 'stages'])
      .where('projectId', '=', projectId)
      .execute();

    await db.transaction().execute(async (trx) => {
      for (const row of rows) {
        const stages = parseStages(row.stages);
        if (
          !stages.some((stage) =>
            stage.entries.some((entry) => entry.commandId === commandId),
          )
        ) {
          continue;
        }

        // Drop the command from every stage, then drop stages it emptied out.
        const nextStages = stages
          .map((stage) => ({
            ...stage,
            entries: stage.entries.filter(
              (entry) => entry.commandId !== commandId,
            ),
          }))
          .filter((stage) => stage.entries.length > 0);

        await trx
          .updateTable('project_command_groups')
          .set({
            stages: JSON.stringify(nextStages),
            commandIds: JSON.stringify(flattenCommandGroupStages(nextStages)),
          })
          .where('id', '=', row.id)
          .execute();
      }
    });
  },
};
