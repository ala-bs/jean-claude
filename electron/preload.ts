import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type {
  AddGitHubSourceParams,
  InstallSourceItemsParams,
  UpdateSourceInstallParams,
} from '@shared/source-management-types';
import type {
  AgentMemoryCaptureWarning,
  AgentMemoryDashboard,
  AgentMemoryExtractionRun,
  AgentMemoryFollowUpCapture,
  AgentMemoryPromptCapture,
  AgentMemoryQueuedPromptCapture,
} from '@shared/agent-memory-types';
import type {
  AppNotification,
  TaskNotificationTarget,
} from '@shared/notification-types';
import type { CacheEvent, CacheSubscriptionUpdate } from '@shared/cache-events';
import type {
  GetYamlParametersIpcParams,
  QueueBuildIpcParams,
} from '@shared/pipeline-types';
import type {
  GlobalPrompt,
  GlobalPromptResponse,
} from '@shared/global-prompt-types';
import type {
  MobileColorScheme,
  MobilePlatform,
  MobilePreviewAndroidAppRestartParams,
  MobilePreviewAndroidAppStatusParams,
  MobilePreviewAndroidCreateDeviceParams,
  MobilePreviewAndroidInstallSystemImageParams,
  MobilePreviewAttachSessionParams,
  MobilePreviewBootDeviceParams,
  MobilePreviewCaptureScreenshotParams,
  MobilePreviewDetachSessionParams,
  MobilePreviewExpoLaunchParams,
  MobilePreviewForwardPortParams,
  MobilePreviewFrameEvent,
  MobilePreviewInputEvent,
  MobilePreviewIosAppRequestParams,
  MobilePreviewIosAppStatusCancelParams,
  MobilePreviewIosAppStatusRequestParams,
  MobilePreviewIosCreateDeviceParams,
  MobilePreviewIosRenameDeviceParams,
  MobilePreviewListMetroPeersParams,
  MobilePreviewListSessionsParams,
  MobilePreviewNativeLogEvent,
  MobilePreviewNativeLogSessionEvent,
  MobilePreviewNativeLogStartParams,
  MobilePreviewOpenDeeplinkParams,
  MobilePreviewOpenDevMenuParams,
  MobilePreviewReloadExpoParams,
  MobilePreviewSessionEvent,
  MobilePreviewSetTextSizeParams,
  MobilePreviewStartParams,
  MobilePreviewWaitForMetroClientParams,
  MobileRotationDirection,
  ReactNativeDevToolsEmbeddedBoundsParams,
  ReactNativeDevToolsEmbeddedCloseParams,
  ReactNativeDevToolsEmbeddedOpenParams,
  ReactNativeDevToolsEmbeddedReloadParams,
  ReactNativeDevToolsEmbeddedVisibilityParams,
  ReactNativeDevToolsOpenParams,
  ReactNativeDevToolsResolveParams,
} from '@shared/mobile-simulator-types';
import type {
  NewWorkActivityEvent,
  WorkActivityWeekParams,
} from '@shared/work-activity-types';
import {
  RUN_COMMAND_GROUP_ABORT_CHANNEL,
  type RunCommandGroupAbortEvent,
  START_PR_COMMAND_CHANNEL,
  type StartPrCommandParams,
} from '@shared/run-command-types';
import {
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from '@shared/terminal-types';
import type {
  TimesheetAction,
  TimesheetAxisLookupRequest,
  TimesheetDraftParams,
  TimesheetEntryInput,
  TimesheetProviderType,
  TimesheetRowDeletion,
  TimesheetRowUpdate,
  TimesheetSyncParams,
} from '@shared/timesheet-types';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { AGENT_CHANNELS } from '@shared/agent-types';
import type { AiUsageDashboardParams } from '@shared/ai-usage-types';
import type { CreateWorkItemVerificationNoteParams } from '@shared/work-item-verification-note-types';
import type { DebugLogEntry } from '@shared/debug-log-types';
import type { ProjectGitLogFilter } from '@shared/types';
import type { StartAdHocRunCommandParams } from '@shared/run-command-types';

const devBadgeLabel = process.env.JC_DEV_BADGE_LABEL?.trim() || undefined;

// A slow IPC round trip can be caused by its handler, a blocked main loop, or
// a blocked renderer loop. Log the channel only; arguments may contain secrets.
function invokeWithDiagnostics(channel: string, ...args: unknown[]) {
  const startedAt = performance.now();
  return Promise.resolve(ipcRenderer.invoke(channel, ...args)).finally(() => {
    const elapsed = performance.now() - startedAt;
    if (elapsed >= 500 && channel !== 'debug:log') {
      const message = `IPC ${channel} took ${Math.round(elapsed)} ms`;
      console.warn(`[performance] ${message}`);
      void ipcRenderer.invoke('debug:log', { scope: 'performance', message }).catch(() => {});
    }
  });
}

let lastRendererLoopTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const delay = now - lastRendererLoopTick - 100;
  lastRendererLoopTick = now;
  if (delay >= 250) {
    const message = `Renderer event loop delayed by ${Math.round(delay)} ms`;
    console.warn(`[performance] ${message}`);
    void ipcRenderer.invoke('debug:log', { scope: 'performance', message }).catch(() => {});
  }
}, 100);

/**
 * Whether this Chromium profile already had a localStorage bucket before this
 * launch, sampled by the main process (see `hasExistingLocalStorageBucket`) and
 * passed via `webPreferences.additionalArguments`.
 *
 * `false` means a genuine first run for this profile, so an empty localStorage
 * is expected rather than a failed read. Defaults to `true` when the argument is
 * missing: assuming "the bucket existed" makes the renderer's boot guard treat
 * an empty read as suspicious, which is the safe direction to be wrong in.
 */
