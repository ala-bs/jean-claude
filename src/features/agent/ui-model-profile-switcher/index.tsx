import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';

import {
  listSelectableProfiles,
  type ModelProfile,
  type ModelTriple,
  tripleForBinding,
} from '@shared/model-profiles';

import {
  Dropdown,
  DropdownDivider,
  DropdownItem,
} from '@/common/ui/dropdown';
import {
  useActivateModelProfile,
  useActiveModelProfile,
  useEffectiveModelProfile,
} from '@/hooks/use-model-profiles';
import { api } from '@/lib/api';
import type { BindingKey } from '@/common/context/keyboard-bindings/types';
import { useOverlaysStore } from '@/stores/overlays';

/**
 * Direct-jump shortcuts, mirroring `model-profile-commands.ts`. `cmd+1..9` is
 * already owned by the feed list, so profile jumps use `cmd+alt+1..9`; these
 * hints must stay in sync with the bindings registered there.
 */
const JUMP_SHORTCUTS: BindingKey[] = [
  'cmd+alt+1',
  'cmd+alt+2',
  'cmd+alt+3',
  'cmd+alt+4',
  'cmd+alt+5',
  'cmd+alt+6',
  'cmd+alt+7',
  'cmd+alt+8',
  'cmd+alt+9',
];

const PROJECT_MODEL_POLICY_QUERY_KEY = ['projects', 'effective-model-policy'];

/** `sonnet · high` — what the profile's `agent` role resolves to. */
function describeTriple(triple: ModelTriple | undefined) {
  if (!triple) return null;
  return `${triple.model} · ${triple.thinkingEffort}`;
}

/**
 * The `agent` role's own triple. Since design revision 1 a role holds its
 * triple inline, so there is no preset list to look anything up in.
 */
function agentTripleFor(profile: ModelProfile): ModelTriple | undefined {
  // `agent` is a chat role, so an image binding here is nonsense — treat it as
  // unset rather than trying to summarise it.
  // Resolve through the profile's presets: a role may bind to a preset by
  // reference, in which case the binding is not itself a triple.
  return (
    tripleForBinding({
      binding: profile.roles.agent,
      presets: profile.presets,
    }) ?? undefined
  );
}

/**
 * Design §5 profile switcher: the primary model control for the header and the
 * composer. Profiles first, raw backend / model / thinking pickers demoted
 * behind "Override this step only…".
 */
