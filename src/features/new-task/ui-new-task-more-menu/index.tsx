import { Loader2, MoreHorizontal, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { skillsQueryKeys } from '@/hooks/use-skills';

/**
 * Occasional actions for the New Task overlay, tucked behind a "more" menu.
 * Currently only exposes reloading the project's skills (the skills list is
 * cached by React Query for 5 minutes, so newly added skills need a manual
 * refresh to show up in the prompt composer).
 */
export function NewTaskMoreMenu({ projectId }: { projectId: string | null }) {
  const queryClient = useQueryClient();
  const [isReloading, setIsReloading] = useState(false);

  const handleReloadSkills = useCallback(() => {
    if (!projectId) return;
    setIsReloading(true);
    void queryClient
      .refetchQueries({ queryKey: skillsQueryKeys.byProject(projectId) })
      .finally(() => setIsReloading(false));
  }, [projectId, queryClient]);

  return (
    <Dropdown
      side="top"
      align="left"
      trigger={
        <button
          type="button"
          aria-label="More actions"
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[5px] px-2 py-[5px] text-xs font-medium"
          style={{
            background: 'var(--color-glass-subtle)',
            border: '1px solid var(--color-glass-border)',
            color: 'var(--color-ink-2)',
          }}
        >
          {isReloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MoreHorizontal className="h-3.5 w-3.5" />
          )}
        </button>
      }
    >
      <DropdownItem
        icon={<RefreshCw />}
        disabled={!projectId || isReloading}
        onClick={handleReloadSkills}
      >
        {isReloading ? 'Reloading skills…' : 'Reload project skills'}
      </DropdownItem>
    </Dropdown>
  );
}
