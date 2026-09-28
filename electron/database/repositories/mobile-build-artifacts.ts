import { db } from '../index';
import type { NewMobileBuildArtifactRow } from '../schema';

export const MobileBuildArtifactRepository = {
  list: async ({ platform, repositoryPath }: {
    platform: string;
    repositoryPath: string;
  }) =>
    db.selectFrom('mobile_build_artifacts').selectAll()
      .where('platform', '=', platform)
      .where('repositoryPath', '=', repositoryPath)
      .orderBy('createdAt', 'desc').execute(),
  findById: async (id: string) =>
    db.selectFrom('mobile_build_artifacts').selectAll().where('id', '=', id).executeTakeFirst(),
  insert: async (row: NewMobileBuildArtifactRow) =>
    db.insertInto('mobile_build_artifacts').values(row).returningAll().executeTakeFirstOrThrow(),
  markUsed: async (id: string, lastUsedAt: string) =>
    db.updateTable('mobile_build_artifacts').set({ lastUsedAt }).where('id', '=', id).execute(),
  rename: async (id: string, name: string) =>
    db.updateTable('mobile_build_artifacts').set({ name }).where('id', '=', id).execute(),
  delete: async (id: string) => db.deleteFrom('mobile_build_artifacts').where('id', '=', id).execute(),
};
