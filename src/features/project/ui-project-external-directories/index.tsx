import { FolderPlus, Trash2 } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import type {
  PermissionAction,
  PermissionScope,
} from '@shared/permission-types';

import {
  useAddProjectPermissionRule,
  useProjectPermissions,
  useRemoveProjectPermissionRule,
} from '@/hooks/use-project-permissions';
import { api } from '@/lib/api';
import { Button } from '@/common/ui/button';
import { useToastStore } from '@/stores/toasts';

const EXTERNAL_DIRECTORY_TOOL = 'external_directory';

/** Permission patterns for external directories are always `<dir>/**`. */
function toPattern(directory: string): string {
  return `${directory.replaceAll('\\', '/').replace(/\/+$/, '')}/**`;
}

function patternToDirectory(pattern: string): string | null {
  return pattern.endsWith('/**') ? pattern.slice(0, -3) : null;
}

/**
 * Directories the project scope grants access to, in insertion order. Only
 * `allow` entries are listed — `ask`/`deny` entries mean "not granted".
 */
export function getExternalDirectories(
  scope: PermissionScope | undefined,
): string[] {
  const config = scope?.[EXTERNAL_DIRECTORY_TOOL];
  if (typeof config !== 'object' || config === null) return [];
  return Object.entries(config)
    .filter(([, action]) => action === 'allow')
    .map(([pattern]) => patternToDirectory(pattern))
    .filter((directory): directory is string => directory !== null);
}

export function ProjectExternalDirectories({
  projectPath,
}: {
  projectPath: string;
}) {
  const { data: permissions, isLoading } = useProjectPermissions(projectPath);
  const addRule = useAddProjectPermissionRule(projectPath);
  const removeRule = useRemoveProjectPermissionRule(projectPath);
  const addToast = useToastStore((state) => state.addToast);

  const directories = useMemo(
    () => getExternalDirectories(permissions),
    [permissions],
  );

  const handleAdd = useCallback(async () => {
    const selected = await api.dialog.openDirectory();
    if (!selected) return;

    const pattern = toPattern(selected);
    if (directories.includes(patternToDirectory(pattern) ?? '')) {
      addToast({ message: 'That directory is already added.', type: 'success' });
      return;
    }

    try {
      await addRule.mutateAsync({
        toolName: EXTERNAL_DIRECTORY_TOOL,
        input: { permissionPatterns: [pattern] },
        action: 'allow' as PermissionAction,
      });
      addToast({ message: `Added access to ${selected}`, type: 'success' });
    } catch (err) {
      addToast({
        message: `Failed to add directory: ${
          err instanceof Error ? err.message : String(err)
        }`,
        type: 'error',
      });
    }
  }, [addRule, addToast, directories]);

  const handleRemove = useCallback(
    (directory: string) => {
      removeRule.mutate(
        { tool: EXTERNAL_DIRECTORY_TOOL, pattern: toPattern(directory) },
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

  const isBusy = addRule.isPending || removeRule.isPending || isLoading;

  return (
    <div className="border-glass-border/60 bg-bg-1/50 flex flex-col gap-3 rounded-xl border p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-ink-1 text-sm font-medium">External directories</p>
          <p className="text-ink-3 mt-0.5 text-xs">
            Directories outside this project that agents may read and write.
            Applies to this project and its worktrees.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={isBusy}
          onClick={() => void handleAdd()}
        >
          <FolderPlus className="size-3.5" />
          Add directory
        </Button>
      </div>

      {directories.length === 0 ? (
        <p className="text-ink-4 text-xs">
          No external directories. Agents are limited to the project directory.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {directories.map((directory) => (
            <li
              key={directory}
              className="border-glass-border/40 bg-bg-2/40 flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5"
            >
              <span
                className="text-ink-2 truncate font-mono text-xs"
                title={directory}
              >
                {directory}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={isBusy}
                aria-label={`Remove ${directory}`}
                onClick={() => handleRemove(directory)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
