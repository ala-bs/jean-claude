import { FolderPlus, Trash2 } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import type { PermissionScope } from '@shared/permission-types';

import { api } from '@/lib/api';
import { Button } from '@/common/ui/button';
import { useToastStore } from '@/stores/toasts';

export const EXTERNAL_DIRECTORY_TOOL = 'external_directory';

/** Permission patterns for external directories are always `<dir>/**`. */
export function toExternalDirectoryPattern(directory: string): string {
  return `${directory.replaceAll('\\', '/').replace(/\/+$/, '')}/**`;
}

export function patternToExternalDirectory(pattern: string): string | null {
  return pattern.endsWith('/**') ? pattern.slice(0, -3) : null;
}

/**
 * Every `external_directory` entry in a scope, in insertion order — including
 * `ask`/`deny` entries and patterns that aren't `<dir>/**`. Those still affect
 * resolution, so the UI must render them or they'd be invisible and
 * unremovable now that the permissions editor hides this pseudo-tool.
 */
export function getExternalDirectoryEntries(
  scope: PermissionScope | undefined,
): { pattern: string; label: string; action: string }[] {
  const config = scope?.[EXTERNAL_DIRECTORY_TOOL];
  if (typeof config !== 'object' || config === null) return [];
  return Object.entries(config).map(([pattern, action]) => ({
    pattern,
    label: patternToExternalDirectory(pattern) ?? pattern,
    action: String(action),
  }));
}

/** Directories a scope grants access to (i.e. `allow` entries only). */
export function getExternalDirectories(
  scope: PermissionScope | undefined,
): string[] {
  return getExternalDirectoryEntries(scope)
    .filter((entry) => entry.action === 'allow')
    .map((entry) => patternToExternalDirectory(entry.pattern))
    .filter((directory): directory is string => directory !== null);
}

/**
 * Scope-agnostic list editor for external directories. The caller supplies the
 * permission scope plus add/remove mutations so this can be reused for project
 * and global permission settings.
 */
export function ExternalDirectories({
  permissions,
  isLoading,
  isBusy,
  description,
  emptyDescription,
  onAdd,
  onRemove,
}: {
  permissions: PermissionScope | undefined;
  isLoading: boolean;
  isBusy: boolean;
  description: string;
  emptyDescription: string;
  onAdd: (pattern: string) => Promise<void>;
  onRemove: (pattern: string) => void;
}) {
  const addToast = useToastStore((state) => state.addToast);

  const entries = useMemo(
    () => getExternalDirectoryEntries(permissions),
    [permissions],
  );

  const handleAdd = useCallback(async () => {
    const selected = await api.dialog.openDirectory();
    if (!selected) return;

    // Mirrors the main process's `hasGlobMetacharacters` guard. Without this
    // we'd write a rule that `getAllowedDirectories` silently drops, so the UI
    // would show the directory as granted while agents never get access.
    if (/[*?[\]{}()!]/.test(selected)) {
      addToast({
        message: `Can't add ${selected}: directory name contains unsupported glob characters.`,
        type: 'error',
      });
      return;
    }

    const pattern = toExternalDirectoryPattern(selected);
    // A non-`allow` entry for the same pattern is re-addable — adding
    // overwrites it back to `allow`.
    if (
      entries.some(
        (entry) => entry.pattern === pattern && entry.action === 'allow',
      )
    ) {
      addToast({ message: 'That directory is already added.', type: 'success' });
      return;
    }

    try {
      await onAdd(pattern);
      addToast({ message: `Added access to ${selected}`, type: 'success' });
    } catch (err) {
      addToast({
        message: `Failed to add directory: ${
          err instanceof Error ? err.message : String(err)
        }`,
        type: 'error',
      });
    }
  }, [addToast, entries, onAdd]);

  const busy = isBusy || isLoading;

  return (
    <div className="border-glass-border/60 bg-bg-1/50 flex flex-col gap-3 rounded-xl border p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-ink-1 text-sm font-medium">External directories</p>
          <p className="text-ink-3 mt-0.5 text-xs">{description}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void handleAdd()}
        >
          <FolderPlus className="size-3.5" />
          Add directory
        </Button>
      </div>

      {entries.length === 0 ? (
        <p className="text-ink-4 text-xs">{emptyDescription}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => (
            <li
              key={entry.pattern}
              className="border-glass-border/40 bg-bg-2/40 flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5"
            >
              <span
                className="text-ink-2 truncate font-mono text-xs"
                title={entry.pattern}
              >
                {entry.label}
              </span>
              {entry.action !== 'allow' && (
                <span className="text-ink-4 shrink-0 text-[10px] tracking-wide uppercase">
                  {entry.action}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Remove ${entry.label}`}
                onClick={() => onRemove(entry.pattern)}
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
