import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AiSkillSlotConfig, AiSkillSlotKey } from '@shared/types';
import { roleForSkillSlot } from '@shared/model-profiles';
import { Select } from '@/common/ui/select';
import { Switch } from '@/common/ui/switch';
import { useManagedSkills } from '@/hooks/use-managed-skills';
import { useResolvedModelForRole } from '@/hooks/use-model-profiles';

/** Sentinel value used when no skill is selected in the dropdown. */
const NO_SKILL_VALUE = '__none__';

export const SLOT_DEFINITIONS: {
  key: AiSkillSlotKey;
  label: string;
  description: string;
}[] = [
  {
    key: 'merge-commit-message',
    label: 'Merge Commit Message',
    description: 'Auto-generate commit messages when squash-merging worktrees',
  },
  {
    key: 'commit-message',
    label: 'Commit Message',
    description: 'Auto-generate commit messages when committing changes',
  },
  {
    key: 'pr-description',
    label: 'PR Description',
    description:
      'Auto-generate pull request title and description when creating a PR',
  },
  {
    key: 'task-name',
    label: 'Task Name',
    description: 'Auto-generate short task names from prompts',
  },
  {
    key: 'verification-note',
    label: 'Verification Note',
    description:
      'Generate named work item verification checklists from selected work items and test cases',
  },
  {
    key: 'project-summary',
    label: 'Project Summary',
    description:
      'Generate short project summaries used as context for project logo generation',
  },
  {
    key: 'project-feature-map',
    label: 'Project Feature Map',
    description:
      'Map project features for selectable context in the new task overlay',
  },
  {
    key: 'work-item-summary',
    label: 'Work Item Summary',
    description:
      'Summarize Azure work item requirements and comment history for faster review',
  },
];

/**
 * Editor for one AI skill slot.
 *
 * A slot decides which **prompt** a feature uses. Which **model** it runs on
 * belongs to the slot's model-profile role, so the model is shown here
 * read-only and edited in Settings → Model profiles. The stored
 * `backend` / `model` / `thinkingEffort` fields are carried through untouched
 * and are no longer read by the resolver.
 */
