import {
  AlertTriangle,
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
  Play,
  RotateCcw,
  RotateCw,
  Route,
  Settings,
  Terminal,
  Type,
  X,
} from 'lucide-react';
import {
} from '@yume-chan/scrcpy-decoder-webcodecs';
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
} from '@yume-chan/scrcpy';
import clsx from 'clsx';

import { Dropdown, DropdownDivider, DropdownItem } from '@/common/ui/dropdown';

import { Button } from '@/common/ui/button';
import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';
import { Select } from '@/common/ui/select';


import {
  useAndroidDeviceManagement,
  useIosDeviceManagement,
  useMobilePreviewDevices,
  useMobilePreviewNativeLogs,
  useMobilePreviewNetworkProxy,
  useMobilePreviewSession,
  useReactNativeDevTools,
} from '@/hooks/use-mobile-preview';

import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useRunCommands } from '@/hooks/use-run-commands';

import {
  useMobilePreviewAutoStartProxy,
  useMobilePreviewDeviceSelection,
  useMobilePreviewFps,
  useMobilePreviewPaneWidth,
  useMobilePreviewQuality,
  useMobilePreviewShowGestures,
} from '@/stores/navigation';

import { useMobilePreviewDeepLinksStore } from '@/stores/mobile-preview-deep-links';
import { useTaskMessagesStore } from '@/stores/task-messages';

import { api } from '@/lib/api';
import { createMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';

import type {
  MobilePlatform,
  MobilePreviewAndroidAppStatus,
  MobilePreviewDevice,
  MobilePreviewIosAppStatus,
  MobilePreviewNetworkRequest,
  MobilePreviewQuality,
  MobilePreviewTextSize,
} from '@shared/mobile-simulator-types';

import type { CommandRunStatus } from '@shared/run-command-types';
import {
  appendNetworkFilterToken,
  getNetworkFacets,
  getNetworkHostname,
  getNetworkMethodClass,
  getNetworkPath,
  getNetworkStatusClass,
  getNetworkStatusLabel,
  logNetworkFilterDebug,
  matchesNetworkFilter,
  matchesNetworkFilterToken,
  matchesNetworkPreset,
  type NetworkFilterContextMenuState,
  type NetworkFilterToken,
  type NetworkPresetFilter,
} from './utils-network';
import {
  NetworkFacetButton,
  NetworkFilterAutocomplete,
  NetworkFilterChip,
  NetworkFilterContextMenu,
  NetworkRequestDetails,
} from './ui-network-inspector';
import {
  useStreamListStoreWhen,
} from '@/hooks/utils-stream-list-store';
import type { MobilePreviewProjectConfig } from '@shared/types';

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
} from './utils-input';
import {
  getVisibleMobilePreviewPaneTab,
  isMobilePreviewPaneTabVisible,
  type MobilePreviewPaneTab,
} from './utils-tabs';
import {
} from './utils-rotation';
import {
} from './utils-frame-readiness';
import {
  EmptyState,
  PlatformLogo,
  PreviewErrorState,
} from './ui-common';
import {
  NativeLogsTabLabel,
  NetworkRequestCountDetail,
  NetworkTabLabel,
  PreviewStatusText,
} from './ui-stream-readouts';
import {
  cleanPreviewError,
  formatError,
  getStreamStrategyLabel,
  getWaitingForFrameDetail,
} from './utils-preview-error';
import {
  canStartDevice,
  formatAndroidImageTag,
  formatAndroidScreenSpec,
  formatDeviceState,
  getAndroidImageCompatibilityWarning,
  getDefaultAndroidProjectPath,
  getIosDeviceChrome,
  getOptionalPositiveInteger,
  getPreferredAndroidSystemImage,
  getPreviewDeviceKey,
  getSuggestedAndroidSystemImageId,
  getSuggestedIosDeviceName,
  isOptionalPositiveInteger,
  parsePort,
} from './utils-device-setup';
import { useMobilePreviewInput } from './use-mobile-preview-input';
import { DevServerTab } from './ui-dev-server-tab';
import { DevToolsTab } from './ui-devtools-tab';
import { LogsTab } from './ui-logs-tab';
import {
  GestureFeedbackOverlay,
  H264PreviewCanvas,
  ImagePreviewSurface,
  RawRgbaPreviewCanvas,
} from './ui-preview-surface';

export { buildGestureFeedbackPath } from './ui-preview-surface';
import {
  createGestureFeedbackStore,
} from './gesture-feedback-store';
import {
  createPreviewFpsStore,
} from './preview-fps-store';
import { getDeviceCornerRadiusRatio } from './utils-device-frame';
import { getMobilePreviewStandaloneLayoutClasses } from '@/features/mobile-preview/utils-mobile-preview-standalone-layout';
import { useMobilePreviewAutoStart } from '@/features/mobile-preview/use-mobile-preview-auto-start';
import { useMobilePreviewExpoLaunch } from '@/features/mobile-preview/use-mobile-preview-expo-launch';

const EMPTY_DEEP_LINKS: Array<{ url: string; pinned: boolean }> = [];
const FIRST_PREVIEW_FRAME_SETUP_WAIT_MS = 15_000;

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

