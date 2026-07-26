import { ProjectRepository } from '../database/repositories';

export function deleteProjectRetainingMemory(projectId: string) {
  return ProjectRepository.delete(projectId);
}
