import { useCallback } from 'react';

import type { PermissionAction } from '@shared/permission-types';

import {
  EXTERNAL_DIRECTORY_TOOL,
  ExternalDirectories,
} from '@/features/common/ui-external-directories';
import {
  useAddProjectPermissionRule,
  useProjectPermissions,
  useRemoveProjectPermissionRule,
} from '@/hooks/use-project-permissions';
import { useToastStore } from '@/stores/toasts';

export function ProjectExternalDirectories({
  projectPath,
}: {
  projectPath: string;
}) {
  const { data: permissions, isLoading } = useProjectPermissions(projectPath);
  const addRule = useAddProjectPermissionRule(projectPath);
  const removeRule = useRemoveProjectPermissionRule(projectPath);
  const addToast = useToastStore((state) => state.addToast);

  const handleAdd = useCallback(
    async (pattern: string) => {
      await addRule.mutateAsync({
        toolName: EXTERNAL_DIRECTORY_TOOL,
        input: { permissionPatterns: [pattern] },
        action: 'allow' as PermissionAction,
      });
    },
    [addRule],
  );

  const handleRemove = useCallback(
    (pattern: string) => {
      removeRule.mutate(
        { tool: EXTERNAL_DIRECTORY_TOOL, pattern },
        {
          onError: (err: Error) => {
            addToast({
              message: `Failed to remove directory: ${err.message}`,
              type: 'error',
            });
          },
        },
      );
    },
    [removeRule, addToast],
  );

  return (
    <ExternalDirectories
      permissions={permissions}
      isLoading={isLoading}
      isBusy={addRule.isPending || removeRule.isPending}
      description="Directories outside this project that agents may read and write. Applies to this project and its worktrees."
      emptyDescription="No external directories. Agents are limited to the project directory."
      onAdd={handleAdd}
      onRemove={handleRemove}
    />
  );
}
