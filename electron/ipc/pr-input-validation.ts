export function validateRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${name} payload`);
  }
  return value as Record<string, unknown>;
}

export function validateNonEmptyId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${name}: must be a non-empty string`);
  }
  return value;
}

export function validatePullRequestId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid pullRequestId: must be a positive safe integer');
  }
  return value;
}

export function validatePrWorkspacePairParams(params: unknown): {
  projectId: string;
  pullRequestId: number;
} {
  const value = validateRecord(params, 'PR workspace');
  return {
    projectId: validateNonEmptyId(value.projectId, 'projectId'),
    pullRequestId: validatePullRequestId(value.pullRequestId),
  };
}
