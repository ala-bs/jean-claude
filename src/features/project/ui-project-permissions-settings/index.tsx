import { useCallback } from 'react';

import type { PermissionAction } from '@shared/permission-types';
import { SCRIPT_EDIT_TOOL } from '@shared/script-edit-detect';

import {
  type FlatRule,
  PermissionsEditor,
} from '@/features/common/ui-permissions-editor';
import {
  getScriptEditAction,
  ScriptEditToggle,
} from '@/features/common/ui-script-edit-toggle';
import {
  useAddProjectPermissionRule,
  useEditProjectPermissionRule,
  useProjectPermissions,
  useRemoveProjectPermissionRule,
} from '@/hooks/use-project-permissions';
import {
  useEditGlobalPermissionRule,
  useGlobalPermissions,
} from '@/hooks/use-global-permissions';
import { ProjectExternalDirectories } from '@/features/project/ui-project-external-directories';
import { useToastStore } from '@/stores/toasts';

export function ProjectPermissionsSettings({
  projectPath,
}: {
  projectPath: string;
}) {
  const { data: permissions, isLoading } = useProjectPermissions(projectPath);
  const { data: globalPermissions, isLoading: isGlobalLoading } =
    useGlobalPermissions();
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

  // Rules resolve as [...globalRules, ...projectRules] (last match wins), so
  // the toggle reflects the effective state: project rule if present, else the
  // global rule, else off.
  const projectScriptEditAction = getScriptEditAction(permissions);
  const globalScriptEditAction = getScriptEditAction(globalPermissions);
  const effectiveScriptEditAction =
    projectScriptEditAction ?? globalScriptEditAction;
  const isScriptEditInherited =
    projectScriptEditAction === undefined &&
    globalScriptEditAction !== undefined;

  const handleScriptEditToggle = useCallback(
    (enabled: boolean) => {
      const inheritsAllow = globalScriptEditAction === 'allow';

      if (enabled) {
        // With a global grant already in force, dropping the project rule
        // returns the project to inheriting it — otherwise the toggle would
        // be a one-way trip out of the inherited state.
        if (inheritsAllow) removeRule.mutate({ tool: SCRIPT_EDIT_TOOL });
        else
          addRule.mutate({
            toolName: SCRIPT_EDIT_TOOL,
            input: {},
            action: 'allow',
          });
        return;
      }

      if (inheritsAllow) {
        // Cancel the inherited grant with `ask`, not `deny`: off must mean
        // "prompt me like before the feature existed", never "silently refuse".
        addRule.mutate({
          toolName: SCRIPT_EDIT_TOOL,
          input: {},
          action: 'ask',
        });
        return;
      }

      removeRule.mutate({ tool: SCRIPT_EDIT_TOOL });
    },
    [addRule, removeRule, globalScriptEditAction],
  );

  const isBusy =
    addRule.isPending ||
    removeRule.isPending ||
    editRule.isPending ||
    migrateToGlobalRule.isPending;

  return (
    <div className="flex flex-col gap-4">
      <ScriptEditToggle
        checked={effectiveScriptEditAction === 'allow'}
        onChange={handleScriptEditToggle}
        inherited={isScriptEditInherited}
        disabled={isBusy || isLoading || isGlobalLoading}
        scopeLabel="Applies to this project and its worktrees (worktrees extend project rules)"
      />
      <ProjectExternalDirectories projectPath={projectPath} />
      <PermissionsEditor
        permissions={permissions}
        isLoading={isLoading}
        isBusy={isBusy}
        onAdd={handleAdd}
        onRemove={handleRemove}
        onEdit={handleEdit}
        onMigrateToGlobal={(rule) => void handleMigrateToGlobal(rule)}
        title="Permissions"
        description="Project-level permission rules. These take precedence over global rules."
        emptyTitle="No project permission rules configured."
        emptyDescription="Add a rule above to control tool access for this project."
      />
    </div>
  );
}
