import { useCallback } from 'react';

import {
  type FlatRule,
  PermissionsEditor,
} from '@/features/common/ui-permissions-editor';
import {
  useAddProjectPermissionRule,
  useEditProjectPermissionRule,
  useProjectPermissions,
  useRemoveProjectPermissionRule,
} from '@/hooks/use-project-permissions';
import { useEditGlobalPermissionRule } from '@/hooks/use-global-permissions';
import { useToastStore } from '@/stores/toasts';
import type { PermissionAction } from '@shared/permission-types';



export function ProjectPermissionsSettings({
  projectPath,
}: {
  projectPath: string;
}) {
  const { data: permissions, isLoading } = useProjectPermissions(projectPath);
  const addRule = useAddProjectPermissionRule(projectPath);
  const removeRule = useRemoveProjectPermissionRule(projectPath);
  const editRule = useEditProjectPermissionRule(projectPath);
  const migrateToGlobalRule = useEditGlobalPermissionRule();
  const addToast = useToastStore((state) => state.addToast);

  const handleAdd = useCallback(
    async (params: {
      toolName: string;
      input: Record<string, unknown>;
      action: PermissionAction;
    }) => {
      await addRule.mutateAsync(params);
    },
    [addRule],
  );

  const handleRemove = useCallback(
    (rule: FlatRule) => {
      removeRule.mutate(
        {
          tool: rule.tool,
          pattern: rule.pattern ?? undefined,
        },
        {
          onError: (err: Error) => {
            console.error('Failed to remove permission rule:', err.message);
          },
        },
      );
    },
    [removeRule],
  );

  const handleEdit = useCallback(
    (
      rule: FlatRule,
      update: { pattern: string | null; action: PermissionAction },
    ) => {
      editRule.mutate({
        tool: rule.tool,
        oldPattern: rule.pattern ?? undefined,
        newPattern: update.pattern ?? undefined,
        action: update.action,
      });
    },
    [editRule],
  );

  const handleMigrateToGlobal = useCallback(
    async (rule: FlatRule) => {
      const label = `${rule.tool}${rule.pattern ? `(${rule.pattern})` : ''}`;
      try {
        // Write the pattern straight through (no buildInput round-trip) so
        // arbitrary tools (skill, mcp__*, ...) keep their pattern instead of
        // collapsing to a scalar that would wipe other global rules.
        await migrateToGlobalRule.mutateAsync({
          tool: rule.tool,
          oldPattern: rule.pattern ?? undefined,
          newPattern: rule.pattern ?? undefined,
          action: rule.action,
        });
      } catch (err) {
        addToast({
          message: `Failed to migrate ${label} to global: ${
            err instanceof Error ? err.message : String(err)
          }`,
          type: 'error',
        });
        return;
      }

      try {
        await removeRule.mutateAsync({
          tool: rule.tool,
          pattern: rule.pattern ?? undefined,
        });
        addToast({
          message: `Moved ${label} to global permissions`,
          type: 'success',
        });
      } catch (err) {
        addToast({
          message: `${label} was added globally but could not be removed from this project: ${
            err instanceof Error ? err.message : String(err)
          }`,
          type: 'error',
        });
      }
    },
    [migrateToGlobalRule, removeRule, addToast],
  );

  return (
    <PermissionsEditor
      permissions={permissions}
      isLoading={isLoading}
      isBusy={
        addRule.isPending ||
        removeRule.isPending ||
        editRule.isPending ||
        migrateToGlobalRule.isPending
      }
      onAdd={handleAdd}
      onRemove={handleRemove}
      onEdit={handleEdit}
      onMigrateToGlobal={(rule) => void handleMigrateToGlobal(rule)}
      title="Permissions"
      description="Project-level permission rules. These take precedence over global rules."
      emptyTitle="No project permission rules configured."
      emptyDescription="Add a rule above to control tool access for this project."
    />
  );
}
