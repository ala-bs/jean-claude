import { useCallback } from 'react';

import type { PermissionAction } from '@shared/permission-types';
import { SCRIPT_EDIT_TOOL } from '@shared/script-edit-detect';

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



export function GlobalPermissionsSettings() {
  const { data: permissions, isLoading } = useGlobalPermissions();
  const addRule = useAddGlobalPermissionRule();
  const removeRule = useRemoveGlobalPermissionRule();
  const editRule = useEditGlobalPermissionRule();

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
