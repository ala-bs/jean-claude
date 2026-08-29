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
  MobilePreviewAndroidAppTrustParams,
  MobilePreviewAndroidCreateDeviceParams,
  MobilePreviewAndroidInstallSystemImageParams,
  MobilePreviewAttachSessionParams,
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
  MobilePreviewListSessionsParams,
  MobilePreviewNativeLogEvent,
  MobilePreviewNativeLogSessionEvent,
  MobilePreviewNativeLogStartParams,
  MobilePreviewNetworkProxyCertificateParams,
  MobilePreviewNetworkProxyEvent,
  MobilePreviewNetworkProxySessionEvent,
  MobilePreviewNetworkProxyStartParams,
  MobilePreviewOpenDeeplinkParams,
  MobilePreviewOpenDevMenuParams,
  MobilePreviewPacketCaptureEvent,
  MobilePreviewPacketCaptureSessionEvent,
  MobilePreviewPacketCaptureStartParams,
  MobilePreviewReloadExpoParams,
  MobilePreviewSessionEvent,
  MobilePreviewSetTextSizeParams,
  MobilePreviewStartParams,
  MobileRotationDirection,
  ReactNativeDevToolsEmbeddedBoundsParams,
  ReactNativeDevToolsEmbeddedCloseParams,
  ReactNativeDevToolsEmbeddedOpenParams,
  ReactNativeDevToolsEmbeddedVisibilityParams,
  ReactNativeDevToolsOpenParams,
  ReactNativeDevToolsResolveParams,
} from '@shared/mobile-simulator-types';
import type {
  NewWorkActivityEvent,
  WorkActivityWeekParams,
} from '@shared/work-activity-types';
import {
  START_PR_COMMAND_CHANNEL,
  type StartPrCommandParams,
} from '@shared/run-command-types';
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
import { AGENT_CHANNELS } from '@shared/agent-types';
import type { AiUsageDashboardParams } from '@shared/ai-usage-types';
import type { CreateWorkItemVerificationNoteParams } from '@shared/work-item-verification-note-types';
import type { DebugLogEntry } from '@shared/debug-log-types';
import type { StartAdHocRunCommandParams } from '@shared/run-command-types';

