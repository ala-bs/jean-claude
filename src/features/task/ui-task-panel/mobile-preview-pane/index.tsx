import {
  Check,
  Circle,
  Copy,
  Keyboard,
  Link,
  ListTree,
  Loader2,
  MoreHorizontal,
  MousePointer2,
  PanelRight,
  Pin,
  PinOff,
  RotateCcw,
  RotateCw,
  Route,
  Settings,
  Terminal,
  Type,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';

import { Dropdown, DropdownDivider, DropdownItem } from '@/common/ui/dropdown';

import { Button } from '@/common/ui/button';
import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';
import { Select } from '@/common/ui/select';


import {
  MOBILE_PREVIEW_DEVICE_ASSIGNMENTS_QUERY_KEY,
  useAndroidDeviceManagement,
  useIosDeviceManagement,
  useMobilePreviewDeviceAssignments,
  useMobilePreviewDevices,
  useMobilePreviewNativeLogs,
  useMobilePreviewSession,
  useReactNativeDevTools,
} from '@/hooks/use-mobile-preview';
import { useTasks } from '@/hooks/use-tasks';

import { useQueryClient } from '@tanstack/react-query';

import {
  buildMobilePreviewDeviceTaskMap,
  resolveDeviceRowTaskInfo,
} from './utils-device-assignments';
import { PreviewNotice, PreviewNoticeStack } from './ui-preview-notices';
import { DeviceRailRow } from './ui-device-rail-row';

import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useRunCommands } from '@/hooks/use-run-commands';

import {
  useMobilePreviewDeviceSelection,
  useMobilePreviewFps,
  useMobilePreviewPaneWidth,
  useMobilePreviewQuality,
  useMobilePreviewShowGestures,
} from '@/stores/navigation';

import { useTaskMessagesStore } from '@/stores/task-messages';

import { api } from '@/lib/api';
import { createMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';

import {
  isPhysicalMobilePreviewDevice,
  type MobilePlatform,
  type MobilePreviewAndroidAppStatus,
  type MobilePreviewDevice,
  type MobilePreviewIosAppStatus,
  type MobilePreviewQuality,
  type MobilePreviewTextSize,
} from '@shared/mobile-simulator-types';

import {
  applyDeviceToBuildCommand,
  getDeviceBuildCommandNotice,
} from './utils-device-build-command';
import {
  applyPreviewDeviceSwitch,
  cancelPendingWorkspaceSetup,
  createIosBuildLaunchCoordinator,
  createPreviewSetupOperationCoordinator,
  getDeferredSetupAction,
  getDependencyInstallDeferredAction,
  getIosAppStatusRequestKey,
  getIosAppStatusRequestState,
  getMobileAppSetupDecision,
  getMobileBuildCommandId,
  shouldStopPreviousIosBuild,
} from './utils-setup-operation';
import {
  canStartDevice,
  formatDeviceState,
  getDefaultAndroidProjectPath,
  getPreviewDeviceKey,
  sortPhysicalDevicesByAvailability,
} from './utils-device-setup';
import { EmptyState, PreviewErrorState } from './ui-common';
import {
  formatError,
  getStreamStrategyLabel,
  getWaitingForFrameDetail,
} from './utils-preview-error';
import {
  GestureFeedbackOverlay,
  H264PreviewCanvas,
  ImagePreviewSurface,
  RawRgbaPreviewCanvas,
} from './ui-preview-surface';
import {
  getRuntimeLaunchAttemptKey,
  getRuntimeLaunchDismissKey,
  isRuntimeLaunchNoticeDismissable,
  shouldShowRuntimeLaunchNotice,
} from './utils-runtime-launch-notice';
import {
  NativeLogsTabLabel,
  PreviewStatusText,
} from './ui-stream-readouts';
import type { CommandRunStatus } from '@shared/run-command-types';
import { DevServerTab } from './ui-dev-server-tab';
import { DevToolsTab } from './ui-devtools-tab';
import { LogsTab } from './ui-logs-tab';
import { ManageDevicesDialog } from './ui-manage-devices-dialog';
import type { MobilePreviewPaneTab } from './utils-tabs';
import type { MobilePreviewProjectConfig } from '@shared/types';
import { SetupTab } from './ui-setup-tab';
import { useMobilePreviewInput } from './use-mobile-preview-input';

export { buildGestureFeedbackPath } from './ui-preview-surface';
import {
  createGestureFeedbackStore,
} from './gesture-feedback-store';
import {
  createPreviewFpsStore,
} from './preview-fps-store';
import { useMobilePreviewRecording } from './use-mobile-preview-recording';
import { useMobilePreviewActions } from './use-mobile-preview-actions';
import {
  type PreviewDerived,
  type PreviewFacts,
  type PreviewStepKey,
  getSetupModel,
  PHYSICAL_IOS_STREAMING_UNSUPPORTED_DETAIL,
  PHYSICAL_IOS_STREAMING_UNSUPPORTED_TITLE,
} from './utils-setup-model';
import {
  type PreviewStepActionIntent,
  getSetupStepAction,
} from './utils-setup-step-actions';
import { runWorkspaceSetup } from './utils-run-workspace-setup';
import { getDeviceCornerRadiusRatio } from './utils-device-frame';
import { waitForDevToolsReattach } from './utils-devtools-reattach';
import { getMobilePreviewStandaloneLayoutClasses } from '@/features/mobile-preview/utils-mobile-preview-standalone-layout';
import {
  clearDismissedNotice,
  isNoticeDismissed,
  markNoticeDismissed,
} from '@/features/mobile-preview/mobile-preview-dismissed-notices-store';
import { useMobilePreviewAutoStart } from '@/features/mobile-preview/use-mobile-preview-auto-start';
import { useMobilePreviewExpoLaunch } from '@/features/mobile-preview/use-mobile-preview-expo-launch';

const FPS_OPTIONS = [
  { value: '15', label: '15 FPS' },
  { value: '30', label: '30 FPS' },
  { value: '60', label: '60 FPS' },
];

const QUALITY_OPTIONS = [
  { value: 'low', label: '480p · 2 Mbps' },
  { value: 'balanced', label: '720p · 8 Mbps' },
  { value: 'high', label: '1080p · 16 Mbps' },
  { value: 'very-high', label: '1440p · 24 Mbps' },
];
const EMPTY_DETECTED_APPS: MobilePreviewProjectConfig['detectedApps'] = [];

const TEXT_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'x-large', label: 'XL' },
];


