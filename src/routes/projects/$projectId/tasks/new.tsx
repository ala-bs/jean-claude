import { ArrowLeft, ListTodo } from 'lucide-react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { nanoid } from 'nanoid';



import {
  getModelsForBackend,
  getModelThinkingCapabilities,
} from '@/features/agent/ui-backend-selector';
import {
  getThinkingEffortOptions,
  normalizeThinkingEffortForModel,
} from '@shared/thinking-settings';
import {
  normalizeInteractionModeForBackend,
  type ThinkingEffort,
} from '@shared/types';
import {
  RateLimitSwapPreview,
  resolveRateLimitSwapSelection,
  useRateLimitSwapPreview,
} from '@/features/agent/ui-rate-limit-swap-preview';
import {
  useBackendDefaultModelsSetting,
  useBackendModelPresetsSetting,
  useBackendsSetting,
  useCompletionSetting,
  useModelQuickSwitcherSetting,
  useThinkingSettingsSetting,
} from '@/hooks/use-settings';
import {
  useProject,
  useProjectBranches,
  useProjectFeatureMap,
  useProjectIsGitRepository,
} from '@/hooks/use-projects';
import { BackendModelPresetPicker } from '@/features/agent/ui-backend-model-preset-picker';
import { BranchSelect } from '@/common/ui/branch-select';
import { Button } from '@/common/ui/button';
import { Checkbox } from '@/common/ui/checkbox';
import { expandFeatureReferencesInPrompt } from '@/lib/prompt-feature-context';
import { findMatchingBackendModelPresetId } from '@/features/agent/ui-backend-preset-selector';
import { getDefaultModelForBackend } from '@/lib/default-models';
import { getOriginalTaskAgentMemoryPrompt } from '@/lib/agent-memory-prompt-input';
import { Input } from '@/common/ui/input';
import { ModeSelector } from '@/features/agent/ui-mode-selector';
import { PromptTextarea } from '@/features/common/ui-prompt-textarea';
import { resolveBackendModelSelection } from '@/features/agent/utils-backend-model-selection';
import { ThinkingSelector } from '@/features/agent/ui-thinking-selector';
import { useBackendModels } from '@/hooks/use-backend-models';
import { useCreateTaskWithWorktree } from '@/hooks/use-tasks';
import { useNewTaskFormStore } from '@/stores/new-task-form';
import { useProjectSkills } from '@/hooks/use-skills';
import { WorkItemsBrowser } from '@/features/agent/ui-work-items-browser';



export const Route = createFileRoute('/projects/$projectId/tasks/new')({
  component: NewTask,
});

