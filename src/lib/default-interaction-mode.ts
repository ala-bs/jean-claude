import {
  type InteractionMode,
  normalizeInteractionModeForBackend,
  type Project,
} from '@shared/types';

import type { AgentBackendType } from '@shared/agent-backend-types';

/**
 * Resolves the interaction mode a brand-new task starts in when the user has
 * not explicitly picked one, honouring the project's auto-accept setting.
 *
 * Mirrors `getDefaultModelForBackend` in `./default-models`.
 */
export function getDefaultInteractionMode({
  project,
}: {
  project?: Pick<Project, 'autoAcceptOnTaskCreation'> | null;
}): InteractionMode {
  return project?.autoAcceptOnTaskCreation ? 'auto' : 'ask';
}

/**
 * Re-normalizes a draft's interaction mode when it is written back as a *side
 * effect* of an unrelated change (switching backend, applying a model preset,
 * accepting a rate-limit swap).
 *
 * Returns `undefined` when the user has not chosen a mode yet, so the "unset"
 * sentinel survives. Writing the *resolved* default back into the draft would
 * silently pin it, and a later change to the project's auto-accept setting
 * would then be ignored for that draft forever.
 */
export function renormalizeDraftInteractionMode({
  draftMode,
  backend,
}: {
  draftMode: InteractionMode | null | undefined;
  backend: AgentBackendType | null;
}): InteractionMode | undefined {
  if (draftMode == null) return undefined;

  return normalizeInteractionModeForBackend({ backend, mode: draftMode });
}
