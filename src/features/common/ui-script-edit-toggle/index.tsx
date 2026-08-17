import type {
  PermissionAction,
  PermissionScope,
} from '@shared/permission-types';
import { SCRIPT_EDIT_TOOL } from '@shared/script-edit-detect';

import { Switch } from '@/common/ui/switch';

/**
 * The `script_edit` action explicitly configured in a scope, or `undefined`
 * when the scope has no rule for it.
 */
export function getScriptEditAction(
  scope: PermissionScope | undefined,
): PermissionAction | undefined {
  const config = scope?.[SCRIPT_EDIT_TOOL];
  if (typeof config === 'string') return config as PermissionAction;
  if (typeof config === 'object' && config !== null) {
    const action = config['*'];
    return typeof action === 'string'
      ? (action as PermissionAction)
      : undefined;
  }
  return undefined;
}

/** True when the given scope grants `script_edit` (scalar or `*` pattern). */
export function isScriptEditAllowed(
  scope: PermissionScope | undefined,
): boolean {
  return getScriptEditAction(scope) === 'allow';
}

export function ScriptEditToggle({
  checked,
  onChange,
  disabled,
  scopeLabel,
  inherited,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Optional scope hint, e.g. "Applies to worktrees only". */
  scopeLabel?: string;
  /** True when the current state comes from global settings, not this scope. */
  inherited?: boolean;
}) {
  return (
    <div className="border-glass-border/60 bg-bg-1/50 flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-ink-1 text-sm font-medium">
            Auto-allow script edits
          </p>
          {scopeLabel && (
            <p className="text-ink-4 mt-0.5 text-[11px]">{scopeLabel}</p>
          )}
        </div>
        {inherited && (
          <p className="text-ink-4 shrink-0 text-[11px]">
            Inherited from global settings
          </p>
        )}
        <Switch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          label="Auto-allow script edits"
        />
      </div>
      <p className="text-ink-3 text-xs">
        Allows python and node snippets (including heredocs) and{' '}
        <code className="font-mono">sed -i</code> commands that only read and
        rewrite files — but only when every file they touch is named literally,
        stays inside the working directory, and is already allowed by your
        read, edit and write rules. Anything else still asks for permission.
      </p>
    </div>
  );
}