function NewTask() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const createTask = useCreateTaskWithWorktree();
  const { data: project } = useProject(projectId);
  const { data: featureMap = null } = useProjectFeatureMap(projectId);
  const { data: isGitRepository = false, isFetching: isGitRepositoryFetching } =
    useProjectIsGitRepository(projectId);
  const canUseWorktree = isGitRepository;
  const {
    data: branchInfos = [],
    isLoading: branchesLoading,
    isFetching: branchesFetching,
  } = useProjectBranches(canUseWorktree ? projectId : null);
  const { data: skills = [] } = useProjectSkills(projectId);

  const { data: completionSetting } = useCompletionSetting();
  const [showWorkItems, setShowWorkItems] = useState(false);
  const hasWorkItemsLink =
    !!project?.workItemProviderId && !!project?.workItemProjectId;

  const { draft, hasDraft, setDraft, clearDraft } =
    useNewTaskFormStore(projectId);
  const userTouchedSelectionRef = useRef(hasDraft);
  const [userTouchedSelection, setUserTouchedSelection] = useState(hasDraft);
  const markUserTouchedSelection = useCallback(() => {
    userTouchedSelectionRef.current = true;
    setUserTouchedSelection(true);
  }, []);
  const {
    name,
    prompt,
    useWorktree,
    useExistingBranch,
    sourceBranch,
    interactionMode,
    modelPreference,
    thinkingEffort,
    backendModelPresetId,
    agentBackend,
    workItemIds,
    workItemUrls,
    updateWorkItemStatus,
  } = draft;
  const selectableBranchInfos = useMemo(
    () =>
      useExistingBranch
        ? branchInfos.filter((branch) => !branch.isCheckedOut)
        : branchInfos,
    [branchInfos, useExistingBranch],
  );

  // Sync draft backend with project→global default on mount
  const { data: backendsSetting } = useBackendsSetting();
  const { data: backendDefaultModelsSetting } =
    useBackendDefaultModelsSetting();
  const { data: backendModelPresets = [] } = useBackendModelPresetsSetting();
  const { data: thinkingSettings } = useThinkingSettingsSetting();
  const { data: quickSwitcherSetting } = useModelQuickSwitcherSetting();
  const resolvedDefaultBackend =
    project?.defaultAgentBackend ?? backendsSetting?.defaultBackend;
  const effectiveAgentBackend =
    agentBackend ??
    (resolvedDefaultBackend &&
    backendsSetting?.enabledBackends.includes(resolvedDefaultBackend)
      ? resolvedDefaultBackend
      : backendsSetting?.enabledBackends[0]) ??
    null;
  // Must be derived from the *validated* backend — pairing a backend with
  // another backend's default model breaks preset matching.
  const effectiveDefaultModelPreference = getDefaultModelForBackend({
    backend: effectiveAgentBackend,
    project,
    backendDefaultModels: backendDefaultModelsSetting,
  });
  const { data: dynamicModels, isFetched: areBackendModelsFetched } =
    useBackendModels(effectiveAgentBackend);
  const availableModelPreferences = useMemo(
    () =>
      getModelsForBackend(effectiveAgentBackend, dynamicModels).map(
        (option) => option.value,
      ),
    [effectiveAgentBackend, dynamicModels],
  );
  const backendModelSelection = useMemo(
    () =>
      resolveBackendModelSelection({
        presets: backendModelPresets,
        backend: effectiveAgentBackend,
        defaultModel: effectiveDefaultModelPreference,
        draftModelPreference: modelPreference,
        draftAgentBackend: agentBackend,
        draftPresetId: backendModelPresetId,
        shouldAutoSelectPreset: draft.shouldAutoSelectBackendModelPreset,
        enabledBackends: backendsSetting?.enabledBackends,
        quickSwitcherEnabled: quickSwitcherSetting?.enabled,
        availableModels: availableModelPreferences,
        areModelsFetched: areBackendModelsFetched,
      }),
    [
      agentBackend,
      areBackendModelsFetched,
      availableModelPreferences,
      backendModelPresetId,
      backendModelPresets,
      backendsSetting?.enabledBackends,
      draft.shouldAutoSelectBackendModelPreset,
      effectiveAgentBackend,
      effectiveDefaultModelPreference,
      modelPreference,
      quickSwitcherSetting?.enabled,
    ],
  );
  const effectiveModelPreference = backendModelSelection.model;
  const effectiveBackendModelPresetId = backendModelSelection.presetId;
  const effectiveBackendModelPreset = backendModelSelection.preset;
  const thinkingCapabilities = getModelThinkingCapabilities(
    effectiveModelPreference,
    dynamicModels,
  );
  const thinkingOptions = getThinkingEffortOptions({
    backend: effectiveAgentBackend,
    model: effectiveModelPreference,
    capabilities: thinkingCapabilities,
  });
  const effectiveThinkingEffort: ThinkingEffort =
    normalizeThinkingEffortForModel({
      backend: effectiveAgentBackend,
      model: effectiveModelPreference,
      effort:
        thinkingEffort ??
        effectiveBackendModelPreset?.thinkingEffort ??
        (effectiveAgentBackend
          ? thinkingSettings?.efforts[effectiveAgentBackend]?.[
              effectiveModelPreference
            ]
          : undefined) ??
        (effectiveAgentBackend
          ? thinkingSettings?.efforts[effectiveAgentBackend]?.default
          : undefined) ??
        'default',
      capabilities: thinkingCapabilities,
    });
  const { data: rateLimitSuggestion } = useRateLimitSwapPreview(
    effectiveAgentBackend,
    !userTouchedSelection,
  );
  const rateLimitSuggestedPresetId = useMemo(() => {
    if (!rateLimitSuggestion?.swapped) return null;

    const backendChanged = rateLimitSuggestion.backend !== effectiveAgentBackend;
    return findMatchingBackendModelPresetId({
      presets: backendModelPresets,
      backend: rateLimitSuggestion.backend,
      model:
        rateLimitSuggestion.model ??
        (backendChanged ? 'default' : effectiveModelPreference),
      thinkingEffort:
        rateLimitSuggestion.thinkingEffort ??
        (backendChanged ? 'default' : effectiveThinkingEffort),
    });
  }, [
    backendModelPresets,
    effectiveAgentBackend,
    effectiveModelPreference,
    effectiveThinkingEffort,
    rateLimitSuggestion,
  ]);
  useEffect(() => {
    if (!rateLimitSuggestion?.swapped || userTouchedSelection) return;

    const nextBackend = rateLimitSuggestion.backend;
    // Use the unclamped model here: `effectiveModelPreference` may have been
    // clamped to 'default' for display, and persisting that would destroy the
    // user's stored selection rather than just hide it.
    const nextModel =
      rateLimitSuggestion.model ??
      (nextBackend !== effectiveAgentBackend
        ? 'default'
        : (modelPreference ?? effectiveDefaultModelPreference));
    const nextThinkingEffort =
      rateLimitSuggestion.thinkingEffort ??
      (nextBackend !== effectiveAgentBackend
        ? 'default'
        : effectiveThinkingEffort);
    setDraft({
      agentBackend: nextBackend,
      modelPreference: nextModel,
      thinkingEffort: nextThinkingEffort,
      backendModelPresetId: null,
      shouldAutoSelectBackendModelPreset: false,
      interactionMode: normalizeInteractionModeForBackend({
        backend: nextBackend,
        mode: interactionMode,
      }),
    });
  }, [
    effectiveAgentBackend,
    effectiveDefaultModelPreference,
    effectiveThinkingEffort,
    interactionMode,
    modelPreference,
    rateLimitSuggestion,
    setDraft,
    userTouchedSelection,
  ]);
  useEffect(() => {
    if (
      !backendsSetting ||
      !project ||
      hasDraft ||
      rateLimitSuggestion?.swapped
    )
      return;

    const resolved =
      project.defaultAgentBackend ?? backendsSetting.defaultBackend;
    if (!resolved) return;
    if (!backendsSetting.enabledBackends.includes(resolved)) return;

    // Seed through the shared resolver so this route lands on the same preset
    // (including the quick-switcher default) as the new-task overlay.
    const { presetId, preset, model } = resolveBackendModelSelection({
      presets: backendModelPresets,
      backend: resolved,
      defaultModel: getDefaultModelForBackend({
        backend: resolved,
        project,
        backendDefaultModels: backendDefaultModelsSetting,
      }),
      enabledBackends: backendsSetting.enabledBackends,
      quickSwitcherEnabled: quickSwitcherSetting?.enabled,
    });

    setDraft({
      agentBackend: resolved,
      modelPreference: model,
      thinkingEffort:
        preset?.thinkingEffort ??
        thinkingSettings?.efforts[resolved]?.[model] ??
        thinkingSettings?.efforts[resolved]?.default ??
        'default',
      backendModelPresetId: presetId,
      shouldAutoSelectBackendModelPreset: true,
      interactionMode: normalizeInteractionModeForBackend({
        backend: resolved,
        mode: interactionMode,
      }),
    });
  }, [
    backendModelPresets,
    backendDefaultModelsSetting,
    backendsSetting,
    hasDraft,
    interactionMode,
    project,
    quickSwitcherSetting?.enabled,
    rateLimitSuggestion?.swapped,
    setDraft,
    thinkingSettings,
  ]);

  // Determine the effective source branch (draft value or project default)
  const effectiveSourceBranch =
    selectableBranchInfos.some((branch) => branch.name === sourceBranch)
      ? sourceBranch
      : project?.defaultBranch &&
          selectableBranchInfos.some(
            (branch) => branch.name === project.defaultBranch,
          )
        ? project.defaultBranch
        : selectableBranchInfos[0]?.name ?? null;
  const isWorktreeDataFetching =
    isGitRepositoryFetching ||
    (canUseWorktree && useWorktree && branchesFetching);

  async function handleCreateTask(shouldStart: boolean) {
    if (isWorktreeDataFetching) return;
    if (!effectiveAgentBackend) return;

    // Pass null if name is empty - will trigger auto-generation when agent starts
    const taskName = name.trim() || null;
    const shouldUseWorktree = canUseWorktree && useWorktree;
    const submitSelection = await resolveRateLimitSwapSelection({
      backend: effectiveAgentBackend,
      model: effectiveModelPreference,
      thinkingEffort: effectiveThinkingEffort,
    });

    const task = await createTask.mutateAsync({
      id: nanoid(),
      projectId,
      name: taskName,
      prompt: expandFeatureReferencesInPrompt({ text: prompt, featureMap }),
      agentMemoryPrompt: getOriginalTaskAgentMemoryPrompt({
        inputMode: 'prompt',
        prompt,
        workItemTemplate: '',
      }),
      status: 'waiting',
      interactionMode: normalizeInteractionModeForBackend({
        backend: submitSelection.backend,
        mode: interactionMode,
      }),
      modelPreference: submitSelection.model,
      thinkingEffort: submitSelection.thinkingEffort as ThinkingEffort,
      agentBackend: submitSelection.backend,
      useWorktree: shouldUseWorktree,
      useExistingBranch: shouldUseWorktree && useExistingBranch,
      workItemIds,
      workItemUrls,
      updateWorkItemStatus,
      sourceBranch: shouldUseWorktree ? effectiveSourceBranch : null,
      updatedAt: new Date().toISOString(),
      autoStart: shouldStart,
    });

    // Clear the draft now that we've submitted
    clearDraft();

    // Navigate to the new task in the feed list, the main view
    navigate({ to: '/all/$taskId', params: { taskId: task.id } });
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await handleCreateTask(true);
  }

  async function handleCreateOnly() {
    await handleCreateTask(false);
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-xl">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            navigate({ to: '/all' })
          }
          icon={<ArrowLeft />}
          className="mb-6"
        >
          Back
        </Button>

        <h1 className="mb-6 text-2xl font-bold">New Task</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Task name */}
          <div>
            <label
              htmlFor="name"
              className="text-ink-1 mb-1 block text-sm font-medium"
            >
              Name <span className="text-ink-3">(optional)</span>
            </label>
            <Input
              id="name"
              size="md"
              value={name}
              onChange={(e) => setDraft({ name: e.target.value })}
              placeholder="Auto-generated from prompt if empty"
              autoComplete="off"
            />
          </div>

          {/* Prompt */}
          <div>
            <label
              htmlFor="prompt"
              className="text-ink-1 mb-1 block text-sm font-medium"
            >
              Prompt
            </label>
            <PromptTextarea
              id="prompt"
              value={prompt}
              onChange={(value) => setDraft({ prompt: value })}
              placeholder="Describe what you want the agent to do... (type / for commands)"
              skills={skills}
              showCommands={false}
              projectRoot={project?.path ?? null}
              enableFilePathAutocomplete
              enableCompletion={completionSetting?.enabled ?? false}
              projectId={projectId}
              featureMap={featureMap}
              maxHeight={400}
              className="focus:border-glass-border-strong border-glass-border bg-bg-1 text-ink-0 min-h-[200px] rounded-lg border px-3 py-2 focus:ring-1 focus:ring-white/10"
            />
          </div>

          {canUseWorktree && (
            <div className="space-y-2">
              <Checkbox
                id="useWorktree"
                checked={useWorktree}
                onChange={(checked) => setDraft({ useWorktree: checked })}
                label="Create git worktree for isolation"
              />

              {useWorktree && (
                <div className="ml-6">
                  <label className="text-ink-2 mb-1 block text-sm font-medium">
                    Source branch
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={useExistingBranch ? 'reuse' : 'new'}
                      onChange={(event) =>
                        setDraft({
                          useExistingBranch: event.target.value === 'reuse',
                        })
                      }
                      className="bg-bg-1 text-ink-1 border-glass-border rounded-md border px-2 text-sm"
                    >
                      <option value="new">New branch</option>
                      <option value="reuse">Existing branch</option>
                    </select>
                    <BranchSelect
                    branches={selectableBranchInfos}
                    branchesLoading={branchesLoading}
                    favoriteBranches={project?.favoriteBranches}
                    defaultBranch={project?.defaultBranch}
                    value={effectiveSourceBranch ?? branchInfos[0]?.name}
                    onChange={(value) =>
                      setDraft({ sourceBranch: value || null })
                    }
                    disabled={branchesLoading}
                      className="min-w-0 flex-1 justify-between"
                    placeholder="Select branch..."
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Work Items */}
          {hasWorkItemsLink && (
            <div>
              {showWorkItems ? (
                <WorkItemsBrowser
                  localProjectId={projectId}
                  providerId={project!.workItemProviderId!}
                  projectId={project!.workItemProjectId!}
                  projectName={project!.workItemProjectName!}
                  onSelect={(wi) => {
                    setDraft({
                      name: wi.fields.title.slice(0, 100),
                      prompt:
                        `[AB#${wi.id}] ${wi.fields.title}\n\n${wi.fields.description ?? ''}`.trim(),
                      workItemIds: [String(wi.id)],
                      workItemUrls: [wi.url],
                    });
                    setShowWorkItems(false);
                  }}
                  onClose={() => setShowWorkItems(false)}
                />
              ) : (
                <div className="space-y-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowWorkItems(true)}
                    icon={<ListTodo />}
                  >
                    {workItemIds?.length
                      ? `From AB#${workItemIds[0]}`
                      : 'From Work Item'}
                  </Button>
                  {workItemIds?.length ? (
                    <div className="ml-1">
                      <Checkbox
                        checked={updateWorkItemStatus}
                        onChange={(checked) =>
                          setDraft({ updateWorkItemStatus: checked })
                        }
                        label="Update linked work item status to Active"
                      />
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {/* Submit row with mode selector */}
          <div className="flex items-center gap-3">
            {effectiveAgentBackend ? (
              <>
                <ModeSelector
                  value={interactionMode}
                  onChange={(mode) => setDraft({ interactionMode: mode })}
                  backend={effectiveAgentBackend}
                />
                <BackendModelPresetPicker
                  backend={effectiveAgentBackend}
                  model={effectiveModelPreference}
                  selectedPresetId={effectiveBackendModelPresetId}
                  enabledBackends={backendsSetting?.enabledBackends}
                  onChange={(selection) => {
                    markUserTouchedSelection();
                    const nextThinkingCapabilities = getModelThinkingCapabilities(
                      selection.model,
                      dynamicModels,
                    );
                    setDraft({
                      agentBackend: selection.backend,
                      backendModelPresetId: selection.presetId,
                      shouldAutoSelectBackendModelPreset:
                        selection.presetId !== null,
                      modelPreference: selection.model,
                      thinkingEffort: normalizeThinkingEffortForModel({
                        backend: selection.backend,
                        model: selection.model,
                        effort:
                          selection.thinkingEffort ??
                          thinkingSettings?.efforts[selection.backend]?.[
                            selection.model
                          ] ??
                          thinkingSettings?.efforts[selection.backend]
                            ?.default ??
                          'default',
                        capabilities: nextThinkingCapabilities,
                      }),
                      interactionMode: normalizeInteractionModeForBackend({
                        backend: selection.backend,
                        mode: interactionMode,
                      }),
                    });
                  }}
                />
                {!effectiveBackendModelPresetId && (
                  <ThinkingSelector
                    value={effectiveThinkingEffort}
                    options={thinkingOptions}
                    onChange={(nextThinkingEffort) => {
                      markUserTouchedSelection();
                      setDraft({ thinkingEffort: nextThinkingEffort });
                    }}
                    disabled={thinkingOptions.length <= 1}
                  />
                )}
                <RateLimitSwapPreview
                  requestedBackend={effectiveAgentBackend}
                  model={effectiveModelPreference}
                  thinkingEffort={effectiveThinkingEffort}
                  selectedPresetId={effectiveBackendModelPresetId}
                  suggestedPresetId={rateLimitSuggestedPresetId}
                  onApplySuggestion={(selection) => {
                    markUserTouchedSelection();
                    setDraft({
                      agentBackend: selection.backend,
                      backendModelPresetId: null,
                      shouldAutoSelectBackendModelPreset: false,
                      modelPreference: selection.model,
                      thinkingEffort: selection.thinkingEffort as ThinkingEffort,
                      interactionMode: normalizeInteractionModeForBackend({
                        backend: selection.backend,
                        mode: interactionMode,
                      }),
                    });
                  }}
                />
              </>
            ) : null}
            <Button
              variant="secondary"
              size="md"
              onClick={handleCreateOnly}
              loading={createTask.isPending}
              disabled={
                createTask.isPending ||
                !prompt.trim() ||
                isWorktreeDataFetching ||
                !effectiveAgentBackend
              }
            >
              Create
            </Button>
            <Button
              variant="primary"
              size="md"
              type="submit"
              loading={createTask.isPending}
              disabled={
                createTask.isPending ||
                !prompt.trim() ||
                isWorktreeDataFetching ||
                !effectiveAgentBackend
              }
            >
              {createTask.isPending ? 'Creating…' : 'Start'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
