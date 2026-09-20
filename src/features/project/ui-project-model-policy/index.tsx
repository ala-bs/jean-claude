import type {
  ModelProfile,
  ProjectModelPolicy,
  ProjectModelPolicyMode,
  ProjectModelPolicySource,
} from '@shared/model-profiles';

import { Select, type SelectOption } from '@/common/ui/select';
import { useMemo, useState } from 'react';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { Checkbox } from '@/common/ui/checkbox';
import { FileLock2 } from 'lucide-react';
import { MODEL_POLICY_FILE_RELATIVE_PATH } from '@shared/model-policy-file';

const MODE_OPTIONS: {
  value: ProjectModelPolicyMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'inherit',
    label: 'Use whatever profile is active',
    description: 'No project-specific rule',
  },
  {
    value: 'prefer',
    label: 'Start this project on a profile',
    description: 'A starting point you can still change',
  },
  {
    value: 'enforce',
    label: 'Restrict this project',
    description: 'Refuse anything outside the rule',
  },
];

const modeSelectOptions: SelectOption<ProjectModelPolicyMode>[] =
  MODE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }));

/** Profile constraint under `enforce`, as an explicit three-way choice. */
type ProfileConstraint = 'any' | 'only' | 'pinned';

/** Backend constraint under `enforce`, as an explicit two-way choice. */
type BackendConstraint = 'all' | 'only';

// "Pick one of N" is a `Select` throughout this app; there is no radio atom in
// `src/common/ui`, and hand-rolled native radios read as foreign here.
const PROFILE_CONSTRAINT_OPTIONS: SelectOption<ProfileConstraint>[] = [
  {
    value: 'any',
    label: 'Any profile',
    description: 'Every profile may run here',
  },
  {
    value: 'only',
    label: 'Only these profiles',
    description: 'Pick the profiles this project accepts',
  },
  {
    value: 'pinned',
    label: 'Always run one profile',
    description: 'This project ignores the active profile',
  },
];

const BACKEND_CONSTRAINT_OPTIONS: SelectOption<BackendConstraint>[] = [
  {
    value: 'all',
    label: 'All enabled backends',
    description: 'No backend restriction',
  },
  {
    value: 'only',
    label: 'Only these backends',
    description: 'Pick the backends this project accepts',
  },
];

function profileName(profiles: ModelProfile[], id: string | undefined) {
  if (!id) return null;
  return profiles.find((profile) => profile.id === id)?.name ?? id;
}

function backendLabel(
  backends: { value: AgentBackendType; label: string }[],
  value: AgentBackendType,
) {
  return backends.find((backend) => backend.value === value)?.label ?? value;
}

/**
 * The single sentence that makes the panel readable: what this project will
 * actually run, derived from the stored policy rather than from the controls.
 */
function describePolicy({
  policy,
  profiles,
  enabledBackends,
}: {
  policy: ProjectModelPolicy;
  profiles: ModelProfile[];
  enabledBackends: { value: AgentBackendType; label: string }[];
}): string {
  const pinned = profileName(profiles, policy.pinnedProfileId);

  if (policy.mode === 'inherit') {
    return 'Follows the globally active profile.';
  }

  if (policy.mode === 'prefer') {
    return pinned
      ? `Starts on ${pinned}. You can still switch profiles in this project.`
      : 'Follows the globally active profile until you pick a starting profile.';
  }

  const parts: string[] = [];
  if (pinned) {
    parts.push(
      `Always runs ${pinned}. Any other profile is refused when a session starts.`,
    );
  } else if (policy.allowedProfileIds?.length) {
    const names = policy.allowedProfileIds
      .map((id) => profileName(profiles, id))
      .filter((name): name is string => Boolean(name))
      .join(', ');
    parts.push(
      `Only ${names} may run here. Anything else is refused when a session starts.`,
    );
  } else {
    parts.push('Any profile may run here.');
  }

  if (policy.allowedBackends?.length) {
    const labels = policy.allowedBackends
      .map((value) => backendLabel(enabledBackends, value))
      .join(', ');
    parts.push(`Backends are limited to ${labels}.`);
  }

  return parts.join(' ');
}