export function SlotDetail({
  slotKey,
  label,
  description,
  config,
  onUpdate,
  projectId,
  projectPath,
  emptySummary = 'Not configured',
  emptyBadgeLabel = 'Disabled',
  toggleLabel = 'Enabled',
  toggleDescription = 'Disabled slots skip AI generation for this feature.',
}: {
  slotKey: AiSkillSlotKey;
  label: string;
  description: string;
  config: AiSkillSlotConfig | null;
  onUpdate: (config: AiSkillSlotConfig | null) => void;
  projectId?: string;
  projectPath?: string;
  emptySummary?: string;
  emptyBadgeLabel?: string;
  toggleLabel?: string;
  toggleDescription?: string;
}) {
  const isEnabled = config !== null;
  const role = roleForSkillSlot(slotKey);
  const { data: resolvedModel } = useResolvedModelForRole(role, projectId);

  // The skills offered are the ones installed for the backend the role
  // resolves to — the backend this slot will actually run on.
  const backend = resolvedModel?.backend ?? 'claude-code';

  const configSkillName = config?.skillName ?? null;
  const [localSkillName, setLocalSkillName] = useState<string | null>(
    configSkillName,
  );
  const hasLocalChangesRef = useRef(false);

  // Sync local state when external config changes (e.g., query refetch).
  useEffect(() => {
    if (hasLocalChangesRef.current && localSkillName !== configSkillName) return;

    hasLocalChangesRef.current = false;
    startTransition(() => setLocalSkillName(configSkillName));
  }, [configSkillName, localSkillName]);

  const { data: skills } = useManagedSkills(backend, projectPath);
  const enabledSkills = useMemo(
    () =>
      (skills ?? []).filter(
        (s) => s.enabledBackends[backend] === true || s.source === 'builtin',
      ),
    [skills, backend],
  );

  const skillOptions = useMemo(() => {
    const builtin = enabledSkills
      .filter((s) => s.source === 'builtin')
      .map((s) => ({ value: s.name, label: `${s.name} (Builtin)` }));
    const other = enabledSkills
      .filter((s) => s.source !== 'builtin')
      .map((s) => ({ value: s.name, label: s.name }));
    const available = [...builtin, ...other].filter(
      (option, index, options) =>
        options.findIndex((candidate) => candidate.value === option.value) ===
        index,
    );
    const previousSelection =
      localSkillName &&
      !available.some((option) => option.value === localSkillName)
        ? [
            {
              value: localSkillName,
              label: `${localSkillName} (Previously selected)`,
            },
          ]
        : [];
    return [
      { value: NO_SKILL_VALUE, label: 'None' },
      ...previousSelection,
      ...available,
    ];
  }, [enabledSkills, localSkillName]);

  /**
   * Preserves whatever model fields the slot already stored. They are dead
   * data — the resolver reads the role instead — but rewriting them here would
   * silently rewrite settings the user never touched.
   */
  const buildConfig = useCallback(
    (skillName: string | null): AiSkillSlotConfig => ({
      backend: config?.backend ?? backend,
      model: config?.model ?? resolvedModel?.model ?? 'default',
      thinkingEffort: config?.thinkingEffort ?? 'default',
      skillName,
    }),
    [backend, config, resolvedModel?.model],
  );

  const hasChanges = config !== null && localSkillName !== configSkillName;

  useEffect(() => {
    if (!hasChanges) return;

    const saveTimeout = window.setTimeout(
      () => onUpdate(buildConfig(localSkillName)),
      500,
    );

    return () => window.clearTimeout(saveTimeout);
  }, [buildConfig, hasChanges, localSkillName, onUpdate]);

  const handleToggleEnabled = useCallback(
    (checked: boolean) => {
      onUpdate(checked ? buildConfig(localSkillName) : null);
    },
    [buildConfig, localSkillName, onUpdate],
  );

  const resolvedModelLabel = resolvedModel?.off
    ? 'Disabled by the active model profile'
    : resolvedModel
      ? `${resolvedModel.backend} / ${resolvedModel.model}${
          resolvedModel.thinkingEffort && resolvedModel.thinkingEffort !== 'default'
            ? ` · ${resolvedModel.thinkingEffort}`
            : ''
        }`
      : 'Resolving…';

  const summary = config
    ? (config.skillName ?? 'Builtin prompt')
    : emptySummary;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-ink-1 text-lg font-semibold">{label}</h2>
            <p className="text-ink-3 mt-1 text-sm">{description}</p>
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            <span className="text-ink-2 text-xs">{summary}</span>
            {!config && (
              <span className="text-ink-3 bg-glass-medium rounded px-1.5 py-0.5 text-xs">
                {emptyBadgeLabel}
              </span>
            )}
          </div>
        </div>

        <div className="border-glass-border bg-bg-1 mt-5 rounded-lg border p-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="text-ink-2 text-sm">Skill</label>
                <p className="text-ink-3 mt-0.5 text-xs">
                  Optional skill prompt applied before generation.
                </p>
              </div>
              <div className="shrink-0">
                <Select
                  value={localSkillName ?? NO_SKILL_VALUE}
                  options={skillOptions}
                  onChange={(value) => {
                    const skillName =
                      value === NO_SKILL_VALUE ? null : value;
                    if (skillName !== localSkillName) {
                      hasLocalChangesRef.current = true;
                    }
                    setLocalSkillName(skillName);
                  }}
                  label="Skill"
                />
              </div>
            </div>

            <div className="border-glass-border border-t" />

            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="text-ink-2 text-sm">Model</label>
                <p className="text-ink-3 mt-0.5 text-xs">
                  Set by the <strong>{label}</strong> role in Settings &rarr;
                  Model profiles.
                </p>
              </div>
              <span className="text-ink-2 shrink-0 font-mono text-xs">
                {resolvedModelLabel}
              </span>
            </div>

            <div className="border-glass-border border-t" />

            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="text-ink-2 text-sm">{toggleLabel}</label>
                <p className="text-ink-3 mt-0.5 text-xs">{toggleDescription}</p>
              </div>
              <Switch checked={isEnabled} onChange={handleToggleEnabled} />
            </div>
          </div>
          {hasChanges && (
            <div className="text-ink-3 mt-4 text-right text-xs">
              Changes save automatically
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
