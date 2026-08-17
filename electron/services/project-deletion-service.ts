import { dbg } from '../lib/debug';
import { ProjectRepository } from '../database/repositories';

import {
  removeProjectPreferenceMemory,
  withProjectPreferenceMemoryLock,
} from './preference-memory-storage';

export async function deleteProjectWithPreferenceMemoryCleanup(
  projectId: string,
) {
  return withProjectPreferenceMemoryLock(projectId, async () => {
    const result = await ProjectRepository.delete(projectId);
    try {
      await removeProjectPreferenceMemory({ projectId });
    } catch (error) {
      dbg.ipc(
        'Failed to clean preference memory for project %s: %O',
        projectId,
        error,
      );
    }
    return result;
  });
}
