import { useMemo } from 'react';

import {
  useActivateModelProfile,
  useActiveModelProfile,
} from '@/hooks/use-model-profiles';
import { useCommands } from '@/common/hooks/use-commands';

const COMMAND_SECTION = 'Model profiles';

/**
 * Direct-jump shortcuts for the first nine profiles.
 *
 * `cmd+1..9` is already taken by `feed-list-navigation` ("Go to Feed Item N")
 * and the feed list stays mounted behind an open task panel, so binding it here
 * would silently shadow it (dispatch is LIFO with no layer precedence).
 * `cmd+shift+1..3` is taken by `pr-detail-tab-navigation`, and `cmd+shift+3/4`
 * are macOS screenshot shortcuts. `cmd+alt+1..9` is unbound everywhere.
 */
const JUMP_BINDINGS = [
  { shortcut: 'cmd+alt+1', label: 'Use Model Profile N' },
  { shortcut: 'cmd+alt+2', label: 'Use Model Profile N' },
  { shortcut: 'cmd+alt+3', label: 'Use Model Profile N' },
  { shortcut: 'cmd+alt+4', label: 'Use Model Profile N' },
  { shortcut: 'cmd+alt+5', label: 'Use Model Profile N' },
  { shortcut: 'cmd+alt+6', label: 'Use Model Profile N' },
  { shortcut: 'cmd+alt+7', label: 'Use Model Profile N' },
  { shortcut: 'cmd+alt+8', label: 'Use Model Profile N' },
  { shortcut: 'cmd+alt+9', label: 'Use Model Profile N' },
] as const;

/**
 * Registers the model-profile switching commands:
 * - `cmd+.` cycles to the next profile
 * - `cmd+alt+1..9` jumps straight to profile N
 *
 * Both appear in the command palette under "Model profiles".
 */
export function useModelProfileCommands() {
  // `useActiveModelProfile` already returns the stable profile array alongside
  // the active profile, so a second `useModelProfilesSetting()` call would be
  // redundant. `profiles` is a stable reference (EMPTY_PROFILES when unset).
  const { profile: activeProfile, profiles } = useActiveModelProfile();
  const activate = useActivateModelProfile();

  const commands = useMemo(() => {
    const activeIndex = profiles.findIndex((p) => p.id === activeProfile?.id);

    const cycle = {
      label: 'Cycle Model Profile',
      section: COMMAND_SECTION,
      shortcut: 'cmd+.' as const,
      keywords: ['model', 'profile', 'backend', 'switch', 'cycle'],
      handler: () => {
        if (profiles.length === 0) return;
        const next = profiles[(activeIndex + 1) % profiles.length];
        if (next) activate.mutate(next.id);
      },
    };

    const jumps = profiles
      .slice(0, JUMP_BINDINGS.length)
      .map((profile, index) => ({
        label: `Use profile: ${profile.name}`,
        section: COMMAND_SECTION,
        shortcut: JUMP_BINDINGS[index].shortcut,
        keywords: ['model', 'profile', 'backend', 'switch'],
        handler: () => activate.mutate(profile.id),
      }));

    return [cycle, ...jumps];
  }, [activate, activeProfile?.id, profiles]);

  useCommands('model-profiles', commands);
}