export function ModelProfileSwitcher({
  projectId,
  stepModel,
  overrideContent,
  onProfileActivated,
  align,
  side,
  className,
}: {
  /** Project whose model policy constrains the list. */
  projectId?: string | null;
  /** The model triple persisted on the task step currently shown in the composer. */
  stepModel?: ModelTriple | null;
  /**
   * The existing backend / model / thinking pickers, rendered inside the
   * "Override this step only…" submenu. Hidden entirely under `enforce`.
   */
  overrideContent?: ReactNode;
  /**
   * Called after a profile is picked from the list. Hosts that keep their own
   * draft model state use this to drop a stale per-step override: picking a
   * profile is a later, more deliberate choice than the raw pickers nested
   * under "Override this step only…", and without it the trigger would show
   * the new profile while the host still submits the old override.
   */
  onProfileActivated?: (profileId: string) => void;
  align?: 'left' | 'right';
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const { profiles } = useActiveModelProfile();
  // The global active profile is not necessarily the profile this project can
  // use. The policy-aware profile must drive both the trigger and selection
  // marker, otherwise the header can display Anthropic while this project
  // resolves Codex.
  const { profile: effectiveProfile } = useEffectiveModelProfile(projectId);
  const stepProfile = useMemo(
    () =>
      stepModel
        ? profiles.find((profile) => {
            const triple = agentTripleFor(profile);
            return (
              triple?.backend === stepModel.backend &&
              triple.model === stepModel.model &&
              triple.thinkingEffort === stepModel.thinkingEffort
            );
          })
        : undefined,
    [profiles, stepModel],
  );
  const activeProfile = stepProfile ?? effectiveProfile;
  // Project-scoped: under a `prefer` policy the project default would
  // otherwise override the pick and the menu would appear inert.
  const activate = useActivateModelProfile(projectId);
  const openOverlay = useOverlaysStore((state) => state.open);
  const [isOverrideOpen, setIsOverrideOpen] = useState(false);

  const { data: effectivePolicy } = useQuery({
    queryKey: [...PROJECT_MODEL_POLICY_QUERY_KEY, projectId ?? null],
    queryFn: () => api.projects.getEffectivePolicy(projectId as string),
    enabled: Boolean(projectId),
  });

  const policy = effectivePolicy?.policy;
  const isEnforced = policy?.mode === 'enforce';

  // Design §2: under `enforce`, disallowed options are hidden, not disabled.
  // `prefer` is a project default, not a restriction, so it lists everything.
  // `listSelectableProfiles` falls back to the full list rather than rendering
  // an empty menu when the policy names profiles that no longer exist.
  const entries = useMemo(
    () =>
      listSelectableProfiles({ profiles, policy }).map((profile) => {
        const triple = agentTripleFor(profile);
        return {
          profile,
          summary: describeTriple(triple),
          // Indexed against the GLOBAL list: `cmd+alt+N` is registered there
          // (`model-profile-commands.ts`), so hiding entries must not renumber.
          shortcut: JUMP_SHORTCUTS[profiles.indexOf(profile)],
        };
      }),
    [policy, profiles],
  );

  const activeSummary = describeTriple(
    activeProfile ? agentTripleFor(activeProfile) : undefined,
  );

  return (
    <Dropdown
      align={align}
      side={side}
      trigger={
        <button
          type="button"
          aria-haspopup="menu"
          className={clsx(
            'border-glass-border text-ink-1 hover:bg-glass-medium flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors',
            className,
          )}
        >
          <span>{activeProfile?.name ?? 'No profile'}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
          {activeSummary && (
            <span className="text-ink-3 font-mono">{activeSummary}</span>
          )}
        </button>
      }
    >
      <div className="text-ink-3 px-3 py-1 text-[10px] tracking-wide uppercase">
        Profiles
      </div>
      {/* Under `enforce` the disallowed profiles are hidden rather than shown
          disabled, so without this the list silently looks short. */}
      {isEnforced && entries.length < profiles.length && (
        <div className="text-ink-3 px-3 pb-1 text-xs">
          Limited to what this project allows.
        </div>
      )}
      {entries.length === 0 && (
        <div className="text-ink-3 px-3 py-1.5 text-sm">
          No profiles yet — create one in Settings.
        </div>
      )}
      {entries.map((entry) => (
        <DropdownItem
          key={entry.profile.id}
          shortcut={entry.shortcut}
          onClick={() => {
            activate.mutate(entry.profile.id);
            onProfileActivated?.(entry.profile.id);
          }}
        >
          <span
            aria-current={
              entry.profile.id === activeProfile?.id ? 'true' : undefined
            }
            className="flex flex-1 items-center gap-2"
          >
            <span aria-hidden="true">
              {entry.profile.id === activeProfile?.id ? '●' : '○'}
            </span>
            <span className="flex-1">{entry.profile.name}</span>
            {entry.summary && (
              <span className="text-ink-3 font-mono text-xs">
                {entry.summary}
              </span>
            )}
          </span>
        </DropdownItem>
      ))}
      <DropdownDivider />
      {!isEnforced && overrideContent && (
        <>
          <DropdownItem
            onClick={() => setIsOverrideOpen((open) => !open)}
            icon={
              <ChevronRight
                className={clsx(
                  'transition-transform',
                  isOverrideOpen && 'rotate-90',
                )}
              />
            }
          >
            Override this step only…
          </DropdownItem>
          {isOverrideOpen && <div className="px-3 py-1.5">{overrideContent}</div>}
        </>
      )}
      <DropdownItem onClick={() => openOverlay('settings')}>
        Edit profiles…
      </DropdownItem>
    </Dropdown>
  );
}
