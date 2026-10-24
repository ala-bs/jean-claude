import { ArrowLeft, ListTodo } from 'lucide-react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { nanoid } from 'nanoid';
import type { ProfilePreset } from '@shared/model-profiles';
import type { PromptFilePart } from '@shared/agent-backend-types';
import { useQuery } from '@tanstack/react-query';



import {
  getDefaultInteractionMode,
  renormalizeDraftInteractionMode,
} from '@/lib/default-interaction-mode';
import { getDescriptionHtml, getTitle } from '@shared/work-item-field-types';
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
  useBackendsSetting,
  useCompletionSetting,
} from '@/hooks/use-settings';
import {
  useProject,
  useProjectBranches,
  useProjectFeatureMap,
} from '@/hooks/use-projects';
import { api } from '@/lib/api';
import { BackendModelPresetPicker } from '@/features/agent/ui-backend-model-preset-picker';
import { BranchSelect } from '@/common/ui/branch-select';
import { Button } from '@/common/ui/button';
import { Checkbox } from '@/common/ui/checkbox';
import { expandFeatureReferencesInPrompt } from '@/lib/prompt-feature-context';
import { findMatchingBackendModelPresetId } from '@/features/agent/ui-backend-preset-selector';
import { getOriginalTaskAgentMemoryPrompt } from '@/lib/agent-memory-prompt-input';
import { Input } from '@/common/ui/input';
import { ModeSelector } from '@/features/agent/ui-mode-selector';
import { PromptTextarea } from '@/features/common/ui-prompt-textarea';
import { resolveAgentModelSelection } from '@/lib/default-models';
import { resolveBackendModelSelection } from '@/features/agent/utils-backend-model-selection';
import { ThinkingSelector } from '@/features/agent/ui-thinking-selector';
import { useBackendModels } from '@/hooks/use-backend-models';
import { useCreateTaskWithWorktree } from '@/hooks/use-tasks';
import { useEffectiveModelProfile } from '@/hooks/use-model-profiles';
import { useNewTaskFormStore } from '@/stores/new-task-form';
import { useProjectCanCreateWorktree } from '@/hooks/use-project-git';
import { useProjectSkills } from '@/hooks/use-skills';
import { WorkItemsBrowser } from '@/features/agent/ui-work-items-browser';
import { buildAttachedFilesXml } from '@/lib/file-attachment-utils';
import {
  deleteAttachmentFiles,
  deleteRelocatedAttachmentFiles,
} from '@/lib/prompt-attachment-cleanup';
import { downloadWorkItemPromptAttachments } from '@/lib/work-item-prompt-attachments';
import { useToastStore } from '@/stores/toasts';



/** Stable fallbacks for the active profile's presets / quick list. */
const EMPTY_PROFILE_PRESETS: ProfilePreset[] = [];
const EMPTY_QUICK_PRESET_IDS: string[] = [];

export const Route = createFileRoute('/projects/$projectId/tasks/new')({
  component: NewTask,
});

