import { useCallback } from 'react';

import type { PermissionAction } from '@shared/permission-types';
import { SCRIPT_EDIT_TOOL } from '@shared/script-edit-detect';

import {
  EXTERNAL_DIRECTORY_TOOL,
  ExternalDirectories,
} from '@/features/common/ui-external-directories';
import {
  type FlatRule,
  PermissionsEditor,
} from '@/features/common/ui-permissions-editor';
import {
  isScriptEditAllowed,
  ScriptEditToggle,
} from '@/features/common/ui-script-edit-toggle';
import {
  useAddGlobalPermissionRule,
  useEditGlobalPermissionRule,
  useGlobalPermissions,
  useRemoveGlobalPermissionRule,
} from '@/hooks/use-global-permissions';
import { useToastStore } from '@/stores/toasts';

export function GlobalPermissionsSettings() {
  const { data: permissions, isLoading } = useGlobalPermissions();
  const addRule = useAddGlobalPermissionRule();
  const removeRule = useRemoveGlobalPermissionRule();
  const editRule = useEditGlobalPermissionRule();
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
      removeRule.mutate({
        tool: rule.tool,
        pattern: rule.pattern ?? undefined,
      });
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

  const handleScriptEditToggle = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        addRule.mutate({
          toolName: SCRIPT_EDIT_TOOL,
          input: {},
          action: 'allow',
        });
      } else {
        removeRule.mutate({ tool: SCRIPT_EDIT_TOOL });
      }
    },
    [addRule, removeRule],
  );

  const handleAddExternalDirectory = useCallback(
    async (pattern: string) => {
      await addRule.mutateAsync({
        toolName: EXTERNAL_DIRECTORY_TOOL,
        input: { permissionPatterns: [pattern] },
        action: 'allow',
      });
    },
    [addRule],
  );

  const handleRemoveExternalDirectory = useCallback(
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

  const isBusy =
    addRule.isPending || removeRule.isPending || editRule.isPending;

  return (
    <div className="flex flex-col gap-4">
      <ScriptEditToggle
        checked={isScriptEditAllowed(permissions)}
        onChange={handleScriptEditToggle}
        disabled={isBusy || isLoading}
        scopeLabel="Applies to all projects"
      />
      <ExternalDirectories
        permissions={permissions}
        isLoading={isLoading}
        isBusy={isBusy}
        description="Directories outside your projects that agents may read and write. Applies to all projects and their worktrees."
        emptyDescription="No external directories. Agents are limited to each project's own directory."
        onAdd={handleAddExternalDirectory}
        onRemove={handleRemoveExternalDirectory}
      />
      <PermissionsEditor
        permissions={permissions}
        isLoading={isLoading}
        isBusy={isBusy}
        onAdd={handleAdd}
        onRemove={handleRemove}
        onEdit={handleEdit}
        title="Permissions"
        description="Global permission rules applied to all projects. Project-level rules take precedence over global rules."
        emptyTitle="No global permission rules configured."
        emptyDescription="Add a rule above to control tool access across all projects."
      />
    </div>
  );
}