const hasExistingLocalStorageBucket = !process.argv.includes(
  '--jc-local-storage-bucket=absent',
);

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  windowState: {
    getIsFullscreen: () => invokeWithDiagnostics('windowState:getIsFullscreen'),
    onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
      const handler = (_: unknown, isFullscreen: boolean) =>
        callback(isFullscreen);
      ipcRenderer.on('windowState:fullscreen-changed', handler);
      return () =>
        ipcRenderer.removeListener('windowState:fullscreen-changed', handler);
    },
  },
  cache: {
    setSubscriptions: (update: CacheSubscriptionUpdate) =>
      invokeWithDiagnostics('cache:setSubscriptions', update),
    onEvent: (callback: (event: CacheEvent) => void) => {
      const handler = (_: unknown, event: CacheEvent) => callback(event);
      ipcRenderer.on('cache:event', handler);
      return () => ipcRenderer.removeListener('cache:event', handler);
    },
  },
  projects: {
    findAll: () => invokeWithDiagnostics('projects:findAll'),
    listEnvVars: (projectId: string) =>
      invokeWithDiagnostics('projects:listEnvVars', projectId),
    createEnvVar: (data: unknown) =>
      invokeWithDiagnostics('projects:createEnvVar', data),
    updateEnvVar: (id: string, data: unknown) =>
      invokeWithDiagnostics('projects:updateEnvVar', id, data),
    deleteEnvVar: (id: string) =>
      invokeWithDiagnostics('projects:deleteEnvVar', id),
    isSecretStorageAvailable: () =>
      invokeWithDiagnostics('projects:isSecretStorageAvailable'),
    findById: (id: string) => invokeWithDiagnostics('projects:findById', id),
    getEffectivePolicy: (projectId: string) =>
      invokeWithDiagnostics('projects:getEffectivePolicy', projectId),
    setModelPolicy: (projectId: string, policy: unknown) =>
      invokeWithDiagnostics('projects:setModelPolicy', projectId, policy),
    create: (data: unknown) => invokeWithDiagnostics('projects:create', data),
    update: (id: string, data: unknown) =>
      invokeWithDiagnostics('projects:update', id, data),
    detectMobilePreview: (projectId: string) =>
      invokeWithDiagnostics('projects:detectMobilePreview', projectId),
    detectAzureRemote: (projectPath: string) =>
      invokeWithDiagnostics('projects:detectAzureRemote', projectPath),
    uploadLogo: (projectId: string, sourcePath: string) =>
      invokeWithDiagnostics('projects:uploadLogo', projectId, sourcePath),
    generateLogo: (projectId: string, customPrompt?: string) =>
      invokeWithDiagnostics('projects:generateLogo', projectId, customPrompt),
    listGeneratedLogos: (projectId: string) =>
      invokeWithDiagnostics('projects:listGeneratedLogos', projectId),
    selectGeneratedLogo: (projectId: string, logoId: string) =>
      invokeWithDiagnostics('projects:selectGeneratedLogo', projectId, logoId),
    deleteGeneratedLogo: (projectId: string, logoId: string) =>
      invokeWithDiagnostics('projects:deleteGeneratedLogo', projectId, logoId),
    regenerateSummary: (projectId: string) =>
      invokeWithDiagnostics('projects:regenerateSummary', projectId),
    getFeatureMap: (projectId: string) =>
      invokeWithDiagnostics('projects:getFeatureMap', projectId),
    createFeatureMapTask: (projectId: string) =>
      invokeWithDiagnostics('projects:createFeatureMapTask', projectId),
    getFeatureMapDraftDiff: (stepId: string) =>
      invokeWithDiagnostics('projects:getFeatureMapDraftDiff', stepId),
    saveFeatureMapFromTask: (stepId: string) =>
      invokeWithDiagnostics('projects:saveFeatureMapFromTask', stepId),
    removeLogo: (projectId: string) =>
      invokeWithDiagnostics('projects:removeLogo', projectId),
    delete: (id: string) => invokeWithDiagnostics('projects:delete', id),
    deleteWorktreesFolder: (projectId: string) =>
      invokeWithDiagnostics('projects:deleteWorktreesFolder', projectId),
    reorder: (orderedIds: string[]) =>
      invokeWithDiagnostics('projects:reorder', orderedIds),
    getBranches: (projectId: string) =>
      invokeWithDiagnostics('projects:getBranches', projectId),
    getBranchesForPath: (projectPath: string) =>
      invokeWithDiagnostics('projects:getBranchesForPath', projectPath),
    getCurrentBranch: (projectId: string) =>
      invokeWithDiagnostics('projects:getCurrentBranch', projectId),
    isGitRepository: (projectId: string) =>
      invokeWithDiagnostics('projects:isGitRepository', projectId),
    git: {
      getStatus: (projectId: string) =>
        invokeWithDiagnostics('projects:git:getStatus', projectId),
      getGraph: (
        projectId: string,
        limit?: number,
        skip?: number,
        filter?: ProjectGitLogFilter,
      ) =>
        invokeWithDiagnostics(
          'projects:git:getGraph',
          projectId,
          limit,
          skip,
          filter,
        ),
      getCommitCount: (projectId: string, filter?: ProjectGitLogFilter) =>
        invokeWithDiagnostics('projects:git:getCommitCount', projectId, filter),
      getCommitDetail: (projectId: string, commitHash: string) =>
        invokeWithDiagnostics('projects:git:getCommitDetail', projectId, commitHash),
      getCommitFileContent: (
        projectId: string,
        commitHash: string,
        filePath: string,
      ) =>
        invokeWithDiagnostics(
          'projects:git:getCommitFileContent',
          projectId,
          commitHash,
          filePath,
        ),
      getWorkingTreeFiles: (projectId: string) =>
        invokeWithDiagnostics('projects:git:getWorkingTreeFiles', projectId),
      fetch: (projectId: string, interactive?: boolean) =>
        invokeWithDiagnostics('projects:git:fetch', projectId, interactive),
      push: (projectId: string) =>
        invokeWithDiagnostics('projects:git:push', projectId),
      pull: (projectId: string) =>
        invokeWithDiagnostics('projects:git:pull', projectId),
      checkoutBranch: (projectId: string, branchName: string) =>
        invokeWithDiagnostics('projects:git:checkoutBranch', projectId, branchName),
      init: (projectId: string) =>
        invokeWithDiagnostics('projects:git:init', projectId),
    },
    getCommitIgnore: (projectId: string) =>
      invokeWithDiagnostics('projects:getCommitIgnore', projectId),
    updateCommitIgnore: (projectId: string, content: string) =>
      invokeWithDiagnostics('projects:updateCommitIgnore', projectId, content),
    getDetected: () => invokeWithDiagnostics('projects:getDetected'),
    detectLogos: (projectPath: string) =>
      invokeWithDiagnostics('projects:detectLogos', projectPath),
    getSkills: (projectId: string, backendType?: AgentBackendType | null) =>
      invokeWithDiagnostics('projects:getSkills', projectId, backendType),
  },
  agentMemory: {
    getDashboard: (params: {
      projectId?: string;
      evidencePage?: number;
      extractionRunPage?: number;
      pageSize?: number;
    }): Promise<AgentMemoryDashboard> =>
      invokeWithDiagnostics('agentMemory:getDashboard', params),
    extractNow: (
      projectId: string,
    ): Promise<{ processed: boolean; run: AgentMemoryExtractionRun | null }> =>
      invokeWithDiagnostics('agentMemory:extractNow', projectId),
    retryRun: (params: {
      projectId?: string;
      runId: string;
      scope: 'project' | 'global';
    }): Promise<{ processed: boolean; run: AgentMemoryExtractionRun | null }> =>
      invokeWithDiagnostics('agentMemory:retryRun', params),
    onCaptureWarning: (
      callback: (warning: AgentMemoryCaptureWarning) => void,
    ) => {
      const handler = (_: unknown, warning: AgentMemoryCaptureWarning) =>
        callback(warning);
      ipcRenderer.on('agentMemory:captureWarning', handler);
      return () =>
        ipcRenderer.removeListener('agentMemory:captureWarning', handler);
    },
  },
  tasks: {
    focused: (taskId: string) => ipcRenderer.send('tasks:focused', taskId),
    findAll: () => invokeWithDiagnostics('tasks:findAll'),
    findByProjectId: (projectId: string) =>
      invokeWithDiagnostics('tasks:findByProjectId', projectId),
    findAllActive: () => invokeWithDiagnostics('tasks:findAllActive'),
    findAllCompleted: (params: { limit: number; offset: number }) =>
      invokeWithDiagnostics('tasks:findAllCompleted', params),
    findById: (id: string) => invokeWithDiagnostics('tasks:findById', id),
    create: (data: unknown) => invokeWithDiagnostics('tasks:create', data),
    createWithWorktree: (data: unknown) =>
      invokeWithDiagnostics('tasks:createWithWorktree', data),
    update: (id: string, data: unknown) =>
      invokeWithDiagnostics('tasks:update', id, data),
    updatePendingMessage: (id: string, pendingMessage: string | null) =>
      invokeWithDiagnostics('tasks:updatePendingMessage', id, pendingMessage),
    setSourceBranch: (params: { taskId: string; sourceBranch: string }) =>
      invokeWithDiagnostics('tasks:setSourceBranch', params),
    setBranchName: (params: { taskId: string; branchName: string }) =>
      invokeWithDiagnostics('tasks:setBranchName', params),
    delete: (id: string, options?: { deleteWorktree?: boolean }) =>
      invokeWithDiagnostics('tasks:delete', id, options),
    deletePrWorkspaceTask: (params: { taskId: string }) =>
      invokeWithDiagnostics('tasks:deletePrWorkspaceTask', params),
    deleteAllPrWorkspaces: (params: {
      projectId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('tasks:deleteAllPrWorkspaces', params),
    toggleUserCompleted: (id: string) =>
      invokeWithDiagnostics('tasks:toggleUserCompleted', id),
    complete: (id: string, options: { cleanupWorktree?: boolean }) =>
      invokeWithDiagnostics('tasks:complete', id, options),
    clearUserCompleted: (id: string) =>
      invokeWithDiagnostics('tasks:clearUserCompleted', id),
    reorder: (projectId: string, activeIds: string[], completedIds: string[]) =>
      invokeWithDiagnostics('tasks:reorder', projectId, activeIds, completedIds),
    worktree: {
      getDiff: (taskId: string) =>
        invokeWithDiagnostics('tasks:worktree:getDiff', taskId),
      getLocalChanges: (taskId: string) =>
        invokeWithDiagnostics('tasks:worktree:getLocalChanges', taskId),
      getCommits: (taskId: string) =>
        invokeWithDiagnostics('tasks:worktree:getCommits', taskId),
      getCommitDiff: (taskId: string, commitHash: string) =>
        invokeWithDiagnostics('tasks:worktree:getCommitDiff', taskId, commitHash),
      getCommitFileContent: (
        taskId: string,
        commitHash: string,
        filePath: string,
        status: 'added' | 'modified' | 'deleted',
      ) =>
        invokeWithDiagnostics(
          'tasks:worktree:getCommitFileContent',
          taskId,
          commitHash,
          filePath,
          status,
        ),
      getFileContent: (
        taskId: string,
        filePath: string,
        status: 'added' | 'modified' | 'deleted',
        originalPath?: string,
      ) =>
        invokeWithDiagnostics(
          'tasks:worktree:getFileContent',
          taskId,
          filePath,
          status,
          originalPath,
        ),
      getLocalFileContent: (
        taskId: string,
        filePath: string,
        status: 'added' | 'modified' | 'deleted',
        scope: 'staged' | 'unstaged',
        originalPath?: string,
      ) =>
        invokeWithDiagnostics(
          'tasks:worktree:getLocalFileContent',
          taskId,
          filePath,
          status,
          scope,
          originalPath,
        ),
      getStatus: (taskId: string) =>
        invokeWithDiagnostics('tasks:worktree:getStatus', taskId),
      commit: (
        taskId: string,
        params: { message?: string; stageAll: boolean },
      ) => invokeWithDiagnostics('tasks:worktree:commit', taskId, params),
      generateCommitMessage: (taskId: string, params: { stageAll: boolean }) =>
        invokeWithDiagnostics(
          'tasks:worktree:generateCommitMessage',
          taskId,
          params,
        ),
      checkMergeConflicts: (taskId: string, params: { targetBranch: string }) =>
        invokeWithDiagnostics(
          'tasks:worktree:checkMergeConflicts',
          taskId,
          params,
        ),
      merge: (
        taskId: string,
        params: {
          targetBranch: string;
          squash?: boolean;
          commitMessage?: string;
          commitAllUnstaged?: boolean;
        },
      ) => invokeWithDiagnostics('tasks:worktree:merge', taskId, params),
      getBranches: (taskId: string) =>
        invokeWithDiagnostics('tasks:worktree:getBranches', taskId),
      pushBranch: (taskId: string, params?: { commitUnstaged?: boolean }) =>
        invokeWithDiagnostics('tasks:worktree:pushBranch', taskId, params),
      pullBranch: (taskId: string) =>
        invokeWithDiagnostics('tasks:worktree:pullBranch', taskId),
      delete: (taskId: string, options?: { keepBranch?: boolean }) =>
        invokeWithDiagnostics('tasks:worktree:delete', taskId, options),
    },
    summary: {
      get: (taskId: string) => invokeWithDiagnostics('tasks:summary:get', taskId),
      generate: (taskId: string) =>
        invokeWithDiagnostics('tasks:summary:generate', taskId),
    },
    generatePrDescription: (params: { taskId: string }) =>
      invokeWithDiagnostics('tasks:generatePrDescription', params),
    createPullRequest: (params: {
      taskId: string;
      title: string;
      description: string;
      isDraft: boolean;
      deleteWorktree?: boolean;
      commitUnstaged?: boolean;
    }) => invokeWithDiagnostics('tasks:createPullRequest', params),
    createPrReviewTask: (params: {
      projectId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('tasks:createPrReviewTask', params),
    startPrCommand: (params: StartPrCommandParams) =>
      invokeWithDiagnostics(START_PR_COMMAND_CHANNEL, params),
  },
  steps: {
    findByTaskId: (taskId: string) =>
      invokeWithDiagnostics('steps:findByTaskId', taskId),
    findById: (stepId: string) => invokeWithDiagnostics('steps:findById', stepId),
    create: (data: unknown) => invokeWithDiagnostics('steps:create', data),
    createPrReviewChatStep: (params: {
      taskId: string;
      pullRequestId: number;
      filePath: string;
      lineStart: number;
      lineEnd?: number;
      side?: 'old' | 'new';
      selectedText: string;
      question: string;
    }) => invokeWithDiagnostics('steps:createPrReviewChatStep', params),
    continuePrReviewChatStep: (params: { stepId: string; question: string }) =>
      invokeWithDiagnostics('steps:continuePrReviewChatStep', params),
    update: (stepId: string, data: unknown) =>
      invokeWithDiagnostics('steps:update', stepId, data),
    archive: (stepId: string) => invokeWithDiagnostics('steps:archive', stepId),
    resolvePrompt: (stepId: string) =>
      invokeWithDiagnostics('steps:resolvePrompt', stepId),
    setMode: (stepId: string, mode: string) =>
      invokeWithDiagnostics('steps:setMode', stepId, mode),
    setAutoAccept: (stepId: string, enabled: boolean) =>
      invokeWithDiagnostics('steps:setAutoAccept', stepId, enabled),
    getAutoAccept: (stepId: string) =>
      invokeWithDiagnostics('steps:getAutoAccept', stepId),
    submitPrReview: (stepId: string) =>
      invokeWithDiagnostics('steps:submitPrReview', stepId),
    addSessionAllowedTool: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) => invokeWithDiagnostics('steps:addSessionAllowedTool', params),
    removeSessionAllowedTool: (params: {
      stepId: string;
      toolName: string;
      pattern?: string;
    }) => invokeWithDiagnostics('steps:removeSessionAllowedTool', params),
    allowForProject: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) => invokeWithDiagnostics('steps:allowForProject', params),
    allowForProjectWorktrees: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) => invokeWithDiagnostics('steps:allowForProjectWorktrees', params),
    allowGlobally: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) => invokeWithDiagnostics('steps:allowGlobally', params),
  },
  providers: {
    findAll: () => invokeWithDiagnostics('providers:findAll'),
    findById: (id: string) => invokeWithDiagnostics('providers:findById', id),
    findByTokenId: (tokenId: string) =>
      invokeWithDiagnostics('providers:findByTokenId', tokenId),
    create: (data: unknown) => invokeWithDiagnostics('providers:create', data),
    update: (id: string, data: unknown) =>
      invokeWithDiagnostics('providers:update', id, data),
    delete: (id: string) => invokeWithDiagnostics('providers:delete', id),
    getDetails: (providerId: string) =>
      invokeWithDiagnostics('providers:getDetails', providerId),
  },
  tokens: {
    findAll: () => invokeWithDiagnostics('tokens:findAll'),
    findById: (id: string) => invokeWithDiagnostics('tokens:findById', id),
    findByProviderType: (providerType: string) =>
      invokeWithDiagnostics('tokens:findByProviderType', providerType),
    create: (data: unknown) => invokeWithDiagnostics('tokens:create', data),
    update: (id: string, data: unknown) =>
      invokeWithDiagnostics('tokens:update', id, data),
    delete: (id: string) => invokeWithDiagnostics('tokens:delete', id),
  },
  azureDevOps: {
    getOrganizations: (tokenId: string) =>
      invokeWithDiagnostics('azureDevOps:getOrganizations', tokenId),
    validateToken: (token: string) =>
      invokeWithDiagnostics('azureDevOps:validateToken', token),
    getTokenExpiration: (tokenId: string) =>
      invokeWithDiagnostics('azureDevOps:getTokenExpiration', tokenId),
    getCurrentUser: (providerId: string) =>
      invokeWithDiagnostics('azureDevOps:getCurrentUser', providerId),
    queryWorkItems: (params: {
      providerId: string;
      projectId: string;
      projectName: string;
      filters: {
        states?: string[];
        workItemTypes?: string[];
        excludeWorkItemTypes?: string[];
        searchText?: string;
        iterationPath?: string;
        iterationPaths?: string[];
        assignedTo?: string;
      };
      extraFieldRefNames?: string[];
    }) => invokeWithDiagnostics('azureDevOps:queryWorkItems', params),
    queryWorkItemOwners: (params: {
      providerId: string;
      projectName: string;
    }) => invokeWithDiagnostics('azureDevOps:queryWorkItemOwners', params),
    getWorkItemById: (params: {
      providerId: string;
      workItemId: number;
      extraFieldRefNames?: string[];
    }) => invokeWithDiagnostics('azureDevOps:getWorkItemById', params),
    getWorkItemsByIds: (params: {
      providerId: string;
      projectName: string;
      workItemIds: number[];
      extraFieldRefNames?: string[];
    }) => invokeWithDiagnostics('azureDevOps:getWorkItemsByIds', params),
    getWorkItemTypeFields: (params: {
      providerId: string;
      azureProjectId: string;
    }) => invokeWithDiagnostics('azureDevOps:getWorkItemTypeFields', params),
    getPullRequestStatuses: (params: {
      providerId: string;
      linkedPrs: Array<{ prId: number; projectId: string; repoId: string }>;
    }) => invokeWithDiagnostics('azureDevOps:getPullRequestStatuses', params),
    getWorkItemStates: (params: {
      providerId: string;
      projectName: string;
      workItemType: string;
    }) => invokeWithDiagnostics('azureDevOps:getWorkItemStates', params),
    getBoardColumns: (params: {
      providerId: string;
      projectId: string;
      projectName: string;
    }) => invokeWithDiagnostics('azureDevOps:getBoardColumns', params),
    updateWorkItemState: (params: {
      providerId: string;
      workItemId: number;
      state: string;
    }) => invokeWithDiagnostics('azureDevOps:updateWorkItemState', params),
    updateWorkItemField: (params: {
      providerId: string;
      workItemId: number;
      field: string;
      value: string | number | null;
    }) => invokeWithDiagnostics('azureDevOps:updateWorkItemField', params),
    updateWorkItemBoardColumn: (params: {
      providerId: string;
      projectId: string;
      projectName: string;
      workItemId: number;
      column: string;
      teamId: string;
      boardId: string;
    }) => invokeWithDiagnostics('azureDevOps:updateWorkItemBoardColumn', params),
    getRelatedTestCases: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => invokeWithDiagnostics('azureDevOps:getRelatedTestCases', params),
    getWorkItemComments: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => invokeWithDiagnostics('azureDevOps:getWorkItemComments', params),
    getWorkItemSummary: (params: {
      projectId: string;
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => invokeWithDiagnostics('azureDevOps:getWorkItemSummary', params),
    generateWorkItemSummary: (params: {
      projectId: string;
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => invokeWithDiagnostics('azureDevOps:generateWorkItemSummary', params),
    getCachedWorkItemSummaries: (params: {
      providerId: string;
      workItemIds: number[];
    }) => invokeWithDiagnostics('azureDevOps:getCachedWorkItemSummaries', params),
    getWorkItemHistory: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => invokeWithDiagnostics('azureDevOps:getWorkItemHistory', params),
    addWorkItemComment: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
      text: string;
    }) => invokeWithDiagnostics('azureDevOps:addWorkItemComment', params),
     updateWorkItemComment: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
      commentId: number;
      text: string;
     }) => invokeWithDiagnostics('azureDevOps:updateWorkItemComment', params),
     setWorkItemCommentReaction: (params: {
       providerId: string;
       projectName: string;
       workItemId: number;
       commentId: number;
       reactionType: 'like' | 'dislike' | 'heart' | 'hooray' | 'smile' | 'confused';
       engaged: boolean;
     }) => invokeWithDiagnostics('azureDevOps:setWorkItemCommentReaction', params),
    uploadWorkItemAttachment: (params: {
      providerId: string;
      projectName: string;
      workItemId?: number;
      filename: string;
      mimeType: string;
      base64: string;
    }) => invokeWithDiagnostics('azureDevOps:uploadWorkItemAttachment', params),
    getIterations: (params: { providerId: string; projectName: string }) =>
      invokeWithDiagnostics('azureDevOps:getIterations', params),
    createPullRequest: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
      isDraft: boolean;
    }) => invokeWithDiagnostics('azureDevOps:createPullRequest', params),
    cloneRepository: (params: {
      orgName: string;
      projectName: string;
      repoName: string;
      targetPath: string;
    }) => invokeWithDiagnostics('azureDevOps:cloneRepository', params),
    listPullRequests: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      status?: 'active' | 'completed' | 'abandoned' | 'all';
    }) => invokeWithDiagnostics('azureDevOps:listPullRequests', params),
    getPullRequest: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('azureDevOps:getPullRequest', params),
    updatePullRequestTitle: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      title: string;
    }) => invokeWithDiagnostics('azureDevOps:updatePullRequestTitle', params),
    updatePullRequestDescription: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      description: string;
    }) =>
      invokeWithDiagnostics('azureDevOps:updatePullRequestDescription', params),
    getPullRequestTags: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('azureDevOps:getPullRequestTags', params),
    addPullRequestTag: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      name: string;
    }) => invokeWithDiagnostics('azureDevOps:addPullRequestTag', params),
    removePullRequestTag: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      name: string;
    }) => invokeWithDiagnostics('azureDevOps:removePullRequestTag', params),
    uploadPullRequestAttachment: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      fileName: string;
      mimeType: string;
      dataBase64: string;
    }) => invokeWithDiagnostics('azureDevOps:uploadPullRequestAttachment', params),
    getPullRequestCommits: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('azureDevOps:getPullRequestCommits', params),
    getPullRequestDivergence: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      sourceRefName?: string;
      targetRefName?: string;
    }) => invokeWithDiagnostics('azureDevOps:getPullRequestDivergence', params),
    getPullRequestChanges: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('azureDevOps:getPullRequestChanges', params),
    getCommitChanges: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      commitId: string;
    }) => invokeWithDiagnostics('azureDevOps:getCommitChanges', params),
    getFileContentAtCommit: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      commitId: string;
      filePath: string;
      version: 'current' | 'parent';
    }) => invokeWithDiagnostics('azureDevOps:getFileContentAtCommit', params),
    getPullRequestFileContent: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      filePath: string;
      version: 'base' | 'head';
    }) => invokeWithDiagnostics('azureDevOps:getPullRequestFileContent', params),
    getPullRequestThreads: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('azureDevOps:getPullRequestThreads', params),
    getPullRequestWorkItems: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('azureDevOps:getPullRequestWorkItems', params),
    linkWorkItemToPr: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      workItemId: number;
    }) => invokeWithDiagnostics('azureDevOps:linkWorkItemToPr', params),
    unlinkWorkItemFromPr: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      workItemId: number;
    }) => invokeWithDiagnostics('azureDevOps:unlinkWorkItemFromPr', params),
    addPullRequestComment: (params: {
      localProjectId?: string;
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      content: string;
    }) => invokeWithDiagnostics('azureDevOps:addPullRequestComment', params),
    addPullRequestFileComment: (params: {
      localProjectId?: string;
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      filePath: string;
      line: number;
      lineEnd?: number;
      selectedLines?: string;
      content: string;
    }) => invokeWithDiagnostics('azureDevOps:addPullRequestFileComment', params),
    addThreadReply: (params: {
      localProjectId?: string;
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      content: string;
    }) => invokeWithDiagnostics('azureDevOps:addThreadReply', params),
    updateThreadComment: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      commentId: number;
      content: string;
    }) => invokeWithDiagnostics('azureDevOps:updateThreadComment', params),
    deleteThreadComment: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      commentId: number;
    }) => invokeWithDiagnostics('azureDevOps:deleteThreadComment', params),
    setThreadCommentLike: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      commentId: number;
      liked: boolean;
    }) => invokeWithDiagnostics('azureDevOps:setThreadCommentLike', params),
    updateThreadStatus: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      status: string;
    }) => invokeWithDiagnostics('azureDevOps:updateThreadStatus', params),
    searchIdentities: (params: { providerId: string; query: string }) =>
      invokeWithDiagnostics('azureDevOps:searchIdentities', params),
    fetchImageAsBase64: (params: { providerId: string; imageUrl: string }) =>
      invokeWithDiagnostics('azureDevOps:fetchImageAsBase64', params),
    downloadWorkItemAttachment: (params: {
      providerId: string;
      attachmentUrl: string;
      filename: string;
      projectPath: string;
    }) => invokeWithDiagnostics('azureDevOps:downloadWorkItemAttachment', params),
    getPullRequestPolicyEvaluations: (params: {
      providerId: string;
      projectId: string;
      pullRequestId: number;
    }) =>
      invokeWithDiagnostics('azureDevOps:getPullRequestPolicyEvaluations', params),
    requeuePolicyEvaluation: (params: {
      providerId: string;
      projectId: string;
      evaluationId: string;
    }) => invokeWithDiagnostics('azureDevOps:requeuePolicyEvaluation', params),
    votePullRequest: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      reviewerId: string;
      vote: number;
    }) => invokeWithDiagnostics('azureDevOps:votePullRequest', params),
    setPullRequestAutoComplete: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      enabled: boolean;
      autoCompleteSetById?: string;
      completionOptions?: {
        mergeStrategy: string;
        deleteSourceBranch: boolean;
        transitionWorkItems: boolean;
        mergeCommitMessage?: string;
        autoCompleteIgnoreConfigIds?: number[];
      };
    }) => invokeWithDiagnostics('azureDevOps:setPullRequestAutoComplete', params),
    publishPullRequest: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('azureDevOps:publishPullRequest', params),
    markPullRequestDraft: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => invokeWithDiagnostics('azureDevOps:markPullRequestDraft', params),
  },
  git: {
    cloneFromUrl: (params: {
      url: string;
      protocol: 'ssh' | 'https';
      targetPath: string;
    }) => invokeWithDiagnostics('git:cloneFromUrl', params),
  },
  dialog: {
    openDirectory: () => invokeWithDiagnostics('dialog:openDirectory'),
    openImageFile: () => invokeWithDiagnostics('dialog:openImageFile'),
    openFiles: () => invokeWithDiagnostics('dialog:openFiles'),
    openApplication: () => invokeWithDiagnostics('dialog:openApplication'),
    saveFile: (params: {
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      content?: Uint8Array;
    }) => invokeWithDiagnostics('dialog:saveFile', params),
  },
  settings: {
    get: (key: string) => invokeWithDiagnostics('settings:get', key),
    set: (key: string, value: unknown) =>
      invokeWithDiagnostics('settings:set', key, value),
  },
  modelProfiles: {
    resolve: (params: {
      role: import('@shared/model-profiles').ModelRole;
      projectId?: string | null;
      override?: import('@shared/model-profiles').ModelOverride | null;
    }) => invokeWithDiagnostics('modelProfiles:resolve', params),
    activate: (profileId: string, projectId?: string | null) =>
      invokeWithDiagnostics('modelProfiles:activate', profileId, projectId ?? null),
  },
  backendConfig: {
    getUserConfig: (
      backend: import('@shared/agent-backend-types').AgentBackendType,
    ) => invokeWithDiagnostics('backendConfig:getUserConfig', backend),
    setUserConfig: (
      backend: import('@shared/agent-backend-types').AgentBackendType,
      content: string,
    ) => invokeWithDiagnostics('backendConfig:setUserConfig', backend, content),
  },
  projectPromptPreface: {
    get: (projectPath: string) =>
      invokeWithDiagnostics('projectPromptPreface:get', projectPath),
    set: (
      projectPath: string,
      value: import('@shared/prompt-preface-types').ProjectPromptPrefaceSetting,
    ) => invokeWithDiagnostics('projectPromptPreface:set', projectPath, value),
  },
  globalPermissions: {
    get: () => invokeWithDiagnostics('globalPermissions:get'),
    set: (permissions: import('@shared/permission-types').PermissionScope) =>
      invokeWithDiagnostics('globalPermissions:set', permissions),
    addRule: (
      toolName: string,
      input: Record<string, unknown>,
      action?: import('@shared/permission-types').PermissionAction,
    ) =>
      invokeWithDiagnostics('globalPermissions:addRule', toolName, input, action),
    removeRule: (tool: string, pattern?: string) =>
      invokeWithDiagnostics('globalPermissions:removeRule', tool, pattern),
    editRule: (
      tool: string,
      oldPattern: string | undefined,
      newPattern: string | undefined,
      action: import('@shared/permission-types').PermissionAction,
    ) =>
      invokeWithDiagnostics(
        'globalPermissions:editRule',
        tool,
        oldPattern,
        newPattern,
        action,
      ),
  },
  permissionEvents: {
    onChanged: (
      callback: (
        event: import('@shared/permission-types').PermissionsChangedEvent,
      ) => void,
    ) => {
      const handler = (
        _: unknown,
        event: import('@shared/permission-types').PermissionsChangedEvent,
      ) => callback(event);
      ipcRenderer.on('permissions:changed', handler);
      return () => ipcRenderer.removeListener('permissions:changed', handler);
    },
  },
  projectPermissions: {
    get: (projectPath: string) =>
      invokeWithDiagnostics('projectPermissions:get', projectPath),
    addRule: (
      projectPath: string,
      toolName: string,
      input: Record<string, unknown>,
      action?: import('@shared/permission-types').PermissionAction,
    ) =>
      invokeWithDiagnostics(
        'projectPermissions:addRule',
        projectPath,
        toolName,
        input,
        action,
      ),
    removeRule: (projectPath: string, tool: string, pattern?: string) =>
      invokeWithDiagnostics(
        'projectPermissions:removeRule',
        projectPath,
        tool,
        pattern,
      ),
    editRule: (
      projectPath: string,
      tool: string,
      oldPattern: string | undefined,
      newPattern: string | undefined,
      action: import('@shared/permission-types').PermissionAction,
    ) =>
      invokeWithDiagnostics(
        'projectPermissions:editRule',
        projectPath,
        tool,
        oldPattern,
        newPattern,
        action,
      ),
  },
  worktreeConfig: {
    getCopyEntries: (projectPath: string) =>
      invokeWithDiagnostics('worktreeConfig:get', projectPath),
    setCopyEntries: (
      projectPath: string,
      entries: import('@shared/permission-types').WorktreeFileCopyEntry[],
    ) =>
      invokeWithDiagnostics('worktreeConfig:setCopyEntries', projectPath, entries),
  },
  fs: {
    readPackageJson: (dirPath: string) =>
      invokeWithDiagnostics('fs:readPackageJson', dirPath),
    readFile: (filePath: string, maxBytes?: number) =>
      invokeWithDiagnostics('fs:readFile', filePath, maxBytes),
    getFileSize: (filePath: string) =>
      invokeWithDiagnostics('fs:getFileSize', filePath),
    readImageAsDataUrl: (filePath: string) =>
      invokeWithDiagnostics('fs:readImageAsDataUrl', filePath),
    readSpreadsheetAsBase64: (filePath: string) =>
      invokeWithDiagnostics('fs:readSpreadsheetAsBase64', filePath),
    getImageUrl: (filePath: string) =>
      invokeWithDiagnostics('fs:getImageUrl', filePath),
    listDirectory: (dirPath: string, projectRoot: string) =>
      invokeWithDiagnostics('fs:listDirectory', dirPath, projectRoot),
    listProjectFiles: (projectRoot: string) =>
      invokeWithDiagnostics('fs:listProjectFiles', projectRoot),
    writeAttachmentFile: (
      projectPath: string,
      filename: string,
      content: string,
      encoding?: 'utf-8' | 'base64',
    ) =>
      invokeWithDiagnostics(
        'fs:writeAttachmentFile',
        projectPath,
        filename,
        content,
        encoding,
      ),
    copyAttachmentFile: (projectPath: string, sourcePath: string) =>
      invokeWithDiagnostics('fs:copyAttachmentFile', projectPath, sourcePath),
    deleteAttachmentFile: (projectPath: string, filePath: string) =>
      invokeWithDiagnostics('fs:deleteAttachmentFile', projectPath, filePath),
    getPathForFile: (file: File) => webUtils.getPathForFile(file) || null,
  },
  shell: {
    openInEditor: (dirPath: string, folderContext?: string) =>
      invokeWithDiagnostics('shell:openInEditor', dirPath, folderContext),
    openPath: (targetPath: string) =>
      invokeWithDiagnostics('shell:openPath', targetPath),
    openTeamsJoinUrl: (url: string) =>
      invokeWithDiagnostics('shell:openTeamsJoinUrl', url),
    getAvailableEditors: () => invokeWithDiagnostics('shell:getAvailableEditors'),
    getAgentCliStatus: () => invokeWithDiagnostics('shell:getAgentCliStatus'),
    setupGlobalGitignore: () =>
      invokeWithDiagnostics('shell:setupGlobalGitignore') as Promise<{
        success: boolean;
        path: string;
      }>,
  },
  calendar: {
    listUpcomingMeetings: () =>
      invokeWithDiagnostics('calendar:listUpcomingMeetings') as Promise<
        import('@shared/calendar-types').UpcomingMeeting[]
      >,
    listTodayMeetings: () =>
      invokeWithDiagnostics('calendar:listTodayMeetings') as Promise<
        import('@shared/calendar-types').UpcomingMeeting[]
      >,
    revealMeeting: (
      meeting: import('@shared/calendar-types').UpcomingMeeting,
    ) => invokeWithDiagnostics('calendar:revealMeeting', meeting) as Promise<void>,
    suppressMeetingStartPopup: (
      meeting: import('@shared/calendar-types').UpcomingMeeting,
    ) =>
      invokeWithDiagnostics(
        'calendar:suppressMeetingStartPopup',
        meeting,
      ) as Promise<void>,
    setIgnoredMeetingIds: (ids: string[]) =>
      invokeWithDiagnostics('calendar:setIgnoredMeetingIds', ids) as Promise<void>,
  },
  agent: {
    start: (stepId: string) => invokeWithDiagnostics(AGENT_CHANNELS.START, stepId),
    stop: (stepId: string) => invokeWithDiagnostics(AGENT_CHANNELS.STOP, stepId),
    stopAll: () => invokeWithDiagnostics(AGENT_CHANNELS.STOP_ALL),
    respond: (stepId: string, requestId: string, response: unknown) =>
      invokeWithDiagnostics(AGENT_CHANNELS.RESPOND, stepId, requestId, response),
    sendMessage: (
      stepId: string,
      parts: unknown[],
      capture?: AgentMemoryFollowUpCapture,
    ) =>
      invokeWithDiagnostics(AGENT_CHANNELS.SEND_MESSAGE, stepId, parts, capture),
    queuePrompt: (
      stepId: string,
      parts: unknown[],
      capture?: AgentMemoryQueuedPromptCapture,
    ) =>
      invokeWithDiagnostics(AGENT_CHANNELS.QUEUE_PROMPT, stepId, parts, capture),
    updateQueuedPrompt: (
      stepId: string,
      promptId: string,
      content: string,
      capture?: AgentMemoryPromptCapture,
    ) =>
      invokeWithDiagnostics(
        AGENT_CHANNELS.UPDATE_QUEUED_PROMPT,
        stepId,
        promptId,
        content,
        capture,
      ),
    cancelQueuedPrompt: (stepId: string, promptId: string) =>
      invokeWithDiagnostics(AGENT_CHANNELS.CANCEL_QUEUED_PROMPT, stepId, promptId),
    getBackendModels: (backend: string) =>
      invokeWithDiagnostics('agent:getBackendModels', backend),
    getMessages: (stepId: string) =>
      invokeWithDiagnostics(AGENT_CHANNELS.GET_MESSAGES, stepId),
    getMessageCount: (stepId: string) =>
      invokeWithDiagnostics(AGENT_CHANNELS.GET_MESSAGE_COUNT, stepId),
    getPendingRequest: (stepId: string) =>
      invokeWithDiagnostics(AGENT_CHANNELS.GET_PENDING_REQUEST, stepId),
    getBackgroundTasks: (stepId: string) =>
      invokeWithDiagnostics(AGENT_CHANNELS.GET_BACKGROUND_TASKS, stepId),
    getMessagesWithRawData: (taskId: string, stepId: string) =>
      invokeWithDiagnostics(
        AGENT_CHANNELS.GET_MESSAGES_WITH_RAW_DATA,
        taskId,
        stepId,
      ),
    getResourceSnapshots: () =>
      invokeWithDiagnostics('agent:resources:getSnapshots'),
    getResourceHistory: () => invokeWithDiagnostics('agent:resources:getHistory'),
    setHighFrequencyResourceSampling: (enabled: boolean) =>
      invokeWithDiagnostics(
        'agent:resources:setHighFrequencySampling',
        enabled,
      ),
    compactRawMessages: (taskId: string) =>
      invokeWithDiagnostics(AGENT_CHANNELS.COMPACT_RAW_MESSAGES, taskId),
    reprocessNormalization: (taskId: string) =>
      invokeWithDiagnostics(AGENT_CHANNELS.REPROCESS_NORMALIZATION, taskId),
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => callback(event);
      ipcRenderer.on(AGENT_CHANNELS.EVENT, handler);
      return () => ipcRenderer.removeListener(AGENT_CHANNELS.EVENT, handler);
    },
  },
  mobilePreview: {
    listDevices: (platform: MobilePlatform) =>
      invokeWithDiagnostics('mobilePreview:listDevices', platform),
    listSessions: (params: MobilePreviewListSessionsParams) =>
      invokeWithDiagnostics('mobilePreview:listSessions', params),
    listDeviceAssignments: () =>
      invokeWithDiagnostics('mobilePreview:listDeviceAssignments'),
    getAndroidToolStatus: () =>
      invokeWithDiagnostics('mobilePreview:getAndroidToolStatus'),
    listAndroidDeviceProfiles: () =>
      invokeWithDiagnostics('mobilePreview:listAndroidDeviceProfiles'),
    listAndroidSystemImages: () =>
      invokeWithDiagnostics('mobilePreview:listAndroidSystemImages'),
    createAndroidDevice: (params: MobilePreviewAndroidCreateDeviceParams) =>
      invokeWithDiagnostics('mobilePreview:createAndroidDevice', params),
    deleteAndroidDevice: (name: string) =>
      invokeWithDiagnostics('mobilePreview:deleteAndroidDevice', name),
    installAndroidSystemImage: (
      params: MobilePreviewAndroidInstallSystemImageParams,
    ) => invokeWithDiagnostics('mobilePreview:installAndroidSystemImage', params),
    getIosToolStatus: () =>
      invokeWithDiagnostics('mobilePreview:getIosToolStatus'),
    listIosRuntimes: () =>
      invokeWithDiagnostics('mobilePreview:listIosRuntimes'),
    listIosDeviceTypes: () =>
      invokeWithDiagnostics('mobilePreview:listIosDeviceTypes'),
    createIosDevice: (params: MobilePreviewIosCreateDeviceParams) =>
      invokeWithDiagnostics('mobilePreview:createIosDevice', params),
    deleteIosDevice: (deviceId: string) =>
      invokeWithDiagnostics('mobilePreview:deleteIosDevice', deviceId),
    eraseIosDevice: (deviceId: string) =>
      invokeWithDiagnostics('mobilePreview:eraseIosDevice', deviceId),
    renameIosDevice: (params: MobilePreviewIosRenameDeviceParams) =>
      invokeWithDiagnostics('mobilePreview:renameIosDevice', params),
    getIosAppStatus: (params: MobilePreviewIosAppStatusRequestParams) =>
      invokeWithDiagnostics('mobilePreview:getIosAppStatus', params),
    cancelIosAppStatus: (params: MobilePreviewIosAppStatusCancelParams) =>
      invokeWithDiagnostics('mobilePreview:cancelIosAppStatus', params),
    restartIosApp: (params: MobilePreviewIosAppRequestParams) =>
      invokeWithDiagnostics('mobilePreview:restartIosApp', params),
    launchExpo: (params: MobilePreviewExpoLaunchParams) =>
      invokeWithDiagnostics('mobilePreview:launchExpo', params),
    cancelExpoLaunch: (requestId: string) =>
      invokeWithDiagnostics('mobilePreview:cancelExpoLaunch', requestId),
    start: (params: MobilePreviewStartParams) =>
      invokeWithDiagnostics('mobilePreview:start', params),
    attachSession: (params: MobilePreviewAttachSessionParams) =>
      invokeWithDiagnostics('mobilePreview:attachSession', params),
    detachSession: (params: MobilePreviewDetachSessionParams) =>
      invokeWithDiagnostics('mobilePreview:detachSession', params),
    stop: (sessionId: string) =>
      invokeWithDiagnostics('mobilePreview:stop', sessionId),
    sendInput: (sessionId: string, event: MobilePreviewInputEvent) =>
      invokeWithDiagnostics('mobilePreview:sendInput', sessionId, event),
    openDeeplink: (params: MobilePreviewOpenDeeplinkParams) =>
      invokeWithDiagnostics('mobilePreview:openDeeplink', params),
    openDevMenu: (params: MobilePreviewOpenDevMenuParams) =>
      invokeWithDiagnostics('mobilePreview:openDevMenu', params),
    reloadExpo: (params: MobilePreviewReloadExpoParams) =>
      invokeWithDiagnostics('mobilePreview:reloadExpo', params),
    waitForMetroClient: (params: MobilePreviewWaitForMetroClientParams) =>
      invokeWithDiagnostics('mobilePreview:waitForMetroClient', params),
    listMetroPeers: (params: MobilePreviewListMetroPeersParams) =>
      invokeWithDiagnostics('mobilePreview:listMetroPeers', params),
    bootDevice: (params: MobilePreviewBootDeviceParams) =>
      invokeWithDiagnostics('mobilePreview:bootDevice', params),
    captureScreenshot: (params: MobilePreviewCaptureScreenshotParams) =>
      invokeWithDiagnostics('mobilePreview:captureScreenshot', params),
    forwardPort: (params: MobilePreviewForwardPortParams) =>
      invokeWithDiagnostics('mobilePreview:forwardPort', params),
    ensureMetroReverse: (params: { deviceId: string; metroPort: number }) =>
      invokeWithDiagnostics('mobilePreview:ensureMetroReverse', params),
    setTextSize: (params: MobilePreviewSetTextSizeParams) =>
      invokeWithDiagnostics('mobilePreview:setTextSize', params),
    setColorScheme: (sessionId: string, scheme: MobileColorScheme) =>
      invokeWithDiagnostics('mobilePreview:setColorScheme', sessionId, scheme),
    rotate: (sessionId: string, direction: MobileRotationDirection) =>
      invokeWithDiagnostics('mobilePreview:rotate', sessionId, direction),
    startNativeLogs: (params: MobilePreviewNativeLogStartParams) =>
      invokeWithDiagnostics('mobilePreview:startNativeLogs', params),
    stopNativeLogs: (sessionId: string) =>
      invokeWithDiagnostics('mobilePreview:stopNativeLogs', sessionId),
    resolveReactNativeDevTools: (params: ReactNativeDevToolsResolveParams) =>
      invokeWithDiagnostics('mobilePreview:resolveReactNativeDevTools', params),
    openReactNativeDevTools: (params: ReactNativeDevToolsOpenParams) =>
      invokeWithDiagnostics('mobilePreview:openReactNativeDevTools', params),
    openEmbeddedReactNativeDevTools: (
      params: ReactNativeDevToolsEmbeddedOpenParams,
    ) =>
      invokeWithDiagnostics(
        'mobilePreview:openEmbeddedReactNativeDevTools',
        params,
      ),
    setEmbeddedReactNativeDevToolsBounds: (
      params: ReactNativeDevToolsEmbeddedBoundsParams,
    ) =>
      invokeWithDiagnostics(
        'mobilePreview:setEmbeddedReactNativeDevToolsBounds',
        params,
      ),
    setEmbeddedReactNativeDevToolsVisibility: (
      params: ReactNativeDevToolsEmbeddedVisibilityParams,
    ) =>
      invokeWithDiagnostics(
        'mobilePreview:setEmbeddedReactNativeDevToolsVisibility',
        params,
      ),
    reloadEmbeddedReactNativeDevTools: (
      params: ReactNativeDevToolsEmbeddedReloadParams,
    ) =>
      invokeWithDiagnostics(
        'mobilePreview:reloadEmbeddedReactNativeDevTools',
        params,
      ),
    closeEmbeddedReactNativeDevTools: (
      params: ReactNativeDevToolsEmbeddedCloseParams,
    ) =>
      invokeWithDiagnostics(
        'mobilePreview:closeEmbeddedReactNativeDevTools',
        params,
      ),
    getAndroidAppStatus: (params: MobilePreviewAndroidAppStatusParams) =>
      invokeWithDiagnostics('mobilePreview:getAndroidAppStatus', params),
    restartAndroidApp: (params: MobilePreviewAndroidAppRestartParams) =>
      invokeWithDiagnostics('mobilePreview:restartAndroidApp', params),
    onNativeLogSession: (
      callback: (event: MobilePreviewNativeLogSessionEvent) => void,
    ) => {
      const handler = (_: unknown, event: MobilePreviewNativeLogSessionEvent) =>
        callback(event);
      ipcRenderer.on('mobilePreview:nativeLogSession', handler);
      return () =>
        ipcRenderer.removeListener('mobilePreview:nativeLogSession', handler);
    },
    onNativeLog: (callback: (event: MobilePreviewNativeLogEvent) => void) => {
      const handler = (_: unknown, event: MobilePreviewNativeLogEvent) =>
        callback(event);
      ipcRenderer.on('mobilePreview:nativeLog', handler);
      return () =>
        ipcRenderer.removeListener('mobilePreview:nativeLog', handler);
    },
    onFrame: (callback: (event: MobilePreviewFrameEvent) => void) => {
      const handler = (_: unknown, event: MobilePreviewFrameEvent) =>
        callback(event);
      ipcRenderer.on('mobilePreview:frame', handler);
      return () => ipcRenderer.removeListener('mobilePreview:frame', handler);
    },
    onSession: (callback: (event: MobilePreviewSessionEvent) => void) => {
      const handler = (_: unknown, event: MobilePreviewSessionEvent) =>
        callback(event);
      ipcRenderer.on('mobilePreview:session', handler);
      return () => ipcRenderer.removeListener('mobilePreview:session', handler);
    },
  },
  mobileBuildStore: {
    list: (params: unknown) => invokeWithDiagnostics('mobileBuildStore:list', params),
    build: (params: unknown) => invokeWithDiagnostics('mobileBuildStore:build', params),
    store: (params: unknown) => invokeWithDiagnostics('mobileBuildStore:store', params),
    install: (params: unknown) => invokeWithDiagnostics('mobileBuildStore:install', params),
    delete: (params: unknown) => invokeWithDiagnostics('mobileBuildStore:delete', params),
    rename: (params: unknown) => invokeWithDiagnostics('mobileBuildStore:rename', params),
  },
  debug: {
    log: (params: { scope: string; message: string; data?: unknown }) =>
      invokeWithDiagnostics('debug:log', params),
    getTableNames: () => invokeWithDiagnostics('debug:getTableNames'),
    getDatabaseSize: () => invokeWithDiagnostics('debug:getDatabaseSize'),
    countOldCompletedTasks: () =>
      invokeWithDiagnostics('debug:countOldCompletedTasks'),
    deleteOldCompletedTasks: () =>
      invokeWithDiagnostics('debug:deleteOldCompletedTasks'),
    queryTable: (params: {
      table: string;
      search?: string;
      limit: number;
      offset: number;
    }) => invokeWithDiagnostics('debug:queryTable', params),
  },
  usage: {
    getAll: (backends: string[]) =>
      invokeWithDiagnostics('agent:usage:getAll', backends),
    getHistory: (params: {
      provider: string;
      limitKey: string;
      since: string;
      until?: string;
    }) => invokeWithDiagnostics('agent:usage:getHistory', params),
    getDashboard: (params: AiUsageDashboardParams) =>
      invokeWithDiagnostics('agent:usage:getDashboard', params),
    getTaskUsage: (taskId: string) =>
      invokeWithDiagnostics('agent:usage:getTaskUsage', taskId),
  },
  workActivity: {
    record: (event: NewWorkActivityEvent) =>
      invokeWithDiagnostics('workActivity:record', event),
    getRange: (params: WorkActivityWeekParams) =>
      invokeWithDiagnostics('workActivity:getRange', params),
    deleteBefore: (before: string) =>
      invokeWithDiagnostics('workActivity:deleteBefore', before),
    deleteAll: () => invokeWithDiagnostics('workActivity:deleteAll'),
  },
  timesheets: {
    listAdapters: () => invokeWithDiagnostics('timesheets:listAdapters'),
    buildDraft: (params: TimesheetDraftParams) =>
      invokeWithDiagnostics('timesheets:buildDraft', params),
    sync: (params: TimesheetSyncParams) =>
      invokeWithDiagnostics('timesheets:sync', params),
    authStatus: (provider: TimesheetProviderType) =>
      invokeWithDiagnostics('timesheets:authStatus', provider),
    login: (provider: TimesheetProviderType) =>
      invokeWithDiagnostics('timesheets:login', provider),
    logout: (provider: TimesheetProviderType) =>
      invokeWithDiagnostics('timesheets:logout', provider),
    listSheets: (provider: TimesheetProviderType) =>
      invokeWithDiagnostics('timesheets:listSheets', provider),
    inspectSheet: (params: {
      provider: TimesheetProviderType;
      sheetId: string;
      navigationUrl: string;
    }) => invokeWithDiagnostics('timesheets:inspectSheet', params),
    lookupAxisOptions: (
      params: TimesheetAxisLookupRequest & { provider: TimesheetProviderType },
    ) => invokeWithDiagnostics('timesheets:lookupAxisOptions', params),
    dryRun: (params: {
      provider: TimesheetProviderType;
      sheetId: string;
      entries: TimesheetEntryInput[];
      deletions?: TimesheetRowDeletion[];
      action: TimesheetAction;
    }) => invokeWithDiagnostics('timesheets:dryRun', params),
    save: (params: {
      provider: TimesheetProviderType;
      sheetId: string;
      entries: TimesheetEntryInput[];
      deletions?: TimesheetRowDeletion[];
      updates?: TimesheetRowUpdate[];
      action: TimesheetAction;
    }) => invokeWithDiagnostics('timesheets:save', params),
  },
  rateLimitSwap: {
    getStatus: () =>
      invokeWithDiagnostics('rate-limit-swap:status') as Promise<{
        active: boolean;
        swaps: Array<{ from: string; to: string }>;
      }>,
    resolve: (
      backend: import('@shared/agent-backend-types').AgentBackendType,
    ) =>
      invokeWithDiagnostics('rate-limit-swap:resolve', backend) as Promise<{
        backend: import('@shared/agent-backend-types').AgentBackendType;
        model?: string;
        thinkingEffort?: import('@shared/types').ThinkingEffort;
        swapped: boolean;
        skippedDueToRateLimit?: boolean;
      }>,
    /**
     * React to a real rate-limit event by activating the fallback profile.
     * Distinct from `resolve`, which is a side-effect-free probe.
     */
    react: (params: {
      backend: import('@shared/agent-backend-types').AgentBackendType;
      projectId?: string | null;
    }) =>
      invokeWithDiagnostics('rate-limit-swap:react', params) as Promise<{
        backend: import('@shared/agent-backend-types').AgentBackendType;
        model?: string;
        thinkingEffort?: import('@shared/types').ThinkingEffort;
        swapped: boolean;
        skippedDueToRateLimit?: boolean;
        profileId?: string;
        blocked?: {
          reason: 'backend-not-allowed' | 'profile-not-allowed';
          message: string;
          allowedBackends?: import('@shared/agent-backend-types').AgentBackendType[];
          allowedProfileIds?: string[];
        };
      }>,
  },
  usageDisplay: {
    saveSettings: (value: import('@shared/types').UsageDisplaySetting) =>
      invokeWithDiagnostics('usageDisplay:saveSettings', value),
  },
  codexbar: {
    getStatus: () => invokeWithDiagnostics('codexbar:getStatus'),
    openInstallPage: () => invokeWithDiagnostics('codexbar:openInstallPage'),
  },
  copilotAuth: {
    requestDeviceCode: () =>
      invokeWithDiagnostics('copilotAuth:requestDeviceCode'),
    completeDeviceLogin: (deviceCode: unknown) =>
      invokeWithDiagnostics('copilotAuth:completeDeviceLogin', deviceCode),
  },
  projectCommands: {
    findByProjectId: (projectId: string) =>
      invokeWithDiagnostics('project:commands:findByProjectId', projectId),
    findAll: () => invokeWithDiagnostics('project:commands:findAll'),
    findFavorites: () => invokeWithDiagnostics('project:commands:findFavorites'),
    create: (data: unknown) =>
      invokeWithDiagnostics('project:commands:create', data),
    update: (id: string, data: unknown) =>
      invokeWithDiagnostics('project:commands:update', { id, data }),
    delete: (id: string) => invokeWithDiagnostics('project:commands:delete', id),
    reorder: (projectId: string, commandIds: string[]) =>
      invokeWithDiagnostics('project:commands:reorder', { projectId, commandIds }),
  },
  projectCommandGroups: {
    findByProjectId: (projectId: string) =>
      invokeWithDiagnostics('project:commandGroups:findByProjectId', projectId),
    findAll: () => invokeWithDiagnostics('project:commandGroups:findAll'),
    findFavorites: () =>
      invokeWithDiagnostics('project:commandGroups:findFavorites'),
    create: (data: unknown) =>
      invokeWithDiagnostics('project:commandGroups:create', data),
    update: (id: string, data: unknown) =>
      invokeWithDiagnostics('project:commandGroups:update', { id, data }),
    delete: (id: string) =>
      invokeWithDiagnostics('project:commandGroups:delete', id),
    reorder: (projectId: string, groupIds: string[]) =>
      invokeWithDiagnostics('project:commandGroups:reorder', {
        projectId,
        groupIds,
      }),
  },
  projectRunConfig: {
    reorder: (projectId: string, items: unknown[]) =>
      invokeWithDiagnostics('project:runConfig:reorder', { projectId, items }),
  },
  runCommands: {
    startCommand: (params: {
      taskId: string;
      runCommandId: string;
    }) =>
      invokeWithDiagnostics('project:commands:run:startCommand', {
        taskId: params.taskId,
        runCommandId: params.runCommandId,
      }),
    startAdHocCommand: (params: StartAdHocRunCommandParams) =>
      invokeWithDiagnostics('project:commands:run:startAdHocCommand', params),
    startFavorite: (params: { projectId: string; runCommandId: string }) =>
      invokeWithDiagnostics('project:commands:run:startFavorite', params),
    startFavoriteGroup: (params: { projectId: string; groupId: string }) =>
      invokeWithDiagnostics('project:commands:run:startFavoriteGroup', params),
    startGroup: (params: {
      taskId: string;
      runCommandIds: string[];
      groupId?: string;
    }) =>
      invokeWithDiagnostics('project:commands:run:startGroup', {
        taskId: params.taskId,
        runCommandIds: params.runCommandIds,
        groupId: params.groupId,
      }),
    stopCommand: (params: { taskId: string; runCommandId: string }) =>
      invokeWithDiagnostics('project:commands:run:stopCommand', params),
    stopAll: () => invokeWithDiagnostics('project:commands:run:stopAll'),
    sendInput: (params: {
      taskId: string;
      runCommandId: string;
      input: string;
    }) => invokeWithDiagnostics('project:commands:run:sendInput', params),
    resetLogs: (params: {
      taskId: string;
      runCommandId: string;
      generation: number;
    }) => invokeWithDiagnostics('project:commands:run:resetLogs', params),
    sendSignal: (params: {
      taskId: string;
      runCommandId: string;
      signal: 'SIGINT' | 'SIGTERM';
    }) => invokeWithDiagnostics('project:commands:run:sendSignal', params),
    getStatus: (taskId: string) =>
      invokeWithDiagnostics('project:commands:run:getStatus', taskId),
    getTaskIdsWithRunningCommands: () =>
      invokeWithDiagnostics(
        'project:commands:run:getTaskIdsWithRunningCommands',
      ) as Promise<string[]>,
    killPortsForCommand: (projectId: string, commandId: string) =>
      invokeWithDiagnostics('project:commands:run:killPortsForCommand', {
        projectId,
        commandId,
      }),
    getPackageScripts: (projectPath: string) =>
      invokeWithDiagnostics('project:commands:run:getPackageScripts', projectPath),
    getProjectSuggestions: (projectPath: string) =>
      invokeWithDiagnostics(
        'project:commands:run:getProjectSuggestions',
        projectPath,
      ),
    saveProjectSuggestions: (projectPath: string, suggestions: unknown) =>
      invokeWithDiagnostics('project:commands:run:saveProjectSuggestions', {
        projectPath,
        suggestions,
      }),
    onStatusChange: (callback: (taskId: string, status: unknown) => void) => {
      const handler = (_: unknown, taskId: string, status: unknown) =>
        callback(taskId, status);
      ipcRenderer.on('project:commands:run:statusChange', handler);
      return () =>
        ipcRenderer.removeListener(
          'project:commands:run:statusChange',
          handler,
        );
    },
    onGroupAborted: (callback: (event: RunCommandGroupAbortEvent) => void) => {
      const handler = (_: unknown, event: RunCommandGroupAbortEvent) =>
        callback(event);
      ipcRenderer.on(RUN_COMMAND_GROUP_ABORT_CHANNEL, handler);
      return () =>
        ipcRenderer.removeListener(RUN_COMMAND_GROUP_ABORT_CHANNEL, handler);
    },
    onLog: (
      callback: (
        taskId: string,
        runCommandId: string,
        stream: 'stdout' | 'stderr',
        text: string,
        generation: number,
      ) => void,
    ) => {
      const handler = (
        _: unknown,
        taskId: string,
        runCommandId: string,
        stream: 'stdout' | 'stderr',
        text: string,
        generation: number,
      ) => callback(taskId, runCommandId, stream, text, generation);
      ipcRenderer.on('project:commands:run:log', handler);
      return () =>
        ipcRenderer.removeListener('project:commands:run:log', handler);
    },
    onLogsReset: (
      callback: (
        taskId: string,
        runCommandId: string,
        generation: number,
      ) => void,
    ) => {
      const handler = (
        _: unknown,
        taskId: string,
        runCommandId: string,
        generation: number,
      ) => callback(taskId, runCommandId, generation);
      ipcRenderer.on('project:commands:run:logsReset', handler);
      return () =>
        ipcRenderer.removeListener('project:commands:run:logsReset', handler);
    },
  },
  terminal: {
    ensure: (params: {
      sessionId: string;
      cwd: string;
      cols: number;
      rows: number;
    }) => invokeWithDiagnostics('project:terminal:ensure', params),
    write: (params: { sessionId: string; data: string }) =>
      invokeWithDiagnostics('project:terminal:write', params),
    resize: (params: { sessionId: string; cols: number; rows: number }) =>
      invokeWithDiagnostics('project:terminal:resize', params),
    close: (sessionId: string) =>
      invokeWithDiagnostics('project:terminal:close', sessionId),
    onData: (callback: (event: TerminalDataEvent) => void) => {
      const handler = (_: unknown, event: TerminalDataEvent) => callback(event);
      ipcRenderer.on(TERMINAL_DATA_CHANNEL, handler);
      return () => ipcRenderer.removeListener(TERMINAL_DATA_CHANNEL, handler);
    },
    onExit: (callback: (event: TerminalExitEvent) => void) => {
      const handler = (_: unknown, event: TerminalExitEvent) => callback(event);
      ipcRenderer.on(TERMINAL_EXIT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(TERMINAL_EXIT_CHANNEL, handler);
    },
  },
  globalPrompt: {
    onShow: (callback: (prompt: GlobalPrompt) => void) => {
      const handler = (_: unknown, prompt: GlobalPrompt) => callback(prompt);
      ipcRenderer.on('globalPrompt:show', handler);
      return () => ipcRenderer.removeListener('globalPrompt:show', handler);
    },
    onDismiss: (callback: (promptId: string) => void) => {
      const handler = (_: unknown, promptId: string) => callback(promptId);
      ipcRenderer.on('globalPrompt:dismiss', handler);
      return () => ipcRenderer.removeListener('globalPrompt:dismiss', handler);
    },
    respond: (response: GlobalPromptResponse) =>
      invokeWithDiagnostics('globalPrompt:respond', response),
  },
  mcpTemplates: {
    findAll: () => invokeWithDiagnostics('mcpTemplates:findAll'),
    findById: (id: string) => invokeWithDiagnostics('mcpTemplates:findById', id),
    create: (data: unknown) => invokeWithDiagnostics('mcpTemplates:create', data),
    update: (id: string, data: unknown) =>
      invokeWithDiagnostics('mcpTemplates:update', id, data),
    delete: (id: string) => invokeWithDiagnostics('mcpTemplates:delete', id),
    getPresets: () => invokeWithDiagnostics('mcpTemplates:getPresets'),
    getEnabledForProject: (projectId: string) =>
      invokeWithDiagnostics('mcpTemplates:getEnabledForProject', projectId),
  },
  projectMcpOverrides: {
    findByProjectId: (projectId: string) =>
      invokeWithDiagnostics('projectMcpOverrides:findByProjectId', projectId),
    upsert: (data: unknown) =>
      invokeWithDiagnostics('projectMcpOverrides:upsert', data),
    delete: (projectId: string, mcpTemplateId: string) =>
      invokeWithDiagnostics(
        'projectMcpOverrides:delete',
        projectId,
        mcpTemplateId,
      ),
  },
  unifiedMcp: {
    getServers: (projectId: string, projectPath: string) =>
      invokeWithDiagnostics('unifiedMcp:getServers', projectId, projectPath),
    activate: (projectPath: string, name: string, command: string) =>
      invokeWithDiagnostics('unifiedMcp:activate', projectPath, name, command),
    deactivate: (projectPath: string, name: string) =>
      invokeWithDiagnostics('unifiedMcp:deactivate', projectPath, name),
    substituteVariables: (
      commandTemplate: string,
      userVariables: Record<string, string>,
      context: {
        projectPath: string;
        projectName: string;
        branchName: string;
        mainRepoPath: string;
      },
    ) =>
      invokeWithDiagnostics(
        'unifiedMcp:substituteVariables',
        commandTemplate,
        userVariables,
        context,
      ),
  },
  globalMcp: {
    findAll: () => invokeWithDiagnostics('globalMcp:findAll'),
    findById: (id: string) => invokeWithDiagnostics('globalMcp:findById', id),
    create: (data: import('@shared/global-mcp-types').NewGlobalMcpServer) => invokeWithDiagnostics('globalMcp:create', data),
    update: (id: string, data: import('@shared/global-mcp-types').UpdateGlobalMcpServer) =>
      invokeWithDiagnostics('globalMcp:update', id, data),
    enable: (id: string, backends: import('@shared/agent-backend-types').AgentBackendType[]) =>
      invokeWithDiagnostics('globalMcp:enable', id, backends),
    disable: (id: string, backends: import('@shared/agent-backend-types').AgentBackendType[]) =>
      invokeWithDiagnostics('globalMcp:disable', id, backends),
    uninstall: (id: string) => invokeWithDiagnostics('globalMcp:uninstall', id),
    discover: () => invokeWithDiagnostics('globalMcp:discover'),
    import: (entry: import('@shared/global-mcp-types').DiscoveredMcpVariant, backends: import('@shared/agent-backend-types').AgentBackendType[]) =>
      invokeWithDiagnostics('globalMcp:import', entry, backends),
  },
  claudeProjects: {
    findNonExistent: () => invokeWithDiagnostics('claudeProjects:findNonExistent'),
    cleanup: (params: { paths: string[]; contentHash: string }) =>
      invokeWithDiagnostics('claudeProjects:cleanup', params),
  },
  unusedWorktrees: {
    scan: () => invokeWithDiagnostics('unusedWorktrees:scan'),
    cleanup: (params: { paths: string[] }) =>
      invokeWithDiagnostics('unusedWorktrees:cleanup', params),
  },
  completion: {
    complete: (params: {
      prompt: string;
      suffix?: string;
      projectId?: string;
      contextBeforePrompt?: string;
    }) => invokeWithDiagnostics('completion:complete', params),
    test: () => invokeWithDiagnostics('completion:test'),
    saveSettings: (params: {
      enabled: boolean;
      apiKey: string;
      model: string;
      serverUrl: string;
    }) => invokeWithDiagnostics('completion:saveSettings', params),
    generateContext: (params: { projectId: string }) =>
      invokeWithDiagnostics('completion:generateContext', params),
    getDailyUsage: () => invokeWithDiagnostics('completion:getDailyUsage'),
  },
  aiGeneration: {
    saveSettings: (params: {
      openAiApiKey: string;
      openAiImageGenerationEnabled: boolean;
      openAiImageModel: string;
      openAiLogoPromptContext: string;
    }) => invokeWithDiagnostics('aiGeneration:saveSettings', params),
    saveBaseImage: (params: { sourcePath: string }) =>
      invokeWithDiagnostics('aiGeneration:saveBaseImage', params),
    listBaseImages: () => invokeWithDiagnostics('aiGeneration:listBaseImages'),
    setBaseImageSelection: (params: {
      mode: 'builtin' | 'custom';
      builtinId?: string;
    }) => invokeWithDiagnostics('aiGeneration:setBaseImageSelection', params),
    removeBaseImage: () => invokeWithDiagnostics('aiGeneration:removeBaseImage'),
  },
  projectTodos: {
    list: (projectId: string) =>
      invokeWithDiagnostics('project-todos:list', projectId),
    count: (projectId: string) =>
      invokeWithDiagnostics('project-todos:count', projectId),
    create: (data: unknown) => invokeWithDiagnostics('project-todos:create', data),
    update: (id: string, data: unknown) =>
      invokeWithDiagnostics('project-todos:update', id, data),
    delete: (id: string) => invokeWithDiagnostics('project-todos:delete', id),
    reorder: (projectId: string, orderedIds: string[]) =>
      invokeWithDiagnostics('project-todos:reorder', projectId, orderedIds),
  },
  agentManagement: {
    getAll: () => invokeWithDiagnostics('agents:getAll'),
    getContent: (agentPath: string) =>
      invokeWithDiagnostics('agents:getContent', agentPath),
    create: (params: {
      enabledBackends: string[];
      name: string;
      description: string;
      content: string;
    }) => invokeWithDiagnostics('agents:create', params),
    update: (params: { agentPath: string; content: string }) =>
      invokeWithDiagnostics('agents:update', params),
    delete: (agentPath: string) =>
      invokeWithDiagnostics('agents:delete', agentPath),
    disable: (agentPath: string, backendType: string) =>
      invokeWithDiagnostics('agents:disable', agentPath, backendType),
    enable: (agentPath: string, backendType: string) =>
      invokeWithDiagnostics('agents:enable', agentPath, backendType),
    migrationPreview: () => invokeWithDiagnostics('agents:migrationPreview'),
    migrationExecute: (params: { itemIds: string[] }) =>
      invokeWithDiagnostics('agents:migrationExecute', params),
  },
  skillManagement: {
    getForStep: (params: { taskId: string; stepId?: string }) =>
      invokeWithDiagnostics('skills:getForStep', params),
    getAll: (backendType: string, projectPath?: string) =>
      invokeWithDiagnostics('skills:getAll', backendType, projectPath),
    getAllUnified: (projectPath?: string) =>
      invokeWithDiagnostics('skills:getAllUnified', projectPath),
    getContent: (skillPath: string) =>
      invokeWithDiagnostics('skills:getContent', skillPath),
    create: (params: {
      enabledBackends: string[];
      scope: string;
      projectPath?: string;
      name: string;
      description: string;
      content: string;
    }) => invokeWithDiagnostics('skills:create', params),
    update: (params: {
      skillPath: string;
      backendType: string;
      name?: string;
      description?: string;
      content?: string;
    }) => invokeWithDiagnostics('skills:update', params),
    delete: (skillPath: string, backendType: string) =>
      invokeWithDiagnostics('skills:delete', skillPath, backendType),
    disable: (skillPath: string, backendType: string) =>
      invokeWithDiagnostics('skills:disable', skillPath, backendType),
    enable: (skillPath: string, backendType: string) =>
      invokeWithDiagnostics('skills:enable', skillPath, backendType),
    migrationPreview: () => invokeWithDiagnostics('skills:migrationPreview'),
    migrationExecute: (params: { itemIds: string[] }) =>
      invokeWithDiagnostics('skills:migrationExecute', params),
    registrySearch: (query: string) =>
      invokeWithDiagnostics('skills:registrySearch', query),
    registryFetchContent: (source: string, skillId: string) =>
      invokeWithDiagnostics('skills:registryFetchContent', source, skillId),
    registryInstall: (params: {
      source: string;
      skillId: string;
      enabledBackends: string[];
    }) => invokeWithDiagnostics('skills:registryInstall', params),
    createWithAgent: (params: {
      prompt: string;
      enabledBackends: string[];
      mode: 'create' | 'improve';
      sourceSkillPath?: string;
      interactionMode?: string | null;
      modelPreference?: string | null;
      agentBackend?: string | null;
    }) => invokeWithDiagnostics('skills:createWithAgent', params),
    publishFromWorkspace: (params: {
      stepId: string;
      workspacePath: string;
      enabledBackends: string[];
      mode: 'create' | 'improve';
      sourceSkillPath?: string;
    }) => invokeWithDiagnostics('skills:publishFromWorkspace', params),
  },
  sourceManagement: {
    list: () => invokeWithDiagnostics('sources:list'),
    addGithub: (params: AddGitHubSourceParams) =>
      invokeWithDiagnostics('sources:addGithub', params),
    refresh: (sourceId: string) =>
      invokeWithDiagnostics('sources:refresh', sourceId),
    installItems: (params: InstallSourceItemsParams) =>
      invokeWithDiagnostics('sources:installItems', params),
    updateInstall: (params: UpdateSourceInstallParams) =>
      invokeWithDiagnostics('sources:updateInstall', params),
    remove: (sourceId: string) =>
      invokeWithDiagnostics('sources:remove', sourceId),
  },
  prSnapshots: {
    record: (params: {
      projectId: string;
      pullRequestId: number;
      providerId: string;
      repoProjectId: string;
      repoId: string;
    }) => invokeWithDiagnostics('pr-snapshots:record', params),
  },
  notifications: {
    list: () => invokeWithDiagnostics('notifications:list'),
    getDesktopStatus: async () => ({
      ...(await invokeWithDiagnostics('notifications:getDesktopStatus')),
      permission:
        typeof Notification === 'undefined'
          ? 'unknown'
          : Notification.permission,
    }),
    openSystemSettings: () =>
      invokeWithDiagnostics('notifications:openSystemSettings'),
    markRead: (id: string | 'all') =>
      invokeWithDiagnostics('notifications:markRead', id),
    delete: (id: string) => invokeWithDiagnostics('notifications:delete', id),
    onNew: (callback: (notification: AppNotification) => void) => {
      const handler = (_: unknown, notification: AppNotification) =>
        callback(notification);
      ipcRenderer.on('notifications:new', handler);
      return () => ipcRenderer.removeListener('notifications:new', handler);
    },
    onOpenTask: (callback: (target: TaskNotificationTarget) => void) => {
      const handler = (_: unknown, target: TaskNotificationTarget) =>
        callback(target);
      ipcRenderer.on('notifications:open-task', handler);
      return () =>
        ipcRenderer.removeListener('notifications:open-task', handler);
    },
  },
  trackedPipelines: {
    list: (projectId: string) =>
      invokeWithDiagnostics('tracked-pipelines:list', projectId),
    listAll: () => invokeWithDiagnostics('tracked-pipelines:listAll'),
    toggle: (id: string, enabled: boolean) =>
      invokeWithDiagnostics('tracked-pipelines:toggle', id, enabled),
    toggleVisible: (id: string, visible: boolean) =>
      invokeWithDiagnostics('tracked-pipelines:toggleVisible', id, visible),
    reorder: (projectId: string, orderedIds: string[]) =>
      invokeWithDiagnostics('tracked-pipelines:reorder', projectId, orderedIds),
    discover: (projectId: string) =>
      invokeWithDiagnostics('tracked-pipelines:discover', projectId),
  },
  pipelines: {
    listRuns: (params: {
      providerId: string;
      azureProjectId: string;
      definitionId: number;
      kind: 'build' | 'release';
    }) => invokeWithDiagnostics('pipelines:listRuns', params),
    getBuild: (params: {
      providerId: string;
      azureProjectId: string;
      buildId: number;
    }) => invokeWithDiagnostics('pipelines:getBuild', params),
    getBuildTimeline: (params: {
      providerId: string;
      azureProjectId: string;
      buildId: number;
    }) => invokeWithDiagnostics('pipelines:getBuildTimeline', params),
    getBuildLog: (params: {
      providerId: string;
      azureProjectId: string;
      buildId: number;
      logId: number;
    }) => invokeWithDiagnostics('pipelines:getBuildLog', params),
    getRelease: (params: {
      providerId: string;
      azureProjectId: string;
      releaseId: number;
    }) => invokeWithDiagnostics('pipelines:getRelease', params),
    listBranches: (params: {
      providerId: string;
      azureProjectId: string;
      repoId: string;
    }) => invokeWithDiagnostics('pipelines:listBranches', params),
    getDefinitionParams: (params: {
      providerId: string;
      azureProjectId: string;
      definitionId: number;
    }) => invokeWithDiagnostics('pipelines:getDefinitionParams', params),
    getYamlParameters: (params: GetYamlParametersIpcParams) =>
      invokeWithDiagnostics('pipelines:getYamlParameters', params),
    queueBuild: (params: QueueBuildIpcParams) =>
      invokeWithDiagnostics('pipelines:queueBuild', params),
    createRelease: (params: {
      providerId: string;
      azureProjectId: string;
      definitionId: number;
      description?: string;
    }) => invokeWithDiagnostics('pipelines:createRelease', params),
    cancelBuild: (params: {
      providerId: string;
      azureProjectId: string;
      buildId: number;
    }) => invokeWithDiagnostics('pipelines:cancelBuild', params),
  },
  feed: {
    getItems: () => invokeWithDiagnostics('feed:getItems'),
    getTaskItems: () => invokeWithDiagnostics('feed:getTaskItems'),
    getPullRequestItems: () => invokeWithDiagnostics('feed:getPullRequestItems'),
    getNoteItems: () => invokeWithDiagnostics('feed:getNoteItems'),
    getWorkItemItems: () => invokeWithDiagnostics('feed:getWorkItemItems'),
    createNote: (params: { content: string }) =>
      invokeWithDiagnostics('feed:createNote', params),
    createWorkItemVerificationNote: (
      params: CreateWorkItemVerificationNoteParams,
    ) => invokeWithDiagnostics('feed:createWorkItemVerificationNote', params),
    updateNote: (params: {
      id: string;
      content?: string;
      completedAt?: string | null;
    }) => invokeWithDiagnostics('feed:updateNote', params),
    deleteNote: (params: { id: string }) =>
      invokeWithDiagnostics('feed:deleteNote', params),
  },
  app: {
    isDevMode: !!process.env.ELECTRON_RENDERER_URL,
    devBadgeLabel,
    hasExistingLocalStorageBucket,
    getIsPreviewMode: () =>
      invokeWithDiagnostics('app:getIsPreviewMode') as Promise<boolean>,
    reportLocalStorageBootBlocked: () =>
      invokeWithDiagnostics(
        'app:reportLocalStorageBootBlocked',
      ) as Promise<string>,
    getReloadUpdateInfo: (params: { builtCommitHash: string }) =>
      invokeWithDiagnostics('app:getReloadUpdateInfo', params) as Promise<{
        commitCount: number;
        latestCommitHash: string | null;
      }>,
    reloadPreview: () =>
      invokeWithDiagnostics('app:reloadPreview') as Promise<void>,
    onReloadPreviewProgress: (
      callback: (progress: {
        step:
          | 'starting'
          | 'stopping-commands'
          | 'pulling'
          | 'building'
          | 'launching'
          | 'restarting';
        label: string;
        detail?: string;
      }) => void,
    ) => {
      const handler = (_: unknown, progress: Parameters<typeof callback>[0]) =>
        callback(progress);
      ipcRenderer.on('app:reloadPreviewProgress', handler);
      return () =>
        ipcRenderer.removeListener('app:reloadPreviewProgress', handler);
    },
  },
  system: {
    getMemoryUsage: () => invokeWithDiagnostics('system:getMemoryUsage'),
  },
  debugLogs: {
    onBatch: (callback: (entries: DebugLogEntry[]) => void) => {
      const handler = (_: unknown, entries: DebugLogEntry[]) =>
        callback(entries);
      ipcRenderer.on('debug:log-batch', handler);
      return () => ipcRenderer.removeListener('debug:log-batch', handler);
    },
  },
  codeFolding: {
    getFoldRanges: (content: string, language: string) =>
      invokeWithDiagnostics('codeFolding:getFoldRanges', content, language),
  },
  onRateLimitSwap: (callback: (data: { from: string; to: string }) => void) => {
    const handler = (_: unknown, data: { from: string; to: string }) =>
      callback(data);
    ipcRenderer.on('rate-limit-swap:triggered', handler);
    return () =>
      ipcRenderer.removeListener('rate-limit-swap:triggered', handler);
  },
});
console.log('Preload script loaded');
