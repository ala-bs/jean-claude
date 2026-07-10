import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Cloud,
  Cpu,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  AddProjectForm,
  type ProjectFormData,
} from '@/features/project/ui-add-project-form';
import {
  api,
  type AzureDevOpsOrganization,
  type DetectedProject,
} from '@/lib/api';
import {
  CloneRepoPane,
  type CloneResult,
} from '@/features/project/ui-clone-repo-pane';
import {
  useBackendsSetting,
  useUpdateBackendsSetting,
} from '@/hooks/use-settings';
import {
  useCreateProject,
  useProjects,
  useUploadProjectLogo,
} from '@/hooks/use-projects';
import { useCreateProvider, useProviders } from '@/hooks/use-providers';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { Button } from '@/common/ui/button';
import { getRandomColor } from '@/lib/colors';
import { Input } from '@/common/ui/input';
import { ProtectedBranchesInput } from '@/features/project/ui-project-settings/protected-branches-input';
import { Select } from '@/common/ui/select';
import { useCreateToken } from '@/hooks/use-tokens';
import { useNewTaskDraftStore } from '@/stores/new-task-draft';
import { useOnboardingStore } from '@/stores/onboarding';
import { useOverlaysStore } from '@/stores/overlays';
import { useTasks } from '@/hooks/use-tasks';
import { useValidateAzureDevOpsToken } from '@/hooks/use-azure-devops';

export const Route = createFileRoute('/onboarding/setup')({
  component: SetupWizardPage,
});

const backendOptions: Array<{
  id: AgentBackendType;
  name: string;
  detail: string;
}> = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    detail: 'Best default if Claude Code is your main agent.',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    detail: 'Use when you prefer OpenCode sessions and skills.',
  },
  {
    id: 'codex',
    name: 'Codex',
    detail: 'Use when you want Codex CLI-backed coding sessions.',
  },
  {
    id: 'vibe',
    name: 'Mistral Vibe',
    detail:
      'Uses vibe-acp. Install mistral-vibe from github.com/mistralai/mistral-vibe, then run vibe-acp --setup or set MISTRAL_API_KEY.',
  },
];

const sourceBadgeConfig: Record<string, { className: string; label: string }> =
  {
    'claude-code': {
      className:
        'rounded px-1.5 py-0.5 text-[10px] font-medium bg-status-run/15 text-status-run',
      label: 'Claude Code',
    },
    opencode: {
      className:
        'rounded px-1.5 py-0.5 text-[10px] font-medium bg-teal-500/15 text-teal-400',
      label: 'OpenCode',
    },
    codex: {
      className:
        'rounded px-1.5 py-0.5 text-[10px] font-medium bg-acc/15 text-acc-ink',
      label: 'Codex',
    },
    vibe: {
      className:
        'rounded px-1.5 py-0.5 text-[10px] font-medium bg-purple-500/15 text-purple-300',
      label: 'Mistral Vibe',
    },
  };

type ProjectCreationState = 'source-selection' | 'form';

const setupSteps = [
  {
    id: 'env',
    number: '00',
    phase: 'Prepare',
    title: 'Environment check',
    summary:
      'Jean-Claude checks local tools first, so setup does not fail later.',
    optional: false,
  },
  {
    id: 'agent',
    number: '01',
    phase: 'Agent',
    title: 'Choose backend(s)',
    summary: 'Pick installed command-line agents Jean-Claude can run.',
    optional: false,
  },
  {
    id: 'azure',
    number: '02',
    phase: 'Project',
    title: 'Connect Azure DevOps',
    summary:
      'Optional. Adds clone, pull requests, and work items. Skip it any time.',
    optional: true,
  },
  {
    id: 'project',
    number: '03',
    phase: 'Project',
    title: 'Add project',
    summary:
      'Repository Jean-Claude manages: tasks, worktrees, permissions, defaults.',
    optional: false,
  },
  {
    id: 'run',
    number: '04',
    phase: 'First task',
    title: 'Run first task',
    summary: 'Plan-mode task verifies setup end to end without editing files.',
    optional: false,
  },
] as const;

const setupPhases = [
  { label: 'Prepare', stepIds: ['env'] },
  { label: 'Agent', stepIds: ['agent'] },
  { label: 'Project', stepIds: ['azure', 'project'] },
  { label: 'First task', stepIds: ['run'] },
];

type SetupStepId = (typeof setupSteps)[number]['id'];