export function MobilePreviewPane({
  taskId,
  projectId,
  projectPath,
  mobilePreviewConfig,
  variant = 'pane',
  retainSessions = false,
  appPathOverride,
  metroPortOverride,
  metroStatusOverride,
  autoLaunchRunningRuntime = false,
  isSelectingAppPath = false,
  appSelectionError = null,
  onSelectAppPath,
}: {
  taskId: string;
  projectId: string;
  projectPath: string;
  mobilePreviewConfig?: MobilePreviewProjectConfig;
  variant?: 'pane' | 'standalone';
  retainSessions?: boolean;
  appPathOverride?: string;
  metroPortOverride?: number;
  metroStatusOverride?: CommandRunStatus;
  autoLaunchRunningRuntime?: boolean;
  isSelectingAppPath?: boolean;
  appSelectionError?: string | null;
  onSelectAppPath?: (appPath: string | null) => void;
}) {
  const isStandalone = variant === 'standalone';
  const [platform, setPlatform] = useState<MobilePlatform>('ios');
  const [deviceId, setDeviceId] = useState('');
  const [previewRotationDeg, setPreviewRotationDeg] = useState(0);
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  // Successful actions stay silent: they clear any stale error instead of
  // adding an informational banner.
  const showActionNotice = useCallback((_message?: string) => {
    setInputNotice(null);
  }, []);
  const [runtimeLaunchRetry, setRuntimeLaunchRetry] = useState(0);
  /**
   * Identity of the runtime-launch notice the user dismissed (device +
   * message), so a different failure — or the same failure on another device —
   * still surfaces instead of staying silently hidden.
   *
   * The module-scope dismissal store is the real source of truth (it survives
   * this pane unmounting when the workspace is closed). This state exists only
   * to re-render on dismiss, which is why every store write below is paired
   * with a `setState`.
   */
  const [dismissedRuntimeLaunchKey, setDismissedRuntimeLaunchKeyState] =
    useState<string | null>(null);
  const [isStandaloneInspectorOpen, setIsStandaloneInspectorOpen] =
    useState(false);
  const [activeTab, setActiveTab] = useState<MobilePreviewPaneTab>('setup');
  const [devToolsLaunchError, setDevToolsLaunchError] = useState<string | null>(
    null,
  );
  const [selectedDevToolsTargetId, setSelectedDevToolsTargetId] = useState('');
  const devToolsViewRef = useRef<HTMLDivElement | null>(null);
  const devToolsOpenedRef = useRef(false);
  const [isDevToolsViewOpen, setIsDevToolsViewOpen] = useState(false);
  const devToolsShouldShowRef = useRef(false);
  const devToolsOpenRequestRef = useRef(0);
  const devToolsTargetMenuOpenRef = useRef(false);
  const devToolsReattachRequestRef = useRef(0);
  const [activeConsoleCommandId, setActiveConsoleCommandId] = useState<
    string | null
  >(null);
  const [resumeSetupAfterPrebuild, setResumeSetupAfterPrebuild] =
    useState(false);
  const [resumeSetupAfterDependenciesInstall, setResumeSetupAfterDependenciesInstall] =
    useState(false);
  const [isManageDevicesOpen, setIsManageDevicesOpen] = useState(false);
  const [isCreateIosDeviceOpen, setIsCreateIosDeviceOpen] = useState(false);
  const [isRestartingAndroidApp, setIsRestartingAndroidApp] = useState(false);
  const [isRestartingIosApp, setIsRestartingIosApp] = useState(false);
  const [androidAppStatus, setAndroidAppStatus] =
    useState<MobilePreviewAndroidAppStatus | null>(null);
  const [resolvedIosAppStatus, setResolvedIosAppStatus] = useState<{
    requestKey: string;
    value: MobilePreviewIosAppStatus | null;
    error: string | null;
  } | null>(null);
  const [iosAppStatusRefreshNonce, setIosAppStatusRefreshNonce] = useState(0);
  const [launchedIosBuildCommandIds, setLaunchedIosBuildCommandIds] = useState<
    string[]
  >([]);
  const [androidProjectExists, setAndroidProjectExists] = useState<
    boolean | null
  >(null);
  const [deviceRailWidth, setDeviceRailWidth] = useState(220);
  const [inspectorPaneWidth, setInspectorPaneWidth] = useState(392);
  const { width, setWidth, minWidth, maxWidth } = useMobilePreviewPaneWidth();
  const { fps, setFps } = useMobilePreviewFps();
  const { quality, setQuality } = useMobilePreviewQuality();
  const { showGestures, setShowGestures } = useMobilePreviewShowGestures();
  const isDevServerTabVisible = activeTab === 'dev-server';
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: width,
    minWidth,
    maxWidth,
    maxWidthFraction: 0.85,
    direction: 'left',
    onWidthChange: setWidth,
  });
  const {
    isDragging: isDraggingDeviceRail,
    handleMouseDown: handleDeviceRailMouseDown,
  } = useHorizontalResize({
    initialWidth: deviceRailWidth,
    minWidth: 160,
    maxWidth: 340,
    maxWidthFraction: 0.35,
    direction: 'right',
    onWidthChange: setDeviceRailWidth,
  });
  const {
    isDragging: isDraggingInspectorPane,
    handleMouseDown: handleInspectorPaneMouseDown,
  } = useHorizontalResize({
    initialWidth: inspectorPaneWidth,
    minWidth: 300,
    maxWidth: 560,
    maxWidthFraction: 0.55,
    direction: 'left',
    onWidthChange: setInspectorPaneWidth,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const selectedDevicePreferenceKeyRef = useRef<string | null>(null);
  const previousIosBuildCommandIdRef = useRef<string | null>(null);
  const launchedIosBuildCommandIdsRef = useRef(new Set<string>());
  const [setupOperationCoordinator] = useState(
    createPreviewSetupOperationCoordinator,
  );
  const [iosBuildLaunchCoordinator] = useState(createIosBuildLaunchCoordinator);
  const lastImageStatsSampleRef = useRef({
    at: 0,
    received: 0,
  });
  const [previewFpsStore] = useState(createPreviewFpsStore);
  const [gestureFeedbackStore] = useState(createGestureFeedbackStore);
  const selectedAppPath = mobilePreviewConfig?.selectedAppPath ?? null;
  const detectedApps = mobilePreviewConfig?.detectedApps ?? EMPTY_DETECTED_APPS;
  const validSelectedAppPath =
    selectedAppPath && detectedApps.some((app) => app.path === selectedAppPath)
      ? selectedAppPath
      : null;
  const hasAppPathOverride =
    typeof appPathOverride === 'string' && appPathOverride.length > 0;
  const needsAppSelection =
    !hasAppPathOverride && detectedApps.length > 1 && !validSelectedAppPath;
  const appPath = hasAppPathOverride
    ? appPathOverride
    : (validSelectedAppPath ?? detectedApps[0]?.path ?? '.');
  const selectedDetectedApp =
    detectedApps.find((app) => app.path === appPath) ?? null;
  const isExpoApp = selectedDetectedApp?.stacks.includes('expo') ?? false;
  const devicePreferenceKey = `${taskId}:${appPath}`;
  const legacyDevicePreferenceKey = `${projectId}:${appPath}`;
  const {
    selectedDevice: savedSelectedDevice,
    setSelectedDevice: setSavedSelectedDevice,
    setVisibleDeviceIdsByPlatform,
    visibleDeviceIdsByPlatform,
  } = useMobilePreviewDeviceSelection({
    key: devicePreferenceKey,
    legacyKey: legacyDevicePreferenceKey,
  });
  const androidProjectPath =
    mobilePreviewConfig?.androidProjectPath ??
    getDefaultAndroidProjectPath({ appPath, detectedApps });
  const inferredAndroidProjectPath = appPath === '.' ? 'android' : `${appPath}/android`;
  // Project override first, detected app config second (see Project Settings →
  // Mobile Preview → App scheme).
  const configuredAppScheme =
    mobilePreviewConfig?.appScheme ??
    detectedApps.find((app) => app.path === appPath)?.detectedAppScheme ??
    null;
  const effectiveProjectPath =
    appPath && appPath !== '.' ? `${projectPath}/${appPath}` : projectPath;
  const devServerCommandId = useMemo(
    () => createMobileDevServerCommandId(appPath),
    [appPath],
  );
  const buildCommandId = useMemo(
    () => getMobileBuildCommandId({ appPath, platform, deviceId }),
    [appPath, deviceId, platform],
  );
  const iosBuildCommandIdPrefix = `mobile-build:${encodeURIComponent(appPath || '.')}:ios:`;
  const prebuildCommandId = useMemo(
    () => `mobile-prebuild:${encodeURIComponent(appPath || '.')}:${platform}`,
    [appPath, platform],
  );
  const dependenciesInstallCommandId = useMemo(
    () => `mobile-dependencies-install:${encodeURIComponent(appPath || '.')}`,
    [appPath],
  );
  const devServerCommand =
    mobilePreviewConfig?.metroStartCommand ?? 'npx expo start --dev-client';
  const dependenciesInstallCommand =
    mobilePreviewConfig?.dependenciesInstallCommand ??
    (mobilePreviewConfig?.packageManager === 'pnpm'
      ? 'pnpm install'
      : mobilePreviewConfig?.packageManager === 'yarn'
        ? 'yarn install'
        : mobilePreviewConfig?.packageManager === 'bun'
          ? 'bun install'
          : 'npm install');
  const consoleCommandScope =
    platform === 'ios' ? `${appPath}\u0000${platform}\u0000${deviceId}` : `${appPath}\u0000${platform}`;
  const packageManagerRunner =
    mobilePreviewConfig?.packageManager === 'pnpm'
      ? 'pnpm exec expo prebuild'
      : mobilePreviewConfig?.packageManager === 'yarn'
        ? 'yarn expo prebuild'
        : mobilePreviewConfig?.packageManager === 'bun'
          ? 'bunx expo prebuild'
          : 'npx expo prebuild';
  const defaultPrebuildCommand = `${packageManagerRunner} --platform ${platform}`;
  const prebuildCommand =
    (platform === 'android'
      ? mobilePreviewConfig?.androidPrebuildCommand
      : mobilePreviewConfig?.iosPrebuildCommand) ?? defaultPrebuildCommand;
  const configuredBuildCommand =
    platform === 'android'
      ? (mobilePreviewConfig?.androidBuildCommand ?? null)
      : (mobilePreviewConfig?.iosBuildCommand ?? null);
  const configuredDevServerPort = mobilePreviewConfig?.metroPort ?? 8081;
  const runCommands = useRunCommands({
    taskId,
    projectId,
    workingDir: effectiveProjectPath,
  });
  const devServerStatus =
    metroStatusOverride ?? runCommands.statusByCommandId[devServerCommandId];
  const buildStatus = runCommands.statusByCommandId[buildCommandId];
  const prebuildStatus = runCommands.statusByCommandId[prebuildCommandId];
  const dependenciesInstallStatus =
    runCommands.statusByCommandId[dependenciesInstallCommandId];
  const devServerStarting = runCommands.isCommandStarting(devServerCommandId);
  const effectiveDevServerPort =
    !devServerStarting && devServerStatus?.status === 'running'
      ? (metroPortOverride ??
        devServerStatus.ports?.[0] ??
        configuredDevServerPort)
      : (metroPortOverride ?? configuredDevServerPort);
  // Eager: resolve the DevTools target as soon as Metro is running so the
  // embedded view can attach before the user opens the tab (captures early
  // console/network activity). Poll until a target shows up, then stop.
  const isDevServerRunning =
    !devServerStarting && devServerStatus?.status === 'running';
  const reactNativeDevTools = useReactNativeDevTools({
    metroPort: effectiveDevServerPort,
    panel: 'console',
    enabled: isDevServerRunning || activeTab === 'devtools',
    pollUntilTargetMs: 5000,
  });
  // Probing Metro directly (instead of through the query) keeps the cache — and
  // therefore the embedded view's URL — untouched while we wait. Every resolve
  // mints a new launchId, so going through the query would tear down and reload
  // the DevTools view on every single poll.
  const probeDevToolsTargetIds = useCallback(async () => {
    const result = await api.mobilePreview.resolveReactNativeDevTools({
      metroPort: effectiveDevServerPort,
      panel: 'console',
    });
    return (result.targets ?? []).map((target) => target.id);
  }, [effectiveDevServerPort]);
  const refetchDevTools = reactNativeDevTools.refetch;
  // Restarting the app kills its Hermes CDP target, so the embedded DevTools
  // view is left attached to a dead session. Wait (the app needs time to boot
  // and re-register with Metro), then refetch exactly once: the fresh launchId
  // in the resolved URL is what makes the embedded view reload.
  const reattachDevToolsAfterRestart = useCallback(
    async (previousTargetIds: string[]) => {
      const requestId = devToolsReattachRequestRef.current + 1;
      devToolsReattachRequestRef.current = requestId;
      const isCancelled = () =>
        devToolsReattachRequestRef.current !== requestId;
      const status = await waitForDevToolsReattach({
        previousTargetIds,
        pollTargetIds: probeDevToolsTargetIds,
        isCancelled,
      });
      if (status === 'cancelled') return;
      // Refetch on timeout too: Metro can reuse a target id for the relaunched
      // app, in which case the wait "fails" even though DevTools must reload.
      await refetchDevTools();
      if (status === 'timeout' && !isCancelled()) {
        setInputNotice(
          'App restarted but no new DevTools target appeared. Use Refresh in the DevTools tab.',
        );
      }
    },
    [probeDevToolsTargetIds, refetchDevTools],
  );
  // Unmount, or switching device/platform, must abandon an in-flight wait —
  // otherwise it would reload the *next* device's DevTools view.
  useEffect(
    () => () => {
      devToolsReattachRequestRef.current += 1;
    },
    [platform, deviceId],
  );
  useEffect(() => {
    const targets = reactNativeDevTools.data?.targets ?? [];
    if (targets.length === 0) {
      queueMicrotask(() => setSelectedDevToolsTargetId(''));
      return;
    }
    if (targets.some((target) => target.id === selectedDevToolsTargetId)) return;
    const nextTargetId = targets.at(-1)?.id ?? '';
    queueMicrotask(() => setSelectedDevToolsTargetId(nextTargetId));
  }, [reactNativeDevTools.data?.targets, selectedDevToolsTargetId]);
  useEffect(() => {
    queueMicrotask(() => setActiveConsoleCommandId(null));
  }, [consoleCommandScope]);
  const currentIosBuildCommandId = platform === 'ios' && deviceId ? buildCommandId : null;
  // Transient loss of the ios device id (re-render/rehydration) while the pane
  // still targets ios must not tear down an in-flight build.
  const isTransientIosCommandIdLoss =
    retainSessions && platform === 'ios' && !deviceId;
  const retainSessionsRef = useRef(retainSessions);
  useEffect(() => {
    retainSessionsRef.current = retainSessions;
  }, [retainSessions]);
  const iosBuildLifecycleRef = useRef({
    statusByCommandId: runCommands.statusByCommandId,
    isCommandStarting: runCommands.isCommandStarting,
    stopCommand: runCommands.stopCommand,
  });
  useEffect(() => {
    iosBuildLifecycleRef.current = {
      statusByCommandId: runCommands.statusByCommandId,
      isCommandStarting: runCommands.isCommandStarting,
      stopCommand: runCommands.stopCommand,
    };
  }, [runCommands]);
  useEffect(() => {
    launchedIosBuildCommandIdsRef.current = new Set(launchedIosBuildCommandIds);
  }, [launchedIosBuildCommandIds]);
  useEffect(() => {
    const previousCommandId = previousIosBuildCommandIdRef.current;
    previousIosBuildCommandIdRef.current = currentIosBuildCommandId;
    if (
      previousCommandId &&
      previousCommandId !== currentIosBuildCommandId &&
      !isTransientIosCommandIdLoss
    ) {
      // cancel() makes a pending launch stop the command once it resolves, so
      // it must be gated on the same condition as the stop below.
      iosBuildLaunchCoordinator.cancel(previousCommandId);
    }
    if (
      !shouldStopPreviousIosBuild({
        previousCommandId,
        currentCommandId: currentIosBuildCommandId,
        previousStatus: previousCommandId
          ? runCommands.statusByCommandId[previousCommandId]?.status
          : undefined,
        previousStarting: previousCommandId
          ? runCommands.isCommandStarting(previousCommandId)
          : false,
        keepPreviousCommand: isTransientIosCommandIdLoss,
      })
    ) {
      return;
    }
    void runCommands.stopCommand(previousCommandId!);
  }, [
    currentIosBuildCommandId,
    iosBuildLaunchCoordinator,
    runCommands,
    isTransientIosCommandIdLoss,
  ]);
  useEffect(
    () => () => {
      // Sessions retained (e.g. user switched to another task): keep in-flight
      // iOS builds alive. Task completion/quit cleanup still stops them.
      if (retainSessionsRef.current) return;
      iosBuildLaunchCoordinator.cancelAll();
      const lifecycle = iosBuildLifecycleRef.current;
      const commandIds = new Set(launchedIosBuildCommandIdsRef.current);
      if (previousIosBuildCommandIdRef.current) {
        commandIds.add(previousIosBuildCommandIdRef.current);
      }
      commandIds.forEach((commandId) => {
        if (
          lifecycle.statusByCommandId[commandId]?.status === 'running' ||
          lifecycle.isCommandStarting(commandId)
        ) {
          void lifecycle.stopCommand(commandId);
        }
      });
    },
    [iosBuildLaunchCoordinator],
  );
  useEffect(() => {
    queueMicrotask(() => {
      setLaunchedIosBuildCommandIds((current) => {
        const next = current.filter((commandId) => {
          const status = runCommands.statusByCommandId[commandId]?.status;
          return !(
            (status === 'stopped' || status === 'errored') &&
            !runCommands.isCommandStarting(commandId)
          );
        });
        return next.length === current.length ? current : next;
      });
    });
  }, [runCommands]);
  const normalizedBuildStatus =
    platform === 'ios' && runCommands.status === null
      ? 'loading'
      : buildStatus?.status === 'running'
      ? 'running'
      : buildStatus?.status === 'stopped'
        ? 'completed'
        : buildStatus?.status === 'errored'
          ? 'errored'
          : 'idle';
  const normalizedPrebuildStatus =
    prebuildStatus?.status === 'stopped' ? 'completed' : prebuildStatus?.status;
  const iosAppStatusRequestKey =
    platform === 'ios' && deviceId
      ? getIosAppStatusRequestKey({
          projectId,
          taskId,
          appPath,
          deviceId,
          buildStatus: buildStatus?.status,
          prebuildStatus: prebuildStatus?.status,
          refreshNonce: iosAppStatusRefreshNonce,
          iosBundleId: mobilePreviewConfig?.iosBundleId,
          packageManager: mobilePreviewConfig?.packageManager,
        })
      : null;
  const {
    value: iosAppStatus,
    error: iosAppStatusError,
    isLoading: isIosAppStatusLoading,
  } = getIosAppStatusRequestState({
    requestKey: iosAppStatusRequestKey,
    resolved: resolvedIosAppStatus,
  });
  const androidStatusProjectPath =
    androidProjectPath ??
    (platform === 'android' && isExpoApp ? inferredAndroidProjectPath : null);
  const consoleCommandId = activeConsoleCommandId ?? devServerCommandId;
  const consoleStatus = runCommands.statusByCommandId[consoleCommandId];
  // Metro output streams continuously; only read it while its tab is visible.
  const devServerLog =
    useTaskMessagesStore((state) =>
      isDevServerTabVisible
        ? state.runCommandLogs[taskId]?.[consoleCommandId]
        : undefined,
    ) ?? null;

  useEffect(() => {
    if (platform !== 'android' || !deviceId || !androidStatusProjectPath) {
      queueMicrotask(() => setAndroidAppStatus(null));
      queueMicrotask(() => setAndroidProjectExists(null));
      return;
    }

    let cancelled = false;
    api.mobilePreview
      .getAndroidAppStatus({
        projectId,
        taskId,
        androidProjectPath: androidStatusProjectPath,
        deviceId,
      })
      .then((status) => {
        if (!cancelled) {
          setAndroidAppStatus(status);
          setAndroidProjectExists(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = formatError(error) ?? '';
          setAndroidAppStatus(null);
          setAndroidProjectExists(
            message.includes('No native Android project found') ? false : null,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    androidStatusProjectPath,
    buildStatus?.status,
    deviceId,
    platform,
    prebuildStatus?.status,
    projectId,
    taskId,
  ]);
  useEffect(() => {
    if (!iosAppStatusRequestKey || platform !== 'ios' || !deviceId) {
      queueMicrotask(() => setResolvedIosAppStatus(null));
      return;
    }

    let cancelled = false;
    const requestId = crypto.randomUUID();
    queueMicrotask(() => {
      if (!cancelled) {
        setResolvedIosAppStatus((current) =>
          current?.requestKey === iosAppStatusRequestKey ? current : null,
        );
      }
    });
    api.mobilePreview
      .getIosAppStatus({ projectId, taskId, appPath, deviceId, requestId })
      .then((status) => {
        if (!cancelled) {
          setResolvedIosAppStatus({
            requestKey: iosAppStatusRequestKey,
            value: status,
            error: null,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setResolvedIosAppStatus({
            requestKey: iosAppStatusRequestKey,
            value: null,
            error: formatError(error) ?? 'Failed to check iOS app status',
          });
        }
      });

    return () => {
      cancelled = true;
      void api.mobilePreview
        .cancelIosAppStatus({ projectId, taskId, requestId })
        .catch(() => {});
    };
  }, [
    appPath,
    buildStatus?.status,
    deviceId,
    iosAppStatusRequestKey,
    mobilePreviewConfig?.iosBundleId,
    mobilePreviewConfig?.packageManager,
    platform,
    prebuildStatus?.status,
    projectId,
    taskId,
  ]);
  const nativeLogParams = useMemo(
    () => (deviceId ? { platform, deviceId } : null),
    [deviceId, platform],
  );
  const nativeLogs = useMobilePreviewNativeLogs(nativeLogParams);
  const selectedPreviewDevice = useMemo(
    () => (deviceId ? { platform, deviceId } : null),
    [deviceId, platform],
  );
  const selectedPreviewDeviceKey = selectedPreviewDevice
    ? getPreviewDeviceKey(selectedPreviewDevice.platform, selectedPreviewDevice.deviceId)
    : null;
  const androidManagement = useAndroidDeviceManagement(
    platform === 'android' || isManageDevicesOpen,
  );
  const iosManagement = useIosDeviceManagement(
    platform === 'ios' || isManageDevicesOpen || isCreateIosDeviceOpen,
  );

  const {
    data: iosDevices = [],
    error: iosDevicesError,
    isLoading: isLoadingIosDevices,
  } = useMobilePreviewDevices('ios');
  const {
    data: androidDevices = [],
    error: androidDevicesError,
    isLoading: isLoadingAndroidDevices,
  } = useMobilePreviewDevices('android');
  const {
    session,
    activeSessionDeviceKeys,
    hasImageFrame,
    imageFrameCountRef,
    subscribeImageFrames,
    subscribeH264Chunks,
    start,
    cancelStart,
    stop,
    sendInput,
    rotate,
    isStarting,
    isStopping,
    isRotating,
    isHydratingRetainedSessions,
    startError,
    stopError,
    rotateError,
  } = useMobilePreviewSession(taskId, selectedPreviewDevice, {
    retainSessions,
  });

  const selectPreviewDevice = useCallback(
    ({ platform: nextPlatform, deviceId: nextDeviceId }: {
      platform: MobilePlatform;
      deviceId: string;
    }) => {
      if (nextPlatform === platform && nextDeviceId === deviceId) return;
      if (!retainSessions && session && session.status !== 'stopped') {
        void stop().catch((error: unknown) => {
          setInputNotice(formatError(error) ?? 'Failed to stop preview stream');
        });
      }
      applyPreviewDeviceSwitch({
        platform: nextPlatform,
        deviceId: nextDeviceId,
        cancelPending: () =>
          cancelPendingWorkspaceSetup({
            cancelSetupOperation: setupOperationCoordinator.cancel,
            cancelStart,
            setResumeSetupAfterPrebuild,
          }),
        setPlatform,
        setDeviceId,
      });
    },
    [
      cancelStart,
      deviceId,
      platform,
      retainSessions,
      session,
      setupOperationCoordinator,
      stop,
    ],
  );

  const allDevices = useMemo(
    () => [...androidDevices, ...iosDevices],
    [androidDevices, iosDevices],
  );
  const hasPendingVisibleDeviceDefaults =
    visibleDeviceIdsByPlatform.android === null ||
    visibleDeviceIdsByPlatform.ios === null;
  const visibleDevices = useMemo(
    () =>
      allDevices.filter((device) => {
        const visibleDeviceIds = visibleDeviceIdsByPlatform[device.platform];
        return visibleDeviceIds === null || visibleDeviceIds.includes(device.id);
      }),
    [allDevices, visibleDeviceIdsByPlatform],
  );
  const selectedDevice = useMemo(
    () =>
      allDevices.find(
        (device) => device.id === deviceId && device.platform === platform,
      ),
    [allDevices, deviceId, platform],
  );
  const sessionWidth = session?.width ?? null;
  const sessionHeight = session?.height ?? null;
  const previewSurfaceStyle = useMemo<CSSProperties>(
    () => {
      const radiusRatio = getDeviceCornerRadiusRatio({
        platform,
        deviceName: selectedDevice?.name ?? '',
      });
      const screenAspectRatio =
        sessionWidth && sessionHeight ? sessionWidth / sessionHeight : 0.46;
      return {
        borderRadius: `${radiusRatio * 100}% / ${radiusRatio * screenAspectRatio * 100}%`,
        transform: `rotate(${previewRotationDeg}deg)`,
        transformOrigin: 'center',
        transition: 'transform 120ms ease',
      };
    },
    [
      platform,
      previewRotationDeg,
      selectedDevice?.name,
      sessionWidth,
      sessionHeight,
    ],
  );
  const selectedDeviceCanStart = canStartDevice(selectedDevice);
  const selectedDeviceIsPhysical = isPhysicalMobilePreviewDevice(selectedDevice);
  const selectedDeviceConnected =
    selectedDeviceIsPhysical && selectedDevice?.connection === 'connected';
  // The selected device — simulator or real hardware — gets a
  // `--device`/`--udid`/`--deviceId` selector (or its `{{device}}` token
  // substituted) so the CLI builds onto it instead of its own default. Script
  // wrappers like `pnpm run ios` hide the CLI, so the detected stacks decide
  // the flag.
  // Round-trip the stacks through a primitive so the memo has a stable dep and
  // nothing downstream holds a reference into the detected-app object.
  const selectedAppStacksKey = useMemo(
    () =>
      detectedApps.find((app) => app.path === appPath)?.stacks.join(',') ?? '',
    [appPath, detectedApps],
  );
  const buildCommandForDevice = useMemo(
    () =>
      configuredBuildCommand
        ? applyDeviceToBuildCommand({
            command: configuredBuildCommand,
            device: selectedDevice,
            stacks: selectedAppStacksKey
              ? selectedAppStacksKey.split(',')
              : null,
          })
        : null,
    [configuredBuildCommand, selectedAppStacksKey, selectedDevice],
  );
  const buildCommand = buildCommandForDevice?.command ?? null;
  const buildCommandDeviceNotice = buildCommandForDevice
    ? getDeviceBuildCommandNotice(buildCommandForDevice)
    : null;
  const physicalIosStreamingUnsupported =
    platform === 'ios' && selectedDeviceIsPhysical;
  const activeSessionDeviceReady =
    !!session &&
    session.status !== 'stopped' &&
    session.platform === platform &&
    session.deviceId === deviceId;

  const devicesErrorMessage =
    formatError(androidDevicesError) ?? formatError(iosDevicesError);
  const isLoadingDevices = isLoadingAndroidDevices || isLoadingIosDevices;

  useEffect(() => {
    selectedDevicePreferenceKeyRef.current = null;
    queueMicrotask(() => {
      if (savedSelectedDevice) {
        setPlatform(savedSelectedDevice.platform);
        setDeviceId(savedSelectedDevice.deviceId);
      } else {
        setDeviceId('');
      }
      selectedDevicePreferenceKeyRef.current = devicePreferenceKey;
    });
  }, [devicePreferenceKey, savedSelectedDevice]);

  useEffect(() => {
    if (isLoadingDevices) return;
    if (activeSessionDeviceReady) return;
    if (selectedDevicePreferenceKeyRef.current !== devicePreferenceKey) return;

    // Never pick a device on the user's behalf: with nothing persisted and
    // nothing chosen yet the pane stays idle ("No device selected") instead of
    // booting an arbitrary simulator.
    if (!savedSelectedDevice && !deviceId) return;

    if (visibleDevices.length === 0) {
      queueMicrotask(() => setDeviceId(''));
      return;
    }

    if (
      !visibleDevices.some(
        (device) => device.id === deviceId && device.platform === platform,
      )
    ) {
      const preferredDevice =
        visibleDevices.find((device) => device.platform === platform) ??
        visibleDevices[0];
      queueMicrotask(() => {
        setPlatform(preferredDevice.platform);
        setDeviceId(preferredDevice.id);
      });
    }
  }, [
    activeSessionDeviceReady,
    deviceId,
    devicePreferenceKey,
    isLoadingDevices,
    platform,
    savedSelectedDevice,
    setDeviceId,
    visibleDevices,
  ]);

  useEffect(() => {
    if (isLoadingDevices) return;

    queueMicrotask(() => {
      setVisibleDeviceIdsByPlatform((current) => {
        const next = { ...current };
        let changed = false;
        const defaults: Record<MobilePlatform, MobilePreviewDevice[]> = {
          android: androidDevices.filter((device) => device.state === 'booted'),
          ios: iosDevices.filter((device) => device.state === 'booted'),
        };
        if (defaults.android.length === 0 && androidDevices[0]) {
          defaults.android = [androidDevices[0]];
        }

        (['android', 'ios'] as const).forEach((devicePlatform) => {
          if (next[devicePlatform] !== null) return;
          next[devicePlatform] = defaults[devicePlatform].map(
            (device) => device.id,
          );
          changed = true;
        });
        return changed ? next : current;
      });
    });
  }, [
    androidDevices,
    iosDevices,
    isLoadingDevices,
    setVisibleDeviceIdsByPlatform,
  ]);

  useEffect(() => {
    if (selectedDevicePreferenceKeyRef.current !== devicePreferenceKey) return;
    if (hasPendingVisibleDeviceDefaults) return;

    if (!deviceId) {
      setSavedSelectedDevice(null);
      return;
    }

    setSavedSelectedDevice({ platform, deviceId });
  }, [
    deviceId,
    devicePreferenceKey,
    hasPendingVisibleDeviceDefaults,
    platform,
    setSavedSelectedDevice,
  ]);

  const appOptions = useMemo(
    () =>
      detectedApps.map((app) => ({
        value: app.path,
        label:
          app.path === '.'
            ? `Root (${app.stacks.join(', ')})`
            : `${app.path} (${app.stacks.join(', ')})`,
        description: app.reasons.join(', '),
      })),
    [detectedApps],
  );

  const isRunning =
    session?.status === 'checking-tools' ||
    session?.status === 'starting' ||
    session?.status === 'streaming';
  const hasActiveSession = !!session && session.status !== 'stopped';
  const { isRecording, startRecording, stopRecording, captureScreenshot } =
    useMobilePreviewRecording({
      containerRef,
      gestureFeedbackStore,
      showGestures,
      hasImageFrame,
      recordingFolder: mobilePreviewConfig?.mobilePreviewRecordingFolder,
    });
  const isInputPreparing = session?.inputStatus === 'starting';
  const displayError =
    session?.error ??
    formatError(startError) ??
    formatError(stopError) ??
    formatError(rotateError);
  const fatalSessionError = session?.status === 'error' ? displayError : null;
  const streamStrategyLabel = getStreamStrategyLabel(session?.streamStrategy);

  const runtimeLaunchState = useMobilePreviewExpoLaunch({
    isRunningRuntime: autoLaunchRunningRuntime && !isHydratingRetainedSessions,
    isLoadingDevices,
    selectedDevice: selectedDevice ?? null,
    isExpoApp,
    taskId,
    projectId,
    appPath,
    metroPort: effectiveDevServerPort,
    devServerPid: devServerStatus?.pid ?? null,
    retryGeneration: runtimeLaunchRetry,
    isSelectedDeviceReady: activeSessionDeviceReady,
    isAppInstalled:
      (platform === 'android'
        ? androidAppStatus?.appInstalled
        : iosAppStatus?.appInstalled) ?? null,
    appScheme: configuredAppScheme,
  });
  // Only terminal notices can be dismissed; transient progress ones clear on
  // their own once the launch settles.
  const canDismissRuntimeLaunchNotice = isRuntimeLaunchNoticeDismissable(
    runtimeLaunchState.status,
  );
  const runtimeLaunchMessage =
    'message' in runtimeLaunchState ? runtimeLaunchState.message : '';
  // Mirrors the inputs that make `useMobilePreviewExpoLaunch` try again, so a
  // dismissal never carries over to a fresh attempt.
  //
  // `taskId`/`appPath` lead the key because dismissals are persisted in a
  // module-scope store shared by the whole renderer. Without them, two tasks on
  // the same simulator with Metro not yet running produce byte-identical keys
  // (pid collapses to '-', port is the project default), so dismissing in one
  // task would silently hide the banner in the other.
  const runtimeLaunchAttemptKey = getRuntimeLaunchAttemptKey([
    taskId,
    appPath,
    runtimeLaunchRetry,
    selectedPreviewDeviceKey,
    effectiveDevServerPort,
    devServerStatus?.pid,
  ]);
  const runtimeLaunchDismissKey = getRuntimeLaunchDismissKey({
    attemptKey: runtimeLaunchAttemptKey,
    message: runtimeLaunchMessage,
  });
  const showRuntimeLaunchNotice = shouldShowRuntimeLaunchNotice({
    status: runtimeLaunchState.status,
    message: runtimeLaunchMessage,
    attemptKey: runtimeLaunchAttemptKey,
    // Fall back to the persisted dismissal so a notice dismissed before the
    // pane unmounted stays dismissed after the workspace is reopened.
    dismissedKey:
      dismissedRuntimeLaunchKey ??
      (isNoticeDismissed(runtimeLaunchDismissKey)
        ? runtimeLaunchDismissKey
        : null),
  });
  const handlePreviewFrameRendered = useCallback(
    (sessionId: string, source: 'image' | 'raw-rgba' | 'h264') => {
      setupOperationCoordinator.markFrameRendered(sessionId, source);
    },
    [setupOperationCoordinator],
  );

  useEffect(() => {
    setupOperationCoordinator.reconcile(
      getPreviewDeviceKey(platform, deviceId),
      session?.id ?? null,
    );
  }, [deviceId, platform, session?.id, setupOperationCoordinator]);

  useEffect(
    () => () => setupOperationCoordinator.cancel(),
    [setupOperationCoordinator],
  );

  useEffect(() => {
    lastImageStatsSampleRef.current = {
      at: performance.now(),
      received: 0,
    };
    previewFpsStore.set(0);
  }, [previewFpsStore, session?.id]);

  useEffect(() => {
    queueMicrotask(() => setPreviewRotationDeg(0));
  }, [session?.id]);

  // H264 sessions report their own fps from the decoder; image sessions are
  // sampled here. Both write to the same ref-based store so the readout never
  // re-renders the pane.
  const isImageFpsSampled =
    session?.status === 'streaming' && session.frameFormat !== 'h264';
  useEffect(() => {
    if (!isImageFpsSampled) {
      previewFpsStore.set(0);
      return undefined;
    }

    const timer = window.setInterval(() => {
      const now = performance.now();
      const previous = lastImageStatsSampleRef.current;
      const seconds = Math.max((now - previous.at) / 1000, 0.001);
      const received = imageFrameCountRef.current;
      const receivedFps = Math.round((received - previous.received) / seconds);

      previewFpsStore.set(receivedFps);
      lastImageStatsSampleRef.current = {
        at: now,
        received,
      };
    }, 1000);

    return () => window.clearInterval(timer);
  }, [imageFrameCountRef, isImageFpsSampled, previewFpsStore, session?.id]);

  const previewMethodText =
    session?.status === 'streaming'
      ? (streamStrategyLabel ?? session.streamStrategy)
      : null;

  const {
    handleBackButton,
    handleHomeButton,
    handleKeyDown,
    handlePaste,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleRotateButton,
    handleShowKeyboardButton,
    handleWheel,
  } = useMobilePreviewInput({
    containerRef,
    imgRef,
    gestureFeedbackStore,
    isRunning,
    session,
    platform,
    previewRotationDeg,
    showGestures,
    sendInput,
    rotate,
    setInputNotice,
    setPreviewRotationDeg,
  });


  const autoPreviewStartAttemptKey = selectedPreviewDeviceKey
    ? [
        taskId,
        appPath,
        effectiveDevServerPort,
        devServerStatus?.pid ?? 'unknown-process',
        selectedPreviewDeviceKey,
      ].join('\0')
    : null;
  const {
    error: autoPreviewStartError,
    retry: retryAutoPreviewStart,
    clearError: clearAutoPreviewStartError,
    dismissError: dismissAutoPreviewStartError,
  } = useMobilePreviewAutoStart({
    enabled:
      autoLaunchRunningRuntime &&
      !needsAppSelection &&
      !hasActiveSession &&
      !isHydratingRetainedSessions &&
      !!deviceId &&
      selectedDeviceCanStart &&
      // Physical iPhones have no screen-stream API (simctl/idb are
      // simulator-only), so `mobilePreview:start` would always reject with the
      // "Live screen streaming is not supported..." guard and paint an error
      // banner the user can do nothing about. Do NOT re-enable this: the fix is
      // a real device-streaming backend, not retrying the doomed call.
      !physicalIosStreamingUnsupported,
    attemptKey: autoPreviewStartAttemptKey,
    start: () =>
      start({
        projectPath: effectiveProjectPath,
        platform,
        deviceId,
        fps,
        quality,
      }),
  });

  const handleStartStop = useCallback(async () => {
    try {
      if (hasActiveSession) {
        setupOperationCoordinator.cancel();
        await stop();
        return;
      }

      // Same simulator-only limitation as the auto-start gate above: starting a
      // stream on a physical iPhone can only ever fail, so it is a no-op here.
      if (
        !deviceId ||
        !selectedDeviceCanStart ||
        needsAppSelection ||
        physicalIosStreamingUnsupported
      )
        return;
      await start({
        projectPath: effectiveProjectPath,
        platform,
        deviceId,
        fps,
        quality,
      });
      clearAutoPreviewStartError();
    } catch {
      // Hook exposes start/stop errors for rendering.
    }
  }, [
    deviceId,
    fps,
    hasActiveSession,
    platform,
    effectiveProjectPath,
    quality,
    selectedDeviceCanStart,
    physicalIosStreamingUnsupported,
    needsAppSelection,
    start,
    stop,
    setupOperationCoordinator,
    clearAutoPreviewStartError,
  ]);

  const handleSelectDevice = useCallback(
    (device: MobilePreviewDevice) => {
      selectPreviewDevice({ platform: device.platform, deviceId: device.id });
    },
    [selectPreviewDevice],
  );

  const handleCloseManageDevices = useCallback(() => {
    setIsManageDevicesOpen(false);
    // The dialog's create-mode state (platform, Android form) is local and
    // resets on unmount, so this pane-level flag must reset with it. Otherwise
    // reopening lands on the Android create form for a pending iOS device.
    setIsCreateIosDeviceOpen(false);
  }, []);

  const {
    activeAction,
    setActiveAction,
    deeplinkUrl,
    setDeeplinkUrl,
    hostPort,
    setHostPort,
    devicePort,
    setDevicePort,
    textSize,
    setTextSize,
    isRunningAction,
    copiedDeviceId,
    mobileActionsMenuRef,
    deeplinkInputRef,
    deepLinks,
    toggleDeepLinkPinned,
    removeDeepLink,
    canForwardPort,
    handleCopyDeviceId,
    handleOpenDeeplink,
    handleOpenDevMenu,
    handleReloadExpo,
    handleShowDeeplinkAction,
    handleForwardPort,
    handleSetTextSize,
  } = useMobilePreviewActions({
    platform,
    deviceId,
    projectId,
    metroPort: effectiveDevServerPort,
    setInputNotice,
    showActionNotice,
  });
  const inputPreparingOverlay = isInputPreparing ? (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/45 backdrop-blur-[1px]">
      <div className="border-border bg-bg-0/95 text-ink-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs shadow-lg">
        <Loader2 className="text-acc size-4 animate-spin" />
        Preparing touch input...
      </div>
    </div>
  ) : null;

  const actionTray =
    activeAction && deviceId ? (
      <div className="border-line bg-bg-1 flex flex-wrap items-center gap-2 border-t px-4 py-2">
        {activeAction === 'deeplink' ? (
          <div className="flex min-w-52 flex-1 flex-wrap items-center gap-2">
            <Input
              ref={deeplinkInputRef}
              value={deeplinkUrl}
              onChange={(event) => setDeeplinkUrl(event.target.value)}
              placeholder="myapp://path"
              size="sm"
              className="min-w-52 flex-1"
            />
            <Button
              onClick={() => void handleOpenDeeplink()}
              disabled={!deeplinkUrl.trim() || isRunningAction}
              loading={isRunningAction}
              variant="secondary"
              size="sm"
            >
              Open
            </Button>
            {deepLinks.length > 0 ? (
              <div className="flex max-h-20 min-w-full flex-wrap gap-1 overflow-y-auto">
                {deepLinks.map((link) => (
                  <div
                    key={link.url}
                    className="border-border/60 bg-bg-0 flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5"
                  >
                    <button
                      type="button"
                      className="text-ink-2 max-w-56 truncate text-left text-[11px] hover:underline"
                      title={link.url}
                      onClick={() => setDeeplinkUrl(link.url)}
                    >
                      {link.url}
                    </button>
                    <IconButton
                      size="sm"
                      icon={link.pinned ? <PinOff /> : <Pin />}
                      tooltip={link.pinned ? 'Unpin deeplink' : 'Pin deeplink'}
                      onClick={() => toggleDeepLinkPinned(projectId, link.url)}
                    />
                    <IconButton
                      size="sm"
                      icon={<X />}
                      tooltip="Remove deeplink"
                      onClick={() => removeDeepLink(projectId, link.url)}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {activeAction === 'port' ? (
          <>
            <div className="flex items-center gap-1">
              <span className="text-ink-3 text-xs">Host</span>
              <Input
                value={hostPort}
                onChange={(event) => setHostPort(event.target.value)}
                inputMode="numeric"
                size="sm"
                className="w-20"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-ink-3 text-xs">Device</span>
              <Input
                value={devicePort}
                onChange={(event) => setDevicePort(event.target.value)}
                inputMode="numeric"
                size="sm"
                className="w-20"
              />
            </div>
            <Button
              onClick={() => void handleForwardPort()}
              disabled={!canForwardPort || isRunningAction}
              loading={isRunningAction}
              variant="secondary"
              size="sm"
            >
              Forward
            </Button>
          </>
        ) : null}
        {activeAction === 'text-size' ? (
          <>
            <Select
              value={textSize}
              options={TEXT_SIZE_OPTIONS}
              onChange={(value) => setTextSize(value as MobilePreviewTextSize)}
              size="sm"
              className="w-28"
            />
            <Button
              onClick={() => void handleSetTextSize()}
              disabled={isRunningAction}
              loading={isRunningAction}
              variant="secondary"
              size="sm"
            >
              Apply
            </Button>
          </>
        ) : null}
        <IconButton
          onClick={() => setActiveAction(null)}
          size="sm"
          icon={<X />}
          tooltip="Hide action"
        />
      </div>
    ) : null;

  const devServerRunning = devServerStatus?.status === 'running';
  const buildRunning = buildStatus?.status === 'running';
  const devServerStopping = runCommands.isCommandStopping(devServerCommandId);
  const buildStarting = runCommands.isCommandStarting(buildCommandId);
  const buildStopping = runCommands.isCommandStopping(buildCommandId);
  const prebuildStarting = runCommands.isCommandStarting(prebuildCommandId);
  const prebuildStopping = runCommands.isCommandStopping(prebuildCommandId);
  const handleStartStopDevServer = () => {
    if (devServerRunning) {
      void runCommands.stopCommand(devServerCommandId);
      return;
    }
    if (needsAppSelection) return;
    void runCommands.startAdHocCommand({
      runCommandId: devServerCommandId,
      name: 'Mobile dev server',
      command: devServerCommand,
      ports: [configuredDevServerPort],
      availablePort: { provider: 'args' },
    });
  };
  const handleStartStopBuild = () => {
    setActiveTab('dev-server');
    setActiveConsoleCommandId(buildCommandId);
    if (buildRunning) {
      void runCommands.stopCommand(buildCommandId);
      return;
    }
    if (!buildCommand || needsAppSelection) return;
    // Both platforms scope the build command id by device.
    if (!deviceId) return;
    if (platform === 'ios') {
      setLaunchedIosBuildCommandIds((current) =>
        current.includes(buildCommandId) ? current : [...current, buildCommandId],
      );
      void iosBuildLaunchCoordinator.launch({
        commandId: buildCommandId,
        start: () =>
          runCommands.startAdHocCommand({
            runCommandId: buildCommandId,
            name: 'iOS build',
            command: buildCommand,
            ports: [],
          }),
        stop: runCommands.stopCommand,
      });
      return;
    }
    void runCommands.startAdHocCommand({
      runCommandId: buildCommandId,
      name: 'Android build',
      command: buildCommand,
      ports: [],
    });
  };
  const handleStartStopPrebuild = () => {
    setActiveTab('dev-server');
    setActiveConsoleCommandId(prebuildCommandId);
    if (prebuildStatus?.status === 'running') {
      setResumeSetupAfterPrebuild(false);
      void runCommands.stopCommand(prebuildCommandId);
      return;
    }
    void runCommands.startAdHocCommand({
      runCommandId: prebuildCommandId,
      name: platform === 'android' ? 'Expo Android prebuild' : 'Expo iOS prebuild',
      command: prebuildCommand,
      ports: [],
    });
  };
  const consoleIsBuild = consoleCommandId === buildCommandId;
  const consoleIsPrebuild = consoleCommandId === prebuildCommandId;
  const consoleRunning = consoleStatus?.status === 'running';
  const renderDevServerBody = () => (
    <DevServerTab
      platform={platform}
      taskId={taskId}
      projectPath={projectPath}
      consoleCommandId={consoleCommandId}
      consoleStatus={consoleStatus}
      consoleIsPrebuild={consoleIsPrebuild}
      consoleIsBuild={consoleIsBuild}
      consoleRunning={consoleRunning}
      prebuildCommand={prebuildCommand}
      prebuildCommandId={prebuildCommandId}
      prebuildStatus={prebuildStatus}
      prebuildStarting={prebuildStarting}
      buildCommand={buildCommand}
      buildCommandId={buildCommandId}
      buildStatus={buildStatus}
      buildStarting={buildStarting}
      buildStopping={buildStopping}
      devServerCommand={devServerCommand}
      devServerStarting={devServerStarting}
      devServerStopping={devServerStopping}
      effectiveDevServerPort={effectiveDevServerPort}
      needsAppSelection={needsAppSelection}
      portsInUseError={runCommands.portsInUseError}
      devServerLog={devServerLog}
      setActiveConsoleCommandId={setActiveConsoleCommandId}
      handleStartStopPrebuild={handleStartStopPrebuild}
      handleStartStopBuild={handleStartStopBuild}
      handleStartStopDevServer={handleStartStopDevServer}
    />
  );

  const nativeLogSession = nativeLogs.session;
  const nativeLogStatus = nativeLogSession?.status ?? 'stopped';
  const handleStartStopNativeLogs = () => {
    if (nativeLogSession && nativeLogStatus === 'running') {
      void nativeLogs.stop(nativeLogSession.id);
      return;
    }
    if (!deviceId) return;
    void nativeLogs.start({ platform, deviceId });
  };
  const renderLogsBody = () => (
    <LogsTab
      platform={platform}
      deviceId={deviceId}
      nativeLogStatus={nativeLogStatus}
      nativeLogCommand={nativeLogSession?.command ?? null}
      nativeLogSessionError={nativeLogSession?.error ?? null}
      nativeLogError={nativeLogs.error}
      logsStore={nativeLogs.logsStore}
      onStartStopNativeLogs={handleStartStopNativeLogs}
      isNativeLogBusy={nativeLogs.isStarting || nativeLogs.isStopping}
    />
  );

  const handleStopAll = useCallback(async () => {
    iosBuildLaunchCoordinator.cancelAll();
    cancelPendingWorkspaceSetup({
      cancelSetupOperation: setupOperationCoordinator.cancel,
      cancelStart,
      setResumeSetupAfterPrebuild,
    });
    setResumeSetupAfterDependenciesInstall(false);
    const stops: Promise<unknown>[] = [];

    if (hasActiveSession) {
      stops.push(stop());
    }
    if (devServerRunning) {
      stops.push(runCommands.stopCommand(devServerCommandId));
    }
    if (platform === 'android' && buildRunning) {
      stops.push(runCommands.stopCommand(buildCommandId));
    }
    const iosBuildCommandIds = new Set(launchedIosBuildCommandIds);
    Object.keys(runCommands.statusByCommandId).forEach((commandId) => {
      if (commandId.startsWith(iosBuildCommandIdPrefix)) {
        iosBuildCommandIds.add(commandId);
      }
    });
    iosBuildCommandIds.forEach((commandId) => {
      if (
        runCommands.statusByCommandId[commandId]?.status === 'running' ||
        runCommands.isCommandStarting(commandId)
      ) {
        stops.push(runCommands.stopCommand(commandId));
      }
    });
    if (prebuildStatus?.status === 'running') {
      stops.push(runCommands.stopCommand(prebuildCommandId));
    }
    if (nativeLogSession && nativeLogStatus === 'running') {
      stops.push(nativeLogs.stop(nativeLogSession.id));
    }

    await Promise.allSettled(stops);
    setLaunchedIosBuildCommandIds([]);
  }, [
    buildCommandId,
    buildRunning,
    cancelStart,
    devServerCommandId,
    devServerRunning,
    hasActiveSession,
    iosBuildLaunchCoordinator,
    iosBuildCommandIdPrefix,
    launchedIosBuildCommandIds,
    nativeLogSession,
    nativeLogStatus,
    nativeLogs,
    platform,
    prebuildCommandId,
    prebuildStatus?.status,
    runCommands,
    setupOperationCoordinator,
    stop,
    setResumeSetupAfterDependenciesInstall,
  ]);
  const handleRestartAndroidApp = () => {
    if (platform !== 'android' || !deviceId || !effectiveAndroidProjectPath) return;

    void (async () => {
      setIsRestartingAndroidApp(true);
      try {
        // Snapshot live targets before the app dies, so "a target id we have
        // not seen" really means the relaunched app.
        const targetIdsBeforeRestart = await probeDevToolsTargetIds().catch(
          () => [],
        );
        const result = await api.mobilePreview.restartAndroidApp({
          projectId,
          taskId,
          androidProjectPath: effectiveAndroidProjectPath,
          deviceId,
        });
        showActionNotice(`${result.packageName} restarted`);
        void reattachDevToolsAfterRestart(targetIdsBeforeRestart);
      } catch (error) {
        setInputNotice(formatError(error) ?? 'Failed to restart Android app');
      } finally {
        setIsRestartingAndroidApp(false);
      }
    })();
  };
  const handleRestartIosApp = () => {
    if (platform !== 'ios' || !deviceId || !iosAppStatus?.appInstalled) return;

    void (async () => {
      setIsRestartingIosApp(true);
      try {
        // Snapshot live targets before the app dies (see Android handler).
        const targetIdsBeforeRestart = await probeDevToolsTargetIds().catch(
          () => [],
        );
        const result = await api.mobilePreview.restartIosApp({
          projectId,
          taskId,
          appPath,
          deviceId,
        });
        showActionNotice(`${result.bundleId} restarted`);
        void reattachDevToolsAfterRestart(targetIdsBeforeRestart);
      } catch (error) {
        setInputNotice(formatError(error) ?? 'Failed to restart iOS app');
      } finally {
        setIsRestartingIosApp(false);
      }
    })();
  };
  const appReady = !needsAppSelection;
  const deviceReady =
    !!deviceId && (selectedDeviceCanStart || activeSessionDeviceReady);
  const metroStatus = devServerRunning
    ? 'ready'
    : devServerStarting
      ? 'running'
      : 'idle';
  const previewStatus =
    session?.status === 'streaming'
      ? 'ready'
      : isStarting ||
          session?.status === 'checking-tools' ||
          session?.status === 'starting'
        ? 'running'
        : 'idle';
  const effectiveAndroidProjectPath = androidProjectPath
    ? androidProjectExists === false
      ? null
      : androidProjectPath
    : androidProjectExists === true
      ? inferredAndroidProjectPath
      : null;
  const androidSetupDecision = getMobileAppSetupDecision({
    platform: 'android',
    isExpoApp,
    nativeProjectExists: androidProjectExists,
    appInstalled: androidAppStatus?.appInstalled ?? null,
    appIdentityResolved: !!androidAppStatus?.packageName,
    buildStatus: normalizedBuildStatus,
  });
  const iosSetupDecision = getMobileAppSetupDecision({
    platform: 'ios',
    isExpoApp,
    nativeProjectExists: iosAppStatus?.nativeProjectExists ?? null,
    appInstalled: iosAppStatus?.appInstalled ?? null,
    appIdentityResolved: !!iosAppStatus?.bundleId,
    buildStatus: normalizedBuildStatus,
    statusCheckFailed: !!iosAppStatusError,
  });
  const appSetupDecision =
    platform === 'android' ? androidSetupDecision : iosSetupDecision;
  const needsExpoAndroidPrebuild =
    platform === 'android' && androidSetupDecision.needsPrebuild;
  const needsExpoIosPrebuild = platform === 'ios' && iosSetupDecision.needsPrebuild;
  const needsExpoPrebuild = needsExpoAndroidPrebuild || needsExpoIosPrebuild;
  const prebuildDone =
    platform === 'android'
      ? !!effectiveAndroidProjectPath
      : iosAppStatus?.nativeProjectExists === true;
  const prebuildStatusValue = !needsExpoPrebuild
    ? 'ready'
    : prebuildStarting || prebuildStatus?.status === 'running'
      ? 'running'
      : prebuildStatus?.status === 'errored'
        ? 'error'
        : prebuildDone
          ? 'ready'
          : 'idle';
  const androidAppInstalled = androidAppStatus?.appInstalled === true;
  const androidAppMissing = androidAppStatus?.appInstalled === false;
  const selectedAppInstalled =
    platform === 'android' ? androidAppInstalled : iosSetupDecision.appReady;
  const dependenciesInstallStatusValue =
    dependenciesInstallStatus?.status === 'stopped'
      ? 'completed'
      : dependenciesInstallStatus?.status;

  const handleStartWorkspace = useCallback(async (options: {
    shouldAutoBuildIos: boolean;
    shouldPrebuildIos: boolean;
  }) => {
    await runWorkspaceSetup({
      facts: {
        platform,
        deviceId,
        needsAppSelection,
        deviceReady,
        // Recomputed by the saga rather than closed over here: React Compiler
        // cannot preserve this useCallback's memoization if the callback reads
        // the outer `effectiveAndroidProjectPath` derivation.
        androidProjectPath,
        androidProjectExists,
        inferredAndroidProjectPath,
        dependenciesInstallStatusValue,
        dependenciesInstallCommandId,
        dependenciesInstallCommand,
        prebuildCommandId,
        prebuildCommand,
        devServerCommandId,
        devServerCommand,
        devServerRunning,
        devServerStarting,
        configuredDevServerPort,
        buildCommandId,
        buildCommand,
        buildRunning,
        buildStarting,
        selectedDeviceIsPhysical,
        androidAppMissing,
        hasActiveSession,
        session,
        effectiveProjectPath,
        fps,
        quality,
        projectId,
        taskId,
      },
      port: {
        startAdHocCommand: runCommands.startAdHocCommand,
        stopCommand: runCommands.stopCommand,
        ensureMetroReverse: api.mobilePreview.ensureMetroReverse,
        startPreviewSession: start,
        setInputNotice,
        showActionNotice,
        setResumeSetupAfterDependenciesInstall,
        setResumeSetupAfterPrebuild,
        setActiveConsoleCommandId,
        setLaunchedIosBuildCommandIds,
        setAndroidAppStatus,
      },
      coordinator: setupOperationCoordinator,
      iosBuildCoordinator: iosBuildLaunchCoordinator,
      options,
    });
  }, [
    androidProjectExists,
    androidProjectPath,
    inferredAndroidProjectPath,
    buildCommand,
    buildCommandId,
    buildRunning,
    buildStarting,
    androidAppMissing,
    devServerCommand,
    devServerCommandId,
    configuredDevServerPort,
    dependenciesInstallCommand,
    dependenciesInstallCommandId,
    dependenciesInstallStatusValue,
    devServerRunning,
    devServerStarting,
    deviceId,
    deviceReady,
    effectiveProjectPath,
    fps,
    hasActiveSession,
    iosBuildLaunchCoordinator,
    needsAppSelection,
    platform,
    prebuildCommand,
    prebuildCommandId,
    projectId,
    selectedDeviceIsPhysical,
    quality,
    runCommands,
    session,
    showActionNotice,
    start,
    setupOperationCoordinator,
    taskId,
  ]);

  useEffect(() => {
    const deferredAction = getDependencyInstallDeferredAction({
      resumeRequested: resumeSetupAfterDependenciesInstall,
      status: dependenciesInstallStatusValue,
    });
    if (deferredAction === 'none') return;
    queueMicrotask(() => {
      setResumeSetupAfterDependenciesInstall(false);
      if (deferredAction === 'error') {
        setInputNotice('Dependency install failed; check Metro tab logs');
        return;
      }
      void handleStartWorkspace({
        shouldAutoBuildIos: iosSetupDecision.shouldAutoBuild,
        shouldPrebuildIos: needsExpoIosPrebuild,
      });
    });
  }, [
    dependenciesInstallStatusValue,
    handleStartWorkspace,
    iosSetupDecision.shouldAutoBuild,
    needsExpoIosPrebuild,
    resumeSetupAfterDependenciesInstall,
  ]);

  useEffect(() => {
    const deferredAction = getDeferredSetupAction({
      resumeRequested: resumeSetupAfterPrebuild,
      prebuildStatus: normalizedPrebuildStatus,
      prebuildDone,
    });
    if (deferredAction === 'none') return;
    if (deferredAction === 'error') {
      queueMicrotask(() => {
        setResumeSetupAfterPrebuild(false);
        setInputNotice('Expo prebuild failed; check Metro tab logs');
      });
      return;
    }
    queueMicrotask(() => {
      setResumeSetupAfterPrebuild(false);
      void handleStartWorkspace({
        shouldAutoBuildIos: iosSetupDecision.shouldAutoBuild,
        shouldPrebuildIos: needsExpoIosPrebuild,
      });
    });
  }, [
    handleStartWorkspace,
    prebuildDone,
    normalizedPrebuildStatus,
    iosSetupDecision.shouldAutoBuild,
    needsExpoAndroidPrebuild,
    needsExpoIosPrebuild,
    resumeSetupAfterPrebuild,
  ]);

  const previewFacts: PreviewFacts = {
    platform,
    deviceId,
    appPath,
    isExpoApp,
    needsAppSelection,
    selectedDeviceCanStart,
    activeSessionDeviceReady,
    selectedDevice: selectedDevice
      ? { name: selectedDevice.name, state: selectedDevice.state }
      : null,
    selectedDeviceIsPhysical,
    selectedDeviceConnected,
    selectedDeviceUnavailableReason: selectedDevice?.unavailableReason ?? null,
    buildCommandDeviceNotice,
    sessionStatus: session?.status,
    isStarting,
    isStopping,
    hasActiveSession,
    previewMethodText,
    devServerRunning,
    devServerStarting,
    devServerStopping,
    effectiveDevServerPort,
    buildRunning,
    buildStarting,
    buildStopping,
    normalizedBuildStatus,
    prebuildStatusStatus: prebuildStatus?.status,
    prebuildStarting,
    prebuildStopping,
    dependenciesInstallStatusStatus: dependenciesInstallStatus?.status,
    dependenciesInstallCommand,
    androidProjectPath,
    androidProjectExists,
    inferredAndroidProjectPath,
    androidAppStatus,
    iosAppStatus,
    iosAppStatusError,
    isIosAppStatusLoading,
    nativeLogRunning: !!(nativeLogSession && nativeLogStatus === 'running'),
    formatDeviceState,
  };
  const previewDerived: PreviewDerived = {
    appReady,
    deviceReady,
    metroStatus,
    previewStatus,
    prebuildStatusValue,
    dependenciesInstallStatusValue,
    effectiveAndroidProjectPath,
    needsExpoIosPrebuild,
    prebuildDone,
    androidAppInstalled,
    selectedAppInstalled,
    appNeedsBuild: appSetupDecision.needsBuild,
    iosAppReady: iosSetupDecision.appReady,
    iosBuildVerificationFailed: iosSetupDecision.buildVerificationFailed,
  };

  const setupModel = getSetupModel(previewFacts, previewDerived);
  const { setupSteps, readySetupSteps, allSetupReady } = setupModel;

  const handleStartStopDependenciesInstall = () => {
    setResumeSetupAfterDependenciesInstall(false);
    if (dependenciesInstallStatusValue === 'running') {
      void runCommands.stopCommand(dependenciesInstallCommandId);
      return;
    }
    void runCommands.startAdHocCommand({
      runCommandId: dependenciesInstallCommandId,
      name: 'Mobile dependencies install',
      command: dependenciesInstallCommand,
      ports: [],
    });
  };

  const setupStepActionHandlers: Record<PreviewStepActionIntent, () => void> = {
    'dependencies-install-toggle': handleStartStopDependenciesInstall,
    'prebuild-toggle': handleStartStopPrebuild,
    'ios-app-status-retry': () =>
      setIosAppStatusRefreshNonce((current) => current + 1),
    'build-toggle': handleStartStopBuild,
    'dev-server-toggle': handleStartStopDevServer,
    'preview-toggle': handleStartStop,
  };

  function getStepAction(stepKey: PreviewStepKey) {
    const action = getSetupStepAction(stepKey, previewFacts, previewDerived, {
      dependenciesInstallStarting: runCommands.isCommandStarting(
        dependenciesInstallCommandId,
      ),
      hasBuildCommand: !!buildCommand,
    });
    if (!action) return null;
    return { ...action, onClick: setupStepActionHandlers[action.intent] };
  }

  const renderSetupBody = () => (
    <SetupTab
      model={setupModel}
      getStepAction={getStepAction}
      platform={platform}
      appOptions={appOptions}
      appPath={appPath}
      appSelectionError={appSelectionError}
      detectedApps={detectedApps}
      hasActiveSession={hasActiveSession}
      iosAppStatus={iosAppStatus}
      iosAppStatusError={iosAppStatusError}
      iosSetupDecision={iosSetupDecision}
      isRestartingIosApp={isRestartingIosApp}
      isSelectingAppPath={isSelectingAppPath}
      needsExpoIosPrebuild={needsExpoIosPrebuild}
      onRestartIosApp={handleRestartIosApp}
      onRetryIosAppStatus={() =>
        setIosAppStatusRefreshNonce((current) => current + 1)
      }
      onSelectAppPath={onSelectAppPath}
      onStartWorkspace={handleStartWorkspace}
      onStopAll={handleStopAll}
      setActiveTab={setActiveTab}
      selectedDetectedApp={selectedDetectedApp}
      validSelectedAppPath={validSelectedAppPath}
    />
  );

  const devToolsResult = reactNativeDevTools.data ?? null;
  const devToolsTargets = devToolsResult?.targets ?? [];
  const devToolsTarget =
    devToolsTargets.find((target) => target.id === selectedDevToolsTargetId) ??
    devToolsTargets.at(-1) ??
    null;
  const devToolsFrontendUrl =
    devToolsTarget?.devtoolsFrontendUrl ?? devToolsResult?.frontendUrl ?? null;
  // One embedded DevTools view per task *and* device, so switching devices
  // doesn't reuse (or tear down) another device's debugger session.
  const devToolsViewId = `rn-devtools:${taskId}:${platform}:${deviceId || 'none'}`;
  const handleDevToolsTargetMenuOpenChange = useCallback(
    (open: boolean) => {
      devToolsTargetMenuOpenRef.current = open;
      const visible = !open && devToolsShouldShowRef.current;
      if (!devToolsOpenedRef.current) return;
      void api.mobilePreview
        .setEmbeddedReactNativeDevToolsVisibility({
          viewId: devToolsViewId,
          visible,
        })
        .catch((error) => {
          setDevToolsLaunchError(formatError(error) ?? String(error));
        });
    },
    [devToolsViewId],
  );
  const devToolsError =
    devToolsLaunchError ??
    formatError(reactNativeDevTools.error) ??
    devToolsResult?.error ??
    null;
  const updateEmbeddedDevToolsBounds = useCallback(() => {
    const element = devToolsViewRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    void api.mobilePreview
      .setEmbeddedReactNativeDevToolsBounds({
        viewId: devToolsViewId,
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      })
      .catch((error) => {
        setDevToolsLaunchError(formatError(error) ?? String(error));
      });
  }, [devToolsViewId]);

  // Lifecycle: create the embedded view as soon as a frontend URL exists
  // (even while another tab is active) and keep it alive across tab switches
  // so console/network history is preserved. Only destroyed on unmount, task
  // change, or when the target disappears.
  useEffect(() => {
    if (!devToolsFrontendUrl) {
      devToolsOpenedRef.current = false;
      queueMicrotask(() => setIsDevToolsViewOpen(false));
      void api.mobilePreview.closeEmbeddedReactNativeDevTools({
        viewId: devToolsViewId,
      });
      return;
    }

    const element = devToolsViewRef.current;
    const rect = element?.getBoundingClientRect();
    const requestId = devToolsOpenRequestRef.current + 1;
    devToolsOpenRequestRef.current = requestId;
    queueMicrotask(() => setDevToolsLaunchError(null));
    void api.mobilePreview
      .openEmbeddedReactNativeDevTools({
        viewId: devToolsViewId,
        frontendUrl: devToolsFrontendUrl,
        bounds: rect
          ? {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            }
          : { x: 0, y: 0, width: 0, height: 0 },
      })
      .then(() => {
        if (devToolsOpenRequestRef.current !== requestId) return;
        devToolsOpenedRef.current = true;
        setIsDevToolsViewOpen(true);
        // Apply the visibility/bounds the UI wants right now; the view may
        // have been created while a different tab was showing.
        updateEmbeddedDevToolsBounds();
        return api.mobilePreview.setEmbeddedReactNativeDevToolsVisibility({
          viewId: devToolsViewId,
          visible:
            devToolsShouldShowRef.current &&
            !devToolsTargetMenuOpenRef.current,
        });
      })
      .catch((error) => {
        if (devToolsOpenRequestRef.current !== requestId) return;
        setDevToolsLaunchError(formatError(error) ?? String(error));
      });

    return () => {
      devToolsOpenRequestRef.current += 1;
      devToolsOpenedRef.current = false;
      queueMicrotask(() => setIsDevToolsViewOpen(false));
      void api.mobilePreview.closeEmbeddedReactNativeDevTools({
        viewId: devToolsViewId,
      });
    };
  }, [devToolsFrontendUrl, devToolsViewId, updateEmbeddedDevToolsBounds]);

  // Visibility + bounds: show the (already running) view only on the DevTools
  // tab; hide it otherwise instead of tearing it down.
  useEffect(() => {
    const wantsTab = activeTab === 'devtools' && !!devToolsFrontendUrl;
    devToolsShouldShowRef.current = wantsTab;
    const shouldShow = wantsTab && !devToolsTargetMenuOpenRef.current;
    if (!isDevToolsViewOpen) return;

    if (!shouldShow) {
      void api.mobilePreview
        .setEmbeddedReactNativeDevToolsVisibility({
          viewId: devToolsViewId,
          visible: false,
        })
        .catch(() => {});
      return;
    }

    const element = devToolsViewRef.current;
    if (!element) return;
    updateEmbeddedDevToolsBounds();
    void api.mobilePreview
      .setEmbeddedReactNativeDevToolsVisibility({
        viewId: devToolsViewId,
        visible: true,
      })
      .catch((error) => {
        setDevToolsLaunchError(formatError(error) ?? String(error));
      });

    const resizeObserver = new ResizeObserver(updateEmbeddedDevToolsBounds);
    resizeObserver.observe(element);
    window.addEventListener('resize', updateEmbeddedDevToolsBounds);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateEmbeddedDevToolsBounds);
    };
  }, [
    activeTab,
    devToolsFrontendUrl,
    devToolsViewId,
    isDevToolsViewOpen,
    updateEmbeddedDevToolsBounds,
  ]);

  const renderDevToolsBody = () => (
    <DevToolsTab
      metroBaseUrl={devToolsResult?.metroBaseUrl ?? null}
      effectiveDevServerPort={effectiveDevServerPort}
      devToolsTargets={devToolsTargets}
      devToolsTarget={devToolsTarget ?? null}
      devToolsError={devToolsError}
      devToolsFrontendUrl={devToolsFrontendUrl}
      devToolsViewRef={devToolsViewRef}
      isFetching={reactNativeDevTools.isFetching}
      isLoading={reactNativeDevTools.isLoading}
      onRefresh={() => void reactNativeDevTools.refetch()}
      setSelectedDevToolsTargetId={setSelectedDevToolsTargetId}
      handleDevToolsTargetMenuOpenChange={handleDevToolsTargetMenuOpenChange}
    />
  );

  // Only the active tab's element tree is built; the other four would be
  // thrown away on every render.
  const inspectorBody =
    activeTab === 'setup'
      ? renderSetupBody()
      : activeTab === 'dev-server'
        ? renderDevServerBody()
        : activeTab === 'devtools'
          ? renderDevToolsBody()
          : renderLogsBody();

  let body = null;
  if (fatalSessionError) {
    body = <PreviewErrorState message={fatalSessionError} />;
  } else if (session?.frameFormat === 'raw-rgba') {
    body = (
      <div className="flex h-full flex-col bg-zinc-950">
        <div
          ref={containerRef}
          tabIndex={0}
          role="application"
          aria-label="Mobile preview input area"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          className="focus-visible:ring-acc relative min-h-0 flex-1 touch-none outline-none focus-visible:ring-2"
        >
          {inputPreparingOverlay}
          <RawRgbaPreviewCanvas
            sessionId={session.id}
            width={session.width ?? 0}
            height={session.height ?? 0}
            subscribeH264Chunks={subscribeH264Chunks}
            onFrameRendered={handlePreviewFrameRendered}
            surfaceStyle={previewSurfaceStyle}
          />
          <GestureFeedbackOverlay store={gestureFeedbackStore} />
        </div>
      </div>
    );
  } else if (session?.frameFormat === 'h264') {
    body = (
      <div className="flex h-full flex-col bg-zinc-950">
        <div
          ref={containerRef}
          tabIndex={0}
          role="application"
          aria-label="Mobile preview input area"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          className="focus-visible:ring-acc relative min-h-0 flex-1 touch-none outline-none focus-visible:ring-2"
        >
          {inputPreparingOverlay}
          <H264PreviewCanvas
            sessionId={session.id}
            width={null}
            height={null}
            subscribeH264Chunks={subscribeH264Chunks}
            onFpsChange={previewFpsStore.set}
            onFrameRendered={handlePreviewFrameRendered}
            surfaceStyle={previewSurfaceStyle}
          />
          <GestureFeedbackOverlay store={gestureFeedbackStore} />
        </div>
      </div>
    );
  } else if (hasImageFrame) {
    body = (
      <div className="flex h-full flex-col bg-zinc-950">
        <div
          ref={containerRef}
          tabIndex={0}
          role="application"
          aria-label="Mobile preview input area"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          className="focus-visible:ring-acc relative flex min-h-0 flex-1 touch-none items-center justify-center p-4 outline-none focus-visible:ring-2"
        >
          {inputPreparingOverlay}
          <ImagePreviewSurface
            imgRef={imgRef}
            sessionId={session?.id ?? null}
            subscribeImageFrames={subscribeImageFrames}
            onFrameRendered={handlePreviewFrameRendered}
            surfaceStyle={previewSurfaceStyle}
          />
          <GestureFeedbackOverlay store={gestureFeedbackStore} />
        </div>
      </div>
    );
  } else if (needsAppSelection) {
    body = (
      <div className="flex h-full items-center justify-center p-6">
        <div className="border-border/70 bg-bg-1/70 w-full max-w-[420px] rounded-xl border p-4">
          <div className="text-ink-1 text-sm font-semibold">
            Choose mobile app
          </div>
          <div className="text-ink-3 mt-1 text-xs">
            Multiple mobile apps detected. Choose one in Setup → Project app.
          </div>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => setActiveTab('setup')}>
            Open Setup
          </Button>
        </div>
      </div>
    );
  } else if (physicalIosStreamingUnsupported) {
    // Deliberately ahead of `displayError`: the iOS adapter throws a raw
    // "streaming is not supported" error for physical devices, and that error
    // is far less useful than saying what does still work.
    body = (
      <EmptyState
        title={PHYSICAL_IOS_STREAMING_UNSUPPORTED_TITLE}
        detail={PHYSICAL_IOS_STREAMING_UNSUPPORTED_DETAIL}
      />
    );
  } else if (displayError) {
    body = <PreviewErrorState message={displayError} />;
  } else if (
    isStarting ||
    session?.status === 'checking-tools' ||
    session?.status === 'starting'
  ) {
    body = (
      <EmptyState
        title="Starting preview..."
        detail="Preparing simulator stream"
      />
    );
  } else if (session?.status === 'streaming') {
    body = (
      <EmptyState
        title="Waiting for first frame..."
        detail={getWaitingForFrameDetail(session.streamStrategy)}
      />
    );
  } else if (session?.status === 'stopped') {
    body = (
      <EmptyState title="Preview stopped" detail="Start again when ready" />
    );
  } else if (devicesErrorMessage) {
    body = (
      <EmptyState
        title="Unable to load devices"
        detail={`${devicesErrorMessage}. ${
          platform === 'ios'
            ? 'Install Xcode Command Line Tools and create an iOS simulator.'
            : 'Install Android Platform Tools and connect or boot an Android device.'
        }`}
      />
    );
  } else if (!deviceId) {
    body = (
      <EmptyState
        title={isLoadingDevices ? 'Loading devices...' : 'No device selected'}
        detail={
          isLoadingDevices ? undefined : 'Select or connect a simulator device'
        }
      />
    );
  } else if (!selectedDeviceCanStart) {
    body = (
      <EmptyState
        title="Device not ready"
        detail={
          // A physical device already explains exactly what to do about it;
          // the simulator copy would be both wrong and useless there.
          selectedDevice?.unavailableReason ??
          'Select a booted or shutdown simulator device'
        }
      />
    );
  } else {
    body = (
      <EmptyState
        title="Preview idle"
        detail="Start preview to stream device frames"
      />
    );
  }

  const orderedDevices = [...visibleDevices].sort((firstDevice, secondDevice) => {
    if (firstDevice.state === 'booted' && secondDevice.state !== 'booted') {
      return -1;
    }
    if (secondDevice.state === 'booted' && firstDevice.state !== 'booted') {
      return 1;
    }
    if (firstDevice.platform !== secondDevice.platform) {
      return firstDevice.platform === 'android' ? -1 : 1;
    }
    return firstDevice.name.localeCompare(secondDevice.name);
  });
  // Real hardware is grouped separately so it is never confused with a
  // disposable simulator. Ordering within each group is preserved.
  // Unreachable hardware stays listed (it shows in Xcode too), but the usable
  // devices come first so the one connected handset is not buried.
  const physicalDevices = sortPhysicalDevicesByAvailability(
    orderedDevices.filter((device) => isPhysicalMobilePreviewDevice(device)),
  );
  const simulatorDevices = orderedDevices.filter(
    (device) => !isPhysicalMobilePreviewDevice(device),
  );
  // Device -> task associations across every task, so a row can show that a
  // device belongs to some other task than the one this pane is rendering.
  const { data: deviceAssignments } = useMobilePreviewDeviceAssignments();
  const { data: allTasks } = useTasks();
  const deviceAssignmentsQueryClient = useQueryClient();
  // The assignments query only polls, so without this a stopped session keeps
  // reading "Live" on its device row until the next tick.
  useEffect(() => {
    void deviceAssignmentsQueryClient.invalidateQueries({
      queryKey: MOBILE_PREVIEW_DEVICE_ASSIGNMENTS_QUERY_KEY,
    });
  }, [deviceAssignmentsQueryClient, session?.status, hasActiveSession]);
  const currentTask = useMemo(
    () => allTasks?.find((task) => task.id === taskId),
    [allTasks, taskId],
  );
  const deviceTaskMap = useMemo(
    () =>
      buildMobilePreviewDeviceTaskMap({
        assignments: deviceAssignments ?? [],
        tasks: allTasks ?? [],
        currentTaskId: taskId,
      }),
    [deviceAssignments, allTasks, taskId],
  );

  const standaloneLayout = getMobilePreviewStandaloneLayoutClasses({
    isStandalone,
    isInspectorOpen: isStandaloneInspectorOpen,
  });

  return (
    <div
      style={isStandalone ? undefined : { width }}
      className={clsx(
        'bg-bg-0 relative flex h-full min-w-0 flex-col overflow-hidden',
        isStandalone ? 'w-full' : 'panel-edge-shadow',
      )}
    >
      {!isStandalone ? (
        <div
          onMouseDown={handleMouseDown}
          className={clsx(
            'hover:bg-acc/50 absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors',
            isDragging && 'bg-acc/50',
          )}
        />
      ) : null}
      {inputNotice || autoPreviewStartError || showRuntimeLaunchNotice ? (
        <PreviewNoticeStack insetLeft={!isStandalone}>
          {inputNotice ? (
            <PreviewNotice
              tone="error"
              role="alert"
              onDismiss={() => setInputNotice(null)}
            >
              {inputNotice}
            </PreviewNotice>
          ) : null}
          {autoPreviewStartError ? (
            <PreviewNotice
              tone="error"
              role="alert"
              action={
                <Button variant="ghost" size="xs" onClick={retryAutoPreviewStart}>
                  Retry preview
                </Button>
              }
              onDismiss={dismissAutoPreviewStartError}
            >
              {autoPreviewStartError}
            </PreviewNotice>
          ) : null}
          {showRuntimeLaunchNotice ? (
            <PreviewNotice
              tone={
                runtimeLaunchState.status === 'error'
                  ? 'error'
                  : runtimeLaunchState.status === 'unsupported'
                    ? 'warn'
                    : 'info'
              }
              role={runtimeLaunchState.status === 'error' ? 'alert' : 'status'}
              icon={
                runtimeLaunchState.status === 'launching' ? (
                  <Loader2 className="size-3 shrink-0 animate-spin" />
                ) : null
              }
              action={
                runtimeLaunchState.status === 'error' ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      // Clear the persisted dismissal for the notice actually
                      // on screen, not just the component-local mirror — after
                      // a reopen the mirror is null while the store still
                      // holds the key.
                      clearDismissedNotice(runtimeLaunchDismissKey);
                      setDismissedRuntimeLaunchKeyState(null);
                      setRuntimeLaunchRetry((value) => value + 1);
                    }}
                  >
                    Retry
                  </Button>
                ) : null
              }
              onDismiss={
                canDismissRuntimeLaunchNotice
                  ? () => {
                      markNoticeDismissed(runtimeLaunchDismissKey);
                      setDismissedRuntimeLaunchKeyState(
                        runtimeLaunchDismissKey,
                      );
                    }
                  : undefined
              }
            >
              {runtimeLaunchMessage}
            </PreviewNotice>
          ) : null}
        </PreviewNoticeStack>
      ) : null}
      {actionTray}
      <div
        className={clsx(
          'flex min-h-0 flex-1 overflow-hidden',
          standaloneLayout.content,
        )}
      >
        <aside
          style={
            {
              '--device-rail-width': `${deviceRailWidth}px`,
            } as CSSProperties
          }
          className={clsx(
            'border-line bg-bg-0 relative flex w-[var(--device-rail-width)] shrink-0 flex-col border-r',
            standaloneLayout.deviceRail,
          )}
        >
          <div
            onMouseDown={handleDeviceRailMouseDown}
            className={clsx(
              'hover:bg-acc/40 absolute top-0 right-[-2px] z-20 h-full w-1 cursor-col-resize transition-colors',
              isDraggingDeviceRail && 'bg-acc/50',
              standaloneLayout.deviceRailResizeHandle,
            )}
          />
          <div className="border-line flex h-[38px] shrink-0 items-center gap-2 border-b px-2">
            <Terminal className="text-ink-3 size-3.5" />
            <span className="text-ink-1 flex-1 text-xs font-semibold">Devices</span>
            <IconButton
              onClick={() => setIsManageDevicesOpen(true)}
              size="sm"
              icon={<Settings />}
              tooltip="Manage visible devices"
            />
          </div>
          <div
            className={clsx(
              'min-h-0 flex-1 overflow-y-auto p-1.5',
              standaloneLayout.deviceList,
            )}
          >
            {devicesErrorMessage ? (
              <div className="text-status-fail p-2 text-xs">{devicesErrorMessage}</div>
            ) : isLoadingDevices ? (
              <div className="text-ink-4 p-2 text-xs">Loading devices...</div>
            ) : allDevices.length === 0 ? (
              <div className="text-ink-4 p-2 text-xs">No devices</div>
            ) : orderedDevices.length === 0 ? (
              <div className="text-ink-4 p-2 text-xs">No visible devices. Use cog to add one.</div>
            ) : (
              (
                [
                  ['Simulators', simulatorDevices],
                  ['Real devices', physicalDevices],
                ] as const
              ).map(([groupLabel, groupDevices]) =>
                groupDevices.length === 0 ? null : (
                  <div
                    key={groupLabel}
                    className={clsx('mb-1.5', standaloneLayout.deviceGroup)}
                  >
                    <div className="text-ink-4 px-2 py-1 text-[9px] font-semibold tracking-wide uppercase">
                      {groupLabel}
                    </div>
                    {groupDevices.map((device) => {
                      const selected =
                        device.id === deviceId && device.platform === platform;
                      const deviceKey = getPreviewDeviceKey(
                        device.platform,
                        device.id,
                      );
                      const taskInfo = resolveDeviceRowTaskInfo({
                        assignedTask: deviceTaskMap.get(deviceKey),
                        // This pane knows its own session is coming up before the
                        // cross-task assignments query catches up.
                        isLocallyActive:
                          activeSessionDeviceKeys.has(deviceKey) ||
                          (selectedPreviewDeviceKey === deviceKey &&
                            (isStarting || activeSessionDeviceReady)),
                        isStarting,
                        currentTaskId: taskId,
                        currentTask,
                      });
                      return (
                        <DeviceRailRow
                          key={device.id}
                          device={device}
                          selected={selected}
                          taskInfo={taskInfo}
                          onSelect={() => handleSelectDevice(device)}
                          className={standaloneLayout.deviceButton}
                        />
                      );
                    })}
                  </div>
                ),
              )
            )}
          </div>
        </aside>

        <main
          className={clsx(
            'bg-bg-0 flex min-w-0 flex-1 flex-col',
            standaloneLayout.preview,
          )}
        >
          <div className="border-line-soft flex h-[38px] shrink-0 items-center gap-1 border-b px-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={!isRunning}
              onClick={() => void handleReloadExpo()}
            >
              Reload
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy />}
              disabled={!hasImageFrame}
              onClick={() => void captureScreenshot()}
            >
              Screenshot
            </Button>
            <Button
              variant={isRecording ? 'secondary' : 'ghost'}
              size="sm"
              icon={<Circle className={isRecording ? 'fill-status-fail text-status-fail' : ''} />}
              disabled={!hasImageFrame}
              onClick={isRecording ? stopRecording : startRecording}
            >
              {isRecording ? 'Stop recording' : 'Record'}
            </Button>
            <span className="bg-border mx-1 h-4 w-px" />
            <IconButton
              onClick={() => handleRotateButton('left')}
              disabled={!isRunning || isRotating}
              size="sm"
              icon={<RotateCcw />}
              tooltip="Rotate left"
            />
            <IconButton
              onClick={() => handleRotateButton('right')}
              disabled={!isRunning || isRotating}
              size="sm"
              icon={<RotateCw />}
              tooltip="Rotate right"
            />
            <div className="min-w-0 flex-1" />
            {isStandalone ? (
              <IconButton
                className={standaloneLayout.inspectorToggle}
                size="sm"
                icon={<PanelRight />}
                tooltip="Toggle inspector"
                aria-expanded={isStandaloneInspectorOpen}
                aria-controls="mobile-preview-inspector"
                onClick={() =>
                  setIsStandaloneInspectorOpen((value) => !value)
                }
              />
            ) : null}
            <PreviewStatusText
              methodText={previewMethodText}
              showFps={session?.status === 'streaming'}
              fpsStore={previewFpsStore}
            />
            <Dropdown
              trigger={<IconButton size="sm" icon={<MoreHorizontal />} tooltip="More" />}
              align="right"
              dropdownRef={mobileActionsMenuRef}
              className="min-w-64"
            >
              <div className="px-3 py-2">
                <div className="text-ink-4 mb-1 text-[10px] font-semibold tracking-wide uppercase">
                  Preview
                </div>
                <div className="grid gap-2">
                  <label className="grid gap-1">
                    <span className="text-ink-3 text-xs">FPS</span>
                    <Select
                      value={String(fps)}
                      options={FPS_OPTIONS}
                      onChange={(value) => setFps(Number(value))}
                      disabled={hasActiveSession}
                      size="sm"
                      className="w-full"
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-ink-3 text-xs">Quality</span>
                    <Select
                      value={quality}
                      options={QUALITY_OPTIONS}
                      onChange={(value) => setQuality(value as MobilePreviewQuality)}
                      disabled={hasActiveSession}
                      size="sm"
                      className="w-full"
                    />
                  </label>
                </div>
              </div>
              <DropdownDivider />
              <DropdownItem
                icon={showGestures ? <Check /> : <MousePointer2 />}
                onClick={() => setShowGestures(!showGestures)}
              >
                Show gestures
              </DropdownItem>
              <DropdownDivider />
              <DropdownItem icon={copiedDeviceId ? <Check /> : <Copy />} onClick={() => void handleCopyDeviceId()}>
                Copy Device UUID
              </DropdownItem>
              <DropdownItem icon={<Link />} onClick={handleShowDeeplinkAction}>
                Open Deeplink
              </DropdownItem>
              {platform === 'android' ? (
                <DropdownItem
                  icon={<RotateCw />}
                  onClick={handleRestartAndroidApp}
                  disabled={
                    !deviceId ||
                    !effectiveAndroidProjectPath ||
                    isRestartingAndroidApp
                  }
                >
                  Restart App
                </DropdownItem>
              ) : (
                <DropdownItem
                  icon={<RotateCw />}
                  onClick={handleRestartIosApp}
                  disabled={
                    !deviceId ||
                    !iosAppStatus?.appInstalled ||
                    isRestartingIosApp
                  }
                >
                  Restart App
                </DropdownItem>
              )}
              <DropdownItem
                icon={<RotateCcw />}
                onClick={() => void handleReloadExpo()}
                disabled={!isDevServerRunning || isRunningAction}
              >
                Reload Expo
              </DropdownItem>
              {platform === 'android' ? (
                <DropdownItem icon={<Route />} onClick={() => setActiveAction('port')}>
                  Forward Port
                </DropdownItem>
              ) : null}
              <DropdownItem
                icon={<ListTree />}
                onClick={() => void handleOpenDevMenu()}
                disabled={!deviceId || !isDevServerRunning || isRunningAction}
              >
                Open Dev Menu
              </DropdownItem>
              <DropdownItem icon={<Type />} onClick={() => setActiveAction('text-size')}>
                Text Size
              </DropdownItem>
            </Dropdown>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
          <div className="border-line-soft bg-bg-0 flex h-[50px] shrink-0 items-center justify-center gap-2 border-t">
            <Button variant="ghost" size="sm" onClick={handleHomeButton} disabled={!isRunning || isInputPreparing}>
              Home
            </Button>
            <Button variant="ghost" size="sm" onClick={handleBackButton} disabled={!isRunning || isInputPreparing}>
              Back
            </Button>
            <span className="bg-border mx-1 h-5 w-px" />
            <Button
              variant="ghost"
              size="sm"
              icon={<ListTree />}
              onClick={() => void handleOpenDevMenu()}
              disabled={!isRunning || isRunningAction}
              title="Open the Expo / React Native dev menu on the device"
            >
              Dev Menu
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw />}
              onClick={() => void handleReloadExpo()}
              disabled={!isDevServerRunning || isRunningAction}
              title="Reload the JS bundle on the connected app (Metro reload)"
            >
              Reload
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCw />}
              onClick={
                platform === 'android'
                  ? handleRestartAndroidApp
                  : handleRestartIosApp
              }
              disabled={
                !deviceId ||
                (platform === 'android'
                  ? !effectiveAndroidProjectPath || isRestartingAndroidApp
                  : !iosAppStatus?.appInstalled || isRestartingIosApp)
              }
              title="Restart the native app on the device"
            >
              Restart
            </Button>
            <span className="bg-border mx-1 h-5 w-px" />
            <Button
              variant="ghost"
              size="sm"
              icon={<Keyboard />}
              onClick={handleShowKeyboardButton}
              disabled={!isRunning || isInputPreparing}
            >
              Keyboard
            </Button>
          </div>
          <div className="text-ink-4 border-line-soft shrink-0 border-t py-1.5 text-center text-[11px]">
            Click to tap · drag to swipe · hold to long-press · scroll to flick · type to send text · Esc → Back
          </div>
        </main>

        <aside
          id="mobile-preview-inspector"
          style={{ width: inspectorPaneWidth, maxWidth: '100%' }}
          className={clsx(
            'border-line bg-bg-1 relative flex shrink-0 flex-col border-l',
            standaloneLayout.inspector,
          )}
        >
          <div
            onMouseDown={handleInspectorPaneMouseDown}
            className={clsx(
              'hover:bg-acc/40 absolute top-0 left-[-2px] z-20 h-full w-1 cursor-col-resize transition-colors',
              isDraggingInspectorPane && 'bg-acc/50',
            )}
          />
          <div className="border-line flex h-[38px] shrink-0 items-center gap-2 border-b px-2.5">
            <div className="border-line bg-bg-0 flex rounded-md border p-0.5">
              {(
                [
                  ['setup', `Setup ${allSetupReady ? '✓' : `${readySetupSteps}/${setupSteps.length}`}`],
                  ['dev-server', 'Metro'],
                  ['devtools', 'DevTools'],
                  ['logs', <NativeLogsTabLabel store={nativeLogs.logsStore} />],
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={clsx(
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                    activeTab === tab
                      ? 'bg-bg-3 text-ink-1'
                      : 'text-ink-3 hover:text-ink-1',
                  )}
                >
                  {label}
                </button>
                ))}
            </div>
            <div className="min-w-0 flex-1" />
            {isStandalone ? (
              <IconButton
                className={standaloneLayout.inspectorClose}
                size="sm"
                icon={<X />}
                tooltip="Close inspector"
                onClick={() => setIsStandaloneInspectorOpen(false)}
              />
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{inspectorBody}</div>
        </aside>
      </div>
      {isManageDevicesOpen ? (
        <ManageDevicesDialog
          platform={platform}
          deviceId={deviceId}
          allDevices={allDevices}
          visibleDevices={visibleDevices}
          androidManagement={androidManagement}
          iosManagement={iosManagement}
          visibleDeviceIdsByPlatform={visibleDeviceIdsByPlatform}
          setVisibleDeviceIdsByPlatform={setVisibleDeviceIdsByPlatform}
          isCreateIosDeviceOpen={isCreateIosDeviceOpen}
          setIsCreateIosDeviceOpen={setIsCreateIosDeviceOpen}
          onSelectPreviewDevice={selectPreviewDevice}
          onClose={handleCloseManageDevices}
        />
      ) : null}
    </div>
  );
}
