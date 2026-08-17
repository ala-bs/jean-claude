export type PermissionModalState = {
  stepId: string;
  command: string;
};

export function createPermissionModalState(
  stepId: string | null,
  command: string,
): PermissionModalState | null {
  return stepId ? { stepId, command } : null;
}