function NewTask() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const createTask = useCreateTaskWithWorktree();
  const addToast = useToastStore((state) => state.addToast);
  const submittingRef = useRef(false);
  const [isPreparingTask, setIsPreparingTask] = useState(false);
  const { data: project, isLoading: isProjectLoading } = useProject(projectId);
  const { data: featureMap = null } = useProjectFeatureMap(projectId);
  // Not just "is a git repo": a repo with no commits has nothing to branch
  // from, so `git worktree add` would fail after the task was already created.
  const { data: canUseWorktree = false, isFetching: isGitRepositoryFetching } =
    useProjectCanCreateWorktree(projectId);
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
    interactionMode: draftInteractionMode,
    modelPreference,
    thinkingEffort,
    backendModelPresetId,
    agentBackend,
    workItemIds,
    workItemUrls,
    updateWorkItemStatus,
  } = draft;
  // Deliberately NOT normalized here. ModeSelector normalizes for display on
  // its own, and the submit sites normalize against the backend actually
  // chosen. Collapsing it early is lossy: 'ask' normalized for a backend with
  // no ask mode becomes 'auto', so a submit-time rate-limit swap to a backend
  // that *does* support ask would then send 'auto' instead of 'ask'.
  const interactionMode =
    draftInteractionMode ?? getDefaultInteractionMode({ project });
  const selectableBranchInfos = useMemo(
    () =>
      useExistingBranch
        ? branchInfos.filter((branch) => !branch.isCheckedOut)
        : branchInfos,
    [branchInfos, useExistingBranch],
  );

  const { data: backendsSetting } = useBackendsSetting();
  const {
    profile: effectiveProfile,
    profiles,
    effectiveProfileId,
    projectProfileId,
  } = useEffectiveModelProfile(projectId);
  // Revision 1: presets and the quick list are owned by a profile, and the one
  // that counts here is the *effective* profile — the project may pin a
  // different profile than the globally active one.
  const profilePresets = effectiveProfile?.presets ?? EMPTY_PROFILE_PRESETS;
  const quickPresetIds =
    effectiveProfile?.quickPresetIds ?? EMPTY_QUICK_PRESET_IDS;
  const { data: effectivePolicy } = useQuery({
    queryKey: ['projects', 'effective-model-policy', projectId],
    queryFn: () => api.projects.getEffectivePolicy(projectId),
    enabled: Boolean(projectId),
  });

  // The `agent` role is the single source of truth for what a new task runs.
  // The draft's own model fields are an explicit per-task override and still win.
  const resolvedAgentModel = useMemo(
    () =>
      resolveAgentModelSelection({
        profiles,
        activeProfileId: effectiveProfileId,
        projectProfileId,
        policy: effectivePolicy?.policy ?? null,
        enabledBackends: backendsSetting?.enabledBackends,
        draft: {
          agentBackend,
          modelPreference,
          thinkingEffort,
          backendModelPresetId,
        },
      }),
    [
      agentBackend,
      backendModelPresetId,
      backendsSetting?.enabledBackends,
      effectivePolicy?.policy,
      effectiveProfileId,
      modelPreference,
      projectProfileId,
      profiles,
      thinkingEffort,
    ],
  );
  // Null until the enabled-backend list has loaded: resolving against an empty
  // list would fall back to a backend the user may not even have enabled.
  const effectiveAgentBackend = backendsSetting
    ? resolvedAgentModel.backend
    : null;
  const effectiveDefaultModelPreference = resolvedAgentModel.model;
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
        presets: profilePresets,
        quickPresetIds,
        backend: effectiveAgentBackend,
        defaultModel: effectiveDefaultModelPreference,
        draftModelPreference: modelPreference,
        draftAgentBackend: agentBackend,
        draftPresetId: backendModelPresetId,
        shouldAutoSelectPreset: draft.shouldAutoSelectBackendModelPreset,
        enabledBackends: backendsSetting?.enabledBackends,
        availableModels: availableModelPreferences,
        areModelsFetched: areBackendModelsFetched,
      }),
    [
      agentBackend,
      areBackendModelsFetched,
      availableModelPreferences,
      backendModelPresetId,
      profilePresets,
      backendsSetting?.enabledBackends,
      draft.shouldAutoSelectBackendModelPreset,
      effectiveAgentBackend,
      effectiveDefaultModelPreference,
      modelPreference,
      quickPresetIds,
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
        resolvedAgentModel.thinkingEffort,
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
      presets: profilePresets,
      backend: rateLimitSuggestion.backend,
      model:
        rateLimitSuggestion.model ??
        (backendChanged ? 'default' : effectiveModelPreference),
      thinkingEffort:
        rateLimitSuggestion.thinkingEffort ??
        (backendChanged ? 'default' : effectiveThinkingEffort),
    });
  }, [
    profilePresets,
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
      interactionMode: renormalizeDraftInteractionMode({
        draftMode: draftInteractionMode,
        backend: nextBackend,
      }),
    });
  }, [
    draftInteractionMode,
    effectiveAgentBackend,
    effectiveDefaultModelPreference,
    effectiveThinkingEffort,
    modelPreference,
    rateLimitSuggestion,
    setDraft,
    userTouchedSelection,
  ]);
  // No default-seeding effect any more. Writing the resolved default into the
  // draft turned it into an explicit per-task override, which is exactly why
  // activating a profile did not change what a new task ran. Defaults now stay
  // derived (`resolvedAgentModel`); the draft holds only real user choices.

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
    // Not just a disabled button: until the project resolves, the interaction
    // mode would fall back to 'ask' and ignore the project's auto-accept
    // setting. Re-checked here so non-button submit paths cannot slip through.
    if (isProjectLoading) return;
    if (!effectiveAgentBackend) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsPreparingTask(true);
    let downloadedFiles: PromptFilePart[] = [];
    let taskCreated = false;
    let taskCreationAttempted = false;

    try {

    // Pass null if name is empty - will trigger auto-generation when agent starts
    const taskName = name.trim() || null;
    const shouldUseWorktree = canUseWorktree && useWorktree;
    const submitSelection = await resolveRateLimitSwapSelection({
      backend: effectiveAgentBackend,
      model: effectiveModelPreference,
      thinkingEffort: effectiveThinkingEffort,
    });

    let finalPrompt = expandFeatureReferencesInPrompt({ text: prompt, featureMap });
    if (workItemIds?.length && project?.workItemProviderId) {
      try {
        const workItems = await api.azureDevOps.getWorkItemsByIds({
          providerId: project.workItemProviderId,
          projectName: project.workItemProjectName!,
          workItemIds: workItemIds.map(Number),
        });
        const attachments = await downloadWorkItemPromptAttachments({
          workItems,
          providerId: project.workItemProviderId,
          projectPath: project.path,
        });
        downloadedFiles = attachments.files;
        finalPrompt += buildAttachedFilesXml(attachments.files);
        if (attachments.failures.length > 0) {
          addToast({
            type: 'error',
            message: `Could not attach: ${attachments.failures.join(', ')}`,
          });
          finalPrompt += `\n\nWork item attachments unavailable: ${attachments.failures.join(', ')}`;
        }
      } catch (error) {
        console.error('Failed to load work item attachments:', error);
        addToast({ type: 'error', message: 'Could not load work item attachments' });
        finalPrompt += '\n\nWork item attachments could not be loaded.';
      }
    }

    setIsPreparingTask(false);
    taskCreationAttempted = true;
    const task = await createTask.mutateAsync({
      id: nanoid(),
      projectId,
      name: taskName,
      prompt: finalPrompt,
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
    taskCreated = true;
    await deleteRelocatedAttachmentFiles({
      projectPath: project?.path,
      files: downloadedFiles,
      prompt: task.prompt,
      worktreePath: task.worktreePath,
    });

    // Clear the draft now that we've submitted
    clearDraft();

    // Navigate to the new task in the feed list, the main view
    navigate({ to: '/all/$taskId', params: { taskId: task.id } });
    } finally {
      if (!taskCreated && !taskCreationAttempted) {
        await deleteAttachmentFiles({
          projectPath: project?.path,
          files: downloadedFiles,
        });
      }
      submittingRef.current = false;
      setIsPreparingTask(false);
    }
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
                      name: getTitle(wi).slice(0, 100),
                      prompt:
                        `[AB#${wi.id}] ${getTitle(wi)}\n\n${getDescriptionHtml(wi) ?? ''}`.trim(),
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
                        effort: selection.thinkingEffort ?? 'default',
                        capabilities: nextThinkingCapabilities,
                      }),
                      interactionMode: renormalizeDraftInteractionMode({
                        draftMode: draftInteractionMode,
                        backend: selection.backend,
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
                      interactionMode: renormalizeDraftInteractionMode({
                        draftMode: draftInteractionMode,
                        backend: selection.backend,
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
              loading={isPreparingTask || createTask.isPending}
              disabled={
                isPreparingTask ||
                createTask.isPending ||
                !prompt.trim() ||
                isWorktreeDataFetching ||
                isProjectLoading ||
                !effectiveAgentBackend
              }
            >
              Create
            </Button>
            <Button
              variant="primary"
              size="md"
              type="submit"
              loading={isPreparingTask || createTask.isPending}
              disabled={
                isPreparingTask ||
                createTask.isPending ||
                !prompt.trim() ||
                isWorktreeDataFetching ||
                isProjectLoading ||
                !effectiveAgentBackend
              }
            >
              {isPreparingTask ? 'Attaching files…' : createTask.isPending ? 'Creating…' : 'Start'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
