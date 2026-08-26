import type { Project } from '@shared/types';

import {
  markResourceChanged,
  markResourceDeleted,
  setIndexResource,
  setResourceSuccess,
} from '../cache-actions';
import { cache$ } from '../cache-store';

export const PROJECTS_INDEX_KEY = 'projects';

export function projectResourceKey(projectId: string) {
  return `project:${projectId}`;
}

export function ingestProject(project: Project) {
  cache$.projects[project.id].set(project);
  setResourceSuccess(projectResourceKey(project.id));
}

export function ingestUpdatedProject(project: Project) {
  markResourceChanged(projectResourceKey(project.id));
  markResourceChanged(PROJECTS_INDEX_KEY);
  ingestProject(project);
}

export function ingestUpdatedProjects(projects: Project[]) {
  markResourceChanged(PROJECTS_INDEX_KEY);
  for (const project of projects) {
    markResourceChanged(projectResourceKey(project.id));
  }

  ingestProjects(projects);
}

export function ingestProjects(projects: Project[]) {
  for (const project of projects) {
    ingestProject(project);
  }

  setIndexResource(
    PROJECTS_INDEX_KEY,
    projects.map((project) => project.id),
  );
}

export function appendProjectToIndex(projectId: string) {
  const ids = cache$.indexes[PROJECTS_INDEX_KEY].ids.get();
  if (!ids || ids.includes(projectId)) {
    return;
  }

  cache$.indexes[PROJECTS_INDEX_KEY].ids.set([...ids, projectId]);
}

export function removeProject(projectId: string) {
  cache$.projects[projectId].delete();
  // See removeTask: guards in-flight loads against resurrecting the project.
  markResourceDeleted(projectResourceKey(projectId));

  const ids = cache$.indexes[PROJECTS_INDEX_KEY].ids.get();
  if (ids) {
    cache$.indexes[PROJECTS_INDEX_KEY].ids.set(
      ids.filter((id) => id !== projectId),
    );
  }
}

export function getProjectIndexIds() {
  return cache$.indexes[PROJECTS_INDEX_KEY].ids.get();
}

export function setProjectIndexIds(ids: string[]) {
  setIndexResource(PROJECTS_INDEX_KEY, ids);
}

export function selectProject(projectId: string) {
  return cache$.projects[projectId].get();
}

export function selectProjectName(projectId: string) {
  return cache$.projects[projectId].name.get();
}

export function selectProjectColor(projectId: string) {
  return cache$.projects[projectId].color.get();
}

export function selectProjectLogoPath(projectId: string) {
  return cache$.projects[projectId].logoPath.get();
}

export function selectProjectRepoProviderId(projectId: string) {
  return cache$.projects[projectId].repoProviderId.get();
}

export function selectProjectRepoProjectId(projectId: string) {
  return cache$.projects[projectId].repoProjectId.get();
}

export function selectProjectRepoId(projectId: string) {
  return cache$.projects[projectId].repoId.get();
}

export function selectProjectPrPriority(projectId: string) {
  return cache$.projects[projectId].prPriority.get();
}

export function selectProjectWorkItemPriority(projectId: string) {
  return cache$.projects[projectId].workItemPriority.get();
}

/**
 * Returns `undefined` — never `[]` — while the index has not loaded yet.
 *
 * This distinction is load-bearing: `useCacheResource` derives both `isLoading`
 * (`data !== undefined`) and its mid-flight rescue (`hasCachedData`) from it, and
 * `resolveSetupState` treats `projects === undefined` as "unknown yet" while an
 * empty array means "this user has no projects — run onboarding". Returning `[]`
 * eagerly made every boot look like a first run for as long as the projects IPC
 * was in flight, which bounced existing users into the setup wizard whenever the
 * backends setting happened to resolve first.
 */
export function selectProjects() {
  const ids = cache$.indexes[PROJECTS_INDEX_KEY].ids.get();
  if (!ids) return undefined;
  return ids.flatMap((id) => {
    const project = cache$.projects[id].get();
    return project ? [project] : [];
  });
}
