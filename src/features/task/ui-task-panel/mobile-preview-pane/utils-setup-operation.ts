export type PreviewSetupOperation = Readonly<{
  id: number;
  deviceKey: string;
}>;

export type PreviewFrameWaitResult = 'frame' | 'timeout' | 'cancelled';
export type PreviewRenderedFrameSource = 'image' | 'raw-rgba' | 'h264';

export function createIosBuildLaunchCoordinator() {
  const pendingByCommandId = new Map<string, Set<{ cancelled: boolean }>>();

  return {
    async launch({
      commandId,
      start,
      stop,
    }: {
      commandId: string;
      start: () => Promise<unknown>;
      stop: (commandId: string) => Promise<unknown>;
    }) {
      const token = { cancelled: false };
      const commandTokens = pendingByCommandId.get(commandId) ?? new Set();
      commandTokens.add(token);
      pendingByCommandId.set(commandId, commandTokens);
      try {
        await start();
        if (token.cancelled) await stop(commandId);
      } finally {
        commandTokens.delete(token);
        if (commandTokens.size === 0) pendingByCommandId.delete(commandId);
      }
    },

    cancel(commandId: string) {
      pendingByCommandId.get(commandId)?.forEach((token) => {
        token.cancelled = true;
      });
    },

    cancelAll() {
      pendingByCommandId.forEach((tokens) => {
        tokens.forEach((token) => {
          token.cancelled = true;
        });
      });
    },
  };
}

export function getMobileBuildCommandId({
  appPath,
  platform,
  deviceId,
}: {
  appPath: string;
  platform: 'ios' | 'android';
  deviceId?: string;
}) {
  const baseId = `mobile-build:${encodeURIComponent(appPath || '.')}:${platform}`;
  return platform === 'ios'
    ? `${baseId}:${encodeURIComponent(deviceId || 'no-device')}`
    : baseId;
}

export function getIosBuildAttemptDecision({
  needsBuild,
  buildStatus,
}: {
  needsBuild: boolean;
  buildStatus: 'idle' | 'loading' | 'running' | 'completed' | 'errored';
}) {
  return {
    shouldAutoBuild: needsBuild && buildStatus === 'idle',
    buildVerificationFailed: needsBuild && buildStatus === 'completed',
  };
}

export function shouldStopPreviousIosBuild({
  previousCommandId,
  currentCommandId,
  previousStatus,
  previousStarting,
}: {
  previousCommandId: string | null;
  currentCommandId: string | null;
  previousStatus: string | undefined;
  previousStarting: boolean;
}) {
  return (
    !!previousCommandId &&
    previousCommandId !== currentCommandId &&
    (previousStatus === 'running' || previousStarting)
  );
}

export function getMobileAppSetupDecision({
  platform,
  isExpoApp,
  nativeProjectExists,
  appInstalled,
  appIdentityResolved,
  buildStatus,
  statusCheckFailed = false,
}: {
  platform: 'ios' | 'android';
  isExpoApp: boolean;
  nativeProjectExists: boolean | null;
  appInstalled: boolean | null;
  appIdentityResolved: boolean;
  buildStatus: 'idle' | 'loading' | 'running' | 'completed' | 'errored';
  statusCheckFailed?: boolean;
}) {
  const appReady =
    appInstalled === true && (platform === 'android' || appIdentityResolved);
  const needsPrebuild =
    isExpoApp &&
    nativeProjectExists === false &&
    (platform === 'android' || !appIdentityResolved);
  const needsBuild =
    platform === 'android'
      ? nativeProjectExists === true && appInstalled === false
      : !statusCheckFailed && !appReady && !needsPrebuild;

  const iosBuildDecision = getIosBuildAttemptDecision({
    needsBuild,
    buildStatus,
  });

  return {
    needsPrebuild,
    appReady,
    needsBuild,
    shouldAutoBuild: platform === 'ios' && iosBuildDecision.shouldAutoBuild,
    buildVerificationFailed:
      platform === 'ios' && iosBuildDecision.buildVerificationFailed,
  };
}

export function getIosAppStatusRequestState<T>({
  requestKey,
  resolved,
}: {
  requestKey: string | null;
  resolved: { requestKey: string; value: T | null; error: string | null } | null;
}): { value: T | null; error: string | null; isLoading: boolean } {
  if (!requestKey) return { value: null, error: null, isLoading: false };
  if (resolved?.requestKey !== requestKey) {
    return { value: null, error: null, isLoading: true };
  }
  return { value: resolved.value, error: resolved.error, isLoading: false };
}

export function getIosAppStatusRequestKey({
  projectId,
  taskId,
  appPath,
  deviceId,
  buildStatus,
  prebuildStatus,
  refreshNonce,
  iosBundleId,
  packageManager,
}: {
  projectId: string;
  taskId: string;
  appPath: string;
  deviceId: string;
  buildStatus?: string | null;
  prebuildStatus?: string | null;
  refreshNonce: number;
  iosBundleId?: string | null;
  packageManager?: string | null;
}) {
  return [
    projectId,
    taskId,
    appPath,
    deviceId,
    buildStatus ?? '',
    prebuildStatus ?? '',
    refreshNonce,
    iosBundleId ?? '',
    packageManager ?? '',
  ].join('\u0000');
}

