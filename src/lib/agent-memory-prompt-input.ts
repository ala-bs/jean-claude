export function getOriginalTaskAgentMemoryPrompt({
  inputMode,
  prompt,
  workItemTemplate,
}: {
  inputMode: 'prompt' | 'work-item';
  prompt: string;
  workItemTemplate: string;
}): string | undefined {
  const originalText = inputMode === 'work-item' ? workItemTemplate : prompt;
  return originalText.trim() ? originalText : undefined;
}

export function buildTaskCreationRetryInput<T extends { updatedAt: string }>(
  creationInput: T,
  updatedAt = new Date().toISOString(),
): T {
  return { ...creationInput, updatedAt };
}