const devBadgeLabel = process.env.JC_DEV_BADGE_LABEL?.trim() || undefined;

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
    getIsFullscreen: () => ipcRenderer.invoke('windowState:getIsFullscreen'),
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
      ipcRenderer.invoke('cache:setSubscriptions', update),
    onEvent: (callback: (event: CacheEvent) => void) => {
      const handler = (_: unknown, event: CacheEvent) => callback(event);
      ipcRenderer.on('cache:event', handler);
      return () => ipcRenderer.removeListener('cache:event', handler);
    },
  },
  projects: {
    findAll: () => ipcRenderer.invoke('projects:findAll'),
    listEnvVars: (projectId: string) =>
      ipcRenderer.invoke('projects:listEnvVars', projectId),
    createEnvVar: (data: unknown) =>
      ipcRenderer.invoke('projects:createEnvVar', data),
    updateEnvVar: (id: string, data: unknown) =>
      ipcRenderer.invoke('projects:updateEnvVar', id, data),
    deleteEnvVar: (id: string) =>
      ipcRenderer.invoke('projects:deleteEnvVar', id),
    isSecretStorageAvailable: () =>
      ipcRenderer.invoke('projects:isSecretStorageAvailable'),
    findById: (id: string) => ipcRenderer.invoke('projects:findById', id),
    create: (data: unknown) => ipcRenderer.invoke('projects:create', data),
    update: (id: string, data: unknown) =>
      ipcRenderer.invoke('projects:update', id, data),
    detectMobilePreview: (projectId: string) =>
      ipcRenderer.invoke('projects:detectMobilePreview', projectId),
    detectAzureRemote: (projectPath: string) =>
      ipcRenderer.invoke('projects:detectAzureRemote', projectPath),
    uploadLogo: (projectId: string, sourcePath: string) =>
      ipcRenderer.invoke('projects:uploadLogo', projectId, sourcePath),
    generateLogo: (projectId: string, customPrompt?: string) =>
      ipcRenderer.invoke('projects:generateLogo', projectId, customPrompt),
    listGeneratedLogos: (projectId: string) =>
      ipcRenderer.invoke('projects:listGeneratedLogos', projectId),
    selectGeneratedLogo: (projectId: string, logoId: string) =>
      ipcRenderer.invoke('projects:selectGeneratedLogo', projectId, logoId),
    deleteGeneratedLogo: (projectId: string, logoId: string) =>
      ipcRenderer.invoke('projects:deleteGeneratedLogo', projectId, logoId),
    regenerateSummary: (projectId: string) =>
      ipcRenderer.invoke('projects:regenerateSummary', projectId),
    getFeatureMap: (projectId: string) =>
      ipcRenderer.invoke('projects:getFeatureMap', projectId),
    createFeatureMapTask: (projectId: string) =>
      ipcRenderer.invoke('projects:createFeatureMapTask', projectId),
    getFeatureMapDraftDiff: (stepId: string) =>
      ipcRenderer.invoke('projects:getFeatureMapDraftDiff', stepId),
    saveFeatureMapFromTask: (stepId: string) =>
      ipcRenderer.invoke('projects:saveFeatureMapFromTask', stepId),
    removeLogo: (projectId: string) =>
      ipcRenderer.invoke('projects:removeLogo', projectId),
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id),
    deleteWorktreesFolder: (projectId: string) =>
      ipcRenderer.invoke('projects:deleteWorktreesFolder', projectId),
    reorder: (orderedIds: string[]) =>
      ipcRenderer.invoke('projects:reorder', orderedIds),
    getBranches: (projectId: string) =>
      ipcRenderer.invoke('projects:getBranches', projectId),
    getBranchesForPath: (projectPath: string) =>
      ipcRenderer.invoke('projects:getBranchesForPath', projectPath),
    getCurrentBranch: (projectId: string) =>
      ipcRenderer.invoke('projects:getCurrentBranch', projectId),
    isGitRepository: (projectId: string) =>
      ipcRenderer.invoke('projects:isGitRepository', projectId),
    getCommitIgnore: (projectId: string) =>
      ipcRenderer.invoke('projects:getCommitIgnore', projectId),
    updateCommitIgnore: (projectId: string, content: string) =>
      ipcRenderer.invoke('projects:updateCommitIgnore', projectId, content),
    getDetected: () => ipcRenderer.invoke('projects:getDetected'),
    detectLogos: (projectPath: string) =>
      ipcRenderer.invoke('projects:detectLogos', projectPath),
    getSkills: (projectId: string) =>
      ipcRenderer.invoke('projects:getSkills', projectId),
  },
  agentMemory: {
    getDashboard: (params: {
      projectId?: string;
      evidencePage?: number;
      extractionRunPage?: number;
      pageSize?: number;
    }): Promise<AgentMemoryDashboard> =>
      ipcRenderer.invoke('agentMemory:getDashboard', params),
    extractNow: (
      projectId: string,
    ): Promise<{ processed: boolean; run: AgentMemoryExtractionRun | null }> =>
      ipcRenderer.invoke('agentMemory:extractNow', projectId),
    retryRun: (params: {
      projectId?: string;
      runId: string;
      scope: 'project' | 'global';
    }): Promise<{ processed: boolean; run: AgentMemoryExtractionRun | null }> =>
      ipcRenderer.invoke('agentMemory:retryRun', params),
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
    findAll: () => ipcRenderer.invoke('tasks:findAll'),
    findByProjectId: (projectId: string) =>
      ipcRenderer.invoke('tasks:findByProjectId', projectId),
    findAllActive: () => ipcRenderer.invoke('tasks:findAllActive'),
    findAllCompleted: (params: { limit: number; offset: number }) =>
      ipcRenderer.invoke('tasks:findAllCompleted', params),
    findById: (id: string) => ipcRenderer.invoke('tasks:findById', id),
    create: (data: unknown) => ipcRenderer.invoke('tasks:create', data),
    createWithWorktree: (data: unknown) =>
      ipcRenderer.invoke('tasks:createWithWorktree', data),
    update: (id: string, data: unknown) =>
      ipcRenderer.invoke('tasks:update', id, data),
    updatePendingMessage: (id: string, pendingMessage: string | null) =>
      ipcRenderer.invoke('tasks:updatePendingMessage', id, pendingMessage),
    setSourceBranch: (params: { taskId: string; sourceBranch: string }) =>
      ipcRenderer.invoke('tasks:setSourceBranch', params),
    setBranchName: (params: { taskId: string; branchName: string }) =>
      ipcRenderer.invoke('tasks:setBranchName', params),
    delete: (id: string, options?: { deleteWorktree?: boolean }) =>
      ipcRenderer.invoke('tasks:delete', id, options),
    deletePrWorkspaceTask: (params: { taskId: string }) =>
      ipcRenderer.invoke('tasks:deletePrWorkspaceTask', params),
    deleteAllPrWorkspaces: (params: {
      projectId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('tasks:deleteAllPrWorkspaces', params),
    toggleUserCompleted: (id: string) =>
      ipcRenderer.invoke('tasks:toggleUserCompleted', id),
    complete: (id: string, options: { cleanupWorktree?: boolean }) =>
      ipcRenderer.invoke('tasks:complete', id, options),
    clearUserCompleted: (id: string) =>
      ipcRenderer.invoke('tasks:clearUserCompleted', id),
    reorder: (projectId: string, activeIds: string[], completedIds: string[]) =>
      ipcRenderer.invoke('tasks:reorder', projectId, activeIds, completedIds),
    worktree: {
      getDiff: (taskId: string) =>
        ipcRenderer.invoke('tasks:worktree:getDiff', taskId),
      getLocalChanges: (taskId: string) =>
        ipcRenderer.invoke('tasks:worktree:getLocalChanges', taskId),
      getCommits: (taskId: string) =>
        ipcRenderer.invoke('tasks:worktree:getCommits', taskId),
      getCommitDiff: (taskId: string, commitHash: string) =>
        ipcRenderer.invoke('tasks:worktree:getCommitDiff', taskId, commitHash),
      getCommitFileContent: (
        taskId: string,
        commitHash: string,
        filePath: string,
        status: 'added' | 'modified' | 'deleted',
      ) =>
        ipcRenderer.invoke(
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
        ipcRenderer.invoke(
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
        ipcRenderer.invoke(
          'tasks:worktree:getLocalFileContent',
          taskId,
          filePath,
          status,
          scope,
          originalPath,
        ),
      getStatus: (taskId: string) =>
        ipcRenderer.invoke('tasks:worktree:getStatus', taskId),
      commit: (
        taskId: string,
        params: { message?: string; stageAll: boolean },
      ) => ipcRenderer.invoke('tasks:worktree:commit', taskId, params),
      generateCommitMessage: (taskId: string, params: { stageAll: boolean }) =>
        ipcRenderer.invoke(
          'tasks:worktree:generateCommitMessage',
          taskId,
          params,
        ),
      checkMergeConflicts: (taskId: string, params: { targetBranch: string }) =>
        ipcRenderer.invoke(
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
      ) => ipcRenderer.invoke('tasks:worktree:merge', taskId, params),
      getBranches: (taskId: string) =>
        ipcRenderer.invoke('tasks:worktree:getBranches', taskId),
      pushBranch: (taskId: string, params?: { commitUnstaged?: boolean }) =>
        ipcRenderer.invoke('tasks:worktree:pushBranch', taskId, params),
      pullBranch: (taskId: string) =>
        ipcRenderer.invoke('tasks:worktree:pullBranch', taskId),
      delete: (taskId: string, options?: { keepBranch?: boolean }) =>
        ipcRenderer.invoke('tasks:worktree:delete', taskId, options),
    },
    summary: {
      get: (taskId: string) => ipcRenderer.invoke('tasks:summary:get', taskId),
      generate: (taskId: string) =>
        ipcRenderer.invoke('tasks:summary:generate', taskId),
    },
    createPullRequest: (params: {
      taskId: string;
      title: string;
      description: string;
      isDraft: boolean;
      deleteWorktree?: boolean;
    }) => ipcRenderer.invoke('tasks:createPullRequest', params),
    createPrReviewTask: (params: {
      projectId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('tasks:createPrReviewTask', params),
    startPrCommand: (params: StartPrCommandParams) =>
      ipcRenderer.invoke(START_PR_COMMAND_CHANNEL, params),
  },
  steps: {
    findByTaskId: (taskId: string) =>
      ipcRenderer.invoke('steps:findByTaskId', taskId),
    findById: (stepId: string) => ipcRenderer.invoke('steps:findById', stepId),
    create: (data: unknown) => ipcRenderer.invoke('steps:create', data),
    createPrReviewChatStep: (params: {
      taskId: string;
      pullRequestId: number;
      filePath: string;
      lineStart: number;
      lineEnd?: number;
      side?: 'old' | 'new';
      selectedText: string;
      question: string;
    }) => ipcRenderer.invoke('steps:createPrReviewChatStep', params),
    continuePrReviewChatStep: (params: { stepId: string; question: string }) =>
      ipcRenderer.invoke('steps:continuePrReviewChatStep', params),
    update: (stepId: string, data: unknown) =>
      ipcRenderer.invoke('steps:update', stepId, data),
    archive: (stepId: string) => ipcRenderer.invoke('steps:archive', stepId),
    resolvePrompt: (stepId: string) =>
      ipcRenderer.invoke('steps:resolvePrompt', stepId),
    setMode: (stepId: string, mode: string) =>
      ipcRenderer.invoke('steps:setMode', stepId, mode),
    setAutoAccept: (stepId: string, enabled: boolean) =>
      ipcRenderer.invoke('steps:setAutoAccept', stepId, enabled),
    getAutoAccept: (stepId: string) =>
      ipcRenderer.invoke('steps:getAutoAccept', stepId),
    submitPrReview: (stepId: string) =>
      ipcRenderer.invoke('steps:submitPrReview', stepId),
    addSessionAllowedTool: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) => ipcRenderer.invoke('steps:addSessionAllowedTool', params),
    removeSessionAllowedTool: (params: {
      stepId: string;
      toolName: string;
      pattern?: string;
    }) => ipcRenderer.invoke('steps:removeSessionAllowedTool', params),
    allowForProject: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) => ipcRenderer.invoke('steps:allowForProject', params),
    allowForProjectWorktrees: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) => ipcRenderer.invoke('steps:allowForProjectWorktrees', params),
    allowGlobally: (params: {
      stepId: string;
      toolName: string;
      input: Record<string, unknown>;
    }) => ipcRenderer.invoke('steps:allowGlobally', params),
  },
  providers: {
    findAll: () => ipcRenderer.invoke('providers:findAll'),
    findById: (id: string) => ipcRenderer.invoke('providers:findById', id),
    findByTokenId: (tokenId: string) =>
      ipcRenderer.invoke('providers:findByTokenId', tokenId),
    create: (data: unknown) => ipcRenderer.invoke('providers:create', data),
    update: (id: string, data: unknown) =>
      ipcRenderer.invoke('providers:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('providers:delete', id),
    getDetails: (providerId: string) =>
      ipcRenderer.invoke('providers:getDetails', providerId),
  },
  tokens: {
    findAll: () => ipcRenderer.invoke('tokens:findAll'),
    findById: (id: string) => ipcRenderer.invoke('tokens:findById', id),
    findByProviderType: (providerType: string) =>
      ipcRenderer.invoke('tokens:findByProviderType', providerType),
    create: (data: unknown) => ipcRenderer.invoke('tokens:create', data),
    update: (id: string, data: unknown) =>
      ipcRenderer.invoke('tokens:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('tokens:delete', id),
  },
  azureDevOps: {
    getOrganizations: (tokenId: string) =>
      ipcRenderer.invoke('azureDevOps:getOrganizations', tokenId),
    validateToken: (token: string) =>
      ipcRenderer.invoke('azureDevOps:validateToken', token),
    getTokenExpiration: (tokenId: string) =>
      ipcRenderer.invoke('azureDevOps:getTokenExpiration', tokenId),
    getCurrentUser: (providerId: string) =>
      ipcRenderer.invoke('azureDevOps:getCurrentUser', providerId),
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
    }) => ipcRenderer.invoke('azureDevOps:queryWorkItems', params),
    queryWorkItemOwners: (params: {
      providerId: string;
      projectName: string;
    }) => ipcRenderer.invoke('azureDevOps:queryWorkItemOwners', params),
    getWorkItemById: (params: { providerId: string; workItemId: number }) =>
      ipcRenderer.invoke('azureDevOps:getWorkItemById', params),
    getWorkItemsByIds: (params: {
      providerId: string;
      projectName: string;
      workItemIds: number[];
    }) => ipcRenderer.invoke('azureDevOps:getWorkItemsByIds', params),
    getPullRequestStatuses: (params: {
      providerId: string;
      linkedPrs: Array<{ prId: number; projectId: string; repoId: string }>;
    }) => ipcRenderer.invoke('azureDevOps:getPullRequestStatuses', params),
    getWorkItemStates: (params: {
      providerId: string;
      projectName: string;
      workItemType: string;
    }) => ipcRenderer.invoke('azureDevOps:getWorkItemStates', params),
    getBoardColumns: (params: {
      providerId: string;
      projectId: string;
      projectName: string;
    }) => ipcRenderer.invoke('azureDevOps:getBoardColumns', params),
    updateWorkItemState: (params: {
      providerId: string;
      workItemId: number;
      state: string;
    }) => ipcRenderer.invoke('azureDevOps:updateWorkItemState', params),
    updateWorkItemField: (params: {
      providerId: string;
      workItemId: number;
      field: string;
      value: string | number | null;
    }) => ipcRenderer.invoke('azureDevOps:updateWorkItemField', params),
    updateWorkItemBoardColumn: (params: {
      providerId: string;
      projectId: string;
      projectName: string;
      workItemId: number;
      column: string;
      teamId: string;
      boardId: string;
    }) => ipcRenderer.invoke('azureDevOps:updateWorkItemBoardColumn', params),
    getRelatedTestCases: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => ipcRenderer.invoke('azureDevOps:getRelatedTestCases', params),
    getWorkItemComments: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => ipcRenderer.invoke('azureDevOps:getWorkItemComments', params),
    getWorkItemSummary: (params: {
      projectId: string;
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => ipcRenderer.invoke('azureDevOps:getWorkItemSummary', params),
    generateWorkItemSummary: (params: {
      projectId: string;
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => ipcRenderer.invoke('azureDevOps:generateWorkItemSummary', params),
    getCachedWorkItemSummaries: (params: {
      providerId: string;
      workItemIds: number[];
    }) => ipcRenderer.invoke('azureDevOps:getCachedWorkItemSummaries', params),
    getWorkItemHistory: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
    }) => ipcRenderer.invoke('azureDevOps:getWorkItemHistory', params),
    addWorkItemComment: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
      text: string;
    }) => ipcRenderer.invoke('azureDevOps:addWorkItemComment', params),
     updateWorkItemComment: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
      commentId: number;
      text: string;
     }) => ipcRenderer.invoke('azureDevOps:updateWorkItemComment', params),
     setWorkItemCommentReaction: (params: {
       providerId: string;
       projectName: string;
       workItemId: number;
       commentId: number;
       reactionType: 'like' | 'dislike' | 'heart' | 'hooray' | 'smile' | 'confused';
       engaged: boolean;
     }) => ipcRenderer.invoke('azureDevOps:setWorkItemCommentReaction', params),
    uploadWorkItemAttachment: (params: {
      providerId: string;
      projectName: string;
      filename: string;
      mimeType: string;
      base64: string;
    }) => ipcRenderer.invoke('azureDevOps:uploadWorkItemAttachment', params),
    getIterations: (params: { providerId: string; projectName: string }) =>
      ipcRenderer.invoke('azureDevOps:getIterations', params),
    createPullRequest: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
      isDraft: boolean;
    }) => ipcRenderer.invoke('azureDevOps:createPullRequest', params),
    cloneRepository: (params: {
      orgName: string;
      projectName: string;
      repoName: string;
      targetPath: string;
    }) => ipcRenderer.invoke('azureDevOps:cloneRepository', params),
    listPullRequests: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      status?: 'active' | 'completed' | 'abandoned' | 'all';
    }) => ipcRenderer.invoke('azureDevOps:listPullRequests', params),
    getPullRequest: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('azureDevOps:getPullRequest', params),
    updatePullRequestTitle: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      title: string;
    }) => ipcRenderer.invoke('azureDevOps:updatePullRequestTitle', params),
    updatePullRequestDescription: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      description: string;
    }) =>
      ipcRenderer.invoke('azureDevOps:updatePullRequestDescription', params),
    getPullRequestTags: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('azureDevOps:getPullRequestTags', params),
    addPullRequestTag: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      name: string;
    }) => ipcRenderer.invoke('azureDevOps:addPullRequestTag', params),
    removePullRequestTag: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      name: string;
    }) => ipcRenderer.invoke('azureDevOps:removePullRequestTag', params),
    uploadPullRequestAttachment: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      fileName: string;
      mimeType: string;
      dataBase64: string;
    }) => ipcRenderer.invoke('azureDevOps:uploadPullRequestAttachment', params),
    getPullRequestCommits: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('azureDevOps:getPullRequestCommits', params),
    getPullRequestChanges: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('azureDevOps:getPullRequestChanges', params),
    getCommitChanges: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      commitId: string;
    }) => ipcRenderer.invoke('azureDevOps:getCommitChanges', params),
    getFileContentAtCommit: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      commitId: string;
      filePath: string;
      version: 'current' | 'parent';
    }) => ipcRenderer.invoke('azureDevOps:getFileContentAtCommit', params),
    getPullRequestFileContent: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      filePath: string;
      version: 'base' | 'head';
    }) => ipcRenderer.invoke('azureDevOps:getPullRequestFileContent', params),
    getPullRequestThreads: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('azureDevOps:getPullRequestThreads', params),
    getPullRequestWorkItems: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('azureDevOps:getPullRequestWorkItems', params),
    linkWorkItemToPr: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      workItemId: number;
    }) => ipcRenderer.invoke('azureDevOps:linkWorkItemToPr', params),
    unlinkWorkItemFromPr: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      workItemId: number;
    }) => ipcRenderer.invoke('azureDevOps:unlinkWorkItemFromPr', params),
    addPullRequestComment: (params: {
      localProjectId?: string;
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      content: string;
    }) => ipcRenderer.invoke('azureDevOps:addPullRequestComment', params),
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
    }) => ipcRenderer.invoke('azureDevOps:addPullRequestFileComment', params),
    addThreadReply: (params: {
      localProjectId?: string;
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      content: string;
    }) => ipcRenderer.invoke('azureDevOps:addThreadReply', params),
    updateThreadComment: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      commentId: number;
      content: string;
    }) => ipcRenderer.invoke('azureDevOps:updateThreadComment', params),
    deleteThreadComment: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      commentId: number;
    }) => ipcRenderer.invoke('azureDevOps:deleteThreadComment', params),
    setThreadCommentLike: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      commentId: number;
      liked: boolean;
    }) => ipcRenderer.invoke('azureDevOps:setThreadCommentLike', params),
    updateThreadStatus: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      threadId: number;
      status: string;
    }) => ipcRenderer.invoke('azureDevOps:updateThreadStatus', params),
    searchIdentities: (params: { providerId: string; query: string }) =>
      ipcRenderer.invoke('azureDevOps:searchIdentities', params),
    fetchImageAsBase64: (params: { providerId: string; imageUrl: string }) =>
      ipcRenderer.invoke('azureDevOps:fetchImageAsBase64', params),
    getPullRequestPolicyEvaluations: (params: {
      providerId: string;
      projectId: string;
      pullRequestId: number;
    }) =>
      ipcRenderer.invoke('azureDevOps:getPullRequestPolicyEvaluations', params),
    requeuePolicyEvaluation: (params: {
      providerId: string;
      projectId: string;
      evaluationId: string;
    }) => ipcRenderer.invoke('azureDevOps:requeuePolicyEvaluation', params),
    votePullRequest: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
      reviewerId: string;
      vote: number;
    }) => ipcRenderer.invoke('azureDevOps:votePullRequest', params),
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
    }) => ipcRenderer.invoke('azureDevOps:setPullRequestAutoComplete', params),
    publishPullRequest: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('azureDevOps:publishPullRequest', params),
    markPullRequestDraft: (params: {
      providerId: string;
      projectId: string;
      repoId: string;
      pullRequestId: number;
    }) => ipcRenderer.invoke('azureDevOps:markPullRequestDraft', params),
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    openImageFile: () => ipcRenderer.invoke('dialog:openImageFile'),
    openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
    openApplication: () => ipcRenderer.invoke('dialog:openApplication'),
    saveFile: (params: {
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      content?: Uint8Array;
    }) => ipcRenderer.invoke('dialog:saveFile', params),
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) =>
      ipcRenderer.invoke('settings:set', key, value),
  },
  backendConfig: {
    getUserConfig: (
      backend: import('@shared/agent-backend-types').AgentBackendType,
    ) => ipcRenderer.invoke('backendConfig:getUserConfig', backend),
    setUserConfig: (
      backend: import('@shared/agent-backend-types').AgentBackendType,
      content: string,
    ) => ipcRenderer.invoke('backendConfig:setUserConfig', backend, content),
  },
  projectPromptPreface: {
    get: (projectPath: string) =>
      ipcRenderer.invoke('projectPromptPreface:get', projectPath),
    set: (
      projectPath: string,
      value: import('@shared/prompt-preface-types').ProjectPromptPrefaceSetting,
    ) => ipcRenderer.invoke('projectPromptPreface:set', projectPath, value),
  },
  globalPermissions: {
    get: () => ipcRenderer.invoke('globalPermissions:get'),
    set: (permissions: import('@shared/permission-types').PermissionScope) =>
      ipcRenderer.invoke('globalPermissions:set', permissions),
    addRule: (
      toolName: string,
      input: Record<string, unknown>,
      action?: import('@shared/permission-types').PermissionAction,
    ) =>
      ipcRenderer.invoke('globalPermissions:addRule', toolName, input, action),
    removeRule: (tool: string, pattern?: string) =>
      ipcRenderer.invoke('globalPermissions:removeRule', tool, pattern),
    editRule: (
      tool: string,
      oldPattern: string | undefined,
      newPattern: string | undefined,
      action: import('@shared/permission-types').PermissionAction,
    ) =>
      ipcRenderer.invoke(
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
      ipcRenderer.invoke('projectPermissions:get', projectPath),
    addRule: (
      projectPath: string,
      toolName: string,
      input: Record<string, unknown>,
      action?: import('@shared/permission-types').PermissionAction,
    ) =>
      ipcRenderer.invoke(
        'projectPermissions:addRule',
        projectPath,
        toolName,
        input,
        action,
      ),
    removeRule: (projectPath: string, tool: string, pattern?: string) =>
      ipcRenderer.invoke(
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
      ipcRenderer.invoke(
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
      ipcRenderer.invoke('worktreeConfig:get', projectPath),
    setCopyEntries: (
      projectPath: string,
      entries: import('@shared/permission-types').WorktreeFileCopyEntry[],
    ) =>
      ipcRenderer.invoke('worktreeConfig:setCopyEntries', projectPath, entries),
  },
  fs: {
    readPackageJson: (dirPath: string) =>
      ipcRenderer.invoke('fs:readPackageJson', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    getFileSize: (filePath: string) =>
      ipcRenderer.invoke('fs:getFileSize', filePath),
    readImageAsDataUrl: (filePath: string) =>
      ipcRenderer.invoke('fs:readImageAsDataUrl', filePath),
    readSpreadsheetAsBase64: (filePath: string) =>
      ipcRenderer.invoke('fs:readSpreadsheetAsBase64', filePath),
    getImageUrl: (filePath: string) =>
      ipcRenderer.invoke('fs:getImageUrl', filePath),
    listDirectory: (dirPath: string, projectRoot: string) =>
      ipcRenderer.invoke('fs:listDirectory', dirPath, projectRoot),
    listProjectFiles: (projectRoot: string) =>
      ipcRenderer.invoke('fs:listProjectFiles', projectRoot),
    writeAttachmentFile: (
      projectPath: string,
      filename: string,
      content: string,
      encoding?: 'utf-8' | 'base64',
    ) =>
      ipcRenderer.invoke(
        'fs:writeAttachmentFile',
        projectPath,
        filename,
        content,
        encoding,
      ),
    copyAttachmentFile: (projectPath: string, sourcePath: string) =>
      ipcRenderer.invoke('fs:copyAttachmentFile', projectPath, sourcePath),
    deleteAttachmentFile: (projectPath: string, filePath: string) =>
      ipcRenderer.invoke('fs:deleteAttachmentFile', projectPath, filePath),
    getPathForFile: (file: File) => webUtils.getPathForFile(file) || null,
  },
  shell: {
    openInEditor: (dirPath: string, folderContext?: string) =>
      ipcRenderer.invoke('shell:openInEditor', dirPath, folderContext),
    openPath: (targetPath: string) =>
      ipcRenderer.invoke('shell:openPath', targetPath),
    openTeamsJoinUrl: (url: string) =>
      ipcRenderer.invoke('shell:openTeamsJoinUrl', url),
    getAvailableEditors: () => ipcRenderer.invoke('shell:getAvailableEditors'),
    getAgentCliStatus: () => ipcRenderer.invoke('shell:getAgentCliStatus'),
    setupGlobalGitignore: () =>
      ipcRenderer.invoke('shell:setupGlobalGitignore') as Promise<{
        success: boolean;
        path: string;
      }>,
  },
  calendar: {
    listUpcomingMeetings: () =>
      ipcRenderer.invoke('calendar:listUpcomingMeetings') as Promise<
        import('@shared/calendar-types').UpcomingMeeting[]
      >,
    listTodayMeetings: () =>
      ipcRenderer.invoke('calendar:listTodayMeetings') as Promise<
        import('@shared/calendar-types').UpcomingMeeting[]
      >,
    revealMeeting: (
      meeting: import('@shared/calendar-types').UpcomingMeeting,
    ) => ipcRenderer.invoke('calendar:revealMeeting', meeting) as Promise<void>,
    suppressMeetingStartPopup: (
      meeting: import('@shared/calendar-types').UpcomingMeeting,
    ) =>
      ipcRenderer.invoke(
        'calendar:suppressMeetingStartPopup',
        meeting,
      ) as Promise<void>,
    setIgnoredMeetingIds: (ids: string[]) =>
      ipcRenderer.invoke('calendar:setIgnoredMeetingIds', ids) as Promise<void>,
  },
  agent: {
    start: (stepId: string) => ipcRenderer.invoke(AGENT_CHANNELS.START, stepId),
    stop: (stepId: string) => ipcRenderer.invoke(AGENT_CHANNELS.STOP, stepId),
    stopAll: () => ipcRenderer.invoke(AGENT_CHANNELS.STOP_ALL),
    respond: (stepId: string, requestId: string, response: unknown) =>
      ipcRenderer.invoke(AGENT_CHANNELS.RESPOND, stepId, requestId, response),
    sendMessage: (
      stepId: string,
      parts: unknown[],
      capture?: AgentMemoryFollowUpCapture,
    ) =>
      ipcRenderer.invoke(AGENT_CHANNELS.SEND_MESSAGE, stepId, parts, capture),
    queuePrompt: (
      stepId: string,
      parts: unknown[],
      capture?: AgentMemoryQueuedPromptCapture,
    ) =>
      ipcRenderer.invoke(AGENT_CHANNELS.QUEUE_PROMPT, stepId, parts, capture),
    updateQueuedPrompt: (
      stepId: string,
      promptId: string,
      content: string,
      capture?: AgentMemoryPromptCapture,
    ) =>
      ipcRenderer.invoke(
        AGENT_CHANNELS.UPDATE_QUEUED_PROMPT,
        stepId,
        promptId,
        content,
        capture,
      ),
    cancelQueuedPrompt: (stepId: string, promptId: string) =>
      ipcRenderer.invoke(AGENT_CHANNELS.CANCEL_QUEUED_PROMPT, stepId, promptId),
    getBackendModels: (backend: string) =>
      ipcRenderer.invoke('agent:getBackendModels', backend),
    getMessages: (stepId: string) =>
      ipcRenderer.invoke(AGENT_CHANNELS.GET_MESSAGES, stepId),
    getMessageCount: (stepId: string) =>
      ipcRenderer.invoke(AGENT_CHANNELS.GET_MESSAGE_COUNT, stepId),
    getPendingRequest: (stepId: string) =>
      ipcRenderer.invoke(AGENT_CHANNELS.GET_PENDING_REQUEST, stepId),
    getMessagesWithRawData: (taskId: string, stepId: string) =>
      ipcRenderer.invoke(
        AGENT_CHANNELS.GET_MESSAGES_WITH_RAW_DATA,
        taskId,
        stepId,
      ),
    getResourceSnapshots: () =>
      ipcRenderer.invoke('agent:resources:getSnapshots'),
    getResourceHistory: () => ipcRenderer.invoke('agent:resources:getHistory'),
    setHighFrequencyResourceSampling: (enabled: boolean) =>
      ipcRenderer.invoke(
        'agent:resources:setHighFrequencySampling',
        enabled,
      ),
    compactRawMessages: (taskId: string) =>
      ipcRenderer.invoke(AGENT_CHANNELS.COMPACT_RAW_MESSAGES, taskId),
    reprocessNormalization: (taskId: string) =>
      ipcRenderer.invoke(AGENT_CHANNELS.REPROCESS_NORMALIZATION, taskId),
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_: unknown, event: unknown) => callback(event);
      ipcRenderer.on(AGENT_CHANNELS.EVENT, handler);
      return () => ipcRenderer.removeListener(AGENT_CHANNELS.EVENT, handler);
    },
  },
  mobilePreview: {
    listDevices: (platform: MobilePlatform) =>
      ipcRenderer.invoke('mobilePreview:listDevices', platform),
    listSessions: (params: MobilePreviewListSessionsParams) =>
      ipcRenderer.invoke('mobilePreview:listSessions', params),
    listDeviceAssignments: () =>
      ipcRenderer.invoke('mobilePreview:listDeviceAssignments'),
    getAndroidToolStatus: () =>
      ipcRenderer.invoke('mobilePreview:getAndroidToolStatus'),
    listAndroidDeviceProfiles: () =>
      ipcRenderer.invoke('mobilePreview:listAndroidDeviceProfiles'),
    listAndroidSystemImages: () =>
      ipcRenderer.invoke('mobilePreview:listAndroidSystemImages'),
    createAndroidDevice: (params: MobilePreviewAndroidCreateDeviceParams) =>
      ipcRenderer.invoke('mobilePreview:createAndroidDevice', params),
    deleteAndroidDevice: (name: string) =>
      ipcRenderer.invoke('mobilePreview:deleteAndroidDevice', name),
    installAndroidSystemImage: (
      params: MobilePreviewAndroidInstallSystemImageParams,
    ) => ipcRenderer.invoke('mobilePreview:installAndroidSystemImage', params),
    getIosToolStatus: () =>
      ipcRenderer.invoke('mobilePreview:getIosToolStatus'),
    listIosRuntimes: () =>
      ipcRenderer.invoke('mobilePreview:listIosRuntimes'),
    listIosDeviceTypes: () =>
      ipcRenderer.invoke('mobilePreview:listIosDeviceTypes'),
    createIosDevice: (params: MobilePreviewIosCreateDeviceParams) =>
      ipcRenderer.invoke('mobilePreview:createIosDevice', params),
    deleteIosDevice: (deviceId: string) =>
      ipcRenderer.invoke('mobilePreview:deleteIosDevice', deviceId),
    eraseIosDevice: (deviceId: string) =>
      ipcRenderer.invoke('mobilePreview:eraseIosDevice', deviceId),
    renameIosDevice: (params: MobilePreviewIosRenameDeviceParams) =>
      ipcRenderer.invoke('mobilePreview:renameIosDevice', params),
    getIosAppStatus: (params: MobilePreviewIosAppStatusRequestParams) =>
      ipcRenderer.invoke('mobilePreview:getIosAppStatus', params),
    cancelIosAppStatus: (params: MobilePreviewIosAppStatusCancelParams) =>
      ipcRenderer.invoke('mobilePreview:cancelIosAppStatus', params),
    restartIosApp: (params: MobilePreviewIosAppRequestParams) =>
      ipcRenderer.invoke('mobilePreview:restartIosApp', params),
    launchExpo: (params: MobilePreviewExpoLaunchParams) =>
      ipcRenderer.invoke('mobilePreview:launchExpo', params),
    cancelExpoLaunch: (requestId: string) =>
      ipcRenderer.invoke('mobilePreview:cancelExpoLaunch', requestId),
    start: (params: MobilePreviewStartParams) =>
      ipcRenderer.invoke('mobilePreview:start', params),
    attachSession: (params: MobilePreviewAttachSessionParams) =>
      ipcRenderer.invoke('mobilePreview:attachSession', params),
    detachSession: (params: MobilePreviewDetachSessionParams) =>
      ipcRenderer.invoke('mobilePreview:detachSession', params),
    stop: (sessionId: string) =>
      ipcRenderer.invoke('mobilePreview:stop', sessionId),
    sendInput: (sessionId: string, event: MobilePreviewInputEvent) =>
      ipcRenderer.invoke('mobilePreview:sendInput', sessionId, event),
    openDeeplink: (params: MobilePreviewOpenDeeplinkParams) =>
      ipcRenderer.invoke('mobilePreview:openDeeplink', params),
    openDevMenu: (params: MobilePreviewOpenDevMenuParams) =>
      ipcRenderer.invoke('mobilePreview:openDevMenu', params),
    reloadExpo: (params: MobilePreviewReloadExpoParams) =>
      ipcRenderer.invoke('mobilePreview:reloadExpo', params),
    forwardPort: (params: MobilePreviewForwardPortParams) =>
      ipcRenderer.invoke('mobilePreview:forwardPort', params),
    setTextSize: (params: MobilePreviewSetTextSizeParams) =>
      ipcRenderer.invoke('mobilePreview:setTextSize', params),
    setColorScheme: (sessionId: string, scheme: MobileColorScheme) =>
      ipcRenderer.invoke('mobilePreview:setColorScheme', sessionId, scheme),
    rotate: (sessionId: string, direction: MobileRotationDirection) =>
      ipcRenderer.invoke('mobilePreview:rotate', sessionId, direction),
    startNativeLogs: (params: MobilePreviewNativeLogStartParams) =>
      ipcRenderer.invoke('mobilePreview:startNativeLogs', params),
    stopNativeLogs: (sessionId: string) =>
      ipcRenderer.invoke('mobilePreview:stopNativeLogs', sessionId),
    startNetworkProxy: (params: MobilePreviewNetworkProxyStartParams) =>
      ipcRenderer.invoke('mobilePreview:startNetworkProxy', params),
    stopNetworkProxy: (sessionId: string) =>
      ipcRenderer.invoke('mobilePreview:stopNetworkProxy', sessionId),
    startPacketCapture: (params: MobilePreviewPacketCaptureStartParams) =>
      ipcRenderer.invoke('mobilePreview:startPacketCapture', params),
    stopPacketCapture: (sessionId: string) =>
      ipcRenderer.invoke('mobilePreview:stopPacketCapture', sessionId),
    resolveReactNativeDevTools: (params: ReactNativeDevToolsResolveParams) =>
      ipcRenderer.invoke('mobilePreview:resolveReactNativeDevTools', params),
    openReactNativeDevTools: (params: ReactNativeDevToolsOpenParams) =>
      ipcRenderer.invoke('mobilePreview:openReactNativeDevTools', params),
    openEmbeddedReactNativeDevTools: (
      params: ReactNativeDevToolsEmbeddedOpenParams,
    ) =>
      ipcRenderer.invoke(
        'mobilePreview:openEmbeddedReactNativeDevTools',
        params,
      ),
    setEmbeddedReactNativeDevToolsBounds: (
      params: ReactNativeDevToolsEmbeddedBoundsParams,
    ) =>
      ipcRenderer.invoke(
        'mobilePreview:setEmbeddedReactNativeDevToolsBounds',
        params,
      ),
    setEmbeddedReactNativeDevToolsVisibility: (
      params: ReactNativeDevToolsEmbeddedVisibilityParams,
    ) =>
      ipcRenderer.invoke(
        'mobilePreview:setEmbeddedReactNativeDevToolsVisibility',
        params,
      ),
    closeEmbeddedReactNativeDevTools: (
      params: ReactNativeDevToolsEmbeddedCloseParams,
    ) =>
      ipcRenderer.invoke(
        'mobilePreview:closeEmbeddedReactNativeDevTools',
        params,
      ),
    installNetworkProxyCertificate: (
      params: MobilePreviewNetworkProxyCertificateParams,
    ) =>
      ipcRenderer.invoke(
        'mobilePreview:installNetworkProxyCertificate',
        params,
      ),
    prepareAndroidAppTrust: (params: MobilePreviewAndroidAppTrustParams) =>
      ipcRenderer.invoke('mobilePreview:prepareAndroidAppTrust', params),
    getAndroidAppStatus: (params: MobilePreviewAndroidAppStatusParams) =>
      ipcRenderer.invoke('mobilePreview:getAndroidAppStatus', params),
    restartAndroidApp: (params: MobilePreviewAndroidAppRestartParams) =>
      ipcRenderer.invoke('mobilePreview:restartAndroidApp', params),
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
    onNetworkProxySession: (
      callback: (event: MobilePreviewNetworkProxySessionEvent) => void,
    ) => {
      const handler = (
        _: unknown,
        event: MobilePreviewNetworkProxySessionEvent,
      ) => callback(event);
      ipcRenderer.on('mobilePreview:networkProxySession', handler);
      return () =>
        ipcRenderer.removeListener(
          'mobilePreview:networkProxySession',
          handler,
        );
    },
    onNetworkProxyRequest: (
      callback: (event: MobilePreviewNetworkProxyEvent) => void,
    ) => {
      const handler = (_: unknown, event: MobilePreviewNetworkProxyEvent) =>
        callback(event);
      ipcRenderer.on('mobilePreview:networkProxyRequest', handler);
      return () =>
        ipcRenderer.removeListener(
          'mobilePreview:networkProxyRequest',
          handler,
        );
    },
    onPacketCaptureSession: (
      callback: (event: MobilePreviewPacketCaptureSessionEvent) => void,
    ) => {
      const handler = (
        _: unknown,
        event: MobilePreviewPacketCaptureSessionEvent,
      ) => callback(event);
      ipcRenderer.on('mobilePreview:packetCaptureSession', handler);
      return () =>
        ipcRenderer.removeListener(
          'mobilePreview:packetCaptureSession',
          handler,
        );
    },
    onPacketCaptureRequest: (
      callback: (event: MobilePreviewPacketCaptureEvent) => void,
    ) => {
      const handler = (_: unknown, event: MobilePreviewPacketCaptureEvent) =>
        callback(event);
      ipcRenderer.on('mobilePreview:packetCaptureRequest', handler);
      return () =>
        ipcRenderer.removeListener(
          'mobilePreview:packetCaptureRequest',
          handler,
        );
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
  debug: {
    log: (params: { scope: string; message: string; data?: unknown }) =>
      ipcRenderer.invoke('debug:log', params),
    getTableNames: () => ipcRenderer.invoke('debug:getTableNames'),
    getDatabaseSize: () => ipcRenderer.invoke('debug:getDatabaseSize'),
    countOldCompletedTasks: () =>
      ipcRenderer.invoke('debug:countOldCompletedTasks'),
    deleteOldCompletedTasks: () =>
      ipcRenderer.invoke('debug:deleteOldCompletedTasks'),
    queryTable: (params: {
      table: string;
      search?: string;
      limit: number;
      offset: number;
    }) => ipcRenderer.invoke('debug:queryTable', params),
  },
  usage: {
    getAll: (backends: string[]) =>
      ipcRenderer.invoke('agent:usage:getAll', backends),
    getHistory: (params: {
      provider: string;
      limitKey: string;
      since: string;
      until?: string;
    }) => ipcRenderer.invoke('agent:usage:getHistory', params),
    getDashboard: (params: AiUsageDashboardParams) =>
      ipcRenderer.invoke('agent:usage:getDashboard', params),
    getTaskUsage: (taskId: string) =>
      ipcRenderer.invoke('agent:usage:getTaskUsage', taskId),
  },
  workActivity: {
    record: (event: NewWorkActivityEvent) =>
      ipcRenderer.invoke('workActivity:record', event),
    getRange: (params: WorkActivityWeekParams) =>
      ipcRenderer.invoke('workActivity:getRange', params),
    deleteBefore: (before: string) =>
      ipcRenderer.invoke('workActivity:deleteBefore', before),
    deleteAll: () => ipcRenderer.invoke('workActivity:deleteAll'),
  },
  timesheets: {
    listAdapters: () => ipcRenderer.invoke('timesheets:listAdapters'),
    buildDraft: (params: TimesheetDraftParams) =>
      ipcRenderer.invoke('timesheets:buildDraft', params),
    sync: (params: TimesheetSyncParams) =>
      ipcRenderer.invoke('timesheets:sync', params),
    authStatus: (provider: TimesheetProviderType) =>
      ipcRenderer.invoke('timesheets:authStatus', provider),
    login: (provider: TimesheetProviderType) =>
      ipcRenderer.invoke('timesheets:login', provider),
    logout: (provider: TimesheetProviderType) =>
      ipcRenderer.invoke('timesheets:logout', provider),
    listSheets: (provider: TimesheetProviderType) =>
      ipcRenderer.invoke('timesheets:listSheets', provider),
    inspectSheet: (params: {
      provider: TimesheetProviderType;
      sheetId: string;
      navigationUrl: string;
    }) => ipcRenderer.invoke('timesheets:inspectSheet', params),
    lookupAxisOptions: (
      params: TimesheetAxisLookupRequest & { provider: TimesheetProviderType },
    ) => ipcRenderer.invoke('timesheets:lookupAxisOptions', params),
    dryRun: (params: {
      provider: TimesheetProviderType;
      sheetId: string;
      entries: TimesheetEntryInput[];
      deletions?: TimesheetRowDeletion[];
      action: TimesheetAction;
    }) => ipcRenderer.invoke('timesheets:dryRun', params),
    save: (params: {
      provider: TimesheetProviderType;
      sheetId: string;
      entries: TimesheetEntryInput[];
      deletions?: TimesheetRowDeletion[];
      updates?: TimesheetRowUpdate[];
      action: TimesheetAction;
    }) => ipcRenderer.invoke('timesheets:save', params),
  },
  rateLimitSwap: {
    getStatus: () =>
      ipcRenderer.invoke('rate-limit-swap:status') as Promise<{
        active: boolean;
        swaps: Array<{ from: string; to: string }>;
      }>,
    resolve: (
      backend: import('@shared/agent-backend-types').AgentBackendType,
    ) =>
      ipcRenderer.invoke('rate-limit-swap:resolve', backend) as Promise<{
        backend: import('@shared/agent-backend-types').AgentBackendType;
        model?: string;
        thinkingEffort?: import('@shared/types').ThinkingEffort;
        swapped: boolean;
      }>,
  },
  usageDisplay: {
    saveSettings: (value: import('@shared/types').UsageDisplaySetting) =>
      ipcRenderer.invoke('usageDisplay:saveSettings', value),
  },
  codexbar: {
    getStatus: () => ipcRenderer.invoke('codexbar:getStatus'),
    openInstallPage: () => ipcRenderer.invoke('codexbar:openInstallPage'),
  },
  copilotAuth: {
    requestDeviceCode: () =>
      ipcRenderer.invoke('copilotAuth:requestDeviceCode'),
    completeDeviceLogin: (deviceCode: unknown) =>
      ipcRenderer.invoke('copilotAuth:completeDeviceLogin', deviceCode),
  },
  projectCommands: {
    findByProjectId: (projectId: string) =>
      ipcRenderer.invoke('project:commands:findByProjectId', projectId),
    findAll: () => ipcRenderer.invoke('project:commands:findAll'),
    findFavorites: () => ipcRenderer.invoke('project:commands:findFavorites'),
    create: (data: unknown) =>
      ipcRenderer.invoke('project:commands:create', data),
    update: (id: string, data: unknown) =>
      ipcRenderer.invoke('project:commands:update', { id, data }),
    delete: (id: string) => ipcRenderer.invoke('project:commands:delete', id),
    reorder: (projectId: string, commandIds: string[]) =>
      ipcRenderer.invoke('project:commands:reorder', { projectId, commandIds }),
  },
  projectCommandGroups: {
    findByProjectId: (projectId: string) =>
      ipcRenderer.invoke('project:commandGroups:findByProjectId', projectId),
    create: (data: unknown) =>
      ipcRenderer.invoke('project:commandGroups:create', data),
    update: (id: string, data: unknown) =>
      ipcRenderer.invoke('project:commandGroups:update', { id, data }),
    delete: (id: string) =>
      ipcRenderer.invoke('project:commandGroups:delete', id),
    reorder: (projectId: string, groupIds: string[]) =>
      ipcRenderer.invoke('project:commandGroups:reorder', {
        projectId,
        groupIds,
      }),
  },
  projectRunConfig: {
    reorder: (projectId: string, items: unknown[]) =>
      ipcRenderer.invoke('project:runConfig:reorder', { projectId, items }),
  },
  runCommands: {
    startCommand: (params: {
      taskId: string;
      runCommandId: string;
    }) =>
      ipcRenderer.invoke('project:commands:run:startCommand', {
        taskId: params.taskId,
        runCommandId: params.runCommandId,
      }),
    startAdHocCommand: (params: StartAdHocRunCommandParams) =>
      ipcRenderer.invoke('project:commands:run:startAdHocCommand', params),
    startFavorite: (params: { projectId: string; runCommandId: string }) =>
      ipcRenderer.invoke('project:commands:run:startFavorite', params),
    startGroup: (params: {
      taskId: string;
      runCommandIds: string[];
    }) =>
      ipcRenderer.invoke('project:commands:run:startGroup', {
        taskId: params.taskId,
        runCommandIds: params.runCommandIds,
      }),
    stopCommand: (params: { taskId: string; runCommandId: string }) =>
      ipcRenderer.invoke('project:commands:run:stopCommand', params),
    stopAll: () => ipcRenderer.invoke('project:commands:run:stopAll'),
    sendInput: (params: {
      taskId: string;
      runCommandId: string;
      input: string;
    }) => ipcRenderer.invoke('project:commands:run:sendInput', params),
    resetLogs: (params: {
      taskId: string;
      runCommandId: string;
      generation: number;
    }) => ipcRenderer.invoke('project:commands:run:resetLogs', params),
    sendSignal: (params: {
      taskId: string;
      runCommandId: string;
      signal: 'SIGINT' | 'SIGTERM';
    }) => ipcRenderer.invoke('project:commands:run:sendSignal', params),
    getStatus: (taskId: string) =>
      ipcRenderer.invoke('project:commands:run:getStatus', taskId),
    getTaskIdsWithRunningCommands: () =>
      ipcRenderer.invoke(
        'project:commands:run:getTaskIdsWithRunningCommands',
      ) as Promise<string[]>,
    killPortsForCommand: (projectId: string, commandId: string) =>
      ipcRenderer.invoke('project:commands:run:killPortsForCommand', {
        projectId,
        commandId,
      }),
    getPackageScripts: (projectPath: string) =>
      ipcRenderer.invoke('project:commands:run:getPackageScripts', projectPath),
    getProjectSuggestions: (projectPath: string) =>
      ipcRenderer.invoke(
        'project:commands:run:getProjectSuggestions',
        projectPath,
      ),
    saveProjectSuggestions: (projectPath: string, suggestions: unknown) =>
      ipcRenderer.invoke('project:commands:run:saveProjectSuggestions', {
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
      ipcRenderer.invoke('globalPrompt:respond', response),
  },
  mcpTemplates: {
    findAll: () => ipcRenderer.invoke('mcpTemplates:findAll'),
    findById: (id: string) => ipcRenderer.invoke('mcpTemplates:findById', id),
    create: (data: unknown) => ipcRenderer.invoke('mcpTemplates:create', data),
    update: (id: string, data: unknown) =>
      ipcRenderer.invoke('mcpTemplates:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('mcpTemplates:delete', id),
    getPresets: () => ipcRenderer.invoke('mcpTemplates:getPresets'),
    getEnabledForProject: (projectId: string) =>
      ipcRenderer.invoke('mcpTemplates:getEnabledForProject', projectId),
  },
  projectMcpOverrides: {
    findByProjectId: (projectId: string) =>
      ipcRenderer.invoke('projectMcpOverrides:findByProjectId', projectId),
    upsert: (data: unknown) =>
      ipcRenderer.invoke('projectMcpOverrides:upsert', data),
    delete: (projectId: string, mcpTemplateId: string) =>
      ipcRenderer.invoke(
        'projectMcpOverrides:delete',
        projectId,
        mcpTemplateId,
      ),
  },
  unifiedMcp: {
    getServers: (projectId: string, projectPath: string) =>
      ipcRenderer.invoke('unifiedMcp:getServers', projectId, projectPath),
    activate: (projectPath: string, name: string, command: string) =>
      ipcRenderer.invoke('unifiedMcp:activate', projectPath, name, command),
    deactivate: (projectPath: string, name: string) =>
      ipcRenderer.invoke('unifiedMcp:deactivate', projectPath, name),
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
      ipcRenderer.invoke(
        'unifiedMcp:substituteVariables',
        commandTemplate,
        userVariables,
        context,
      ),
  },
  globalMcp: {
    findAll: () => ipcRenderer.invoke('globalMcp:findAll'),
    findById: (id: string) => ipcRenderer.invoke('globalMcp:findById', id),
    create: (data: import('@shared/global-mcp-types').NewGlobalMcpServer) => ipcRenderer.invoke('globalMcp:create', data),
    update: (id: string, data: import('@shared/global-mcp-types').UpdateGlobalMcpServer) =>
      ipcRenderer.invoke('globalMcp:update', id, data),
    enable: (id: string, backends: import('@shared/agent-backend-types').AgentBackendType[]) =>
      ipcRenderer.invoke('globalMcp:enable', id, backends),
    disable: (id: string, backends: import('@shared/agent-backend-types').AgentBackendType[]) =>
      ipcRenderer.invoke('globalMcp:disable', id, backends),
    uninstall: (id: string) => ipcRenderer.invoke('globalMcp:uninstall', id),
    discover: () => ipcRenderer.invoke('globalMcp:discover'),
    import: (entry: import('@shared/global-mcp-types').DiscoveredMcpVariant, backends: import('@shared/agent-backend-types').AgentBackendType[]) =>
      ipcRenderer.invoke('globalMcp:import', entry, backends),
  },
  claudeProjects: {
    findNonExistent: () => ipcRenderer.invoke('claudeProjects:findNonExistent'),
    cleanup: (params: { paths: string[]; contentHash: string }) =>
      ipcRenderer.invoke('claudeProjects:cleanup', params),
  },
  unusedWorktrees: {
    scan: () => ipcRenderer.invoke('unusedWorktrees:scan'),
    cleanup: (params: { paths: string[] }) =>
      ipcRenderer.invoke('unusedWorktrees:cleanup', params),
  },
  completion: {
    complete: (params: {
      prompt: string;
      suffix?: string;
      projectId?: string;
      contextBeforePrompt?: string;
    }) => ipcRenderer.invoke('completion:complete', params),
    test: () => ipcRenderer.invoke('completion:test'),
    saveSettings: (params: {
      enabled: boolean;
      apiKey: string;
      model: string;
      serverUrl: string;
    }) => ipcRenderer.invoke('completion:saveSettings', params),
    generateContext: (params: { projectId: string }) =>
      ipcRenderer.invoke('completion:generateContext', params),
    getDailyUsage: () => ipcRenderer.invoke('completion:getDailyUsage'),
  },
  aiGeneration: {
    saveSettings: (params: {
      openAiApiKey: string;
      openAiImageGenerationEnabled: boolean;
      openAiImageModel: string;
      openAiLogoPromptContext: string;
    }) => ipcRenderer.invoke('aiGeneration:saveSettings', params),
    saveBaseImage: (params: { sourcePath: string }) =>
      ipcRenderer.invoke('aiGeneration:saveBaseImage', params),
    listBaseImages: () => ipcRenderer.invoke('aiGeneration:listBaseImages'),
    setBaseImageSelection: (params: {
      mode: 'builtin' | 'custom';
      builtinId?: string;
    }) => ipcRenderer.invoke('aiGeneration:setBaseImageSelection', params),
    removeBaseImage: () => ipcRenderer.invoke('aiGeneration:removeBaseImage'),
  },
  projectTodos: {
    list: (projectId: string) =>
      ipcRenderer.invoke('project-todos:list', projectId),
    count: (projectId: string) =>
      ipcRenderer.invoke('project-todos:count', projectId),
    create: (data: unknown) => ipcRenderer.invoke('project-todos:create', data),
    update: (id: string, data: unknown) =>
      ipcRenderer.invoke('project-todos:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('project-todos:delete', id),
    reorder: (projectId: string, orderedIds: string[]) =>
      ipcRenderer.invoke('project-todos:reorder', projectId, orderedIds),
  },
  agentManagement: {
    getAll: () => ipcRenderer.invoke('agents:getAll'),
    getContent: (agentPath: string) =>
      ipcRenderer.invoke('agents:getContent', agentPath),
    create: (params: {
      enabledBackends: string[];
      name: string;
      description: string;
      content: string;
    }) => ipcRenderer.invoke('agents:create', params),
    update: (params: { agentPath: string; content: string }) =>
      ipcRenderer.invoke('agents:update', params),
    delete: (agentPath: string) =>
      ipcRenderer.invoke('agents:delete', agentPath),
    disable: (agentPath: string, backendType: string) =>
      ipcRenderer.invoke('agents:disable', agentPath, backendType),
    enable: (agentPath: string, backendType: string) =>
      ipcRenderer.invoke('agents:enable', agentPath, backendType),
    migrationPreview: () => ipcRenderer.invoke('agents:migrationPreview'),
    migrationExecute: (params: { itemIds: string[] }) =>
      ipcRenderer.invoke('agents:migrationExecute', params),
  },
  skillManagement: {
    getForStep: (params: { taskId: string; stepId?: string }) =>
      ipcRenderer.invoke('skills:getForStep', params),
    getAll: (backendType: string, projectPath?: string) =>
      ipcRenderer.invoke('skills:getAll', backendType, projectPath),
    getAllUnified: (projectPath?: string) =>
      ipcRenderer.invoke('skills:getAllUnified', projectPath),
    getContent: (skillPath: string) =>
      ipcRenderer.invoke('skills:getContent', skillPath),
    create: (params: {
      enabledBackends: string[];
      scope: string;
      projectPath?: string;
      name: string;
      description: string;
      content: string;
    }) => ipcRenderer.invoke('skills:create', params),
    update: (params: {
      skillPath: string;
      backendType: string;
      name?: string;
      description?: string;
      content?: string;
    }) => ipcRenderer.invoke('skills:update', params),
    delete: (skillPath: string, backendType: string) =>
      ipcRenderer.invoke('skills:delete', skillPath, backendType),
    disable: (skillPath: string, backendType: string) =>
      ipcRenderer.invoke('skills:disable', skillPath, backendType),
    enable: (skillPath: string, backendType: string) =>
      ipcRenderer.invoke('skills:enable', skillPath, backendType),
    migrationPreview: () => ipcRenderer.invoke('skills:migrationPreview'),
    migrationExecute: (params: { itemIds: string[] }) =>
      ipcRenderer.invoke('skills:migrationExecute', params),
    registrySearch: (query: string) =>
      ipcRenderer.invoke('skills:registrySearch', query),
    registryFetchContent: (source: string, skillId: string) =>
      ipcRenderer.invoke('skills:registryFetchContent', source, skillId),
    registryInstall: (params: {
      source: string;
      skillId: string;
      enabledBackends: string[];
    }) => ipcRenderer.invoke('skills:registryInstall', params),
    createWithAgent: (params: {
      prompt: string;
      enabledBackends: string[];
      mode: 'create' | 'improve';
      sourceSkillPath?: string;
      interactionMode?: string | null;
      modelPreference?: string | null;
      agentBackend?: string | null;
    }) => ipcRenderer.invoke('skills:createWithAgent', params),
    publishFromWorkspace: (params: {
      stepId: string;
      workspacePath: string;
      enabledBackends: string[];
      mode: 'create' | 'improve';
      sourceSkillPath?: string;
    }) => ipcRenderer.invoke('skills:publishFromWorkspace', params),
  },
  sourceManagement: {
    list: () => ipcRenderer.invoke('sources:list'),
    addGithub: (params: AddGitHubSourceParams) =>
      ipcRenderer.invoke('sources:addGithub', params),
    refresh: (sourceId: string) =>
      ipcRenderer.invoke('sources:refresh', sourceId),
    installItems: (params: InstallSourceItemsParams) =>
      ipcRenderer.invoke('sources:installItems', params),
    updateInstall: (params: UpdateSourceInstallParams) =>
      ipcRenderer.invoke('sources:updateInstall', params),
    remove: (sourceId: string) =>
      ipcRenderer.invoke('sources:remove', sourceId),
  },
  prSnapshots: {
    record: (params: {
      projectId: string;
      pullRequestId: number;
      providerId: string;
      repoProjectId: string;
      repoId: string;
    }) => ipcRenderer.invoke('pr-snapshots:record', params),
  },
  notifications: {
    list: () => ipcRenderer.invoke('notifications:list'),
    getDesktopStatus: async () => ({
      ...(await ipcRenderer.invoke('notifications:getDesktopStatus')),
      permission:
        typeof Notification === 'undefined'
          ? 'unknown'
          : Notification.permission,
    }),
    openSystemSettings: () =>
      ipcRenderer.invoke('notifications:openSystemSettings'),
    markRead: (id: string | 'all') =>
      ipcRenderer.invoke('notifications:markRead', id),
    delete: (id: string) => ipcRenderer.invoke('notifications:delete', id),
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
      ipcRenderer.invoke('tracked-pipelines:list', projectId),
    listAll: () => ipcRenderer.invoke('tracked-pipelines:listAll'),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('tracked-pipelines:toggle', id, enabled),
    toggleVisible: (id: string, visible: boolean) =>
      ipcRenderer.invoke('tracked-pipelines:toggleVisible', id, visible),
    reorder: (projectId: string, orderedIds: string[]) =>
      ipcRenderer.invoke('tracked-pipelines:reorder', projectId, orderedIds),
    discover: (projectId: string) =>
      ipcRenderer.invoke('tracked-pipelines:discover', projectId),
  },
  pipelines: {
    listRuns: (params: {
      providerId: string;
      azureProjectId: string;
      definitionId: number;
      kind: 'build' | 'release';
    }) => ipcRenderer.invoke('pipelines:listRuns', params),
    getBuild: (params: {
      providerId: string;
      azureProjectId: string;
      buildId: number;
    }) => ipcRenderer.invoke('pipelines:getBuild', params),
    getBuildTimeline: (params: {
      providerId: string;
      azureProjectId: string;
      buildId: number;
    }) => ipcRenderer.invoke('pipelines:getBuildTimeline', params),
    getBuildLog: (params: {
      providerId: string;
      azureProjectId: string;
      buildId: number;
      logId: number;
    }) => ipcRenderer.invoke('pipelines:getBuildLog', params),
    getRelease: (params: {
      providerId: string;
      azureProjectId: string;
      releaseId: number;
    }) => ipcRenderer.invoke('pipelines:getRelease', params),
    listBranches: (params: {
      providerId: string;
      azureProjectId: string;
      repoId: string;
    }) => ipcRenderer.invoke('pipelines:listBranches', params),
    getDefinitionParams: (params: {
      providerId: string;
      azureProjectId: string;
      definitionId: number;
    }) => ipcRenderer.invoke('pipelines:getDefinitionParams', params),
    getYamlParameters: (params: GetYamlParametersIpcParams) =>
      ipcRenderer.invoke('pipelines:getYamlParameters', params),
    queueBuild: (params: QueueBuildIpcParams) =>
      ipcRenderer.invoke('pipelines:queueBuild', params),
    createRelease: (params: {
      providerId: string;
      azureProjectId: string;
      definitionId: number;
      description?: string;
    }) => ipcRenderer.invoke('pipelines:createRelease', params),
    cancelBuild: (params: {
      providerId: string;
      azureProjectId: string;
      buildId: number;
    }) => ipcRenderer.invoke('pipelines:cancelBuild', params),
  },
  feed: {
    getItems: () => ipcRenderer.invoke('feed:getItems'),
    getTaskItems: () => ipcRenderer.invoke('feed:getTaskItems'),
    getPullRequestItems: () => ipcRenderer.invoke('feed:getPullRequestItems'),
    getNoteItems: () => ipcRenderer.invoke('feed:getNoteItems'),
    getWorkItemItems: () => ipcRenderer.invoke('feed:getWorkItemItems'),
    createNote: (params: { content: string }) =>
      ipcRenderer.invoke('feed:createNote', params),
    createWorkItemVerificationNote: (
      params: CreateWorkItemVerificationNoteParams,
    ) => ipcRenderer.invoke('feed:createWorkItemVerificationNote', params),
    updateNote: (params: {
      id: string;
      content?: string;
      completedAt?: string | null;
    }) => ipcRenderer.invoke('feed:updateNote', params),
    deleteNote: (params: { id: string }) =>
      ipcRenderer.invoke('feed:deleteNote', params),
  },
  app: {
    isDevMode: !!process.env.ELECTRON_RENDERER_URL,
    devBadgeLabel,
    hasExistingLocalStorageBucket,
    getIsPreviewMode: () =>
      ipcRenderer.invoke('app:getIsPreviewMode') as Promise<boolean>,
    getReloadUpdateInfo: (params: { builtCommitHash: string }) =>
      ipcRenderer.invoke('app:getReloadUpdateInfo', params) as Promise<{
        commitCount: number;
        latestCommitHash: string | null;
      }>,
    reloadPreview: () =>
      ipcRenderer.invoke('app:reloadPreview') as Promise<void>,
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
    getMemoryUsage: () => ipcRenderer.invoke('system:getMemoryUsage'),
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
      ipcRenderer.invoke('codeFolding:getFoldRanges', content, language),
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