type MobilePreviewAction = 'deeplink' | 'port' | 'text-size';

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
  onClose: () => void;
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
  const [isStandaloneInspectorOpen, setIsStandaloneInspectorOpen] =
    useState(false);
  const [activeAction, setActiveAction] = useState<MobilePreviewAction | null>(
    null,
  );
  const [deeplinkUrl, setDeeplinkUrl] = useState('');
  const deepLinks = useMobilePreviewDeepLinksStore(
    (state) => state.linksByProject[projectId] ?? EMPTY_DEEP_LINKS,
  );
  const recordDeepLinkOpened = useMobilePreviewDeepLinksStore(
    (state) => state.recordOpened,
  );
  const toggleDeepLinkPinned = useMobilePreviewDeepLinksStore(
    (state) => state.togglePinned,
  );
  const removeDeepLink = useMobilePreviewDeepLinksStore((state) => state.remove);
  const [hostPort, setHostPort] = useState('3000');
  const [devicePort, setDevicePort] = useState('3000');
  const [textSize, setTextSize] = useState<MobilePreviewTextSize>('normal');
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [copiedDeviceId, setCopiedDeviceId] = useState(false);
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
  const [activeConsoleCommandId, setActiveConsoleCommandId] = useState<
    string | null
  >(null);
  const [resumeSetupAfterPrebuild, setResumeSetupAfterPrebuild] =
    useState(false);
  const [resumeSetupAfterDependenciesInstall, setResumeSetupAfterDependenciesInstall] =
    useState(false);
  const [isManageDevicesOpen, setIsManageDevicesOpen] = useState(false);
  const [isCreateAndroidDeviceOpen, setIsCreateAndroidDeviceOpen] =
    useState(false);
  const [isCreateIosDeviceOpen, setIsCreateIosDeviceOpen] = useState(false);
  const [manageCreatePlatform, setManageCreatePlatform] =
    useState<MobilePlatform>('android');
  const [managedSelectedDeviceKey, setManagedSelectedDeviceKey] = useState<
    string | null
  >(null);
  const [androidDeviceName, setAndroidDeviceName] = useState('Pixel_8_API_35');
  const [androidDeviceProfileId, setAndroidDeviceProfileId] =
    useState('pixel_8');
  const [androidSystemImageId, setAndroidSystemImageId] = useState('');
  const [androidRamMb, setAndroidRamMb] = useState('');
  const [androidVmHeapMb, setAndroidVmHeapMb] = useState('');
  const [androidStorageMb, setAndroidStorageMb] = useState('');
  const [androidHwKeyboard, setAndroidHwKeyboard] = useState(true);
  const [deletingAndroidDeviceId, setDeletingAndroidDeviceId] = useState<
    string | null
  >(null);
  const [iosDeviceName, setIosDeviceName] = useState('');
  const [iosDeviceTypeId, setIosDeviceTypeId] = useState('');
  const [iosRuntimeId, setIosRuntimeId] = useState('');
  const [renamingIosDeviceId, setRenamingIosDeviceId] = useState<string | null>(
    null,
  );
  const [iosRenameValue, setIosRenameValue] = useState('');
  const [deletingIosDeviceId, setDeletingIosDeviceId] = useState<string | null>(
    null,
  );
  const [erasingIosDeviceId, setErasingIosDeviceId] = useState<string | null>(
    null,
  );
  const [enableNetworkMitm, setEnableNetworkMitm] = useState(false);
  const [androidCertGuidanceVisible, setAndroidCertGuidanceVisible] =
    useState(false);
  const [isRestartingAndroidApp, setIsRestartingAndroidApp] = useState(false);
  const [isRestartingIosApp, setIsRestartingIosApp] = useState(false);
  const [showTunneledNetworkRequests, setShowTunneledNetworkRequests] =
    useState(false);
  const [networkPreset, setNetworkPreset] =
    useState<NetworkPresetFilter>('all');
  const [networkFilter, setNetworkFilter] = useState<NetworkFilterToken[]>([]);
  const [networkFacet, setNetworkFacet] = useState('all');
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
  const [networkEndpointRailWidth, setNetworkEndpointRailWidth] =
    useState(184);
  const [selectedNetworkRequestId, setSelectedNetworkRequestId] = useState<
    string | null
  >(null);
  const [networkFilterContextMenu, setNetworkFilterContextMenu] =
    useState<NetworkFilterContextMenuState | null>(null);
  const hasAutoSelectedNetworkRequestRef = useRef(false);
  const { width, setWidth, minWidth, maxWidth } = useMobilePreviewPaneWidth();
  const { fps, setFps } = useMobilePreviewFps();
  const { quality, setQuality } = useMobilePreviewQuality();
  const { showGestures, setShowGestures } = useMobilePreviewShowGestures();
  const { autoStartProxy } = useMobilePreviewAutoStartProxy();
  const visibleActiveTab = getVisibleMobilePreviewPaneTab({
    tab: activeTab,
    networkEnabled: autoStartProxy,
  });
  const isDevServerTabVisible = visibleActiveTab === 'dev-server';
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: width,
    minWidth,
    maxWidth,
    maxWidthFraction: 0.85,
    direction: 'left',
    onWidthChange: setWidth,
  });
  const {
    isDragging: isDraggingNetworkEndpointRail,
    handleMouseDown: handleNetworkEndpointRailMouseDown,
  } = useHorizontalResize({
    initialWidth: networkEndpointRailWidth,
    minWidth: 140,
    maxWidth: 320,
    maxWidthFraction: 0.35,
    direction: 'right',
    onWidthChange: setNetworkEndpointRailWidth,
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
  const networkPanelRef = useRef<HTMLDivElement>(null);
  const pendingNetworkContextMenuRef = useRef<HTMLElement | null>(null);
  const suppressNetworkClickRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const mobileActionsMenuRef = useRef<{ toggle: () => void } | null>(null);
  const deeplinkInputRef = useRef<HTMLInputElement>(null);
  const selectedDevicePreferenceKeyRef = useRef<string | null>(null);
  const suggestedIosDeviceNameRef = useRef('');
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
  const [isRecording, setIsRecording] = useState(false);
  const recordingRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    timer: number;
    chunks: Blob[];
  } | null>(null);
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
    visibleDeviceIdsByPlatform: savedVisibleDeviceIdsByPlatform,
  } = useMobilePreviewDeviceSelection({
    key: devicePreferenceKey,
    legacyKey: legacyDevicePreferenceKey,
  });
  const visibleDeviceIdsByPlatform = useMemo(
    () => savedVisibleDeviceIdsByPlatform ?? { android: null, ios: null },
    [savedVisibleDeviceIdsByPlatform],
  );
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
  const buildCommand =
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
    if (previousCommandId && previousCommandId !== currentIosBuildCommandId) {
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
      })
    ) {
      return;
    }
    void runCommands.stopCommand(previousCommandId!);
  }, [currentIosBuildCommandId, iosBuildLaunchCoordinator, runCommands]);
  useEffect(
    () => () => {
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
  const networkProxyParams = useMemo(
    () =>
      deviceId && !needsAppSelection
        ? {
            projectPath,
            appPath,
            platform,
            deviceId,
            autoConfigureDevice: true,
          }
        : null,
    [appPath, deviceId, needsAppSelection, platform, projectPath],
  );
  const networkProxy = useMobilePreviewNetworkProxy(networkProxyParams);
  const androidManagement = useAndroidDeviceManagement(
    platform === 'android' || isManageDevicesOpen,
  );
  const iosManagement = useIosDeviceManagement(
    platform === 'ios' || isManageDevicesOpen || isCreateIosDeviceOpen,
  );
  const networkCertificateInstalled =
    networkProxy.certificate?.platform === platform &&
    networkProxy.certificate.deviceId === deviceId;
  const networkProxyStartParams = useMemo(
    () =>
      networkProxyParams
        ? {
            ...networkProxyParams,
            enableMitm: enableNetworkMitm && networkCertificateInstalled,
          }
        : null,
    [enableNetworkMitm, networkCertificateInstalled, networkProxyParams],
  );
  // Only subscribe to the request buffer while the network tab is on screen, so
  // proxy traffic cannot re-render the pane (and the preview surface) in the
  // background.
  const isNetworkTabVisible = visibleActiveTab === 'network';
  const capturedNetworkRequests = useStreamListStoreWhen(
    networkProxy.requestsStore,
    isNetworkTabVisible,
  );
  const networkRequests = useMemo(
    () =>
      [...capturedNetworkRequests].sort(
        (firstRequest, secondRequest) =>
          Date.parse(secondRequest.startedAt) -
          Date.parse(firstRequest.startedAt),
      ),
    [capturedNetworkRequests],
  );
  const displayedNetworkRequests = useMemo(
    () =>
      showTunneledNetworkRequests
        ? networkRequests
        : networkRequests.filter((request) => !request.tunnelOnly),
    [networkRequests, showTunneledNetworkRequests],
  );
  const visibleNetworkRequests = useMemo(
    () =>
      displayedNetworkRequests
        .filter((request) => matchesNetworkPreset(request, networkPreset))
        .filter(
          (request) =>
            networkFacet === 'all' || getNetworkPath(request.url) === networkFacet,
        )
        .filter((request) => matchesNetworkFilter(request, networkFilter)),
    [displayedNetworkRequests, networkFacet, networkFilter, networkPreset],
  );
  const networkFacets = useMemo(
    () => getNetworkFacets(displayedNetworkRequests),
    [displayedNetworkRequests],
  );
  const selectedNetworkRequest =
    visibleNetworkRequests.find(
      (request) => request.id === selectedNetworkRequestId,
    ) ?? null;

  useEffect(() => {
    if (networkFilter.length === 0) return;
    logNetworkFilterDebug('filter-applied', {
      tokens: networkFilter,
      displayedCount: displayedNetworkRequests.length,
      visibleCount: visibleNetworkRequests.length,
      hiddenSamples: displayedNetworkRequests
        .filter(
          (request) =>
            matchesNetworkPreset(request, networkPreset) &&
            (networkFacet === 'all' || getNetworkPath(request.url) === networkFacet) &&
            !matchesNetworkFilter(request, networkFilter),
        )
        .slice(0, 8)
        .map((request) => ({
          method: request.method,
          status: getNetworkStatusLabel(request),
          host: getNetworkHostname(request.url),
          path: getNetworkPath(request.url),
          tokenResults: networkFilter.map((token) => ({
            token,
            matches: matchesNetworkFilterToken(request, token),
          })),
        })),
      visibleSamples: visibleNetworkRequests.slice(0, 5).map((request) => ({
        host: getNetworkHostname(request.url),
        path: getNetworkPath(request.url),
      })),
    });
  }, [
    displayedNetworkRequests,
    networkFacet,
    networkFilter,
    networkPreset,
    visibleNetworkRequests,
  ]);

  // These three reconcile the selection/facet against the visible requests. They
  // must not run while the network tab is hidden: the request buffer is
  // unsubscribed then, so the derived lists are empty and would otherwise clear
  // the user's selected request and endpoint filter.
  useEffect(() => {
    if (!isNetworkTabVisible) return;
    if (hasAutoSelectedNetworkRequestRef.current) return;
    const firstRequest = visibleNetworkRequests[0];
    if (!firstRequest) return;
    hasAutoSelectedNetworkRequestRef.current = true;
    queueMicrotask(() => setSelectedNetworkRequestId(firstRequest.id));
  }, [isNetworkTabVisible, visibleNetworkRequests]);

  useEffect(() => {
    if (!isNetworkTabVisible) return;
    if (!selectedNetworkRequestId) return;
    if (
      visibleNetworkRequests.some(
        (request) => request.id === selectedNetworkRequestId,
      )
    ) {
      return;
    }

    queueMicrotask(() =>
      setSelectedNetworkRequestId(visibleNetworkRequests[0]?.id ?? null),
    );
  }, [isNetworkTabVisible, selectedNetworkRequestId, visibleNetworkRequests]);

  useEffect(() => {
    if (!isNetworkTabVisible) return;
    if (networkFacet === 'all') return;
    if (networkFacets.some((facet) => facet.path === networkFacet)) return;
    queueMicrotask(() => setNetworkFacet('all'));
  }, [isNetworkTabVisible, networkFacet, networkFacets]);

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
  const managedDeviceKey = `${platform}:${deviceId}`;
  const selectedManagedDevice = useMemo(() => {
    const preferredKey = managedSelectedDeviceKey ?? managedDeviceKey;
    return (
      allDevices.find(
        (device) => `${device.platform}:${device.id}` === preferredKey,
      ) ?? allDevices[0] ?? null
    );
  }, [allDevices, managedDeviceKey, managedSelectedDeviceKey]);
  const managedDevicesByPlatform = useMemo(
    () => ({
      android: allDevices.filter((device) => device.platform === 'android'),
      ios: allDevices.filter((device) => device.platform === 'ios'),
    }),
    [allDevices],
  );
  const isCreatingManagedDevice =
    isCreateAndroidDeviceOpen || isCreateIosDeviceOpen;

  useEffect(() => {
    if (!isManageDevicesOpen) return undefined;

    function handleManageDevicesEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (isCreatingManagedDevice) {
        setIsCreateAndroidDeviceOpen(false);
        setIsCreateIosDeviceOpen(false);
      } else {
        setIsManageDevicesOpen(false);
      }
    }

    window.addEventListener('keydown', handleManageDevicesEscape, true);
    return () =>
      window.removeEventListener('keydown', handleManageDevicesEscape, true);
  }, [isCreatingManagedDevice, isManageDevicesOpen]);
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
  const activeSessionDeviceReady =
    !!session &&
    session.status !== 'stopped' &&
    session.platform === platform &&
    session.deviceId === deviceId;

  const androidProfileOptions = useMemo(
    () =>
      (androidManagement.profiles.data ?? []).map((profile) => ({
        value: profile.id,
        label: profile.name,
        description: profile.manufacturer ?? undefined,
      })),
    [androidManagement.profiles.data],
  );
  const androidSystemImageOptions = useMemo(
    () =>
      (androidManagement.systemImages.data ?? []).map((image) => ({
        value: image.id,
        label: `API ${image.apiLevel} · ${image.tag} · ${image.abi}`,
      })),
    [androidManagement.systemImages.data],
  );
  const availableIosRuntimes = useMemo(
    () => (iosManagement.runtimes.data ?? []).filter((runtime) => runtime.available),
    [iosManagement.runtimes.data],
  );
  const iosDeviceTypes = useMemo(
    () =>
      (iosManagement.deviceTypes.data ?? []).filter(
        (deviceType) =>
          deviceType.productFamily === 'iPhone' ||
          deviceType.name.toLowerCase().includes('iphone'),
      ),
    [iosManagement.deviceTypes.data],
  );
  const iosRuntimeOptions = useMemo(
    () =>
      availableIosRuntimes.map((runtime) => ({
        value: runtime.id,
        label: runtime.name,
      })),
    [availableIosRuntimes],
  );
  const iosDeviceTypeOptions = useMemo(
    () =>
      iosDeviceTypes.map((deviceType) => ({
        value: deviceType.id,
        label: deviceType.name,
      })),
    [iosDeviceTypes],
  );
  const selectedAndroidProfile = useMemo(
    () =>
      androidManagement.profiles.data?.find(
        (profile) => profile.id === androidDeviceProfileId,
      ) ?? null,
    [androidDeviceProfileId, androidManagement.profiles.data],
  );
  const selectedAndroidSystemImage = useMemo(
    () =>
      androidManagement.systemImages.data?.find(
        (image) => image.id === androidSystemImageId,
      ) ?? null,
    [androidSystemImageId, androidManagement.systemImages.data],
  );
  const selectedIosRuntime = useMemo(
    () =>
      availableIosRuntimes.find((runtime) => runtime.id === iosRuntimeId) ?? null,
    [availableIosRuntimes, iosRuntimeId],
  );
  const selectedIosDeviceType = useMemo(
    () =>
      iosDeviceTypes.find((deviceType) => deviceType.id === iosDeviceTypeId) ?? null,
    [iosDeviceTypeId, iosDeviceTypes],
  );
  const suggestedIosDeviceName = getSuggestedIosDeviceName({
    deviceType: selectedIosDeviceType,
    runtime: selectedIosRuntime,
  });
  const androidHostArch = androidManagement.toolStatus.data?.hostArch;
  const androidImageCompatibilityWarning = getAndroidImageCompatibilityWarning(
    androidHostArch,
    selectedAndroidSystemImage?.abi,
  );
  const androidManagementError =
    formatError(androidManagement.createDevice.error) ??
    formatError(androidManagement.deleteDevice.error) ??
    formatError(androidManagement.installSystemImage.error) ??
    formatError(androidManagement.profiles.error) ??
    formatError(androidManagement.systemImages.error) ??
    formatError(androidManagement.toolStatus.error);
  const iosManagementError =
    formatError(iosManagement.createDevice.error) ??
    formatError(iosManagement.deleteDevice.error) ??
    formatError(iosManagement.eraseDevice.error) ??
    formatError(iosManagement.renameDevice.error) ??
    formatError(iosManagement.runtimes.error) ??
    formatError(iosManagement.deviceTypes.error) ??
    formatError(iosManagement.toolStatus.error);
  const androidAdvancedNumbersAreValid = [
    androidRamMb,
    androidVmHeapMb,
    androidStorageMb,
  ].every(isOptionalPositiveInteger);
  const trimmedAndroidDeviceName = androidDeviceName.trim();
  const canCreateAndroidDevice =
    trimmedAndroidDeviceName.length > 0 &&
    androidAdvancedNumbersAreValid &&
    androidProfileOptions.some((option) => option.value === androidDeviceProfileId) &&
    androidSystemImageOptions.some(
      (option) => option.value === androidSystemImageId,
    );
  const trimmedIosDeviceName = iosDeviceName.trim();
  const canCreateIosDevice =
    trimmedIosDeviceName.length > 0 &&
    iosDeviceTypeOptions.some((option) => option.value === iosDeviceTypeId) &&
    iosRuntimeOptions.some((option) => option.value === iosRuntimeId);
  const devicesErrorMessage =
    formatError(androidDevicesError) ?? formatError(iosDevicesError);
  const isLoadingDevices = isLoadingAndroidDevices || isLoadingIosDevices;

  useEffect(() => {
    if (
      androidSystemImageId &&
      androidSystemImageOptions.some((option) => option.value === androidSystemImageId)
    ) {
      return;
    }
    if (!androidHostArch) return;
    const image = getPreferredAndroidSystemImage(
      androidManagement.systemImages.data,
      androidHostArch,
    );
    if (image) queueMicrotask(() => setAndroidSystemImageId(image.id));
  }, [
    androidHostArch,
    androidManagement.systemImages.data,
    androidSystemImageId,
    androidSystemImageOptions,
  ]);

  useEffect(() => {
    if (
      androidDeviceProfileId &&
      androidProfileOptions.some((option) => option.value === androidDeviceProfileId)
    ) {
      return;
    }
    const firstProfile = androidProfileOptions[0];
    if (firstProfile) queueMicrotask(() => setAndroidDeviceProfileId(firstProfile.value));
  }, [androidDeviceProfileId, androidProfileOptions]);

  useEffect(() => {
    if (
      iosRuntimeId &&
      iosRuntimeOptions.some((option) => option.value === iosRuntimeId)
    ) {
      return;
    }
    const firstRuntime = iosRuntimeOptions[0];
    if (firstRuntime) queueMicrotask(() => setIosRuntimeId(firstRuntime.value));
  }, [iosRuntimeId, iosRuntimeOptions]);

  useEffect(() => {
    if (
      iosDeviceTypeId &&
      iosDeviceTypeOptions.some((option) => option.value === iosDeviceTypeId)
    ) {
      return;
    }
    const firstDeviceType = iosDeviceTypeOptions[0];
    if (firstDeviceType) {
      queueMicrotask(() => setIosDeviceTypeId(firstDeviceType.value));
    }
  }, [iosDeviceTypeId, iosDeviceTypeOptions]);

  useEffect(() => {
    const previousSuggestedName = suggestedIosDeviceNameRef.current;
    suggestedIosDeviceNameRef.current = suggestedIosDeviceName;
    if (
      !suggestedIosDeviceName ||
      (iosDeviceName && iosDeviceName !== previousSuggestedName)
    ) {
      return;
    }
    queueMicrotask(() => setIosDeviceName(suggestedIosDeviceName));
  }, [iosDeviceName, suggestedIosDeviceName]);

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

  const handleCreateAndroidDevice = useCallback(async () => {
    if (!canCreateAndroidDevice) return;
    try {
      await androidManagement.createDevice.mutateAsync({
        name: trimmedAndroidDeviceName,
        deviceProfileId: androidDeviceProfileId,
        systemImageId: androidSystemImageId,
        ramMb: getOptionalPositiveInteger(androidRamMb),
        vmHeapMb: getOptionalPositiveInteger(androidVmHeapMb),
        storageMb: getOptionalPositiveInteger(androidStorageMb),
        hwKeyboard: androidHwKeyboard,
      });
      setVisibleDeviceIdsByPlatform((current) => ({
        ...current,
        android: [
          ...new Set([
            ...(current.android ?? androidDevices.map((device) => device.id)),
            trimmedAndroidDeviceName,
          ]),
        ],
      }));
      selectPreviewDevice({
        platform: 'android',
        deviceId: trimmedAndroidDeviceName,
      });
      setIsCreateAndroidDeviceOpen(false);
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }, [
    androidDeviceProfileId,
    androidHwKeyboard,
    androidManagement.createDevice,
    androidDevices,
    androidRamMb,
    androidStorageMb,
    androidSystemImageId,
    androidVmHeapMb,
    canCreateAndroidDevice,
    selectPreviewDevice,
    setVisibleDeviceIdsByPlatform,
    trimmedAndroidDeviceName,
  ]);

  const handleInstallSuggestedAndroidImage = useCallback(async () => {
    try {
      await androidManagement.installSystemImage.mutateAsync({
        systemImageId: getSuggestedAndroidSystemImageId(androidHostArch),
      });
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }, [androidHostArch, androidManagement.installSystemImage]);

  async function handleDeleteAndroidDevice(name: string) {
    if (!window.confirm(`Delete Android device "${name}"?`)) return;
    setDeletingAndroidDeviceId(name);
    try {
      await androidManagement.deleteDevice.mutateAsync(name);
      setVisibleDeviceIdsByPlatform((current) => ({
        ...current,
        android: (current.android ?? androidDevices.map((device) => device.id)).filter(
          (id) => id !== name,
        ),
      }));
    } catch {
      // Mutation error is rendered from React Query state.
    } finally {
      setDeletingAndroidDeviceId(null);
    }
  }

  const handleCreateIosDevice = useCallback(async () => {
    if (!canCreateIosDevice) return;
    try {
      const createdDeviceId = await iosManagement.createDevice.mutateAsync({
        name: trimmedIosDeviceName,
        deviceTypeId: iosDeviceTypeId,
        runtimeId: iosRuntimeId,
      });
      if (createdDeviceId) {
        setVisibleDeviceIdsByPlatform((current) => ({
          ...current,
          ios: [
            ...new Set([
              ...(current.ios ?? iosDevices.map((device) => device.id)),
              createdDeviceId,
            ]),
          ],
        }));
        selectPreviewDevice({ platform: 'ios', deviceId: createdDeviceId });
      }
      setIsCreateIosDeviceOpen(false);
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }, [
    canCreateIosDevice,
    iosDevices,
    iosDeviceTypeId,
    iosManagement.createDevice,
    iosRuntimeId,
    selectPreviewDevice,
    setVisibleDeviceIdsByPlatform,
    trimmedIosDeviceName,
  ]);

  async function handleDeleteIosDevice(deviceIdToDelete: string) {
    if (!window.confirm('Delete this iOS simulator?')) return;
    setDeletingIosDeviceId(deviceIdToDelete);
    try {
      await iosManagement.deleteDevice.mutateAsync(deviceIdToDelete);
      setVisibleDeviceIdsByPlatform((current) => ({
        ...current,
        ios: (current.ios ?? iosDevices.map((device) => device.id)).filter(
          (id) => id !== deviceIdToDelete,
        ),
      }));
    } catch {
      // Mutation error is rendered from React Query state.
    } finally {
      setDeletingIosDeviceId(null);
    }
  }

  async function handleEraseIosDevice(deviceIdToErase: string) {
    if (!window.confirm('Erase this iOS simulator content and settings?')) return;
    setErasingIosDeviceId(deviceIdToErase);
    try {
      await iosManagement.eraseDevice.mutateAsync(deviceIdToErase);
    } catch {
      // Mutation error is rendered from React Query state.
    } finally {
      setErasingIosDeviceId(null);
    }
  }

  async function handleRenameIosDevice(deviceIdToRename: string) {
    const name = iosRenameValue.trim();
    if (!name) return;
    try {
      await iosManagement.renameDevice.mutateAsync({
        deviceId: deviceIdToRename,
        name,
      });
      setRenamingIosDeviceId(null);
      setIosRenameValue('');
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }

  useEffect(() => {
    queueMicrotask(() => setCopiedDeviceId(false));
  }, [deviceId]);

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
  const stopRecording = () => {
    const recording = recordingRef.current;
    if (!recording) return;
    window.clearInterval(recording.timer);
    recording.recorder.stop();
    recordingRef.current = null;
    setIsRecording(false);
  };
  const startRecording = () => {
    if (!hasImageFrame || isRecording) return;
    const source = containerRef.current?.querySelector('canvas, img') as
      | HTMLCanvasElement
      | HTMLImageElement
      | null;
    if (!source) return;
    const sourceWidth = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
    const sourceHeight = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!sourceWidth || !sourceHeight || !mimeType) return;
    const canvas = document.createElement('canvas');
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    const draw = () => {
      context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
      const feedback = gestureFeedbackStore.get();
      if (!showGestures || !feedback?.points.length) return;
      const containerRect = containerRef.current?.getBoundingClientRect();
      const surfaceRect = source.getBoundingClientRect();
      if (!containerRect || !surfaceRect) return;
      const scaleX = sourceWidth / surfaceRect.width;
      const scaleY = sourceHeight / surfaceRect.height;
      context.strokeStyle = '#7dd3fc';
      context.lineWidth = 3 * scaleX;
      context.lineCap = 'round';
      context.beginPath();
      feedback.points.forEach((point, index) => {
        const x = (point.x + containerRect.left - surfaceRect.left) * scaleX;
        const y = (point.y + containerRect.top - surfaceRect.top) * scaleY;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    };
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      try {
        const folder = mobilePreviewConfig?.mobilePreviewRecordingFolder ??
          (await api.settings.get('mobilePreviewRecordingFolder'));
        const defaultPath = folder
          ? `${folder}/mobile-preview-${new Date().toISOString().replaceAll(':', '-')}.webm`
          : undefined;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        await api.dialog.saveFile({
          defaultPath,
          filters: [{ name: 'WebM video', extensions: ['webm'] }],
          content: new Uint8Array(await blob.arrayBuffer()),
        });
      } finally {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
    draw();
    recorder.start();
    const timer = window.setInterval(draw, 1000 / 30);
    recordingRef.current = { recorder, stream, timer, chunks };
    setIsRecording(true);
  };
  useEffect(() => stopRecording, []);
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
    retryGeneration: runtimeLaunchRetry,
    isSelectedDeviceReady: activeSessionDeviceReady,
    isAppInstalled:
      (platform === 'android'
        ? androidAppStatus?.appInstalled
        : iosAppStatus?.appInstalled) ?? null,
    appScheme: configuredAppScheme,
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
  } = useMobilePreviewAutoStart({
    enabled:
      autoLaunchRunningRuntime &&
      !needsAppSelection &&
      !hasActiveSession &&
      !isHydratingRetainedSessions &&
      !!deviceId &&
      selectedDeviceCanStart,
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

      if (!deviceId || !selectedDeviceCanStart || needsAppSelection) return;
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

  const handleCopyDeviceId = useCallback(async () => {
    if (!deviceId) return;
    await navigator.clipboard.writeText(deviceId);
    setCopiedDeviceId(true);
    showActionNotice('Device UUID copied');
  }, [deviceId, showActionNotice]);

  const handleOpenDeeplink = useCallback(async () => {
    if (!deviceId || !deeplinkUrl.trim()) return;
    setIsRunningAction(true);
    try {
      await api.mobilePreview.openDeeplink({
        platform,
        deviceId,
        url: deeplinkUrl.trim(),
      });
      recordDeepLinkOpened(projectId, deeplinkUrl);
      showActionNotice('Deeplink opened');
    } catch (error) {
      setInputNotice(formatError(error) ?? 'Failed to open deeplink');
    } finally {
      setIsRunningAction(false);
    }
  }, [
    deeplinkUrl,
    deviceId,
    platform,
    projectId,
    recordDeepLinkOpened,
    showActionNotice,
  ]);

  const handleOpenDevMenu = useCallback(async () => {
    if (!deviceId) return;
    setIsRunningAction(true);
    try {
      await api.mobilePreview.openDevMenu({
        platform,
        deviceId,
        metroPort: effectiveDevServerPort,
      });
      showActionNotice('Dev menu toggled on device');
    } catch (error) {
      setInputNotice(formatError(error) ?? 'Failed to open dev menu');
    } finally {
      setIsRunningAction(false);
    }
  }, [deviceId, effectiveDevServerPort, platform, showActionNotice]);

  const handleReloadExpo = useCallback(async () => {
    setIsRunningAction(true);
    try {
      await api.mobilePreview.reloadExpo({ metroPort: effectiveDevServerPort });
      showActionNotice();
    } catch (error) {
      setInputNotice(formatError(error) ?? 'Failed to reload Expo');
    } finally {
      setIsRunningAction(false);
    }
  }, [effectiveDevServerPort, showActionNotice]);

  const handleShowDeeplinkAction = useCallback(() => {
    mobileActionsMenuRef.current?.toggle();
    setActiveAction('deeplink');
    requestAnimationFrame(() => {
      deeplinkInputRef.current?.focus();
    });
  }, []);

  const parsedHostPort = parsePort(hostPort);
  const parsedDevicePort = parsePort(devicePort);
  const canForwardPort = parsedHostPort !== null && parsedDevicePort !== null;

  const handleForwardPort = useCallback(async () => {
    if (
      !deviceId ||
      platform !== 'android' ||
      parsedHostPort === null ||
      parsedDevicePort === null
    ) {
      return;
    }
    setIsRunningAction(true);
    try {
      await api.mobilePreview.forwardPort({
        platform,
        deviceId,
        hostPort: parsedHostPort,
        devicePort: parsedDevicePort,
      });
      showActionNotice(
        `Forwarded :${parsedDevicePort} -> localhost:${parsedHostPort}`,
      );
    } catch (error) {
      setInputNotice(formatError(error) ?? 'Failed to forward port');
    } finally {
      setIsRunningAction(false);
    }
  }, [deviceId, parsedDevicePort, parsedHostPort, platform, showActionNotice]);

  const handleSetTextSize = useCallback(async () => {
    if (!deviceId) return;
    setIsRunningAction(true);
    try {
      await api.mobilePreview.setTextSize({
        platform,
        deviceId,
        size: textSize,
      });
      showActionNotice('Text size applied');
    } catch (error) {
      setInputNotice(formatError(error) ?? 'Failed to set text size');
    } finally {
      setIsRunningAction(false);
    }
  }, [deviceId, platform, showActionNotice, textSize]);
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
    if (platform === 'ios' && !deviceId) return;
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
    />
  );

  const networkSession = networkProxy.session;
  const networkStatus = networkSession?.status ?? 'stopped';

  const handleStartStopNetworkProxy = () => {
    if (networkSession && networkStatus === 'running') {
      void networkProxy.stop(networkSession.id);
      return;
    }
    if (!networkProxyStartParams) return;
    void networkProxy.start(networkProxyStartParams);
  };
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
    if (networkSession && networkStatus === 'running') {
      stops.push(networkProxy.stop(networkSession.id));
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
    networkProxy,
    networkSession,
    networkStatus,
    platform,
    prebuildCommandId,
    prebuildStatus?.status,
    runCommands,
    setupOperationCoordinator,
    stop,
    setResumeSetupAfterDependenciesInstall,
  ]);
  const handleInstallNetworkCertificate = () => {
    if (!deviceId || !networkProxyParams) return;

    void (async () => {
      try {
        if (networkSession && networkStatus === 'running') {
          await networkProxy.stop(networkSession.id);
        }
        await networkProxy.installCertificate({ platform, deviceId });
        const mitmParams = { ...networkProxyParams, enableMitm: true };
        setEnableNetworkMitm(true);
        await networkProxy.start(mitmParams);
        if (platform === 'android') {
          setAndroidCertGuidanceVisible(true);
        } else {
          showActionNotice('CA installed; HTTPS decrypt enabled');
        }
      } catch (error) {
        setInputNotice(
          formatError(error) ?? 'Failed to install proxy certificate',
        );
      }
    })();
  };
  const handlePrepareAndroidAppTrust = () => {
    if (platform !== 'android' || !networkProxyParams) return;
    if (!effectiveAndroidProjectPath) {
      setInputNotice('Set Android project folder in project settings first');
      return;
    }

    void (async () => {
      try {
        const result = await networkProxy.prepareAndroidAppTrust({
          projectId,
          taskId,
          androidProjectPath: effectiveAndroidProjectPath,
        });
        const editedFiles = result.nativeFiles
          .map((filePath) =>
            filePath.startsWith(projectPath)
              ? filePath.slice(projectPath.length).replace(/^\/+/, '')
              : filePath,
          )
          .join(', ');
        showActionNotice(`${result.message} Edited: ${editedFiles}`);
      } catch (error) {
        setInputNotice(
          formatError(error) ?? 'Failed to prepare Android app trust',
        );
      }
    })();
  };
  const handleRestartAndroidApp = () => {
    if (platform !== 'android' || !deviceId || !effectiveAndroidProjectPath) return;

    void (async () => {
      setIsRestartingAndroidApp(true);
      try {
        const result = await api.mobilePreview.restartAndroidApp({
          projectId,
          taskId,
          androidProjectPath: effectiveAndroidProjectPath,
          deviceId,
        });
        showActionNotice(`${result.packageName} restarted`);
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
        const result = await api.mobilePreview.restartIosApp({
          projectId,
          taskId,
          appPath,
          deviceId,
        });
        showActionNotice(`${result.bundleId} restarted`);
      } catch (error) {
        setInputNotice(formatError(error) ?? 'Failed to restart iOS app');
      } finally {
        setIsRestartingIosApp(false);
      }
    })();
  };
  const networkProxySubtitle = networkSession
    ? `${networkSession.proxyUrl} · HTTPS decrypt ${
        networkSession.enableMitm ? 'on' : 'off'
      }`
    : platform === 'android'
      ? 'Android emulator proxy auto-configured'
      : 'iOS simulator proxy routing automatic';
  const networkPresetCounts = {
    all: displayedNetworkRequests.length,
    errors: displayedNetworkRequests.filter((request) =>
      matchesNetworkPreset(request, 'errors'),
    ).length,
    post: displayedNetworkRequests.filter((request) =>
      matchesNetworkPreset(request, 'post'),
    ).length,
    get: displayedNetworkRequests.filter((request) =>
      matchesNetworkPreset(request, 'get'),
    ).length,
  };
  const handleNetworkRequestContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    request: MobilePreviewNetworkRequest,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const host = getNetworkHostname(request.url);
    const path = getNetworkPath(request.url);
    setNetworkFilterContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: 'Add filter from request',
      subtitle: `${host}${path}`,
      items: [
        { key: 'method', value: request.method.toUpperCase() },
        { key: 'status', value: getNetworkStatusLabel(request).toString() },
        { key: 'host', value: host },
        { key: 'path', value: path },
      ],
    });
  };
  const handleNetworkFacetContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    path: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setNetworkFilterContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: 'Add filter from endpoint',
      subtitle: path,
      items: [{ key: 'path', value: path }],
    });
  };
  const openNetworkFilterContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    trigger: HTMLElement,
  ) => {
    const path = trigger.dataset.networkFilterPath;
    if (path) {
      event.preventDefault();
      event.stopPropagation();
      setNetworkFilterContextMenu({
        x: event.clientX,
        y: event.clientY,
        title: 'Add filter from endpoint',
        subtitle: path,
        items: [{ key: 'path', value: path }],
      });
      return true;
    }

    const requestId = trigger.dataset.networkRequestId;
    const request = visibleNetworkRequests.find(
      (networkRequest) => networkRequest.id === requestId,
    );
    if (!request) return false;

    const host = getNetworkHostname(request.url);
    const requestPath = getNetworkPath(request.url);
    event.preventDefault();
    event.stopPropagation();
    setNetworkFilterContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: 'Add filter from request',
      subtitle: `${host}${requestPath}`,
      items: [
        { key: 'host', value: host },
        { key: 'path', value: requestPath },
      ],
    });
    return true;
  };
  const getNetworkFilterContextTrigger = (target: EventTarget | null) =>
    target instanceof HTMLElement
      ? target.closest<HTMLElement>('[data-network-filter-context]')
      : null;
  const handleNetworkContextMenuCapture = (event: ReactMouseEvent<HTMLElement>) => {
    const trigger = getNetworkFilterContextTrigger(event.target);
    if (!trigger) return;
    pendingNetworkContextMenuRef.current = null;
    openNetworkFilterContextMenu(event, trigger);
  };
  const handleNetworkMouseDownCapture = (event: ReactMouseEvent<HTMLElement>) => {
    const isSecondaryClick = event.button === 2 || (event.button === 0 && event.ctrlKey);
    if (!isSecondaryClick) return;
    const trigger = getNetworkFilterContextTrigger(event.target);
    if (!trigger) return;
    pendingNetworkContextMenuRef.current = trigger;
    suppressNetworkClickRef.current = true;
    window.setTimeout(() => {
      suppressNetworkClickRef.current = false;
    }, 0);
    event.preventDefault();
    event.stopPropagation();
  };
  const handleNetworkMouseUpCapture = (event: ReactMouseEvent<HTMLElement>) => {
    const trigger = pendingNetworkContextMenuRef.current;
    if (!trigger) return;
    pendingNetworkContextMenuRef.current = null;
    openNetworkFilterContextMenu(event, trigger);
  };
  const handleNetworkClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressNetworkClickRef.current) return;
    suppressNetworkClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const renderNetworkBody = () => (
    <div
      ref={networkPanelRef}
      onContextMenuCapture={handleNetworkContextMenuCapture}
      onMouseDownCapture={handleNetworkMouseDownCapture}
      onMouseUpCapture={handleNetworkMouseUpCapture}
      onClickCapture={handleNetworkClickCapture}
      className="relative flex h-full min-h-0 flex-col bg-zinc-950"
    >
      {networkProxy.error || networkSession?.error ? (
        <div className="border-status-fail/40 bg-status-fail/10 text-status-fail border-b px-4 py-2 text-xs">
          {formatError(networkProxy.error) ?? networkSession?.error}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center border-b border-zinc-900/90 bg-zinc-950 px-3 py-1.5">
        <NetworkFilterAutocomplete
          tokens={networkFilter}
          onChange={setNetworkFilter}
          requests={displayedNetworkRequests}
          resultCount={visibleNetworkRequests.length}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-900/90 bg-zinc-950 px-3 py-1">
        <NetworkFilterChip
          label="All"
          count={networkPresetCounts.all}
          active={networkPreset === 'all'}
          onClick={() => setNetworkPreset('all')}
        />
        <NetworkFilterChip
          label="Errors"
          count={networkPresetCounts.errors}
          active={networkPreset === 'errors'}
          tone="danger"
          onClick={() => setNetworkPreset('errors')}
        />
        <NetworkFilterChip
          label="POST"
          count={networkPresetCounts.post}
          active={networkPreset === 'post'}
          onClick={() => setNetworkPreset('post')}
        />
        <NetworkFilterChip
          label="GET"
          count={networkPresetCounts.get}
          active={networkPreset === 'get'}
          tone="success"
          onClick={() => setNetworkPreset('get')}
        />
        <label className="text-ink-3 inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[3px] border border-zinc-800 bg-zinc-900/50 px-2 text-[10px]">
          <input
            type="checkbox"
            checked={showTunneledNetworkRequests}
            onChange={(event) =>
              setShowTunneledNetworkRequests(event.currentTarget.checked)
            }
            className="h-3 w-3"
          />
          Tunnels
        </label>
        <div className="min-w-0 flex-1" />
        <div className="text-ink-4 hidden max-w-[260px] truncate font-mono text-[10px] xl:block">
          {networkProxySubtitle}
        </div>
        <label className="text-ink-3 inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[3px] border border-zinc-800 bg-zinc-900/50 px-2 text-[10px]">
          <input
            type="checkbox"
            checked={enableNetworkMitm && networkCertificateInstalled}
            onChange={(event) =>
              setEnableNetworkMitm(event.currentTarget.checked)
            }
            disabled={
              !!networkSession ||
              !networkCertificateInstalled ||
              networkProxy.isStarting ||
              networkProxy.isStopping
            }
            className="h-3 w-3"
          />
          Decrypt
        </label>
      </div>
      {!networkProxyParams ? (
        <EmptyState
          title="Network capture unavailable"
          detail={
            needsAppSelection ? 'Select an app first' : 'Select a device first'
          }
        />
      ) : networkRequests.length === 0 ? (
        <div className="flex h-full items-center justify-center p-6 text-center">
          <div>
            <div className="text-ink-1 text-sm font-medium">
              No network requests
            </div>
            <div className="text-ink-3 mt-1 max-w-md text-xs">
              {platform === 'ios'
                ? 'Start the proxy, then use the app. Jean-Claude routes iOS simulator traffic through macOS proxy settings until stop.'
                : 'Start the proxy, then use the app. HTTP should show full requests; HTTPS may only show CONNECT tunnels unless the app trusts the Jean-Claude CA.'}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            style={{ width: networkEndpointRailWidth }}
            className="relative hidden shrink-0 flex-col border-r border-zinc-900/90 bg-zinc-950 p-1.5 lg:flex"
          >
            <div
              onMouseDown={handleNetworkEndpointRailMouseDown}
              className={clsx(
                'hover:bg-acc/40 absolute top-0 right-[-2px] z-20 h-full w-1 cursor-col-resize transition-colors',
                isDraggingNetworkEndpointRail && 'bg-acc/50',
              )}
            />
            <div className="text-ink-4 px-2 pt-0.5 pb-1.5 text-[9px] font-semibold tracking-wide uppercase">
              Endpoints
            </div>
            <NetworkFacetButton
              label="All requests"
              count={displayedNetworkRequests.length}
              active={networkFacet === 'all'}
              onClick={() => setNetworkFacet('all')}
            />
            {networkFacets.map((facet) => (
              <NetworkFacetButton
                key={facet.path}
                label={facet.path.replace(/^\/api\//, '')}
                count={facet.count}
                active={networkFacet === facet.path}
                failed={facet.failed}
                onClick={() => setNetworkFacet(facet.path)}
                onContextMenu={(event) =>
                  handleNetworkFacetContextMenu(event, facet.path)
                }
              />
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-auto bg-zinc-950">
            <div className="text-ink-4 sticky top-0 z-10 grid h-[23px] grid-cols-[54px_46px_78px_minmax(0,1fr)] items-center gap-2 border-b border-zinc-900/90 bg-zinc-950 px-2.5 text-[9px] font-semibold tracking-wide uppercase">
              <span>Method</span>
              <span>Status</span>
              <span>Time</span>
              <span>URL</span>
            </div>
            {visibleNetworkRequests.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6 text-center">
                <div>
                  <div className="text-ink-1 text-sm font-medium">
                    {displayedNetworkRequests.length === 0
                      ? 'Only tunnel requests'
                      : 'No matching requests'}
                  </div>
                  <div className="text-ink-3 mt-1 max-w-md text-xs">
                    {displayedNetworkRequests.length === 0
                      ? 'Enable Tunnels to inspect CONNECT rows'
                      : 'Adjust the filter or choose another endpoint'}
                  </div>
                </div>
              </div>
            ) : visibleNetworkRequests.map((request) => {
              const selected = request.id === selectedNetworkRequestId;
              const maxDuration = Math.max(
                1,
                ...displayedNetworkRequests.map(
                  (networkRequest) => networkRequest.durationMs ?? 0,
                ),
              );
              const durationWidth =
                request.durationMs === null
                  ? 0
                  : Math.max(10, (request.durationMs / maxDuration) * 100);
              return (
                <button
                  key={`${request.sessionId}:${request.id}`}
                  type="button"
                  data-network-filter-context="request"
                  data-network-request-id={request.id}
                  className={clsx(
                    'grid h-[26px] w-full grid-cols-[54px_46px_78px_minmax(0,1fr)] items-center gap-2 border-b border-zinc-900/80 px-2.5 text-left transition-colors',
                    selected
                      ? 'bg-acc-soft shadow-[inset_2px_0_0_var(--color-acc)]'
                      : 'hover:bg-zinc-900/70',
                  )}
                  onClick={() => setSelectedNetworkRequestId(request.id)}
                  onContextMenu={(event) =>
                    handleNetworkRequestContextMenu(event, request)
                  }
                  onMouseDown={(event) => {
                    if (event.button === 2) {
                      handleNetworkRequestContextMenu(event, request);
                    }
                  }}
                >
                  <span
                    className={clsx(
                      'font-mono text-[11px] font-semibold',
                      getNetworkMethodClass(request.method),
                    )}
                  >
                    {request.method}
                  </span>
                  <span
                    className={clsx(
                      'font-mono text-[11px] font-semibold',
                      getNetworkStatusClass(request),
                    )}
                  >
                    {getNetworkStatusLabel(request)}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="h-1 w-[26px] overflow-hidden rounded-full bg-zinc-900">
                      <span
                        className={clsx(
                          'block h-full rounded-full',
                          request.error ||
                            (request.status !== null && request.status >= 400)
                            ? 'bg-status-fail'
                            : 'bg-emerald-300',
                        )}
                        style={{ width: `${durationWidth}%` }}
                      />
                    </span>
                    <span className="text-ink-4 font-mono text-[10px]">
                      {request.durationMs === null
                        ? '-'
                        : `${request.durationMs}ms`}
                    </span>
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px]">
                    <span className="text-ink-4">
                      {getNetworkHostname(request.url)}
                    </span>
                    <span className="text-ink-1">
                      {getNetworkPath(request.url)}
                    </span>
                    {request.error ? (
                      <span className="text-status-fail ml-2">
                        {request.error}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          {selectedNetworkRequest ? (
            <NetworkRequestDetails
              request={selectedNetworkRequest}
              onClose={() => setSelectedNetworkRequestId(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );

  const networkProxyError = networkProxy.error || networkSession?.error;
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
  const proxyStatus = networkProxyError
    ? 'error'
    : networkStatus === 'running'
      ? 'ready'
      : networkProxy.isStarting
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
  const androidTrustConfigured = !!androidAppStatus?.trustConfigured;
  const androidTrustReady =
    platform !== 'android' || (androidAppInstalled && androidTrustConfigured);
  const httpsStatus =
    proxyStatus === 'error'
      ? 'idle'
      : networkProxy.isInstallingCertificate ||
          networkProxy.isPreparingAndroidAppTrust
        ? 'running'
        : networkStatus === 'running' &&
            networkSession?.enableMitm &&
            networkCertificateInstalled &&
            androidTrustReady
          ? 'ready'
          : platform === 'android' &&
              networkStatus === 'running' &&
              networkSession?.enableMitm &&
              networkCertificateInstalled &&
              !androidTrustReady
            ? 'blocked'
            : 'idle';
  const dependenciesInstallStatusValue =
    dependenciesInstallStatus?.status === 'stopped'
      ? 'completed'
      : dependenciesInstallStatus?.status;
  const setupSteps = [
    {
      key: 'app',
      label: 'App selected',
      status: appReady ? 'ready' : 'blocked',
      detail: appReady ? appPath : 'Choose app first',
      tab: null,
    },
    {
      key: 'dependencies-install',
      label: 'Dependencies installed',
      status:
        dependenciesInstallStatusValue === 'errored'
          ? 'error'
          : dependenciesInstallStatusValue === 'running'
            ? 'running'
            : dependenciesInstallStatusValue === 'completed'
              ? 'ready'
              : 'idle',
      detail:
        dependenciesInstallStatusValue === 'completed'
          ? dependenciesInstallCommand
          : dependenciesInstallStatusValue === 'running'
            ? 'Installing dependencies...'
            : dependenciesInstallStatusValue === 'errored'
              ? 'Dependency install failed; check Metro tab logs'
              : dependenciesInstallCommand,
      tab: 'dev-server' as const,
    },
    {
      key: 'device',
      label: 'Device ready',
      status: deviceReady ? 'ready' : deviceId ? 'blocked' : 'idle',
      detail: selectedDevice
        ? `${selectedDevice.name} · ${formatDeviceState(selectedDevice.state)}`
        : activeSessionDeviceReady
          ? `${deviceId} · active preview session`
        : 'Select booted device',
      tab: null,
    },
    ...((autoStartProxy && needsExpoAndroidPrebuild) || needsExpoIosPrebuild
      ? [
          {
            key: 'prebuild',
            label: `${platform === 'android' ? 'Android' : 'iOS'} project generated`,
            status: prebuildStatusValue,
            detail:
              prebuildStatusValue === 'ready'
                ? `${platform === 'android' ? inferredAndroidProjectPath : `${appPath === '.' ? '' : `${appPath}/`}ios`} · generated`
                : prebuildStatusValue === 'running'
                  ? 'Running expo prebuild...'
                  : prebuildStatusValue === 'error'
                    ? 'Prebuild failed; check Metro tab logs'
                    : `Expo app has no ${platform} folder`,
            tab: 'dev-server' as const,
          },
        ]
      : []),
    ...((platform === 'android' && effectiveAndroidProjectPath) || platform === 'ios'
      ? [
          {
            key: 'install',
            label: 'App installed',
            status: iosAppStatusError
              ? 'error'
              : isIosAppStatusLoading ||
                  normalizedBuildStatus === 'loading' ||
                  buildStarting ||
                  buildRunning
              ? 'running'
              : selectedAppInstalled
              ? 'ready'
              : appSetupDecision.needsBuild
                ? 'blocked'
                : 'idle',
            detail:
              platform === 'android'
                ? androidAppStatus?.packageName
                  ? androidAppInstalled
                    ? `${androidAppStatus.packageName} · installed`
                    : `${androidAppStatus.packageName} · build required`
                  : 'Package id not detected; build optional'
                : iosAppStatus?.bundleId
                  ? iosSetupDecision.appReady
                    ? `${iosAppStatus.bundleId} · installed`
                    : `${iosAppStatus.bundleId} · build required`
                  : isIosAppStatusLoading
                    ? 'Checking simulator app status...'
                    : normalizedBuildStatus === 'loading'
                      ? 'Checking persisted build history...'
                    : iosAppStatusError
                      ? `Status check failed: ${iosAppStatusError}`
                    : iosSetupDecision.buildVerificationFailed
                      ? 'Build completed, but bundle id is still unresolved'
                      : normalizedBuildStatus === 'errored'
                        ? 'Build failed; check iOS build logs'
                        : 'Bundle id not detected; build required',
            tab: 'dev-server' as const,
          },
        ]
      : []),
    {
      key: 'metro',
      label: 'Metro running',
      status: metroStatus,
      detail: devServerRunning
        ? `port ${effectiveDevServerPort} · live`
        : devServerStarting
          ? 'Starting dev server...'
          : 'Not started',
      tab: 'dev-server',
    },
    {
      key: 'preview',
      label: 'Preview streaming',
      status: previewStatus,
      detail: previewMethodText ?? (previewStatus === 'running' ? 'Starting stream...' : 'Not started'),
      tab: null,
    },
    ...(autoStartProxy
      ? [
          {
            key: 'proxy',
            label: 'Proxy running',
            status: proxyStatus,
            detail: networkProxyError
              ? cleanPreviewError(formatError(networkProxyError) ?? 'Proxy failed')
              : networkStatus === 'running'
                ? (networkSession?.proxyUrl ?? 'Proxy live')
                : networkProxy.isStarting
                  ? 'Starting proxy...'
                  : platform === 'android'
                    ? 'Android emulator proxy auto-configured'
                    : 'iOS proxy routing automatic',
            tab: 'network' as const,
          },
          {
            key: 'https',
            label: 'HTTPS decrypt ready',
            status: httpsStatus,
            detail:
              httpsStatus === 'ready'
                ? (
                    <NetworkRequestCountDetail
                      store={networkProxy.requestsStore}
                      showTunneled={showTunneledNetworkRequests}
                    />
                  )
                : httpsStatus === 'blocked'
                  ? effectiveAndroidProjectPath
                    ? androidTrustConfigured
                      ? 'Build and install app on device'
                      : 'Rebuild app so debug trust config applies'
                    : 'Set Android project folder in project settings'
                  : httpsStatus === 'running'
                    ? 'Preparing certificate trust...'
                    : !networkCertificateInstalled
                      ? platform === 'android' && androidCertGuidanceVisible
                        ? 'Finish CA install on Android, then restart app'
                        : 'Install CA certificate to decrypt HTTPS'
                      : networkStatus !== 'running'
                        ? 'Start proxy with HTTPS decrypt'
                        : 'Waiting for certificate trust',
            tab: 'network' as const,
          },
        ]
      : []),
  ] as const;
  const readySetupSteps = setupSteps.filter((step) => step.status === 'ready').length;
  const incompleteSetupSteps = setupSteps.filter((step) => step.status !== 'ready');
  const anySetupRunning = setupSteps.some((step) => step.status === 'running');
  const anySetupStopping =
    isStopping ||
    devServerStopping ||
    buildStopping ||
    prebuildStopping ||
    networkProxy.isStopping;
  const canStopSetup = !!(
    hasActiveSession ||
    isStarting ||
    devServerRunning ||
    buildRunning ||
    prebuildStatus?.status === 'running' ||
    (nativeLogSession && nativeLogStatus === 'running') ||
    (networkSession && networkStatus === 'running') ||
    anySetupStopping
  );
  const allSetupReady = readySetupSteps === setupSteps.length;
  const blockedSetupStep = setupSteps.find(
    (step) => step.status === 'blocked' || step.status === 'error',
  );
  const nextSetupStep =
    blockedSetupStep ??
    incompleteSetupSteps.find((step) => step.status !== 'running') ??
    incompleteSetupSteps[0] ??
    null;
  const missingSetupLabels = incompleteSetupSteps
    .filter((step) => step.status !== 'running')
    .map((step) => step.label);
  const missingSetupDetail = missingSetupLabels.length
    ? `Missing: ${missingSetupLabels.join(', ')}.`
    : 'Setup is running.';
  const ctaLabel = allSetupReady
    ? 'Workspace ready'
    : anySetupRunning
      ? 'Starting workspace...'
      : needsAppSelection
        ? 'Continue setup'
        : platform === 'ios' && iosAppStatusError
          ? 'Retry app status'
        : ((autoStartProxy && needsExpoAndroidPrebuild) || needsExpoIosPrebuild) &&
            !prebuildDone
          ? 'Run Expo prebuild'
          : autoStartProxy && proxyStatus === 'error'
            ? 'Restart proxy'
            : autoStartProxy && httpsStatus === 'blocked'
              ? 'Fix Android trust'
              : nextSetupStep?.key === 'https'
                  ? networkCertificateInstalled
                    ? 'Finish HTTPS setup'
                    : 'Install certificate'
              : readySetupSteps > 2
                ? 'Continue setup'
                : 'Start workspace';
  const ctaDisabled = allSetupReady || anySetupRunning || needsAppSelection || !deviceReady;
  const setupHeadline = allSetupReady
    ? 'Workspace ready'
    : nextSetupStep
      ? `Next: ${nextSetupStep.label}`
    : readySetupSteps > 2
      ? 'Resume mobile debug'
      : 'Debug this app end-to-end';
  const setupDetail = allSetupReady
    ? autoStartProxy
      ? 'Preview, Metro, proxy, and HTTPS decrypt are live.'
      : 'Preview and Metro are live. Proxy stays manual.'
    : nextSetupStep
      ? `${nextSetupStep.detail}. ${missingSetupDetail}`
    : autoStartProxy
      ? 'One action starts Metro, preview, proxy, and HTTPS decrypt. Logs stay manual.'
      : 'One action starts Metro and preview. Proxy stays manual.';

  const handleStartWorkspace = useCallback(async ({
    shouldAutoBuildIos,
    shouldPrebuildAndroid,
    shouldPrebuildIos,
  }: {
    shouldAutoBuildIos: boolean;
    shouldPrebuildAndroid: boolean;
    shouldPrebuildIos: boolean;
  }) => {
    if (needsAppSelection || !deviceReady) return;
    const setupCoordinator = setupOperationCoordinator;
    const setupOperation = setupCoordinator.begin(
      getPreviewDeviceKey(platform, deviceId),
    );
      if (!setupOperation) return;

      try {
      if (dependenciesInstallStatusValue !== 'completed') {
        if (dependenciesInstallStatusValue === 'errored') {
          setInputNotice('Dependency install failed; check Metro tab logs');
          return;
        }
        if (dependenciesInstallStatusValue !== 'running') {
          setResumeSetupAfterDependenciesInstall(true);
          await runCommands.startAdHocCommand({
            runCommandId: dependenciesInstallCommandId,
            name: 'Mobile dependencies install',
            command: dependenciesInstallCommand,
            ports: [],
          });
        }
        return;
      }

      const setupEffectiveAndroidProjectPath = androidProjectPath
        ? androidProjectExists === false
          ? null
          : androidProjectPath
        : androidProjectExists === true
          ? inferredAndroidProjectPath
          : null;
      if (
        (autoStartProxy &&
          shouldPrebuildAndroid &&
          !setupEffectiveAndroidProjectPath) ||
        shouldPrebuildIos
      ) {
        setResumeSetupAfterPrebuild(true);
        await runCommands.startAdHocCommand({
          runCommandId: prebuildCommandId,
          name: platform === 'android' ? 'Expo Android prebuild' : 'Expo iOS prebuild',
          command: prebuildCommand,
          ports: [],
        });
        showActionNotice('Expo prebuild started; setup will continue when it finishes');
        return;
      }

      if (!devServerRunning && !devServerStarting) {
        void runCommands.startAdHocCommand({
          runCommandId: devServerCommandId,
          name: 'Mobile dev server',
          command: devServerCommand,
          ports: [configuredDevServerPort],
          availablePort: { provider: 'args' },
        });
      }

      let setupSessionId = session?.id ?? null;
      if (
        hasActiveSession &&
        (!session ||
          session.platform !== platform ||
          session.deviceId !== deviceId)
      ) {
        setupCoordinator.cancel();
        return;
      }
      if (!hasActiveSession) {
        const startedSession = await start({
          projectPath: effectiveProjectPath,
          platform,
          deviceId,
          fps,
          quality,
        });
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        if (
          startedSession.platform !== platform ||
          startedSession.deviceId !== deviceId ||
          startedSession.status === 'stopped'
        ) {
          setupCoordinator.cancel();
          return;
        }
        setupSessionId = startedSession.id;
      }

      if (
        !setupSessionId ||
        !setupCoordinator.bindSession(setupOperation, setupSessionId)
      ) {
        return;
      }

      if (platform === 'ios') {
        const frameResult = await setupCoordinator.waitForFrame(
          setupOperation,
          setupSessionId,
          FIRST_PREVIEW_FRAME_SETUP_WAIT_MS,
        );
        if (
          frameResult === 'cancelled' ||
          !setupCoordinator.isCurrent(setupOperation)
        ) {
          return;
        }
      }

      if (!setupCoordinator.isCurrent(setupOperation)) return;
      if (
        platform === 'ios' &&
        shouldAutoBuildIos &&
        buildCommand &&
        !buildRunning &&
        !buildStarting
      ) {
        setLaunchedIosBuildCommandIds((current) =>
          current.includes(buildCommandId) ? current : [...current, buildCommandId],
        );
        setActiveConsoleCommandId(buildCommandId);
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
      }

      if (!autoStartProxy) {
        if (
          platform === 'android' &&
          setupEffectiveAndroidProjectPath &&
          androidAppMissing &&
          buildCommand &&
          !buildRunning &&
          !buildStarting
        ) {
          setActiveConsoleCommandId(buildCommandId);
          void runCommands.startAdHocCommand({
            runCommandId: buildCommandId,
            name: 'Android build',
            command: buildCommand,
            ports: [],
          });
        }
        return;
      }

      if (platform === 'android' && !setupEffectiveAndroidProjectPath) {
        if (shouldPrebuildAndroid) {
          setResumeSetupAfterPrebuild(true);
          await runCommands.startAdHocCommand({
            runCommandId: prebuildCommandId,
            name: 'Expo Android prebuild',
            command: prebuildCommand,
            ports: [],
          });
          showActionNotice('Expo prebuild started; setup will continue when it finishes');
        } else {
          showActionNotice('Checking Android project folder before proxy setup');
        }
        return;
      }

      if (!networkProxyParams) return;
      if (!setupCoordinator.isCurrent(setupOperation)) return;

      if (proxyStatus === 'error' && networkSession) {
        await networkProxy.stop(networkSession.id);
        if (!setupCoordinator.isCurrent(setupOperation)) return;
      }

      if (!networkCertificateInstalled) {
        if (networkSession && networkStatus === 'running') {
          await networkProxy.stop(networkSession.id);
          if (!setupCoordinator.isCurrent(setupOperation)) return;
        }
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        await networkProxy.installCertificate({ platform, deviceId });
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        setEnableNetworkMitm(true);
        if (platform === 'android') {
          setAndroidCertGuidanceVisible(true);
        }
        await networkProxy.start({ ...networkProxyParams, enableMitm: true });
      } else if (networkStatus !== 'running') {
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        setEnableNetworkMitm(true);
        await networkProxy.start({ ...networkProxyParams, enableMitm: true });
      } else if (networkSession && !networkSession.enableMitm) {
        await networkProxy.stop(networkSession.id);
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        setEnableNetworkMitm(true);
        await networkProxy.start({ ...networkProxyParams, enableMitm: true });
      }

      if (!setupCoordinator.isCurrent(setupOperation)) return;
      if (
        platform === 'android' &&
        setupEffectiveAndroidProjectPath &&
        !androidTrustConfigured
      ) {
        const trustResult = await networkProxy.prepareAndroidAppTrust({
          projectId,
          taskId,
          androidProjectPath: setupEffectiveAndroidProjectPath,
        });
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        setAndroidAppStatus((current) =>
          current
            ? { ...current, trustConfigured: true }
            : {
                appInstalled: null,
                packageName: null,
                trustConfigured: true,
              },
        );

        if (
          buildCommand &&
          !buildRunning &&
          !buildStarting &&
          (trustResult.changed || androidAppMissing)
        ) {
          setActiveConsoleCommandId(buildCommandId);
          void runCommands.startAdHocCommand({
            runCommandId: buildCommandId,
            name: 'Android build',
            command: buildCommand,
            ports: [],
          });
        }
      } else if (
        platform === 'android' &&
        setupEffectiveAndroidProjectPath &&
        androidAppMissing &&
        buildCommand &&
        !buildRunning &&
        !buildStarting
      ) {
        setActiveConsoleCommandId(buildCommandId);
        void runCommands.startAdHocCommand({
          runCommandId: buildCommandId,
          name: 'Android build',
          command: buildCommand,
          ports: [],
        });
      }
    } catch (error) {
      if (setupCoordinator.isCurrent(setupOperation)) {
        setInputNotice(formatError(error) ?? 'Workspace setup failed');
      }
    } finally {
      setupCoordinator.complete(setupOperation);
    }
  }, [
    buildCommand,
    buildCommandId,
    buildRunning,
    buildStarting,
    androidAppMissing,
    androidProjectExists,
    androidTrustConfigured,
    autoStartProxy,
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
    androidProjectPath,
    inferredAndroidProjectPath,
    iosBuildLaunchCoordinator,
    needsAppSelection,
    networkCertificateInstalled,
    networkProxy,
    networkProxyParams,
    networkSession,
    networkStatus,
    platform,
    prebuildCommand,
    prebuildCommandId,
    projectId,
    proxyStatus,
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
        shouldPrebuildAndroid: needsExpoAndroidPrebuild,
        shouldPrebuildIos: needsExpoIosPrebuild,
      });
    });
  }, [
    dependenciesInstallStatusValue,
    handleStartWorkspace,
    iosSetupDecision.shouldAutoBuild,
    needsExpoAndroidPrebuild,
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
        shouldPrebuildAndroid: needsExpoAndroidPrebuild,
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

  function getSetupStepAction(stepKey: (typeof setupSteps)[number]['key']) {
    if (stepKey === 'dependencies-install') {
      return {
        label:
          dependenciesInstallStatusValue === 'running' ? 'Stop' : 'Run',
        onClick: () => {
          if (dependenciesInstallStatusValue === 'running') {
            setResumeSetupAfterDependenciesInstall(false);
            void runCommands.stopCommand(dependenciesInstallCommandId);
            return;
          }
          setResumeSetupAfterDependenciesInstall(false);
          void runCommands.startAdHocCommand({
            runCommandId: dependenciesInstallCommandId,
            name: 'Mobile dependencies install',
            command: dependenciesInstallCommand,
            ports: [],
          });
        },
        disabled: runCommands.isCommandStarting(dependenciesInstallCommandId),
        loading: runCommands.isCommandStarting(dependenciesInstallCommandId),
        variant: dependenciesInstallStatusValue === 'running' ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'prebuild') {
      return {
        label: prebuildStatus?.status === 'running' ? 'Stop' : 'Run',
        onClick: handleStartStopPrebuild,
        disabled: prebuildStarting,
        loading: prebuildStarting,
        variant: prebuildStatus?.status === 'running' ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'install') {
      if (platform === 'ios' && iosAppStatusError) {
        return {
          label: 'Retry',
          onClick: () => setIosAppStatusRefreshNonce((current) => current + 1),
          disabled: isIosAppStatusLoading,
          loading: isIosAppStatusLoading,
          variant: 'primary',
        } as const;
      }
      return {
        label: buildRunning
          ? 'Stop'
          : selectedAppInstalled || normalizedBuildStatus === 'completed'
            ? 'Rebuild'
            : 'Build',
        onClick: handleStartStopBuild,
          disabled:
            !buildCommand ||
            needsAppSelection ||
            (platform === 'ios' && !deviceId) ||
            normalizedBuildStatus === 'loading' ||
            buildStarting ||
            buildStopping,
        loading: buildStarting || buildStopping,
        variant: buildRunning ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'metro') {
      return {
        label: devServerRunning ? 'Stop' : 'Start',
        onClick: handleStartStopDevServer,
        disabled: needsAppSelection || devServerStarting || devServerStopping,
        loading: devServerStarting || devServerStopping,
        variant: devServerRunning ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'preview') {
      return {
        label: hasActiveSession ? 'Stop' : 'Start',
        onClick: handleStartStop,
        disabled:
          isStopping ||
          (!hasActiveSession &&
            (!deviceId || !deviceReady || isStarting || needsAppSelection)),
        loading: isStarting || isStopping,
        variant: hasActiveSession ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'logs') {
      return {
        label: nativeLogSession && nativeLogStatus === 'running' ? 'Stop' : 'Start',
        onClick: handleStartStopNativeLogs,
        disabled: !deviceId || nativeLogs.isStarting || nativeLogs.isStopping,
        loading: nativeLogs.isStarting || nativeLogs.isStopping,
        variant:
          nativeLogSession && nativeLogStatus === 'running' ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'proxy') {
      return {
        label: networkSession && networkStatus === 'running' ? 'Stop' : 'Start',
        onClick: handleStartStopNetworkProxy,
        disabled:
          !networkProxyStartParams ||
          networkProxy.isStarting ||
          networkProxy.isStopping ||
          networkProxy.isInstallingCertificate,
        loading: networkProxy.isStarting || networkProxy.isStopping,
        variant:
          networkSession && networkStatus === 'running' ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'https') {
      return {
        label:
          platform === 'android' && !androidTrustConfigured ? 'Trust app' : 'Install cert',
        onClick:
          platform === 'android' && !androidTrustConfigured
            ? handlePrepareAndroidAppTrust
            : handleInstallNetworkCertificate,
        disabled:
          !deviceId ||
          !networkProxyStartParams ||
          networkProxy.isInstallingCertificate ||
          networkProxy.isPreparingAndroidAppTrust ||
          networkProxy.isStarting ||
          networkProxy.isStopping,
        loading:
          networkProxy.isInstallingCertificate ||
          networkProxy.isPreparingAndroidAppTrust,
        variant: 'secondary',
      } as const;
    }
    return null;
  }

  const renderSetupBody = () => (
    <div className="bg-bg-1 min-h-0 flex-1 overflow-y-auto pb-4">
      <div className="border-line-soft border-b p-3.5">
        <div className="flex items-center gap-3">
          <div className="relative flex size-12 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-zinc-950">
            <svg className="absolute inset-0 size-12 -rotate-90" viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r="20" fill="none" stroke="var(--color-bg-3)" strokeWidth="4" />
              <circle
                cx="24"
                cy="24"
                r="20"
                fill="none"
                stroke={blockedSetupStep ? 'var(--color-status-fail)' : 'var(--color-acc)'}
                strokeDasharray={Math.PI * 40}
                strokeDashoffset={Math.PI * 40 * (1 - readySetupSteps / setupSteps.length)}
                strokeLinecap="round"
                strokeWidth="4"
              />
            </svg>
            {blockedSetupStep ? (
              <AlertTriangle className="text-status-fail size-4" />
            ) : allSetupReady ? (
              <Check className="text-status-done size-4" />
            ) : (
              <span className="text-ink-0 font-mono text-sm font-semibold">
                {readySetupSteps}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-ink-0 text-sm font-semibold">{setupHeadline}</div>
            <div className="text-ink-3 mt-0.5 text-[11px] leading-relaxed">
              {setupDetail}
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button
            className="min-w-0 flex-1 justify-center"
            variant={allSetupReady ? 'secondary' : 'primary'}
            icon={anySetupRunning ? <Loader2 className="animate-spin" /> : <Play />}
            disabled={ctaDisabled}
            loading={anySetupRunning}
            onClick={() => {
              if (platform === 'ios' && iosAppStatusError) {
                setIosAppStatusRefreshNonce((current) => current + 1);
                return;
              }
              void handleStartWorkspace({
                shouldAutoBuildIos: iosSetupDecision.shouldAutoBuild,
                shouldPrebuildAndroid: needsExpoAndroidPrebuild,
                shouldPrebuildIos: needsExpoIosPrebuild,
              });
            }}
          >
            {ctaLabel}
          </Button>
          <Button
            className="shrink-0 justify-center"
            variant="secondary"
            disabled={!canStopSetup || anySetupStopping}
            loading={anySetupStopping}
            onClick={() => void handleStopAll()}
          >
            Stop all
          </Button>
        </div>
        <div className="text-ink-4 mt-2 flex items-center justify-between text-[10px]">
          <span>{readySetupSteps} of {setupSteps.length} ready</span>
        </div>
      </div>

      {detectedApps.length > 1 ? (
        <div className="border-line-soft border-b p-3">
          <div className="text-ink-4 mb-1 text-[9px] font-semibold tracking-wide uppercase">
            Project app
          </div>
          <Select
            value={selectedDetectedApp ? appPath : (validSelectedAppPath ?? '')}
            options={[{ value: '', label: 'Choose app' }, ...appOptions]}
            onChange={(value) => onSelectAppPath?.(value || null)}
            disabled={
              hasActiveSession || !onSelectAppPath || isSelectingAppPath
            }
            size="sm"
            className="w-full justify-between"
          />
          <div className="text-ink-4 mt-1.5 truncate font-mono text-[10px]">
            {selectedDetectedApp
              ? appPath
              : (validSelectedAppPath ?? 'Select app to continue setup')}
          </div>
          {appSelectionError ? (
            <div
              className="text-status-fail mt-1.5 text-[10px]"
              role="alert"
            >
              {appSelectionError}
            </div>
          ) : isSelectingAppPath ? (
            <div className="text-ink-4 mt-1.5 text-[10px]" role="status">
              Updating project app...
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="text-ink-4 px-3 pt-3 pb-1 text-[9px] font-semibold tracking-wide uppercase">
        Workspace
      </div>
      <div className="border-line mx-3 overflow-hidden rounded-md border bg-zinc-950/45">
        {setupSteps.map((step) => {
          const action = getSetupStepAction(step.key);
          return (
          <div
            key={step.key}
            onClick={() => step.tab && setActiveTab(step.tab)}
            className={clsx(
              'border-line-soft flex w-full items-center gap-2.5 border-b px-3 py-2 text-left last:border-b-0',
              step.tab ? 'cursor-pointer hover:bg-bg-2' : 'cursor-default',
            )}
          >
            <span
              className={clsx(
                'flex size-5 shrink-0 items-center justify-center rounded-full border',
                step.status === 'ready' && 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
                step.status === 'running' && 'border-acc/30 bg-acc-soft text-acc-ink',
                (step.status === 'blocked' || step.status === 'error') &&
                  'border-status-fail/30 bg-status-fail/10 text-status-fail',
                step.status === 'idle' && 'border-zinc-800 text-ink-4',
              )}
            >
              {step.status === 'ready' ? (
                <Check className="size-3" />
              ) : step.status === 'running' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : step.status === 'blocked' || step.status === 'error' ? (
                <AlertTriangle className="size-3" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-ink-1 block text-[12px] font-medium">
                {step.label}
              </span>
              <span
                className={clsx(
                  'block whitespace-normal break-all font-mono text-[10px] leading-4',
                  step.status === 'blocked' || step.status === 'error'
                    ? 'text-status-fail'
                    : 'text-ink-4',
                )}
              >
                {step.detail}
              </span>
            </span>
            {action ? (
              <Button
                size="xs"
                variant={action.variant}
                disabled={action.disabled}
                loading={action.loading}
                onClick={(event) => {
                  event.stopPropagation();
                  action.onClick();
                }}
                className="min-w-[64px] shrink-0 justify-center"
              >
                {action.label}
              </Button>
            ) : null}
          </div>
          );
        })}
      </div>

      {platform === 'ios' ? (
        <div className="border-line bg-bg-0 mx-3 mt-3 flex items-center justify-between gap-3 rounded-md border p-3">
          <div>
            <div className="text-ink-1 text-xs font-semibold">iOS app</div>
            <div className="text-ink-4 mt-0.5 font-mono text-[10px]">
              {iosAppStatus?.bundleId ?? 'Bundle id unresolved'}
            </div>
          </div>
          <Button
            size="xs"
            variant="secondary"
            disabled={!iosSetupDecision.appReady || isRestartingIosApp}
            loading={isRestartingIosApp}
            onClick={handleRestartIosApp}
          >
            Restart app
          </Button>
        </div>
      ) : null}

      {platform === 'android' && androidCertGuidanceVisible ? (
        <div className="border-line bg-bg-0 mx-3 mt-3 rounded-md border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-ink-1 text-xs font-semibold">
                Finish certificate install on Android
              </div>
              <div className="text-ink-4 mt-0.5 text-[10px]">
                Complete these steps on emulator/device.
              </div>
            </div>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setAndroidCertGuidanceVisible(false)}
            >
              Hide
            </Button>
          </div>
          <div className="mt-3">
            <Button
              size="xs"
              variant="secondary"
              disabled={!deviceId || !effectiveAndroidProjectPath || isRestartingAndroidApp}
              loading={isRestartingAndroidApp}
              onClick={handleRestartAndroidApp}
            >
              Restart app
            </Button>
          </div>
          <div className="text-ink-3 mt-3 space-y-2 text-[11px] leading-relaxed">
            <div className="flex gap-2">
              <span className="text-ink-4 font-mono">1.</span>
              <span>
                If Android did not open settings, go to <span className="text-ink-1">Settings</span> → <span className="text-ink-1">Security & privacy</span> → <span className="text-ink-1">More security settings</span>.
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-ink-4 font-mono">2.</span>
              <span>
                Open <span className="text-ink-1">Encryption & credentials</span> → <span className="text-ink-1">Install a certificate</span> → <span className="text-ink-1">CA certificate</span>.
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-ink-4 font-mono">3.</span>
              <span>
                Choose <span className="text-ink-1">Jean-Claude CA</span>, accept warning, then relaunch app.
              </span>
            </div>
            <div className="border-line-soft text-ink-4 border-t pt-2 text-[10px]">
              Android app HTTPS also needs <span className="text-ink-2">Trust app</span> + rebuild once so debug builds trust user CAs.
            </div>
          </div>
        </div>
      ) : null}
    </div>
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
        if (devToolsViewRef.current) updateEmbeddedDevToolsBounds();
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
    visibleActiveTab === 'setup'
      ? renderSetupBody()
      : visibleActiveTab === 'dev-server'
        ? renderDevServerBody()
        : visibleActiveTab === 'network'
          ? renderNetworkBody()
          : visibleActiveTab === 'devtools'
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
        detail="Select a booted or shutdown simulator device"
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
      {inputNotice ? (
        <div className="border-status-fail/30 bg-status-fail/10 text-status-fail flex items-start gap-2 border-b px-3 py-2 font-mono text-[11px]">
          <span className="min-w-0 flex-1">{inputNotice}</span>
          <button
            type="button"
            className="text-status-fail/70 hover:text-status-fail shrink-0"
            aria-label="Dismiss notice"
            onClick={() => setInputNotice(null)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {autoPreviewStartError ? (
        <div
          className="border-status-fail/30 bg-status-fail/10 text-status-fail flex items-center gap-2 border-b px-3 py-1.5 font-mono text-[10.5px]"
          role="alert"
        >
          <span className="min-w-0 flex-1">{autoPreviewStartError}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={retryAutoPreviewStart}
          >
            Retry preview
          </Button>
        </div>
      ) : null}
      {runtimeLaunchState.status !== 'idle' &&
      runtimeLaunchState.status !== 'ready' ? (
        <div
          className={clsx(
            'border-b px-3 py-1.5 font-mono text-[10.5px]',
            runtimeLaunchState.status === 'error'
              ? 'border-status-fail/30 bg-status-fail/10 text-status-fail'
              : runtimeLaunchState.status === 'unsupported'
                ? 'border-status-warn/30 bg-status-warn/10 text-status-warn'
                : 'border-line-soft bg-bg-1 text-ink-3',
          )}
          role={runtimeLaunchState.status === 'error' ? 'alert' : 'status'}
        >
          <div className="flex items-center gap-2">
            {runtimeLaunchState.status === 'launching' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : null}
            <span className="min-w-0 flex-1">{runtimeLaunchState.message}</span>
            {runtimeLaunchState.status === 'error' ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setRuntimeLaunchRetry((value) => value + 1)}
              >
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {actionTray}
      {networkFilterContextMenu ? (
        <NetworkFilterContextMenu
          state={networkFilterContextMenu}
          onAddFilter={(token) =>
            setNetworkFilter((currentTokens) =>
              appendNetworkFilterToken(currentTokens, token),
            )
          }
          onClose={() => setNetworkFilterContextMenu(null)}
        />
      ) : null}

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
              <div className={clsx('mb-1.5', standaloneLayout.deviceGroup)}>
                <div className="text-ink-4 px-2 py-1 text-[9px] font-semibold tracking-wide uppercase">
                  Saved devices
                </div>
                {orderedDevices.map((device) => {
                  const selected =
                    device.id === deviceId && device.platform === platform;
                  const deviceKey = getPreviewDeviceKey(
                    device.platform,
                    device.id,
                  );
                  const previewActive =
                    activeSessionDeviceKeys.has(deviceKey) ||
                    (selectedPreviewDeviceKey === deviceKey &&
                      (isStarting || activeSessionDeviceReady));
                  return (
                    <button
                      key={device.id}
                      type="button"
                      onClick={() => handleSelectDevice(device)}
                      className={clsx(
                        'grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors',
                        standaloneLayout.deviceButton,
                        selected
                          ? 'bg-acc-soft shadow-[inset_2px_0_0_var(--color-acc)]'
                          : 'hover:bg-bg-2',
                      )}
                    >
                      <span
                        className={clsx(
                          'h-[7px] w-[7px] rounded-full',
                          device.state === 'booted'
                            ? 'bg-emerald-300 shadow-[0_0_7px_var(--color-status-done)]'
                            : 'bg-ink-4',
                        )}
                      />
                      <span className="min-w-0">
                        <span className="text-ink-1 block truncate text-[12px] font-medium">
                          {device.name}
                        </span>
                        <span className="text-ink-4 block truncate font-mono text-[10px]">
                          {device.osVersion ?? formatDeviceState(device.state)}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        {previewActive ? (
                          <span
                            aria-label="Preview active"
                            className="bg-status-done size-1.5 animate-pulse rounded-full shadow-[0_0_7px_var(--color-status-done)]"
                            title="Preview active"
                          />
                        ) : null}
                        <PlatformLogo platform={device.platform} />
                      </span>
                    </button>
                  );
                })}
              </div>
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
            <Button variant="ghost" size="sm" disabled={!isRunning}>
              Reload
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy />}
              disabled={!hasImageFrame}
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
                  [
                    'network',
                    <NetworkTabLabel
                      store={networkProxy.requestsStore}
                      showTunneled={showTunneledNetworkRequests}
                    />,
                  ],
                ] as const
              )
                .filter(([tab]) =>
                  isMobilePreviewPaneTabVisible({
                    tab,
                    networkEnabled: autoStartProxy,
                  }),
                )
                .map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={clsx(
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                    visibleActiveTab === tab
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
            ) : (
              <IconButton size="sm" icon={<X />} tooltip="Clear" />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{inspectorBody}</div>
        </aside>
      </div>
      {isManageDevicesOpen ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
          onMouseDown={() => setIsManageDevicesOpen(false)}
        >
          <div
            className="border-line bg-bg-1 flex h-[620px] max-h-[88vh] w-[880px] max-w-[94vw] flex-col overflow-hidden rounded-[14px] border shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_40px_90px_-24px_rgba(0,0,0,0.72)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="border-line-soft flex h-[58px] shrink-0 items-center gap-3 border-b px-[18px]">
              <span className="bg-acc-soft text-acc-ink flex size-[30px] items-center justify-center rounded-lg">
                <Settings className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-ink-0 text-[15px] font-semibold">
                    {isCreatingManagedDevice ? 'New device' : 'Manage devices'}
                  </span>
                  {!isCreatingManagedDevice ? (
                    <span className="text-ink-4 font-mono text-[11px]">
                      {allDevices.length} devices
                    </span>
                  ) : null}
                </div>
                <div className="text-ink-3 mt-0.5 text-xs">
                  {isCreatingManagedDevice
                    ? 'Choose the display first, then configure runtime and storage'
                    : 'Checked devices show in the device switcher'}
                </div>
              </div>
              {!isCreatingManagedDevice ? (
                <div className="text-ink-3 flex items-center gap-1.5 text-[11.5px]">
                  <span className="bg-acc text-bg-0 flex size-3.5 items-center justify-center rounded-[3px]">
                    <Check className="size-2.5" strokeWidth={3} />
                  </span>
                  {visibleDevices.length} in switcher
                </div>
              ) : null}
              <IconButton
                onClick={() => {
                  if (isCreatingManagedDevice) {
                    setIsCreateAndroidDeviceOpen(false);
                    setIsCreateIosDeviceOpen(false);
                  } else {
                    setIsManageDevicesOpen(false);
                  }
                }}
                size="sm"
                icon={<X />}
                tooltip={isCreatingManagedDevice ? 'Cancel' : 'Close'}
              />
            </div>
            {isCreatingManagedDevice ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-line-soft flex shrink-0 items-center gap-3 border-b px-[18px] py-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setIsCreateAndroidDeviceOpen(false);
                      setIsCreateIosDeviceOpen(false);
                    }}
                  >
                    Back
                  </Button>
                  <div className="min-w-0 flex-1" />
                  <div className="border-line bg-bg-0 flex rounded-md border p-0.5">
                    {(['android', 'ios'] as const).map((createPlatform) => (
                      <button
                        key={createPlatform}
                        type="button"
                        onClick={() => {
                          setManageCreatePlatform(createPlatform);
                          setIsCreateAndroidDeviceOpen(createPlatform === 'android');
                          setIsCreateIosDeviceOpen(createPlatform === 'ios');
                        }}
                        className={clsx(
                          'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                          manageCreatePlatform === createPlatform
                            ? 'bg-bg-3 text-ink-1'
                            : 'text-ink-3 hover:text-ink-1',
                        )}
                      >
                        {createPlatform === 'android' ? 'Android' : 'iOS'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 max-[760px]:flex-col">
                  <div className="min-w-0 flex-1 overflow-y-auto p-[22px]">
                    <div className="text-ink-0 text-[13px] font-semibold">
                      {manageCreatePlatform === 'android'
                        ? 'Device profile'
                        : 'Device type'}
                      <span className="text-ink-3 ml-2 text-[11.5px] font-normal">
                        {manageCreatePlatform === 'android'
                          ? `${androidManagement.profiles.data?.length ?? 0} options`
                          : `${iosDeviceTypes.length} options`}
                      </span>
                    </div>
                    <p className="text-ink-3 mt-1 mb-4 max-w-[440px] text-xs leading-relaxed">
                      The profile sets screen size, resolution and density. Pick the display where the app will actually run.
                    </p>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
                      {manageCreatePlatform === 'android'
                        ? (androidManagement.profiles.data ?? []).map((profile) => {
                            const selected = profile.id === androidDeviceProfileId;
                            const screen = profile.screen;
                            const aspect = screen
                              ? Math.min(screen.width, screen.height) /
                                Math.max(screen.width, screen.height)
                              : 0.46;
                            const isTablet = aspect > 0.62;
                            return (
                              <button
                                key={profile.id}
                                type="button"
                                onClick={() => setAndroidDeviceProfileId(profile.id)}
                                className={clsx(
                                  'relative flex min-h-[148px] flex-col items-center gap-2.5 rounded-[10px] border px-2.5 pt-3.5 pb-3 text-center transition-colors',
                                  selected
                                    ? 'border-acc-line bg-acc-soft'
                                    : 'border-line-soft bg-bg-0 hover:bg-bg-2',
                                )}
                              >
                                <span
                                  className={clsx(
                                    'absolute top-2 right-2 flex size-4 items-center justify-center rounded-full border',
                                    selected
                                      ? 'border-acc bg-acc text-bg-0'
                                      : 'border-line opacity-30',
                                  )}
                                >
                                  {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
                                </span>
                                <span
                                  className={clsx(
                                    'mt-2 flex items-center justify-center rounded-md border p-[4px]',
                                    selected ? 'border-acc-line shadow-[0_0_0_3px_var(--color-acc-soft)]' : 'border-line',
                                  )}
                                  style={{
                                    width: Math.max(26, Math.round(60 * aspect)),
                                    height: 60,
                                    borderRadius: isTablet ? 5 : 7,
                                  }}
                                >
                                  <span
                                    className={clsx(
                                      'block h-full w-full rounded-[3px]',
                                      selected ? 'bg-acc-soft' : 'bg-bg-3',
                                    )}
                                  />
                                </span>
                                <span className="text-ink-1 mt-1 line-clamp-2 text-xs font-semibold">
                                  {profile.name}
                                </span>
                                <span className="text-ink-4 font-mono text-[9.5px]">
                                  {formatAndroidScreenSpec(screen)}
                                </span>
                                <span className="text-ink-3 text-[9px] font-semibold tracking-wide uppercase">
                                  {isTablet ? 'Tablet' : 'Phone'}
                                </span>
                              </button>
                            );
                          })
                        : iosDeviceTypes.map((deviceType) => {
                            const selected = deviceType.id === iosDeviceTypeId;
                            const chrome = getIosDeviceChrome(deviceType);
                            return (
                              <button
                                key={deviceType.id}
                                type="button"
                                onClick={() => setIosDeviceTypeId(deviceType.id)}
                                className={clsx(
                                  'relative flex min-h-[148px] flex-col items-center gap-2.5 rounded-[10px] border px-2.5 pt-3.5 pb-3 text-center transition-colors',
                                  selected
                                    ? 'border-acc-line bg-acc-soft'
                                    : 'border-line-soft bg-bg-0 hover:bg-bg-2',
                                )}
                              >
                                <span
                                  className={clsx(
                                    'absolute top-2 right-2 flex size-4 items-center justify-center rounded-full border',
                                    selected
                                      ? 'border-acc bg-acc text-bg-0'
                                      : 'border-line opacity-30',
                                  )}
                                >
                                  {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
                                </span>
                                <span
                                  className={clsx(
                                    'mt-2 flex items-center justify-center rounded-md border p-[4px]',
                                    selected ? 'border-acc-line shadow-[0_0_0_3px_var(--color-acc-soft)]' : 'border-line',
                                  )}
                                  style={{
                                    width: Math.round(chrome.height * chrome.aspect),
                                    height: chrome.height,
                                    borderRadius: chrome.hasHomeButton ? 6 : 8,
                                  }}
                                >
                                  <span
                                    className={clsx(
                                      'relative block h-full w-full overflow-hidden rounded-[4px]',
                                      selected ? 'bg-acc-soft' : 'bg-bg-3',
                                    )}
                                  >
                                    {chrome.hasDynamicIsland ? (
                                      <span className="bg-bg-0/80 absolute top-[5px] left-1/2 h-[4px] w-[34%] -translate-x-1/2 rounded-full" />
                                    ) : null}
                                    {chrome.hasClassicNotch ? (
                                      <span className="bg-bg-0/80 absolute top-0 left-1/2 h-[7px] w-[42%] -translate-x-1/2 rounded-b-md" />
                                    ) : null}
                                    {chrome.hasHomeButton ? (
                                      <span className="border-line absolute bottom-[4px] left-1/2 size-[6px] -translate-x-1/2 rounded-full border" />
                                    ) : null}
                                    <span className="bg-line/70 absolute top-[14px] left-[-2px] h-[10px] w-[2px] rounded-l" />
                                    <span className="bg-line/70 absolute top-[18px] right-[-2px] h-[14px] w-[2px] rounded-r" />
                                  </span>
                                </span>
                                <span className="text-ink-1 mt-1 line-clamp-2 text-xs font-semibold">
                                  {deviceType.name}
                                </span>
                                <span className="text-ink-4 font-mono text-[9.5px]">
                                  {deviceType.screen
                                    ? `${deviceType.screen.width} x ${deviceType.screen.height}`
                                    : (deviceType.productFamily ?? 'iPhone')}
                                </span>
                                <span className="text-ink-3 text-[9px] font-semibold tracking-wide uppercase">
                                  Phone
                                </span>
                              </button>
                            );
                          })}
                    </div>
                  </div>
                  <div className="border-line-soft bg-bg-0 flex w-[340px] shrink-0 flex-col border-l max-[760px]:min-h-[320px] max-[760px]:w-full max-[760px]:border-t max-[760px]:border-l-0">
                    <div className="min-h-0 flex-1 overflow-y-auto p-5">
                      <div className="text-ink-4 mb-3 text-[10px] font-semibold tracking-wide uppercase">
                        Configuration
                      </div>
                      <label className="text-ink-3 mb-1.5 block text-[11px] font-medium">
                        Name <span className="text-ink-4 font-normal">optional</span>
                      </label>
                      <Input
                        value={manageCreatePlatform === 'android' ? androidDeviceName : iosDeviceName}
                        onChange={(event) => {
                          if (manageCreatePlatform === 'android') {
                            setAndroidDeviceName(event.target.value);
                          } else {
                            setIosDeviceName(event.target.value);
                          }
                        }}
                        placeholder={manageCreatePlatform === 'android' ? 'Pixel_8_API_35' : 'iPhone 16 Pro iOS 18.5'}
                        className="h-9 font-mono text-xs"
                      />
                      <div className="mt-4">
                        <label className="text-ink-3 mb-1.5 block text-[11px] font-medium">
                          {manageCreatePlatform === 'android' ? 'System image' : 'Runtime'}
                        </label>
                        {manageCreatePlatform === 'android' ? (
                          <Select
                            value={androidSystemImageId}
                            options={
                              androidSystemImageOptions.length > 0
                                ? androidSystemImageOptions
                                : [{ value: '', label: 'No system images' }]
                            }
                            onChange={setAndroidSystemImageId}
                            disabled={androidSystemImageOptions.length === 0}
                            size="sm"
                            className="w-full justify-between"
                          />
                        ) : (
                          <Select
                            value={iosRuntimeId}
                            options={
                              iosRuntimeOptions.length > 0
                                ? iosRuntimeOptions
                                : [{ value: '', label: 'No iOS runtimes' }]
                            }
                            onChange={setIosRuntimeId}
                            disabled={iosRuntimeOptions.length === 0}
                            size="sm"
                            className="w-full justify-between"
                          />
                        )}
                      </div>
                      {manageCreatePlatform === 'android' ? (
                        <>
                          <div className="mt-5 flex items-center gap-2">
                            <span className="text-ink-4 text-[10px] font-semibold tracking-wide uppercase">
                              Advanced
                            </span>
                            <span className="bg-line-soft h-px flex-1" />
                          </div>
                          <div className="mt-3 grid grid-cols-3 gap-2">
                            <Input value={androidRamMb} onChange={(event) => setAndroidRamMb(event.target.value)} inputMode="numeric" placeholder="RAM" className="h-9 text-xs" />
                            <Input value={androidVmHeapMb} onChange={(event) => setAndroidVmHeapMb(event.target.value)} inputMode="numeric" placeholder="Heap" className="h-9 text-xs" />
                            <Input value={androidStorageMb} onChange={(event) => setAndroidStorageMb(event.target.value)} inputMode="numeric" placeholder="Storage" className="h-9 text-xs" />
                          </div>
                          <label className="text-ink-2 mt-3 flex items-center gap-2 text-xs">
                            <input type="checkbox" checked={androidHwKeyboard} onChange={(event) => setAndroidHwKeyboard(event.currentTarget.checked)} className="accent-acc size-3.5" />
                            Hardware keyboard
                          </label>
                        </>
                      ) : null}
                      <div className="text-ink-4 mt-5 mb-2 text-[10px] font-semibold tracking-wide uppercase">
                        Summary
                      </div>
                      <div className="border-line-soft bg-bg-1 rounded-md border p-3 text-[11.5px]">
                        {(manageCreatePlatform === 'android'
                          ? [
                              ['Device', selectedAndroidProfile?.name ?? 'Unknown profile'],
                              ['Display', formatAndroidScreenSpec(selectedAndroidProfile?.screen ?? null)],
                              ['System image', selectedAndroidSystemImage ? `API ${selectedAndroidSystemImage.apiLevel} · ${formatAndroidImageTag(selectedAndroidSystemImage.tag)} · ${selectedAndroidSystemImage.abi}` : 'No image selected'],
                              ['Host arch', androidHostArch ?? 'unknown'],
                            ]
                          : [
                              ['Device', selectedIosDeviceType?.name ?? 'Unknown device type'],
                              ['Runtime', selectedIosRuntime?.name ?? 'No runtime selected'],
                            ]
                        ).map(([label, value]) => (
                          <div key={label} className="flex items-baseline gap-3 py-1">
                            <span className="text-ink-4 w-20 shrink-0">{label}</span>
                            <span className="text-ink-1 flex-1 text-right font-mono break-words">{value}</span>
                          </div>
                        ))}
                      </div>
                      {manageCreatePlatform === 'android' && androidImageCompatibilityWarning ? (
                        <div className="border-status-warn/30 bg-status-warn/10 text-status-warn mt-3 flex gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-snug">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          <span>{androidImageCompatibilityWarning}</span>
                        </div>
                      ) : null}
                      {manageCreatePlatform === 'android' && androidManagement.systemImages.data?.length === 0 ? (
                        <div className="border-line text-ink-3 mt-3 rounded-md border border-dashed p-2 text-[11px] leading-snug">
                          <div className="mb-2">No Android system images installed.</div>
                          <Button
                            size="sm"
                            loading={androidManagement.installSystemImage.isPending}
                            onClick={handleInstallSuggestedAndroidImage}
                          >
                            Install Android 35 image
                          </Button>
                          <div className="text-ink-4 mt-2">
                            Downloads are large. If licenses block install, run <code>sdkmanager --licenses</code> once.
                          </div>
                        </div>
                      ) : null}
                      {manageCreatePlatform === 'ios' && iosManagement.toolStatus.data?.missingTools.includes('xcrun') ? (
                        <div className="border-status-warn/30 bg-status-warn/10 text-status-warn mt-3 rounded-md border p-2 text-[11px] leading-snug">
                          Missing xcrun. Run <code>xcode-select --install</code>, then restart Jean-Claude.
                        </div>
                      ) : null}
                      {manageCreatePlatform === 'ios' && availableIosRuntimes.length === 0 ? (
                        <div className="border-line text-ink-3 mt-3 rounded-md border border-dashed p-2 text-[11px] leading-snug">
                          No available iOS runtimes. Install one from Xcode Settings &gt; Platforms.
                        </div>
                      ) : null}
                      {manageCreatePlatform === 'android' && androidManagementError ? (
                        <div className="text-status-fail mt-3 text-[11px] leading-snug">{cleanPreviewError(androidManagementError)}</div>
                      ) : null}
                      {manageCreatePlatform === 'ios' && iosManagementError ? (
                        <div className="text-status-fail mt-3 text-[11px] leading-snug">{cleanPreviewError(iosManagementError)}</div>
                      ) : null}
                    </div>
                    <div className="border-line-soft flex shrink-0 gap-2 border-t p-4">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setIsCreateAndroidDeviceOpen(false);
                          setIsCreateIosDeviceOpen(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <div className="flex-1" />
                      {manageCreatePlatform === 'android' ? (
                        <Button size="sm" variant="primary" loading={androidManagement.createDevice.isPending} disabled={!canCreateAndroidDevice || androidManagement.createDevice.isPending} onClick={handleCreateAndroidDevice}>
                          Create device
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" loading={iosManagement.createDevice.isPending} disabled={!canCreateIosDevice || iosManagement.createDevice.isPending} onClick={handleCreateIosDevice}>
                          Create device
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 max-[700px]:flex-col">
                <div className="border-line-soft bg-bg-0 flex w-[300px] shrink-0 flex-col border-r max-[700px]:h-[220px] max-[700px]:w-full max-[700px]:border-r-0 max-[700px]:border-b">
                  <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                    {(['android', 'ios'] as const).map((devicePlatform) => {
                      const platformDevices = managedDevicesByPlatform[devicePlatform];
                      if (platformDevices.length === 0) return null;
                      return (
                        <div key={devicePlatform} className="mb-1.5">
                          <div className="text-ink-4 px-1.5 py-2 text-[10px] font-semibold tracking-wide uppercase">
                            {devicePlatform === 'android' ? 'Android' : 'iOS'} · {platformDevices.length}
                          </div>
                          {platformDevices.map((device) => {
                            const selected = selectedManagedDevice?.id === device.id && selectedManagedDevice.platform === device.platform;
                            const visibleDeviceIds = visibleDeviceIdsByPlatform[device.platform];
                            const checked = visibleDeviceIds === null || visibleDeviceIds.includes(device.id);
                            return (
                              <button
                                key={`${device.platform}:${device.id}`}
                                type="button"
                                onClick={() => setManagedSelectedDeviceKey(`${device.platform}:${device.id}`)}
                                className={clsx(
                                  'mb-0.5 grid w-full grid-cols-[16px_8px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors',
                                  selected ? 'border-line bg-bg-3' : 'border-transparent hover:bg-bg-2',
                                )}
                              >
                                <span
                                  role="checkbox"
                                  aria-checked={checked}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setVisibleDeviceIdsByPlatform((current) => {
                                      const currentIds = current[device.platform] ?? managedDevicesByPlatform[device.platform].map((platformDevice) => platformDevice.id);
                                      return {
                                        ...current,
                                        [device.platform]: checked ? currentIds.filter((id) => id !== device.id) : [...new Set([...currentIds, device.id])],
                                      };
                                    });
                                  }}
                                  className={clsx(
                                    'flex size-4 items-center justify-center rounded-[3px] border',
                                    checked ? 'border-acc bg-acc text-bg-0' : 'border-line bg-bg-1',
                                  )}
                                >
                                  {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
                                </span>
                                <span className={clsx('size-[7px] rounded-full', device.state === 'booted' ? 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.7)]' : 'bg-ink-4')} />
                                <span className="min-w-0">
                                  <span className="text-ink-1 block truncate text-[12.5px] font-medium">{device.name}</span>
                                  <span className="text-ink-4 block truncate font-mono text-[10px]">{device.osVersion ?? formatDeviceState(device.state)}</span>
                                </span>
                                <PlatformLogo platform={device.platform} />
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                    {allDevices.length === 0 ? (
                      <div className="text-ink-4 p-3 text-xs">No devices yet.</div>
                    ) : null}
                  </div>
                  <div className="border-line-soft shrink-0 border-t p-2.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full justify-center"
                      onClick={() => {
                        const nextPlatform = platform ?? 'android';
                        setManageCreatePlatform(nextPlatform);
                        setIsCreateAndroidDeviceOpen(nextPlatform === 'android');
                        setIsCreateIosDeviceOpen(nextPlatform === 'ios');
                      }}
                    >
                      New device
                    </Button>
                  </div>
                </div>
                {selectedManagedDevice ? (
                  <div className="min-w-0 flex-1 overflow-y-auto p-6">
                    <div className="mb-5 flex items-center gap-3.5">
                      <span className="border-line bg-bg-1 flex h-[54px] w-[25px] shrink-0 items-center justify-center rounded-lg border p-[3px]">
                        <span className="bg-bg-3 h-full w-full rounded-[4px]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5">
                          <span className="text-ink-0 truncate text-[17px] font-semibold">{selectedManagedDevice.name}</span>
                          <PlatformLogo platform={selectedManagedDevice.platform} />
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <span className={clsx('size-[7px] rounded-full', selectedManagedDevice.state === 'booted' ? 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.7)]' : 'bg-ink-4')} />
                          <span className="text-ink-4 font-mono text-[11px]">{formatDeviceState(selectedManagedDevice.state)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-ink-4 mb-2.5 text-[10px] font-semibold tracking-wide uppercase">Specification</div>
                    <div className="border-line-soft bg-bg-0 mb-5 rounded-md border px-3.5 py-1.5 text-[11.5px]">
                      {[
                        ['Handle', selectedManagedDevice.id],
                        ['OS', selectedManagedDevice.osVersion ?? (selectedManagedDevice.platform === 'android' ? 'Android' : 'iOS')],
                        ['State', formatDeviceState(selectedManagedDevice.state)],
                        ['Platform', selectedManagedDevice.platform === 'android' ? 'Android' : 'iOS'],
                      ].map(([label, value]) => (
                        <div key={label} className="border-line-soft flex items-baseline gap-3 border-b py-2 last:border-b-0">
                          <span className="text-ink-3 w-[70px] shrink-0">{label}</span>
                          <span className="text-ink-1 flex-1 text-right font-mono break-all">{value}</span>
                        </div>
                      ))}
                    </div>
                    {renamingIosDeviceId === selectedManagedDevice.id ? (
                      <div className="border-line-soft bg-bg-0 mb-4 flex flex-wrap items-center gap-2 rounded-md border p-2">
                        <Input value={iosRenameValue} onChange={(event) => setIosRenameValue(event.target.value)} className="h-8 min-w-44 flex-1 text-xs" />
                        <Button size="sm" variant="primary" loading={iosManagement.renameDevice.isPending} disabled={!iosRenameValue.trim() || iosManagement.renameDevice.isPending} onClick={() => handleRenameIosDevice(selectedManagedDevice.id)}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setRenamingIosDeviceId(null); setIosRenameValue(''); }}>Cancel</Button>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setVisibleDeviceIdsByPlatform((current) => {
                            const currentIds =
                              current[selectedManagedDevice.platform] ??
                              managedDevicesByPlatform[
                                selectedManagedDevice.platform
                              ].map((platformDevice) => platformDevice.id);
                            return {
                              ...current,
                              [selectedManagedDevice.platform]: [
                                ...new Set([...currentIds, selectedManagedDevice.id]),
                              ],
                            };
                          });
                          handleSelectDevice(selectedManagedDevice);
                          setIsManageDevicesOpen(false);
                        }}
                      >
                        Select device
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const visibleDeviceIds = visibleDeviceIdsByPlatform[selectedManagedDevice.platform];
                          const checked = visibleDeviceIds === null || visibleDeviceIds.includes(selectedManagedDevice.id);
                          setVisibleDeviceIdsByPlatform((current) => {
                            const currentIds = current[selectedManagedDevice.platform] ?? managedDevicesByPlatform[selectedManagedDevice.platform].map((platformDevice) => platformDevice.id);
                            return {
                              ...current,
                              [selectedManagedDevice.platform]: checked ? currentIds.filter((id) => id !== selectedManagedDevice.id) : [...new Set([...currentIds, selectedManagedDevice.id])],
                            };
                          });
                        }}
                      >
                        Toggle switcher
                      </Button>
                      {selectedManagedDevice.platform === 'ios' ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => { setRenamingIosDeviceId(selectedManagedDevice.id); setIosRenameValue(selectedManagedDevice.name); }}>Rename</Button>
                          <Button size="sm" variant="ghost" loading={iosManagement.eraseDevice.isPending && erasingIosDeviceId === selectedManagedDevice.id} onClick={() => handleEraseIosDevice(selectedManagedDevice.id)}>Erase</Button>
                          <Button size="sm" variant="ghost" loading={iosManagement.deleteDevice.isPending && deletingIosDeviceId === selectedManagedDevice.id} onClick={() => handleDeleteIosDevice(selectedManagedDevice.id)}>Delete</Button>
                        </>
                      ) : selectedManagedDevice.state === 'shutdown' ? (
                        <Button size="sm" variant="ghost" loading={androidManagement.deleteDevice.isPending && deletingAndroidDeviceId === selectedManagedDevice.id} onClick={() => handleDeleteAndroidDevice(selectedManagedDevice.id)}>Delete</Button>
                      ) : null}
                    </div>
                    {androidManagementError || iosManagementError ? (
                      <div className="text-status-fail mt-4 text-[11px] leading-snug">
                        {cleanPreviewError(androidManagementError ?? iosManagementError ?? '')}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-ink-4 flex flex-1 items-center justify-center text-xs">Select a device</div>
                )}
              </div>
            )}
            {!isCreatingManagedDevice ? (
              <div className="border-line flex h-12 shrink-0 items-center justify-end border-t px-4">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setIsManageDevicesOpen(false)}
                >
                  Done
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