/**
 * Per-project model policy editor (design §2, "Project policy — the
 * constraint").
 *
 * Outcome-first and mode-gated: each mode renders only the fields the resolver
 * actually reads for it (`allowedBackends` / `allowedProfileIds` are consulted
 * under `enforce` only), and every list is an explicit "all" vs "only these"
 * choice so an empty stored value can never masquerade as a restriction.
 *
 * Presentational: the parent owns the effective policy query and the
 * `api.projects.setModelPolicy` mutation. When `source === 'file'` a committed
 * `.jean-claude/model-policy.json` is the source of truth and wins wholesale,
 * so every control renders read-only.
 */
export function ProjectModelPolicyEditor({
  policy,
  source,
  filePath,
  profiles,
  enabledBackends,
  onChange,
}: {
  policy: ProjectModelPolicy;
  source: ProjectModelPolicySource;
  /** Absolute path of the repo policy file, when `source === 'file'`. */
  filePath?: string;
  profiles: ModelProfile[];
  enabledBackends: { value: AgentBackendType; label: string }[];
  onChange: (policy: ProjectModelPolicy) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const readOnly = source === 'file';
  const mode = policy.mode;
  const allowedBackends = policy.allowedBackends ?? [];
  const allowedProfileIds = policy.allowedProfileIds ?? [];

  const backendConstraint: BackendConstraint = policy.allowedBackends?.length
    ? 'only'
    : 'all';
  const profileConstraint: ProfileConstraint = policy.pinnedProfileId
    ? 'pinned'
    : policy.allowedProfileIds?.length
      ? 'only'
      : 'any';

  const outcome = describePolicy({ policy, profiles, enabledBackends });

  const emit = (next: ProjectModelPolicy) => {
    if (readOnly) return;
    setError(null);
    onChange(next);
  };

  const handleModeChange = (nextMode: ProjectModelPolicyMode) => {
    if (nextMode === mode) return;
    // Only keep the fields the target mode actually uses, so a stored value can
    // never sit there looking live while the resolver ignores it.
    if (nextMode === 'inherit') {
      emit({ mode: 'inherit' });
      return;
    }
    if (nextMode === 'prefer') {
      const next: ProjectModelPolicy = { mode: 'prefer' };
      if (policy.pinnedProfileId) next.pinnedProfileId = policy.pinnedProfileId;
      emit(next);
      return;
    }
    emit({ ...policy, mode: 'enforce' });
  };

  const handleBackendConstraintChange = (next: BackendConstraint) => {
    const updated: ProjectModelPolicy = { ...policy };
    if (next === 'all') {
      // Delete the key instead of checking every box: "all" and "an explicit
      // list of everything" must never be two spellings of the same state.
      delete updated.allowedBackends;
    } else {
      updated.allowedBackends = enabledBackends.map((backend) => backend.value);
    }
    emit(updated);
  };

  const handleBackendToggle = (backend: AgentBackendType, checked: boolean) => {
    const next = checked
      ? enabledBackends
          .map((entry) => entry.value)
          .filter(
            (value) => allowedBackends.includes(value) || value === backend,
          )
      : allowedBackends.filter((value) => value !== backend);

    if (next.length === 0) {
      setError('Pick at least one backend, or choose all enabled backends.');
      return;
    }

    emit({ ...policy, allowedBackends: next });
  };

  const handleProfileConstraintChange = (next: ProfileConstraint) => {
    const updated: ProjectModelPolicy = { ...policy };
    // The two controls are mutually exclusive in the data, not just on screen:
    // under `enforce` a pin always wins, so an allow-list next to it could
    // never change the outcome.
    delete updated.allowedProfileIds;
    delete updated.pinnedProfileId;
    if (next === 'only') {
      updated.allowedProfileIds = profiles.map((profile) => profile.id);
    } else if (next === 'pinned') {
      const first = policy.pinnedProfileId ?? profiles[0]?.id;
      if (first) updated.pinnedProfileId = first;
    }
    emit(updated);
  };

  const handleProfileToggle = (profileId: string, checked: boolean) => {
    const next = checked
      ? profiles
          .map((profile) => profile.id)
          .filter((id) => allowedProfileIds.includes(id) || id === profileId)
      : allowedProfileIds.filter((id) => id !== profileId);

    if (next.length === 0) {
      setError('Pick at least one profile, or choose any profile.');
      return;
    }

    const updated: ProjectModelPolicy = { ...policy, allowedProfileIds: next };
    delete updated.pinnedProfileId;
    emit(updated);
  };

  const handlePinnedProfileChange = (profileId: string) => {
    const updated: ProjectModelPolicy = { ...policy };
    delete updated.allowedProfileIds;
    if (profileId) {
      updated.pinnedProfileId = profileId;
    } else {
      delete updated.pinnedProfileId;
    }
    emit(updated);
  };


  // The atomic `Select` rather than a native one, so this panel matches the
  // rest of Settings (the profile editor and AI generation both use it).
  const profileOptions = useMemo(
    () => [
      { value: '', label: 'No profile' },
      ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
    ],
    [profiles],
  );

  const profilePicker = (
    <Select
      label="Pinned model profile"
      value={policy.pinnedProfileId ?? ''}
      options={profileOptions}
      disabled={readOnly}
      onChange={handlePinnedProfileChange}
      className="w-full"
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <span className="text-ink-1 mb-1 block text-sm font-medium">
          Model policy
        </span>
        <Select
          label="Policy mode"
          value={mode}
          options={modeSelectOptions}
          disabled={readOnly}
          onChange={(next) => handleModeChange(next as ProjectModelPolicyMode)}
          className="w-full"
        />
      </div>

      <p
        role="status"
        aria-label="Model policy outcome"
        className="text-ink-2 border-line-1 border-l-2 py-0.5 pl-2 text-xs"
      >
        {outcome}
      </p>

      {readOnly && (
        <p className="text-ink-3 flex items-center gap-1.5 text-xs">
          <FileLock2 className="h-3.5 w-3.5 shrink-0" />
          <span>
            Defined in <code>{MODEL_POLICY_FILE_RELATIVE_PATH}</code>
            {filePath ? ` (${filePath})` : ''} — edit the committed file to
            change it.
          </span>
        </p>
      )}

      {mode === 'prefer' && (
        <div>
          <span className="text-ink-1 mb-1 block text-sm font-medium">
            Starting profile
          </span>
          {profilePicker}
        </div>
      )}

      {mode === 'enforce' && (
        <>
          <div>
            <span className="text-ink-1 mb-1 block text-sm font-medium">
              Profiles
            </span>
            <Select
              label="Profile constraint"
              value={profileConstraint}
              options={PROFILE_CONSTRAINT_OPTIONS}
              disabled={readOnly}
              onChange={(next) =>
                handleProfileConstraintChange(next as ProfileConstraint)
              }
              className="w-full"
            />
            <div className="mt-2 flex flex-col gap-1">
              {profileConstraint === 'only' && (
                <div className="flex flex-wrap gap-3 pb-1">
                  {profiles.map((profile) => (
                    <Checkbox
                      key={profile.id}
                      size="sm"
                      checked={allowedProfileIds.includes(profile.id)}
                      disabled={readOnly}
                      ariaLabel={`Allow profile ${profile.name}`}
                      label={profile.name}
                      onChange={(checked) =>
                        handleProfileToggle(profile.id, checked)
                      }
                    />
                  ))}
                </div>
              )}
              {profileConstraint === 'pinned' && <div>{profilePicker}</div>}
            </div>
          </div>

          <div>
            <span className="text-ink-1 mb-1 block text-sm font-medium">
              Backends
            </span>
            <Select
              label="Backend constraint"
              value={backendConstraint}
              options={BACKEND_CONSTRAINT_OPTIONS}
              disabled={readOnly}
              onChange={(next) =>
                handleBackendConstraintChange(next as BackendConstraint)
              }
              className="w-full"
            />
            <div className="mt-2">
              {backendConstraint === 'only' && (
                <div className="flex flex-wrap gap-3">
                  {enabledBackends.map((backend) => (
                    <Checkbox
                      key={backend.value}
                      size="sm"
                      checked={allowedBackends.includes(backend.value)}
                      disabled={readOnly}
                      ariaLabel={`Allow ${backend.label}`}
                      label={backend.label}
                      onChange={(checked) =>
                        handleBackendToggle(backend.value, checked)
                      }
                    />
                  ))}
                </div>
              )}
            </div>
            <p className="text-ink-3 mt-1 text-xs">
              A policy can only narrow this list — it never grants a backend you
              have not enabled.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-danger text-xs">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