function SetupWizardPage() {
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const { data: tasks = [] } = useTasks();
  const { data: providers = [] } = useProviders();
  const { data: backendsSetting } = useBackendsSetting();
  const {
    data: cliStatuses = [],
    isLoading: isLoadingCliStatuses,
    refetch: refetchCliStatuses,
  } = useQuery({
    queryKey: ['agent-cli-status'],
    queryFn: api.shell.getAgentCliStatus,
  });
  const cliStatusByBackend = useMemo(
    () => new Map(cliStatuses.map((item) => [item.backend, item])),
    [cliStatuses],
  );
  const updateBackends = useUpdateBackendsSetting();
  const openOverlay = useOverlaysStore((s) => s.open);
  const setSelectedProjectId = useNewTaskDraftStore(
    (s) => s.setSelectedProjectId,
  );
  const setDraft = useNewTaskDraftStore((s) => s.setDraft);
  const completeSetupWizard = useOnboardingStore((s) => s.completeSetupWizard);
  const setupBackendSelected = useOnboardingStore(
    (s) => s.setupBackendSelected,
  );
  const markSetupBackendSelected = useOnboardingStore(
    (s) => s.markSetupBackendSelected,
  );
  const skipSetupWizard = useOnboardingStore((s) => s.skipSetupWizard);

  const firstProject = projects[0];
  const hasProject = projects.length > 0;
  const defaultBackend = backendsSetting?.defaultBackend ?? null;
  const selectedBackends = backendsSetting?.enabledBackends ?? [];
  const hasSelectedBackend = selectedBackends.length > 0;
  const hasTask = firstProject
    ? tasks.some((task) => task.projectId === firstProject.id)
    : false;
  const [activeStepId, setActiveStepId] = useState<SetupStepId>('env');
  const [envScanned, setEnvScanned] = useState(false);
  const [azureSkipped, setAzureSkipped] = useState(false);
  const hasAzureProvider = providers.some(
    (provider) => provider.type === 'azure-devops',
  );
  const azureDone = azureSkipped || hasAzureProvider;
  const hasInstalledSelectedBackend = selectedBackends.some(
    (backend) => cliStatusByBackend.get(backend)?.installed === true,
  );
  const setupBackendReady = isLoadingCliStatuses
    ? hasSelectedBackend
    : hasInstalledSelectedBackend;
  const completionByStep: Record<SetupStepId, boolean> = {
    env: envScanned,
    agent: setupBackendReady,
    azure: azureDone,
    project: hasProject,
    run: hasTask,
  };
  const completedCount = setupSteps.filter(
    (step) => completionByStep[step.id],
  ).length;
  const requiredSetupDone = hasProject && setupBackendReady;
  const activeStepIndex = Math.max(
    setupSteps.findIndex((step) => step.id === activeStepId),
    0,
  );
  const activeStep = setupSteps[activeStepIndex];

  function isStepReachable(stepIndex: number) {
    return setupSteps
      .slice(0, stepIndex)
      .every((step) => step.optional || completionByStep[step.id]);
  }

  function goNext() {
    if (activeStep.id === 'azure' && !azureDone) setAzureSkipped(true);
    setActiveStepId(
      setupSteps[Math.min(activeStepIndex + 1, setupSteps.length - 1)].id,
    );
  }

  function goBack() {
    setActiveStepId(setupSteps[Math.max(activeStepIndex - 1, 0)].id);
  }

  function handleSkip() {
    window.sessionStorage.setItem('jc-setup-wizard-skipped', '1');
    skipSetupWizard();
    void navigate({ to: '/all' });
  }

  function handleFinish() {
    if (!requiredSetupDone) {
      handleSkip();
      return;
    }
    completeSetupWizard();
    if (firstProject) {
      void navigate({
        to: '/projects/$projectId',
        params: { projectId: firstProject.id },
      });
      return;
    }
    void navigate({ to: '/all' });
  }

  async function handleToggleBackend(backend: AgentBackendType) {
    const cliStatus = cliStatusByBackend.get(backend);
    if (!cliStatus?.installed) return;

    const enabledBackends = backendsSetting?.enabledBackends ?? [];
    const nextEnabledBackends = enabledBackends.includes(backend)
      ? enabledBackends.filter((item) => item !== backend)
      : [...enabledBackends, backend];
    if (nextEnabledBackends.length === 0) return;

    const nextDefaultBackend =
      defaultBackend && nextEnabledBackends.includes(defaultBackend)
      ? defaultBackend
      : nextEnabledBackends[0];

    await updateBackends.mutateAsync({
      enabledBackends: nextEnabledBackends,
      defaultBackend: nextDefaultBackend,
    });
    markSetupBackendSelected();
  }

  async function handleSetDefaultBackend(backend: AgentBackendType) {
    const enabledBackends = backendsSetting?.enabledBackends ?? [];
    if (!enabledBackends.includes(backend)) return;

    await updateBackends.mutateAsync({
      enabledBackends,
      defaultBackend: backend,
    });
    markSetupBackendSelected();
  }

  function handleCreateTask() {
    if (firstProject) {
      const taskBackend = defaultBackend ?? selectedBackends[0];
      setSelectedProjectId(firstProject.id);
      setDraft(firstProject.id, {
        inputMode: 'prompt',
        prompt:
          'Summarize this project and suggest one safe first improvement.',
        interactionMode: 'plan',
        ...(taskBackend ? { agentBackend: taskBackend } : {}),
      });
    }
    openOverlay('new-task');
  }

  useEffect(() => {
    if (isLoadingCliStatuses) return;
    if (!backendsSetting) return;
    if (setupBackendSelected) return;
    if ((backendsSetting.enabledBackends?.length ?? 0) > 0) return;

    const installedBackends = backendOptions
      .map((backend) => backend.id)
      .filter((backend) => cliStatusByBackend.get(backend)?.installed === true);
    if (installedBackends.length === 0) return;

    void updateBackends.mutateAsync({
      enabledBackends: installedBackends,
      defaultBackend: installedBackends[0],
    });
  }, [
    backendsSetting,
    cliStatusByBackend,
    isLoadingCliStatuses,
    setupBackendSelected,
    updateBackends,
  ]);

  return (
    <div className="h-full flex-1 overflow-hidden bg-[radial-gradient(ellipse_900px_560px_at_14%_-10%,color-mix(in_srgb,var(--color-acc)_28%,transparent),transparent_56%),radial-gradient(ellipse_760px_520px_at_110%_116%,color-mix(in_srgb,var(--color-status-done)_18%,transparent),transparent_58%),var(--color-bg-0)]">
      <div className="flex h-full flex-col">
        <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[384px_1fr]">
          <aside className="border-glass-border/70 flex min-h-0 flex-col overflow-y-auto border-r bg-black/20 p-7">
            <div className="mb-3 flex items-center gap-3">
              <div className="text-ink-3 flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] uppercase">
                <Sparkles className="text-acc h-3.5 w-3.5" />
                First run setup
              </div>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={handleSkip}>
                Skip
              </Button>
            </div>
            <h1 className="text-ink-0 mb-3 text-[32px] leading-none font-semibold tracking-[-0.04em]">
              Get Jean-Claude
              <br />
              <span className="text-acc">running.</span>
            </h1>
            <div className="mb-5 flex items-baseline gap-2">
              <span className="text-ink-0 font-mono text-2xl font-bold">
                {completedCount}
                <span className="text-ink-4">/{setupSteps.length}</span>
              </span>
              <span className="text-ink-3 font-mono text-[11px] tracking-[0.1em] uppercase">
                steps complete
              </span>
            </div>

            <div className="space-y-5">
              {setupPhases.map((phase, phaseIndex) => {
                const phaseDone = phase.stepIds.every(
                  (id) => completionByStep[id as SetupStepId],
                );
                const phaseActive = phase.stepIds.includes(activeStep.id);
                return (
                  <section key={phase.label}>
                    <div className="mb-2 flex items-center gap-2">
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-md font-mono text-[10px] font-bold ${
                          phaseDone
                            ? 'bg-acc text-bg-0'
                            : phaseActive
                              ? 'bg-acc/15 text-acc'
                              : 'text-ink-4 bg-white/[0.04]'
                        }`}
                      >
                        {phaseDone ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          phaseIndex + 1
                        )}
                      </span>
                      <span className="text-ink-2 font-mono text-[10px] font-semibold tracking-[0.14em] uppercase">
                        {phase.label}
                      </span>
                      <span className="bg-glass-border h-px flex-1" />
                    </div>
                    <div className="border-glass-border ml-2 space-y-1 border-l pl-3">
                      {phase.stepIds.map((id) => {
                        const step = setupSteps.find((item) => item.id === id)!;
                        const stepIndex = setupSteps.findIndex(
                          (item) => item.id === id,
                        );
                        const done = completionByStep[step.id];
                        const reachable = isStepReachable(stepIndex);
                        return (
                          <button
                            key={step.id}
                            type="button"
                            disabled={!reachable}
                            onClick={() => setActiveStepId(step.id)}
                            className={`group w-full rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                              activeStep.id === step.id
                                ? 'bg-acc/12 text-ink-0'
                                : 'text-ink-3 enabled:hover:bg-white/[0.04]'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`h-2 w-2 rounded-full ${
                                  done
                                    ? 'bg-acc'
                                    : activeStep.id === step.id
                                      ? 'bg-status-run'
                                      : 'bg-ink-4'
                                }`}
                              />
                              <span className="text-xs font-semibold">
                                {step.title}
                              </span>
                              {step.optional && (
                                <span className="text-ink-4 ml-auto text-[10px]">
                                  optional
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </aside>

          <section className="relative min-h-0 overflow-y-auto p-6 sm:p-10">
            <div className="text-ink-0/[0.04] pointer-events-none absolute top-5 right-10 font-mono text-[160px] leading-none font-bold select-none">
              {activeStep.number}
            </div>
            <div className="relative max-w-3xl">
              <div className="mb-7 flex items-start gap-4">
                <div className="bg-acc/15 border-acc/30 text-acc flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border">
                  {getStepIcon(activeStep.id)}
                </div>
                <div>
                  <div className="text-ink-4 mb-1 font-mono text-[11px] tracking-[0.16em] uppercase">
                    Step {activeStep.number} · {activeStep.phase}
                    {activeStep.optional ? ' · Optional' : ' · Required'}
                  </div>
                  <h2 className="text-ink-0 text-3xl leading-none font-semibold tracking-[-0.04em]">
                    {activeStep.title}
                  </h2>
                  <p className="text-ink-2 mt-3 max-w-xl text-sm leading-6">
                    {activeStep.summary}
                  </p>
                </div>
              </div>

              {activeStep.id === 'env' && (
                <EnvironmentStep
                  scanned={envScanned}
                  onScanned={() => setEnvScanned(true)}
                  onRescan={() => {
                    setEnvScanned(false);
                    void refetchCliStatuses();
                  }}
                />
              )}
              {activeStep.id === 'agent' && (
                <AgentStep
                  backends={backendOptions}
                  selectedBackends={selectedBackends}
                  defaultBackend={defaultBackend}
                  cliStatusByBackend={cliStatusByBackend}
                  isLoading={isLoadingCliStatuses}
                  onToggle={handleToggleBackend}
                  onSetDefault={handleSetDefaultBackend}
                />
              )}
              {activeStep.id === 'azure' && (
                <AzureStep
                  connected={hasAzureProvider}
                  skipped={azureSkipped}
                  onSkip={() => setAzureSkipped(true)}
                />
              )}
              {activeStep.id === 'project' && (
                <SetupPanel>
                  {hasProject ? (
                    <div className="mb-4 space-y-2">
                      <div className="text-ink-2 text-xs font-medium">
                        {projects.length}{' '}
                        {projects.length === 1 ? 'project' : 'projects'} added
                      </div>
                      {projects.map((project) => (
                        <div
                          key={project.id}
                          className="border-status-done/20 bg-status-done/10 rounded-xl border p-4"
                        >
                          <div className="text-ink-0 font-semibold">
                            {project.name} ready
                          </div>
                          <div className="text-ink-3 mt-1 truncate font-mono text-xs">
                            {project.path}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <InlineProjectCreator
                    hasProject={hasProject}
                    hasAzureProvider={hasAzureProvider}
                  />
                </SetupPanel>
              )}
              {activeStep.id === 'run' && (
                <FirstTaskStep
                  hasTask={hasTask}
                  onCreateTask={handleCreateTask}
                />
              )}

              <footer className="mt-7 flex flex-wrap items-center gap-3">
                <Button
                  variant="secondary"
                  onClick={goBack}
                  icon={<ArrowLeft />}
                  disabled={activeStepIndex === 0}
                >
                  Back
                </Button>
                {activeStep.id === 'azure' && !azureDone && (
                  <Button variant="ghost" onClick={() => setAzureSkipped(true)}>
                    Skip Azure
                  </Button>
                )}
                <div className="flex-1" />
                <div className="text-ink-4 flex items-center gap-2 text-xs">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Setup never blocks app use
                </div>
                {activeStep.id === 'run' ? (
                  <Button
                    variant="primary"
                    onClick={handleFinish}
                    icon={<Check />}
                  >
                    {requiredSetupDone ? 'Finish setup' : 'Continue later'}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={goNext}
                    disabled={
                      !completionByStep[activeStep.id] && !activeStep.optional
                    }
                  >
                    Continue
                  </Button>
                )}
              </footer>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function getStepIcon(stepId: SetupStepId) {
  const className = 'h-5 w-5';
  if (stepId === 'env') return <Cpu className={className} />;
  if (stepId === 'agent') return <Terminal className={className} />;
  if (stepId === 'azure') return <Cloud className={className} />;
  if (stepId === 'project') return <FolderPlus className={className} />;
  return <Play className={className} />;
}

function SetupPanel({ children }: { children: ReactNode }) {
  return (
    <div className="border-glass-border bg-bg-1/85 rounded-2xl border p-4 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
      {children}
    </div>
  );
}

function SetupNote({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'done' | 'warn' | 'azure';
  children: ReactNode;
}) {
  const classes = {
    default: 'border-glass-border bg-white/[0.04] text-ink-2',
    done: 'border-status-done/20 bg-status-done/10 text-status-done',
    warn: 'border-status-run/20 bg-status-run/10 text-status-run',
    azure: 'border-status-azure/20 bg-status-azure/10 text-status-azure',
  }[tone];
  return (
    <div className={`rounded-xl border p-3 text-sm leading-6 ${classes}`}>
      {children}
    </div>
  );
}

function EnvironmentStep({
  scanned,
  onScanned,
  onRescan,
}: {
  scanned: boolean;
  onScanned: () => void;
  onRescan: () => void;
}) {
  const rows = [
    {
      id: 'git',
      label: 'Git',
      detail: 'Required for worktrees and diffs',
      status: 'ok' as const,
    },
  ];

  useEffect(() => {
    if (scanned) return;
    const timeout = window.setTimeout(onScanned, 500);
    return () => window.clearTimeout(timeout);
  }, [onScanned, scanned]);

  return (
    <SetupPanel>
      <SetupNote tone="warn">
        Jean-Claude checks required local tools first. Agent CLIs are checked in
        the backend step.
      </SetupNote>
      <div className="mt-4 space-y-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className="border-glass-border bg-bg-1/60 flex items-start gap-3 rounded-xl border p-3"
          >
            <div
              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                row.status === 'ok'
                  ? 'bg-status-done/10 text-status-done'
                  : 'bg-status-run/10 text-status-run'
              }`}
            >
              {row.status === 'ok' ? (
                <Check className="h-4 w-4" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-ink-0 text-sm font-semibold">
                {row.label}
              </div>
              <div className="text-ink-3 mt-1 font-mono text-xs">
                {row.detail}
              </div>
            </div>
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                row.status === 'ok'
                  ? 'border-status-done/20 bg-status-done/10 text-status-done'
                  : 'border-status-run/20 bg-status-run/10 text-status-run'
              }`}
            >
              {row.status === 'ok' ? 'ready' : 'optional'}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-4">
        {scanned ? (
          <div className="border-glass-border text-ink-2 flex flex-wrap items-center gap-3 rounded-xl border bg-black/20 px-4 py-3 text-xs">
            <Cpu className="text-acc h-4 w-4" />
            Environment scan complete.
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw />}
              onClick={onRescan}
            >
              Retry scan
            </Button>
          </div>
        ) : (
          <SetupNote>Scanning environment...</SetupNote>
        )}
      </div>
    </SetupPanel>
  );
}

function AgentStep({
  backends,
  selectedBackends,
  defaultBackend,
  cliStatusByBackend,
  isLoading,
  onToggle,
  onSetDefault,
}: {
  backends: typeof backendOptions;
  selectedBackends: AgentBackendType[];
  defaultBackend: AgentBackendType | null;
  cliStatusByBackend: Map<
    AgentBackendType,
    Awaited<ReturnType<typeof api.shell.getAgentCliStatus>>[number]
  >;
  isLoading: boolean;
  onToggle: (backend: AgentBackendType) => Promise<void>;
  onSetDefault: (backend: AgentBackendType) => Promise<void>;
}) {
  return (
    <SetupPanel>
      <SetupNote>
        Backend is local CLI Jean-Claude drives for coding sessions. Pick at
        least one installed backend; enable more anytime in settings.
      </SetupNote>
      <div className="mt-4 grid gap-3">
        {backends.map((backend) => {
          const selected = selectedBackends.includes(backend.id);
          const cliStatus = cliStatusByBackend.get(backend.id);
          const installed = cliStatus?.installed === true;
          const disabled = isLoading || !installed;
          return (
            <div
              key={backend.id}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-disabled={disabled}
              onClick={() => void onToggle(backend.id)}
              onKeyDown={(event) => {
                if (disabled) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                void onToggle(backend.id);
              }}
              className={`rounded-xl border p-4 text-left transition-colors ${
                selected
                  ? 'border-acc/50 bg-acc/10 text-ink-0 shadow-[inset_3px_0_0_var(--color-acc)]'
                  : 'border-glass-border text-ink-2 bg-white/[0.025] hover:bg-white/[0.05]'
              } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${
                    selected
                      ? 'border-acc bg-acc text-bg-0'
                      : 'border-white/15 bg-white/[0.04] text-transparent'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-ink-0 text-sm font-semibold">
                      {backend.name}
                    </span>
                    {backend.id === defaultBackend && selected ? (
                      <span className="text-acc bg-acc/10 rounded px-1.5 py-0.5 font-mono text-[10px]">
                        default
                      </span>
                    ) : null}
                    {selected && backend.id !== defaultBackend ? (
                      <button
                        type="button"
                        className="text-ink-2 hover:text-ink-0 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] transition-colors"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onSetDefault(backend.id);
                        }}
                      >
                        set default
                      </button>
                    ) : null}
                    <span className="flex-1" />
                    <span
                      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                        installed
                          ? 'border-status-done/20 bg-status-done/10 text-status-done'
                          : 'border-status-run/20 bg-status-run/10 text-status-run'
                      }`}
                    >
                      {isLoading
                        ? 'checking'
                        : installed
                          ? `${cliStatus.command} ready`
                          : 'missing'}
                    </span>
                  </div>
                  <div className="text-ink-3 text-xs leading-5">
                    {backend.detail}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </SetupPanel>
  );
}
function AzureStep({
  connected,
  skipped,
  onSkip,
}: {
  connected: boolean;
  skipped: boolean;
  onSkip: () => void;
}) {
  const { data: providers = [] } = useProviders();
  const validateToken = useValidateAzureDevOpsToken();
  const createToken = useCreateToken();
  const createProvider = useCreateProvider();
  const [label, setLabel] = useState('Azure DevOps PAT');
  const [token, setToken] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [organizations, setOrganizations] = useState<AzureDevOpsOrganization[]>(
    [],
  );
  const [selectedOrgIds, setSelectedOrgIds] = useState<Set<string>>(new Set());
  const [validatedToken, setValidatedToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const existingOrgUrls = useMemo(
    () =>
      new Set(
        providers
          .filter((provider) => provider.type === 'azure-devops')
          .map((provider) => provider.baseUrl),
      ),
    [providers],
  );
  const selectedOrganizations = organizations.filter((org) =>
    selectedOrgIds.has(org.id),
  );
  const isValidating = validateToken.isPending;
  const isConnecting = createToken.isPending || createProvider.isPending;

  const validateAzureToken = useCallback(async (tokenValue: string) => {
    setError(null);

    try {
      const orgs = await validateToken.mutateAsync(tokenValue);
      const newOrgs = orgs.filter((org) => !existingOrgUrls.has(org.url));

      if (newOrgs.length === 0) {
        setOrganizations([]);
        setSelectedOrgIds(new Set());
        setValidatedToken(tokenValue);
        setError('All accessible Azure DevOps organizations are already connected.');
        return;
      }

      setOrganizations(newOrgs);
      setSelectedOrgIds(new Set(newOrgs.map((org) => org.id)));
      setValidatedToken(tokenValue);
    } catch (err) {
      setOrganizations([]);
      setSelectedOrgIds(new Set());
      setValidatedToken(tokenValue);
      setError(
        err instanceof Error ? err.message : 'Failed to validate Azure token',
      );
    }
  }, [existingOrgUrls, validateToken]);

  useEffect(() => {
    const trimmedToken = token.trim();
    if (!trimmedToken) return;
    if (trimmedToken === validatedToken) return;

    const timeout = window.setTimeout(() => {
      void validateAzureToken(trimmedToken);
    }, 650);

    return () => window.clearTimeout(timeout);
  }, [token, validatedToken, validateAzureToken]);

  async function handleConnect() {
    if (selectedOrganizations.length === 0) return;
    setError(null);

    try {
      const createdToken = await createToken.mutateAsync({
        label: label.trim() || 'Azure DevOps PAT',
        token: token.trim(),
        providerType: 'azure-devops',
        expiresAt: expiresAt || null,
        updatedAt: new Date().toISOString(),
      });

      for (const org of selectedOrganizations) {
        await createProvider.mutateAsync({
          type: 'azure-devops',
          label: org.name,
          baseUrl: org.url,
          tokenId: createdToken.id,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect Azure');
    }
  }

  function toggleOrg(orgId: string) {
    setSelectedOrgIds((prev) => {
      const next = new Set(prev);
      if (next.has(orgId)) next.delete(orgId);
      else next.add(orgId);
      return next;
    });
  }

  return (
    <SetupPanel>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          ['Clone repositories', 'Pull repos into managed projects.'],
          ['Create pull requests', 'Open and update PRs from finished tasks.'],
          ['Link work items', 'Attach work item context to PRs.'],
          ['Update work states', 'Move work across boards as tasks land.'],
        ].map(([title, body]) => (
          <div
            key={title}
            className="border-glass-border bg-bg-1/60 rounded-xl border p-3"
          >
            <div className="text-ink-0 text-sm font-semibold">{title}</div>
            <div className="text-ink-3 mt-1 text-xs leading-5">{body}</div>
          </div>
        ))}
      </div>
      <div className="mt-4">
        {connected ? (
          <SetupNote tone="done">
            Azure DevOps organization connected. You can clone Azure repos in the
            next step.
          </SetupNote>
        ) : skipped ? (
          <SetupNote>
            Azure skipped. You can clone from Azure in project setup or settings
            later.
          </SetupNote>
        ) : (
          <div className="space-y-4">
            <div className="border-status-azure/20 bg-status-azure/10 rounded-xl border p-3">
              <div className="text-status-azure text-sm font-semibold">
                Create Azure DevOps PAT
              </div>
              <div className="text-ink-2 mt-2 grid gap-2 text-xs leading-5 sm:grid-cols-3">
                <div>
                  <span className="text-ink-0 font-medium">1. Open Azure</span>
                  <br />
                  User settings → Personal access tokens → New Token.
                </div>
                <div>
                  <span className="text-ink-0 font-medium">2. Set access</span>
                  <br />
                  Organization: accessible orgs. Expiration: your choice.
                </div>
                <div>
                  <span className="text-ink-0 font-medium">3. Add scopes</span>
                  <br />
                  Use these scopes so Jean-Claude can connect repos, PRs, and
                  work items.
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                {[
                  ['Project & Team: Read', 'List projects and teams.'],
                  ['Code: Read & Write', 'Read repos, create PRs, comment, vote.'],
                  ['Work Items: Read & Write', 'Search, link, comment, update states.'],
                  ['Graph: Read', 'Resolve users and reviewer mentions.'],
                ].map(([scope, reason]) => (
                  <div
                    key={scope}
                    className="border-status-azure/15 bg-scrim/15 rounded-lg border px-3 py-2"
                  >
                    <div className="text-status-azure font-medium">{scope}</div>
                    <div className="text-ink-3 mt-0.5 leading-5">{reason}</div>
                  </div>
                ))}
              </div>
              <div className="border-status-azure/15 text-ink-3 bg-scrim/10 mt-2 rounded-lg border px-3 py-2 text-xs leading-5">
                Optional: add Build Execute and Release Execute only if you want
                Jean-Claude to queue, cancel, or create pipeline and release runs.
              </div>
              <div className="text-ink-3 mt-3 rounded-lg bg-black/10 px-3 py-2 text-xs leading-5">
                Direct token page format:{' '}
                <span className="text-ink-1 font-mono">
                  https://dev.azure.com/&lt;your-org&gt;/_usersSettings/tokens
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-3">
                <a
                  href="https://dev.azure.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-acc-ink inline-flex items-center gap-1 text-xs hover:underline"
                >
                  Open Azure DevOps
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
                <a
                  href="https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-3 hover:text-acc-ink inline-flex items-center gap-1 text-xs hover:underline"
                >
                  Microsoft PAT guide
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="azure-token-label"
                  className="text-ink-1 mb-1 block text-sm font-medium"
                >
                  Token label
                </label>
                <Input
                  id="azure-token-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Work Azure PAT"
                  autoComplete="off"
                />
              </div>
              <div>
                <label
                  htmlFor="azure-token-expiration"
                  className="text-ink-1 mb-1 block text-sm font-medium"
                >
                  Expiration date optional
                </label>
                <Input
                  id="azure-token-expiration"
                  type="date"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <label
                  htmlFor="azure-token"
                  className="text-ink-1 mb-1 block text-sm font-medium"
                >
                  Personal access token
                </label>
                <Input
                  id="azure-token"
                  type="password"
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                    setOrganizations([]);
                    setSelectedOrgIds(new Set());
                    setValidatedToken('');
                  }}
                  placeholder="Paste Azure DevOps PAT"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <div className="text-ink-3 flex items-center gap-2 text-xs">
                  {isValidating ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Checking token...
                    </>
                  ) : organizations.length > 0 ? (
                    <>
                      <Check className="text-status-done h-3.5 w-3.5" />
                      Organizations found and selected.
                    </>
                  ) : (
                    'Paste a PAT to find organizations automatically.'
                  )}
                </div>
                <Button type="button" variant="ghost" onClick={onSkip}>
                  Skip Azure for now
                </Button>
              </div>
            </div>

            {organizations.length > 0 && (
              <div className="border-glass-border bg-bg-1/60 rounded-xl border p-3">
                <div className="text-ink-0 text-sm font-semibold">
                  Select organizations
                </div>
                <div className="mt-3 space-y-2">
                  {organizations.map((org) => (
                    <label
                      key={org.id}
                      className="border-glass-border bg-bg-2/60 flex cursor-pointer items-start gap-3 rounded-lg border p-3"
                    >
                      <input
                        type="checkbox"
                        checked={selectedOrgIds.has(org.id)}
                        onChange={() => toggleOrg(org.id)}
                        className="mt-1"
                      />
                      <span>
                        <span className="text-ink-0 block text-sm font-medium">
                          {org.name}
                        </span>
                        <span className="text-ink-3 block text-xs">
                          {org.url}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <Button
                  className="mt-3"
                  variant="primary"
                  onClick={handleConnect}
                  disabled={selectedOrgIds.size === 0 || isConnecting}
                  loading={isConnecting}
                >
                  Connect Azure DevOps
                </Button>
              </div>
            )}

            {error && (
              <div className="bg-status-fail/10 text-status-fail border-status-fail/50 rounded-lg border px-3 py-2 text-sm">
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    </SetupPanel>
  );
}

function FirstTaskStep({
  hasTask,
  onCreateTask,
}: {
  hasTask: boolean;
  onCreateTask: () => void;
}) {
  return (
    <SetupPanel>
      <SetupNote>
        Start with read-only plan prompt: summarize project and suggest one safe
        improvement. Plan mode asks before file edits.
      </SetupNote>
      <div className="text-ink-2 mt-4 rounded-xl border border-white/10 bg-black/20 p-4 font-mono text-xs">
        <div className="text-ink-4 mb-2">Starter prompt</div>
        Summarize this project and suggest one safe first improvement.
      </div>
      <div className="mt-4">
        {hasTask ? (
          <SetupNote tone="done">
            First task exists. Setup can finish.
          </SetupNote>
        ) : (
          <Button variant="accent" icon={<Play />} onClick={onCreateTask}>
            New first task
          </Button>
        )}
      </div>
    </SetupPanel>
  );
}

function InlineProjectCreator({
  hasProject,
  hasAzureProvider,
}: {
  hasProject: boolean;
  hasAzureProvider: boolean;
}) {
  const createProject = useCreateProject();
  const uploadProjectLogo = useUploadProjectLogo();
  const [isOpen, setIsOpen] = useState(!hasProject);
  const [creationState, setCreationState] =
    useState<ProjectCreationState>('source-selection');
  const [formData, setFormData] = useState<ProjectFormData | null>(null);
  const [showClonePane, setShowClonePane] = useState(false);
  const [isFromClone, setIsFromClone] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [protectedBranches, setProtectedBranches] = useState<string[]>([]);

  const { data: detectedProjects = [], isLoading: isLoadingDetected } =
    useQuery({
      queryKey: ['detected-projects'],
      queryFn: () => api.projects.getDetected(),
      enabled: isOpen && creationState === 'source-selection',
    });

  const filteredProjects = detectedProjects.filter((project) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      project.name.toLowerCase().includes(query) ||
      project.path.toLowerCase().includes(query) ||
      project.displayPath.toLowerCase().includes(query)
    );
  });

  const hasDetectedProjects = detectedProjects.length > 0;
  const {
    data: branchInfos = [],
    isError: branchesError,
    isLoading: branchesLoading,
  } = useQuery({
    queryKey: ['project-branches-for-path', formData?.path],
    queryFn: () => api.projects.getBranchesForPath(formData?.path ?? ''),
    enabled: creationState === 'form' && !!formData?.path,
    retry: false,
  });
  const branches = useMemo(
    () => branchInfos.map((branch) => branch.name),
    [branchInfos],
  );
  const preferredBranch =
    branches.find((branch) => branch === 'main') ??
    branches.find((branch) => branch === 'master') ??
    branches[0] ??
    '';
  const effectiveDefaultBranch = defaultBranch || preferredBranch;
  const effectiveProtectedBranches =
    protectedBranches.length > 0
      ? protectedBranches
      : effectiveDefaultBranch
        ? [effectiveDefaultBranch]
        : [];

  async function handleSelectLocalFolder() {
    const selectedPath = await api.dialog.openDirectory();
    if (!selectedPath) return;

    setFormData({
      name: await inferProjectName(selectedPath),
      path: selectedPath,
      color: getRandomColor(),
      selectedLogoPath: await getDefaultLogoPath(selectedPath),
      repoProviderId: null,
      repoProjectId: null,
      repoProjectName: null,
      repoId: null,
      repoName: null,
      workItemProviderId: null,
      workItemProjectId: null,
      workItemProjectName: null,
    });
    setIsFromClone(false);
    setDefaultBranch('');
    setProtectedBranches([]);
    setCreationState('form');
  }

  async function handleSelectDetectedProject(project: DetectedProject) {
    setFormData({
      name: await inferProjectName(project.path),
      path: project.path,
      color: getRandomColor(),
      selectedLogoPath: await getDefaultLogoPath(project.path),
      repoProviderId: null,
      repoProjectId: null,
      repoProjectName: null,
      repoId: null,
      repoName: null,
      workItemProviderId: null,
      workItemProjectId: null,
      workItemProjectName: null,
    });
    setIsFromClone(false);
    setDefaultBranch('');
    setProtectedBranches([]);
    setCreationState('form');
  }

  async function handleCloneSuccess(result: CloneResult) {
    setShowClonePane(false);
    setFormData({
      name: result.repoName,
      path: result.path,
      color: getRandomColor(),
      selectedLogoPath: await getDefaultLogoPath(result.path),
      repoProviderId: result.repoProviderId,
      repoProjectId: result.repoProjectId,
      repoProjectName: result.repoProjectName,
      repoId: result.repoId,
      repoName: result.repoName,
      workItemProviderId: result.repoProviderId,
      workItemProjectId: result.repoProjectId,
      workItemProjectName: result.repoProjectName,
    });
    setIsFromClone(true);
    setDefaultBranch('');
    setProtectedBranches([]);
    setCreationState('form');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formData) return;

    const project = await createProject.mutateAsync({
      name: formData.name,
      path: formData.path,
      type: 'local',
      color: formData.color,
      repoProviderId: formData.repoProviderId,
      repoProjectId: formData.repoProjectId,
      repoProjectName: formData.repoProjectName,
      repoId: formData.repoId,
      repoName: formData.repoName,
      workItemProviderId: formData.workItemProviderId,
      workItemProjectId: formData.workItemProjectId,
      workItemProjectName: formData.workItemProjectName,
      defaultBranch: effectiveDefaultBranch || null,
      protectedBranches: effectiveProtectedBranches,
      updatedAt: new Date().toISOString(),
    });

    if (formData.selectedLogoPath) {
      try {
        await uploadProjectLogo.mutateAsync({
          projectId: project.id,
          sourcePath: formData.selectedLogoPath,
        });
      } catch {
        // Project creation should still succeed if detected logo copy fails.
      }
    }

    setFormData(null);
    setCreationState('source-selection');
    setIsFromClone(false);
    setDefaultBranch('');
    setProtectedBranches([]);
    setIsOpen(false);
  }

  function handleFormChange(updates: Partial<ProjectFormData>) {
    if (!formData) return;
    setFormData({ ...formData, ...updates });
  }

  function handleBack() {
    setCreationState('source-selection');
    setFormData(null);
    setIsFromClone(false);
    setDefaultBranch('');
    setProtectedBranches([]);
  }

  if (!isOpen) {
    return (
      <Button
        variant="secondary"
        size="sm"
        icon={<FolderPlus />}
        onClick={() => setIsOpen(true)}
      >
        Add another project
      </Button>
    );
  }

  if (creationState === 'form' && formData) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            icon={<ArrowLeft />}
          >
            Back
          </Button>
          <div className="text-ink-3 text-xs">
            {isFromClone
              ? 'Configure cloned project'
              : 'Configure local project'}
          </div>
        </div>
        <div className="border-glass-border bg-bg-1/30 space-y-3 rounded-xl border p-3">
          <div>
            <div className="text-ink-1 text-sm font-medium">Branch setup</div>
            <p className="text-ink-3 mt-1 text-xs leading-5">
              Pick default merge branch and protected branches before first
              task.
            </p>
          </div>
          {branchesError ? (
            <p className="text-ink-3 text-xs">
              No Git branches detected for this folder. You can finish project
              creation and adjust branches later in project settings.
            </p>
          ) : (
            <>
              <div>
                <label className="text-ink-1 mb-1 block text-sm font-medium">
                  Default merge branch
                </label>
                <Select
                  value={branchesLoading ? '' : effectiveDefaultBranch}
                  options={
                    branchesLoading
                      ? [{ value: '', label: 'Loading...' }]
                      : branches.length === 0
                        ? [{ value: '', label: 'No branches found' }]
                        : branches.map((branch) => ({
                            value: branch,
                            label: branch,
                          }))
                  }
                  onChange={setDefaultBranch}
                  disabled={branchesLoading || branches.length === 0}
                  className="w-full justify-between"
                />
              </div>
              <ProtectedBranchesInput
                branches={branches}
                branchesLoading={branchesLoading}
                protectedBranches={effectiveProtectedBranches}
                onChange={setProtectedBranches}
              />
            </>
          )}
        </div>
        <AddProjectForm
          formData={formData}
          onChange={handleFormChange}
          onSubmit={handleSubmit}
          isSubmitting={createProject.isPending}
          repoSectionExpanded={isFromClone}
          workItemSectionExpanded={false}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="accent"
          size="sm"
          onClick={handleSelectLocalFolder}
          icon={<Folder />}
        >
          Local folder
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowClonePane(true)}
          icon={<GitBranch />}
          disabled={!hasAzureProvider}
        >
          Clone from Azure DevOps
        </Button>
      </div>

      {!hasAzureProvider && (
        <SetupNote tone="warn">
          Connect Azure DevOps first to clone Azure repositories. Local folders
          still work without Azure.
        </SetupNote>
      )}

      {hasDetectedProjects && (
        <Input
          size="sm"
          icon={<Search />}
          aria-label="Filter detected projects"
          placeholder="Filter detected projects..."
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
      )}

      {(isLoadingDetected || hasDetectedProjects) && (
        <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {isLoadingDetected &&
            [0, 1, 2, 3].map((item) => (
              <div
                key={item}
                className="bg-bg-1/50 h-20 animate-pulse rounded-lg"
              />
            ))}

          {!isLoadingDetected &&
            filteredProjects.map((project) => (
              <button
                key={project.path}
                type="button"
                aria-label={`Add project: ${project.name}`}
                onClick={() => void handleSelectDetectedProject(project)}
                className="bg-bg-1/50 hover:border-glass-border hover:bg-glass-light border-glass-border flex min-h-20 w-full cursor-pointer flex-col items-start rounded-lg border p-3 text-left transition-colors"
              >
                <div className="flex max-w-full items-center gap-1.5 overflow-hidden">
                  <FolderOpen className="text-ink-3 h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-sm font-medium">
                    {project.name}
                  </span>
                </div>
                {project.sources.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {project.sources.map((source) => {
                      const badge = sourceBadgeConfig[source];
                      if (!badge) return null;
                      return (
                        <span key={source} className={badge.className}>
                          {badge.label}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="text-ink-3 mt-auto w-full truncate text-xs">
                  {project.displayPath}
                </div>
              </button>
            ))}

          {!isLoadingDetected &&
            hasDetectedProjects &&
            filteredProjects.length === 0 && (
              <p className="text-ink-3 py-6 text-center text-sm sm:col-span-2">
                No projects match &ldquo;{searchQuery}&rdquo;
              </p>
            )}
        </div>
      )}

      {showClonePane && hasAzureProvider && (
        <div className="border-glass-border bg-bg-1/40 rounded-xl border">
          <CloneRepoPane
            onClose={() => setShowClonePane(false)}
            onCloneSuccess={(result) => void handleCloneSuccess(result)}
          />
        </div>
      )}
    </div>
  );
}

async function inferProjectName(folderPath: string): Promise<string> {
  const pkg = await api.fs.readPackageJson(folderPath);
  if (pkg?.name) return pkg.name;
  return folderPath.split(/[/\\]/).pop() || 'Untitled';
}

async function getDefaultLogoPath(projectPath: string): Promise<string | null> {
  const logos = await api.projects.detectLogos(projectPath);
  return logos[0]?.path ?? null;
}
