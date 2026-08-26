import type { AgentBackendType, PromptPart } from '@shared/agent-backend-types';
import {
  applyPromptPrefaceToParts,
  mergePromptPreface,
} from '@shared/prompt-preface-types';

import { SettingsRepository } from '../database/repositories/settings';

import { readProjectPromptPreface } from './permission-settings-service';

export async function applyConfiguredPromptPreface({
  parts,
  projectPath,
  isInitialPrompt,
  backend,
  model,
}: {
  parts: PromptPart[];
  projectPath: string;
  isInitialPrompt: boolean;
  backend: AgentBackendType;
  model: string;
}): Promise<PromptPart[]> {
  const global = await SettingsRepository.get('promptPreface');
  const project = await readProjectPromptPreface(projectPath);
  const effective = mergePromptPreface({ global, project });
  return applyPromptPrefaceToParts({
    parts,
    entries: effective,
    isInitialPrompt,
    backend,
    model,
  });
}