export function getDeferredSetupAction({
  resumeRequested,
  prebuildStatus,
  prebuildDone,
}: {
  resumeRequested: boolean;
  prebuildStatus: string | undefined;
  prebuildDone: boolean;
}): 'none' | 'error' | 'resume' {
  if (!resumeRequested) return 'none';
  if (prebuildStatus === 'errored') return 'error';
  return prebuildStatus === 'completed' && prebuildDone ? 'resume' : 'none';
}

export function getDependencyInstallDeferredAction({
  resumeRequested,
  status,
}: {
  resumeRequested: boolean;
  status: string | undefined;
}): 'none' | 'error' | 'resume' {
  if (!resumeRequested) return 'none';
  if (status === 'errored') return 'error';
  return status === 'completed' ? 'resume' : 'none';
}

export function cancelPendingWorkspaceSetup({
  cancelSetupOperation,
  cancelStart,
  setResumeSetupAfterPrebuild,
}: {
  cancelSetupOperation: () => void;
  cancelStart: () => void;
  setResumeSetupAfterPrebuild: (resume: boolean) => void;
}) {
  cancelSetupOperation();
  cancelStart();
  setResumeSetupAfterPrebuild(false);
}

export function applyPreviewDeviceSwitch({
  platform,
  deviceId,
  cancelPending,
  setPlatform,
  setDeviceId,
}: {
  platform: 'ios' | 'android';
  deviceId: string;
  cancelPending: () => void;
  setPlatform: (platform: 'ios' | 'android') => void;
  setDeviceId: (deviceId: string) => void;
}) {
  cancelPending();
  setPlatform(platform);
  setDeviceId(deviceId);
}

export function createPreviewSetupOperationCoordinator() {
  let nextId = 0;
  let active:
    | {
        operation: PreviewSetupOperation;
        sessionId: string | null;
        resolveWait: ((result: PreviewFrameWaitResult) => void) | null;
        timeout: ReturnType<typeof setTimeout> | null;
      }
    | null = null;
  const renderedSessionIds = new Set<string>();

  const settleWait = (result: PreviewFrameWaitResult) => {
    if (!active?.resolveWait) return;
    const resolve = active.resolveWait;
    active.resolveWait = null;
    if (active.timeout) clearTimeout(active.timeout);
    active.timeout = null;
    resolve(result);
  };

  const cancel = () => {
    if (!active) return;
    settleWait('cancelled');
    active = null;
  };

  return {
    begin(deviceKey: string): PreviewSetupOperation | null {
      if (active) return null;
      const operation = { id: ++nextId, deviceKey };
      active = {
        operation,
        sessionId: null,
        resolveWait: null,
        timeout: null,
      };
      return operation;
    },

    bindSession(operation: PreviewSetupOperation, sessionId: string): boolean {
      if (active?.operation !== operation) return false;
      active.sessionId = sessionId;
      return true;
    },

    isCurrent(operation: PreviewSetupOperation): boolean {
      return active?.operation === operation;
    },

    waitForFrame(
      operation: PreviewSetupOperation,
      sessionId: string,
      timeoutMs: number,
    ): Promise<PreviewFrameWaitResult> {
      if (active?.operation !== operation || active.sessionId !== sessionId) {
        return Promise.resolve('cancelled');
      }
      if (renderedSessionIds.has(sessionId)) return Promise.resolve('frame');

      return new Promise((resolve) => {
        if (!active || active.operation !== operation) {
          resolve('cancelled');
          return;
        }
        active.resolveWait = resolve;
        active.timeout = setTimeout(() => {
          if (active?.operation !== operation) return;
          active.resolveWait = null;
          active.timeout = null;
          resolve('timeout');
        }, timeoutMs);
      });
    },

    markFrameRendered(
      sessionId: string,
      _source: PreviewRenderedFrameSource,
    ) {
      renderedSessionIds.add(sessionId);
      if (active?.sessionId === sessionId) settleWait('frame');
    },

    reconcile(deviceKey: string, sessionId: string | null) {
      if (
        active &&
        (active.operation.deviceKey !== deviceKey ||
          (active.sessionId !== null && active.sessionId !== sessionId))
      ) {
        cancel();
      }
      renderedSessionIds.forEach((renderedSessionId) => {
        if (renderedSessionId !== sessionId) {
          renderedSessionIds.delete(renderedSessionId);
        }
      });
    },

    complete(operation: PreviewSetupOperation) {
      if (active?.operation !== operation) return;
      settleWait('cancelled');
      active = null;
    },

    cancel,
  };
}
