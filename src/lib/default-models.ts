import type {
  BackendDefaultModelsSetting,
  ModelPreference,
  Project,
} from '@shared/types';
import type { AgentBackendType } from '@shared/agent-backend-types';


export function getDefaultModelForBackend({
  backend,
  project,
  backendDefaultModels,
}: {
  backend: AgentBackendType | null;
  project?: Pick<
    Project,
    'defaultAgentBackend' | 'defaultAgentModelPreference'
  > | null;
  backendDefaultModels?: BackendDefaultModelsSetting | null;
}): ModelPreference {
  if (!backend) return 'default';

  if (
    project?.defaultAgentBackend === backend &&
    project.defaultAgentModelPreference
  ) {
    return project.defaultAgentModelPreference;
  }

  return backendDefaultModels?.models[backend] ?? 'default';
}
