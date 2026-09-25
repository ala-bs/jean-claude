import {
  Camera,
  Hammer,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Smartphone,
  Square,
  Star,
  X,
} from 'lucide-react';
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';

import {
  DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG,
  type MobilePreviewProjectConfig,
} from '@shared/types';
import {
  makeMobileDevDeviceKey,
  useMobileDevPaneFavorites,
  useMobileDevPaneTaskState,
} from '@/stores/mobile-dev-pane';
import { api } from '@/lib/api';
import { Button } from '@/common/ui/button';
import { cleanIpcError } from '@/lib/ipc-error';
import { Combobox } from '@/common/ui/combobox';
import { CommandLogsSection } from '../command-logs-pane/command-logs-section';
import { createMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';
import { DeeplinkButton } from './ui-deeplink-button';
import { focusOnNonInteractiveMouseDown } from '../command-logs-pane/utils-log-pane-focus';
import { IconButton } from '@/common/ui/icon-button';
import { Separator } from '@/common/ui/separator';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useMobileDevPaneWidth } from '@/stores/navigation';
import { useMobilePreviewDevices } from '@/hooks/use-mobile-preview';
import { useProjectCommandAvailability } from '@/hooks/use-project-command-availability';
import { useRunCommands } from '@/hooks/use-run-commands';
import { useToastStore } from '@/stores/toasts';

import {
  buildDeviceOptions,
  getDeviceChips,
  getFavoriteDevices,
  isFavoriteDevice,
  PLATFORM_LABELS,
} from './utils-device-options';
import {
  createStartLaunchRequestId,
  resolveStartLaunchDecision,
} from './utils-start-launch';
import { buildMobileDevVirtualTabs } from './utils-log-tabs';
import { reloadAppOnMetro } from './utils-reload-app';
import { resolveActiveDevice } from './utils-active-device';
import { resolveAndroidProjectPath } from './utils-android-project-path';
import { resolveDeviceListStatus } from './utils-device-list-status';
import { resolveMobileDevAppPath } from './utils-app-path';
import { resolveMobileDevBuildCommand } from './utils-build-command';
import { resolveMobileDevDetectedApp } from './utils-detected-app';
import { resolveRestartReattach } from './utils-restart-reattach';
import { restartAppOnDevice } from './utils-restart-app';
import { summarizeDeviceActionError } from './utils-action-error';
import { verifyDeeplinkOnDevice } from './utils-verify-deeplink';
import { TASK_PANEL_HEADER_HEIGHT_CLS } from '../constants';

function StatusDot({
  tone,
  pulse,
}: {
  tone: 'running' | 'stopped' | 'errored';
  pulse?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={clsx(
        'size-2 shrink-0 rounded-full',
        tone === 'running' && 'bg-green-500',
        tone === 'errored' && 'bg-red-500',
        tone === 'stopped' && 'bg-ink-3/50',
        pulse && 'animate-pulse',
      )}
    />
  );
}

/**
 * Lightweight mobile dev pane: pick a device, boot it, run Metro, watch logs.
 *
 * Deliberately does NOT stream a framebuffer, forward input, or embed React
 * Native DevTools — that is the full mobile preview workspace. Here the user
 * works against the real simulator/emulator window, so this pane only has to
 * get the dev server and the device up.
 */
export function MobileDevPane({
  taskId,
  projectId,
  projectPath,
  mobilePreviewConfig,
  onClose,
}: {
  taskId: string;
  projectId: string;
  projectPath: string;
  mobilePreviewConfig: MobilePreviewProjectConfig | null | undefined;
  onClose: () => void;
}) {
  const { width, setWidth, minWidth, maxWidth } = useMobileDevPaneWidth();
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: width,
    minWidth,
    maxWidth,
    maxWidthFraction: 0.6,
    direction: 'left',
    onWidthChange: setWidth,
  });

  const { selectedDevice, selectedLogTab, selectDevice, setSelectedLogTab } =
    useMobileDevPaneTaskState(taskId);
  const { favoriteDevices, toggleFavoriteDevice } = useMobileDevPaneFavorites();

  const [bootingDeviceKey, setBootingDeviceKey] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [isVerifyingDeeplink, setIsVerifyingDeeplink] = useState(false);
  const [restartingDeviceKey, setRestartingDeviceKey] = useState<string | null>(
    null,
  );
  // Set when the user presses Start; consumed by the effect that deeplinks the
  // app once Metro reports a live port. See `resolveStartLaunchDecision`.
  // A ref, not state: the effect both reads and clears it, and clearing state
  // inside an effect body is exactly the cascading-render pattern the React
  // compiler rejects. The effect already re-runs on the value it waits for
  // (`hasLiveDevServerPort`), so no render is needed to re-check it.
  const startLaunchDeviceKeyRef = useRef<string | null>(null);
  const startOperationActiveRef = useRef(false);
  // The device whose app Start is currently deeplinking. Reload and Restart
  // gate on this for the same reason they gate on each other: killing or
  // re-pointing an app while another deeplink is in flight is the documented
  // SIGSEGV in `restartAppOnDevice`.
  const [startLaunchingDeviceKey, setStartLaunchingDeviceKey] = useState<
    string | null
  >(null);
  // Only success/progress copy lives inline; failures go to a toast because
  // device errors (devicectl dumps) are far too long for this narrow pane.
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const addToast = useToastStore((state) => state.addToast);
  const activeDeviceKeyRef = useRef('');
  const paneRef = useRef<HTMLDivElement>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  // The last build this pane put on screen. Build command ids are
  // device-scoped, so without this, switching device (or stopping Metro, which
  // clears the selection) would drop a running build's tab while its output
  // kept accumulating out of reach.
  //
  // Tagged with its task (logs are task-keyed) and compared during render
  // rather than reset in an effect, which would cascade renders -- the same
  // shape as `useRunCommands`'s own `statusTaskId` guard.
  const [stickyBuild, setStickyBuild] = useState<{
    taskId: string;
    commandId: string;
  } | null>(null);

  const appPath = useMemo(
    () => resolveMobileDevAppPath(mobilePreviewConfig),
    [mobilePreviewConfig],
  );
  // Metro must run from the app directory in a monorepo, not the repo root.
  const workingDir =
    appPath && appPath !== '.' ? `${projectPath}/${appPath}` : projectPath;

  const androidProjectPath = useMemo(
    () => resolveAndroidProjectPath({ config: mobilePreviewConfig, appPath }),
    [mobilePreviewConfig, appPath],
  );

  const devServerCommandId = useMemo(
    () => createMobileDevServerCommandId(appPath),
    [appPath],
  );
  const devServerCommand =
    mobilePreviewConfig?.metroStartCommand ??
    DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG.metroStartCommand ??
    'npx expo start --dev-client';
  const configuredDevServerPort =
    mobilePreviewConfig?.metroPort ??
    DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG.metroPort ??
    8081;

  const runCommands = useRunCommands({ taskId, projectId, workingDir });
  const commandAvailability = useProjectCommandAvailability(projectId);
  const devServerStatus = runCommands.statusByCommandId[devServerCommandId];
  const devServerStarting = runCommands.isCommandStarting(devServerCommandId);
  const devServerStopping = runCommands.isCommandStopping(devServerCommandId);
  const devServerRunning = devServerStatus?.status === 'running';
  // Once running, the runner may have picked a different free port than the
  // configured one, so the status is the source of truth. Both guards matter:
  // `CommandStatus` is 'running' | 'stopped' | 'errored' and a crashed process
  // keeps its `ports`, while `devServerStarting` means the status still
  // describes the *previous* run. Either would hand out a dead port.
  const hasLiveDevServerPort = devServerRunning && !devServerStarting;
  const effectiveDevServerPort = hasLiveDevServerPort
    ? (devServerStatus?.ports?.[0] ?? configuredDevServerPort)
    : configuredDevServerPort;

  // Deeplinking into the app is how it gets pointed at a Metro port; a plain
  // native relaunch reuses whatever URL the dev client last remembered.
  const { isExpoApp, appScheme } = useMemo(
    () =>
      resolveMobileDevDetectedApp({ config: mobilePreviewConfig, appPath }),
    [appPath, mobilePreviewConfig],
  );

  // One list, both platforms. Queried separately because the backend lists per
  // platform, and because a missing Android SDK must not hide iOS simulators.
  const iosQuery = useMobilePreviewDevices('ios');
  const androidQuery = useMobilePreviewDevices('android');
  const devices = useMemo(
    () => [...(iosQuery.data ?? []), ...(androidQuery.data ?? [])],
    [iosQuery.data, androidQuery.data],
  );
  // React Query hands back a new result object every render, so depend on the
  // stable `refetch` rather than the query itself.
  const refetchIos = iosQuery.refetch;
  const refetchAndroid = androidQuery.refetch;
  const refetchDevices = useCallback(async () => {
    await Promise.all([refetchIos(), refetchAndroid()]);
  }, [refetchIos, refetchAndroid]);

  // A platform whose tooling is not installed errors permanently; see
  // resolveDeviceListStatus for the rule that keeps the other platform usable.
  const {
    isLoading: isLoadingDevices,
    isFetching: isFetchingDevices,
    failedPlatforms,
    errors: deviceListErrors,
  } = useMemo(
    () =>
      resolveDeviceListStatus({
        deviceCount: devices.length,
        ios: iosQuery,
        android: androidQuery,
      }),
    [devices.length, iosQuery, androidQuery],
  );
  const deviceListError = deviceListErrors.length
    ? deviceListErrors.map((error) => cleanIpcError(error)).join(' · ')
    : null;

  const { activeDeviceKey, activeDevice, persistedDeviceName } = useMemo(
    () => resolveActiveDevice({ devices, selection: selectedDevice }),
    [devices, selectedDevice],
  );
  const isActiveDeviceBooted = activeDevice?.state === 'booted';
  const isDeviceUnavailable = Boolean(activeDevice?.unavailableReason);
  const isScreenshotSupported =
    activeDevice?.platform === 'android' ||
    (activeDevice?.kind !== 'physical' && activeDevice?.platform === 'ios');
  const canCaptureScreenshot =
    Boolean(activeDevice) &&
    isScreenshotSupported &&
    !isDeviceUnavailable &&
    (isActiveDeviceBooted || activeDevice?.connection === 'connected');
  // `isBooting` guards re-entrancy; the per-device flags drive the UI, so
  // switching device mid-boot does not show a spinner on the new selection.
  const isBooting = bootingDeviceKey !== null;
  const isActiveDeviceBooting =
    bootingDeviceKey !== null && bootingDeviceKey === activeDeviceKey;
  useEffect(() => {
    activeDeviceKeyRef.current = activeDeviceKey;
  }, [activeDeviceKey]);

  // "Did the user move to a *different* device while this slow action ran?"
  // Slow-action results are discarded when they did, so the outcome is never
  // reported against the wrong device. An empty selection (Metro stopped, which
  // clears it) is not a different device, so results still surface.
  const isDeviceSelectionSwitched = useCallback(
    (startedDeviceKey: string) =>
      activeDeviceKeyRef.current !== '' &&
      activeDeviceKeyRef.current !== startedDeviceKey,
    [],
  );

  // Unavailable devices stay in the list so their reason stays readable; the
  // Boot button is what refuses them.
  // Grouping uses a snapshot taken when the menu opens; the star's filled state
  // still reads live `favoriteDevices`, so toggling gives instant feedback
  // without the row jumping to the Favorites group under the cursor.
  // Null while closed (ordering follows live favorites); a snapshot while open,
  // so starring a row does not hoist it into the Favorites group under the
  // cursor mid-click. Derived rather than synced in an effect, which would
  // cascade renders.
  const [frozenFavorites, setFrozenFavorites] = useState<
    typeof favoriteDevices | null
  >(null);
  const handlePickerOpenChange = useCallback(
    (open: boolean) => {
      setFrozenFavorites(open ? favoriteDevices : null);
    },
    [favoriteDevices],
  );
  const orderingFavorites = frozenFavorites ?? favoriteDevices;

  const deviceOptions = useMemo(
    () => buildDeviceOptions({ devices, favoriteDevices: orderingFavorites }),
    [devices, orderingFavorites],
  );

  const favorites = useMemo(
    () => getFavoriteDevices({ devices, favoriteDevices }),
    [devices, favoriteDevices],
  );
  // What the chip row renders: favorites, plus the selected device when it is
  // not starred (see `getDeviceChips`). Layout still keys off `favorites`, so a
  // user with no favorites keeps the full combobox row.
  const deviceChips = useMemo(
    () => getDeviceChips({ devices, favoriteDevices, activeDeviceKey }),
    [activeDeviceKey, devices, favoriteDevices],
  );
  const isActiveDeviceFavorite = activeDevice
    ? isFavoriteDevice({
        favoriteDevices,
        platform: activeDevice.platform,
        deviceId: activeDevice.id,
      })
    : false;

  const findDeviceByKey = useCallback(
    (deviceKey: string) =>
      devices.find(
        (candidate) =>
          makeMobileDevDeviceKey({
            platform: candidate.platform,
            deviceId: candidate.id,
          }) === deviceKey,
      ) ?? null,
    [devices],
  );

  const handleToggleFavoriteByKey = useCallback(
    (deviceKey: string) => {
      const device = findDeviceByKey(deviceKey);
      if (!device) return;
      toggleFavoriteDevice({
        platform: device.platform,
        deviceId: device.id,
        deviceName: device.name,
      });
    },
    [findDeviceByKey, toggleFavoriteDevice],
  );

  const handleToggleFavorite = useCallback(() => {
    if (!activeDevice) return;
    handleToggleFavoriteByKey(
      makeMobileDevDeviceKey({
        platform: activeDevice.platform,
        deviceId: activeDevice.id,
      }),
    );
  }, [activeDevice, handleToggleFavoriteByKey]);

  // Star control for a dropdown row. Rendered as a sibling of the row button by
  // <Combobox>, so clicking it toggles the favorite without selecting the row
  // or closing the menu -- the point is to star several devices in one pass.
  // Keyboard users star via the button beside the picker, which is in the tab
  // order; this in-list control is a mouse affordance.
  const renderOptionTrailing = useCallback(
    (option: { value: string }) => {
      const device = findDeviceByKey(option.value);
      if (!device) return null;
      const starred = isFavoriteDevice({
        favoriteDevices,
        platform: device.platform,
        deviceId: device.id,
      });
      return (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => handleToggleFavoriteByKey(option.value)}
          aria-label={
            starred ? 'Remove from favorites' : 'Add to favorites'
          }
          aria-pressed={starred}
          title={starred ? 'Remove from favorites' : 'Add to favorites'}
          className="text-ink-3 hover:bg-glass-medium hover:text-ink-1 flex size-6 items-center justify-center rounded transition-colors"
        >
          <Star
            className={clsx(
              'size-3.5',
              starred && 'fill-current text-amber-400',
            )}
          />
        </button>
      );
    },
    [favoriteDevices, findDeviceByKey, handleToggleFavoriteByKey],
  );

  // Build targets exactly the selected device, so everything about it (command
  // id, status, logs) is scoped to `activeDevice` and changes when it changes.
  const build = useMemo(
    () =>
      resolveMobileDevBuildCommand({
        config: mobilePreviewConfig,
        appPath,
        device: activeDevice,
      }),
    [activeDevice, appPath, mobilePreviewConfig],
  );
  const buildCommandId = build.commandId;
  const buildStatus = buildCommandId
    ? runCommands.statusByCommandId[buildCommandId]
    : undefined;
  const buildStarting = buildCommandId
    ? runCommands.isCommandStarting(buildCommandId)
    : false;
  const buildStopping = buildCommandId
    ? runCommands.isCommandStopping(buildCommandId)
    : false;
  const buildRunning = buildStatus?.status === 'running';

  const handleToggleBuild = useCallback(() => {
    // A build always targets exactly one device; with none selected there is
    // nothing to build onto and no command id to scope the run to.
    if (!activeDevice || !buildCommandId) return;
    if (buildRunning) {
      setStickyBuild({ taskId, commandId: buildCommandId });
      setSelectedLogTab(buildCommandId);
      void runCommands.stopCommand(buildCommandId);
      return;
    }
    // Guards run before any UI state changes, so a click that cannot start a
    // build does not yank the log box onto an empty stream.
    if (!build.command || !activeDevice) return;
    setStickyBuild({ taskId, commandId: buildCommandId });
    setSelectedLogTab(buildCommandId);
    void runCommands.startAdHocCommand({
      runCommandId: buildCommandId,
      // Matches the preview pane's labels for the same command id.
      name: activeDevice.platform === 'ios' ? 'iOS build' : 'Android build',
      command: build.command,
      ports: [],
    });
  }, [
    activeDevice,
    build.command,
    buildCommandId,
    buildRunning,
    runCommands,
    setSelectedLogTab,
    taskId,
  ]);

  const stickyBuildCommandId =
    stickyBuild?.taskId === taskId ? stickyBuild.commandId : null;
  const virtualTabs = useMemo(
    () =>
      buildMobileDevVirtualTabs({
        projectId,
        devServerCommandId,
        buildCommandId,
        stickyBuildCommandId,
        activeDevice,
        // Build tabs are device-scoped; without the list two simulators on one
        // platform would both render as plain "iOS build".
        devices,
      }),
    [
      activeDevice,
      buildCommandId,
      devServerCommandId,
      devices,
      projectId,
      stickyBuildCommandId,
    ],
  );

  // Tabs are only visible while their command is running or still holds output,
  // so *any* of these ids -- including Metro's -- can be absent: a fresh task has
  // no tabs at all, and clearing a stopped command's logs retires its tab.
  // `CommandLogsSection` falls back to the first visible tab and, with none,
  // shows `emptyText` instead of an empty log box. So a stale or retired
  // selection degrades rather than blanking the pane.
  const selectedCommandId = selectedLogTab ?? devServerCommandId;

  // Without this the pane never holds focus (clicks land on body), so the
  // containment gate on the logs section's shortcuts would reject every ⌘K.
  // Interactive targets are left alone so the device combobox and the log
  // search box keep managing their own focus.
  const focusPane = useCallback(
    (event: ReactMouseEvent) => focusOnNonInteractiveMouseDown(paneRef)(event),
    [],
  );

  const handleSelectDevice = useCallback(
    (deviceKey: string) => {
      startLaunchDeviceKeyRef.current = null;
      startOperationActiveRef.current = false;
      setBootError(null);
      setActionNotice(null);
      const device = findDeviceByKey(deviceKey);
      if (!device) return;
      selectDevice({
        platform: device.platform,
        deviceId: device.id,
        deviceName: device.name,
      });
    },
    [findDeviceByKey, selectDevice],
  );

  const handleBootDevice = useCallback(async () => {
    if (!activeDevice || isBooting) return;
    setBootError(null);
    const bootedDeviceKey = activeDeviceKey;
    const bootedPlatform = activeDevice.platform;
    const bootedDeviceId = activeDevice.id;
    setBootingDeviceKey(bootedDeviceKey);
    try {
      // The resolved id is deliberately discarded. `bootDevice` returns the adb
      // serial for Android, but `listDevices` reports booted emulators under
      // their AVD name (the serial lives in `connectionId`), so persisting the
      // serial would guarantee the selection never matches an option again.
      await api.mobilePreview.bootDevice({
        platform: bootedPlatform,
        deviceId: bootedDeviceId,
      });
      await refetchDevices();
    } catch (error) {
      // Boots are slow; the user may have picked a different device meanwhile.
      // Reporting a stale failure against the new selection would be wrong.
      // An *empty* selection is not a switch though -- stopping Metro clears it,
      // and there is no other device to misattribute the failure to, so the
      // error must still surface instead of vanishing with the spinner.
      if (isDeviceSelectionSwitched(bootedDeviceKey)) return;
      setBootError(cleanIpcError(error));
    } finally {
      setBootingDeviceKey(null);
    }
  }, [
    activeDevice,
    activeDeviceKey,
    isBooting,
    isDeviceSelectionSwitched,
    refetchDevices,
  ]);

  const handleToggleDevServer = useCallback(async () => {
    if (devServerRunning) {
      // The feed list badge reads `deviceByTaskId` directly, so a selection that
      // outlives Metro would keep advertising a device this task no longer runs
      // on. Clearing here is what makes the badge disappear -- but only once the
      // stop actually succeeded. `stopCommand` rethrows, and the status stays
      // 'running' on failure, so clearing up front would drop the selection
      // (disabling Boot/Restart) while Metro is still very much alive.
      // A stop cancels any deeplink the previous Start was still waiting to
      // fire, otherwise it would land on the next run's port.
      startLaunchDeviceKeyRef.current = null;
      void runCommands
        .stopCommand(devServerCommandId)
        .then(() => selectDevice(null));
      return;
    }
    // Start means "run the app", not just "run Metro": the deeplink is what
    // points the dev client at this server.
    if (devServerStarting || isBooting || startOperationActiveRef.current) return;
    startOperationActiveRef.current = true;
    const startDeviceKey = activeDeviceKey;
    startLaunchDeviceKeyRef.current = startDeviceKey || null;
    setBootError(null);
    try {
      if (
        activeDevice &&
        activeDevice.state !== 'booted' &&
        activeDevice.kind !== 'physical' &&
        !isDeviceUnavailable
      ) {
        setBootError(null);
        setBootingDeviceKey(startDeviceKey);
        await api.mobilePreview.bootDevice({
          platform: activeDevice.platform,
          deviceId: activeDevice.id,
        });
        await refetchDevices();
        if (activeDeviceKeyRef.current !== startDeviceKey) {
          startLaunchDeviceKeyRef.current = null;
          startOperationActiveRef.current = false;
          return;
        }
      }

      await runCommands.startAdHocCommand({
        runCommandId: devServerCommandId,
        // Must match the preview pane, which starts this same runCommandId --
        // otherwise the shared command's label flips depending on who started it.
        name: 'Mobile dev server',
        command: devServerCommand,
        ports: [configuredDevServerPort],
        availablePort: { provider: 'args' },
      }).then(({ started }) => {
        // `runStart` RESOLVES with `started: false` on a ports-in-use conflict
        // and when a newer operation supersedes this one -- it only rejects on
        // a hard error. Leaving the flag set there would arm a deeplink that
        // fires much later, when this shared run command (the preview pane
        // starts the same `devServerCommandId`) next reports a live port.
        if (!started) {
          startLaunchDeviceKeyRef.current = null;
          startOperationActiveRef.current = false;
        }
      });
    } catch (error) {
      startLaunchDeviceKeyRef.current = null;
      startOperationActiveRef.current = false;
      if (activeDeviceKeyRef.current === startDeviceKey || !startDeviceKey) {
        setBootError(cleanIpcError(error));
      }
    } finally {
      setBootingDeviceKey((current) =>
        current === startDeviceKey ? null : current,
      );
    }
  }, [
    activeDevice,
    activeDeviceKey,
    configuredDevServerPort,
    devServerCommand,
    devServerCommandId,
    devServerRunning,
    devServerStarting,
    isBooting,
    isDeviceUnavailable,
    refetchDevices,
    runCommands,
    selectDevice,
  ]);

  // Reload = swap the JS bundle in the already-running app, via Metro's own
  // reload command. Restart = relaunch the native app process on the device.
  // Same split (and wording) as the full preview pane.
  const handleReload = useCallback(async () => {
    // Reload can now deeplink (see `reloadAppOnMetro`), and a restart in flight
    // means the app is mid-relaunch: it has been killed and has not attached
    // yet, so the peer count is legitimately 0 and the repair would fire an
    // `exp://` deeplink into a still-booting app. That is the exact case
    // `restartAppOnDevice` documents as fatal -- the dev client tears the JS
    // runtime down while the first bundle is still loading and the process
    // dies with a SIGSEGV. The button is disabled for this too; the guard is
    // what makes it safe, since the restart re-enables the button the moment
    // the user switches device.
    if (isReloading || restartingDeviceKey !== null) return;
    // Captured before the await: the selection can change while the deeplink
    // is in flight.
    const reloadedDeviceName = activeDevice?.name ?? 'this device';
    setActionNotice(null);
    setIsReloading(true);
    try {
      const outcome = await reloadAppOnMetro({
        api: api.mobilePreview,
        metroPort: effectiveDevServerPort,
        projectId,
        taskId,
        appPath,
        device: activeDevice,
        // Same gate as the restart path, for the same reason: `launchExpo`
        // rejects outright when the app cannot be deeplinked, and asking anyway
        // would turn a "nothing attached" notice into a spurious error.
        //
        // `isActiveDeviceBooted` is checked here rather than inside
        // `resolveRestartReattach` because the restart path gets it from its
        // button (`disabled={!activeDeviceKey || !isActiveDeviceBooted}`) while
        // Reload's button only gates on the dev server. Without it, a selected
        // but shut-down simulator reaches `xcrun simctl openurl` and the user
        // gets "Unable to lookup in current state: Shutdown" instead of the
        // no-client message that actually tells them what to do.
        reattach: activeDevice && isActiveDeviceBooted
          ? resolveRestartReattach({
              isExpoApp,
              hasLiveDevServerPort,
              device: activeDevice,
              metroPort: effectiveDevServerPort,
              appScheme,
            })
          : null,
      });
      // Metro accepts the broadcast whether or not an app is listening, so
      // "sent" alone was indistinguishable from the button doing nothing.
      if (outcome.status === 'no-client') {
        addToast({
          message: `No app is connected to Metro on :${effectiveDevServerPort}, so there was nothing to reload. Open the app on the device (Restart, or Build & Run) and try again.`,
          type: 'error',
        });
        return;
      }
      if (outcome.status === 'reattach-failed') {
        // Names the device instead of saying "this device": the deeplink is
        // slow and the dropdown stays enabled, so by the time this lands the
        // selection may have moved and a deictic pronoun would blame the wrong
        // simulator.
        addToast({
          message: `No app was connected to Metro on :${effectiveDevServerPort}, and re-attaching ${reloadedDeviceName} failed: ${summarizeDeviceActionError(outcome.error)}`,
          type: 'error',
        });
        return;
      }
      setActionNotice(
        // Deliberately NOT "and reloaded": `launchExpo` resolves once
        // `simctl openurl` / `am start` reports the OS accepted the URL, which
        // proves nothing about the app coming up or a bundle loading. Claiming
        // a reload here would be the same unverified-success bug bce4dd89 and
        // ec578952 removed from the restart path.
        outcome.status === 'reattached'
          ? `Re-pointed the app at Metro on :${outcome.metroPort}.`
          : 'Reload sent to Metro.',
      );
    } catch (error) {
      // The port itself is already named by the main-process message, so this
      // adds only what the renderer alone knows: where that port came from.
      // A port learned from the running command drifts from the configured one
      // whenever Metro fell back to another port, and the two cases are fixed
      // in different places.
      const portSource = hasLiveDevServerPort
        ? 'port reported by the running dev server command'
        : "port from this project's mobile preview settings";
      addToast({
        message: `Reload failed (${portSource}): ${summarizeDeviceActionError(error)}`,
        type: 'error',
      });
    } finally {
      setIsReloading(false);
    }
  }, [
    activeDevice,
    addToast,
    appPath,
    appScheme,
    effectiveDevServerPort,
    hasLiveDevServerPort,
    isActiveDeviceBooted,
    isExpoApp,
    isReloading,
    projectId,
    restartingDeviceKey,
    taskId,
  ]);

  const handleOpenDeeplink = useCallback(
    async (url: string) => {
      if (!activeDevice) throw new Error('Select a device first.');
      // Mirrors `handleReload`'s internal guard: the trigger disables itself
      // during a restart, but the dropdown may already be open when the
      // restart starts, and the open menu is not gated by the trigger.
      if (isReloading || restartingDeviceKey !== null) {
        throw new Error('Wait for the restart to finish.');
      }
      setActionNotice(null);
      try {
        await api.mobilePreview.openDeeplink({
          platform: activeDevice.platform,
          deviceId: activeDevice.id,
          url,
        });
      } catch (error) {
        // Rethrown so the dropdown keeps the URL and shows the failure inline
        // instead of clearing the input and looking like it worked.
        throw new Error(summarizeDeviceActionError(error));
      }
      setActionNotice(`Opened ${url} on ${activeDevice.name}.`);
    },
    [activeDevice, isReloading, restartingDeviceKey],
  );

  const handleVerifyDeeplink = useCallback(async () => {
    if (!activeDevice || !isActiveDeviceBooted || isVerifyingDeeplink) return;
    const verificationDeviceKey = activeDeviceKey;
    setActionNotice(null);
    setIsVerifyingDeeplink(true);
    try {
      const result = await verifyDeeplinkOnDevice({
        api: api.mobilePreview,
        device: activeDevice,
        projectId,
        taskId,
        appPath,
        androidProjectPath,
      });
      // Status probes can be slow on iOS physical devices. Do not report an
      // old device's result after the user has selected another device (or
      // cleared the selection while the probe was in flight).
      if (activeDeviceKeyRef.current !== verificationDeviceKey) return;
      const platformLabel = PLATFORM_LABELS[result.platform];
      setActionNotice(
        result.appInstalled === true
          ? `${platformLabel} deeplink verified (${result.appId ?? 'installed app'}).`
          : result.appInstalled === false
            ? `${platformLabel} app is not installed on ${activeDevice.name}.`
            : `${platformLabel} app installation could not be determined.`,
      );
    } catch (error) {
      if (activeDeviceKeyRef.current !== verificationDeviceKey) return;
      addToast({
        message: `Deeplink verification failed: ${summarizeDeviceActionError(error)}`,
        type: 'error',
      });
    } finally {
      setIsVerifyingDeeplink(false);
    }
  }, [
    activeDevice,
    activeDeviceKey,
    addToast,
    androidProjectPath,
    appPath,
    isActiveDeviceBooted,
    isVerifyingDeeplink,
    projectId,
    taskId,
  ]);

  const handleCaptureScreenshot = useCallback(async () => {
    if (!activeDevice || !canCaptureScreenshot || isCapturingScreenshot) {
      return;
    }
    const deviceName = activeDevice.name;
    setActionNotice(null);
    setIsCapturingScreenshot(true);
    try {
      const result = await api.mobilePreview.captureScreenshot({
        platform: activeDevice.platform,
        deviceId: activeDevice.id,
      });
      const timestamp = new Date().toISOString().replaceAll(':', '-');
      await api.dialog.saveFile({
        defaultPath: `mobile-screenshot-${timestamp}.${result.extension}`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
        content: result.content,
      });
      setActionNotice(`Screenshot captured from ${deviceName}.`);
    } catch (error) {
      addToast({
        message: `Screenshot failed: ${summarizeDeviceActionError(error)}`,
        type: 'error',
      });
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [
    activeDevice,
    addToast,
    canCaptureScreenshot,
    isCapturingScreenshot,
  ]);

  const handleRestartApp = useCallback(async () => {
    // Mirrors `handleBootDevice`'s re-entrancy guard: the button disables
    // itself, but switching device mid-restart re-enables it and would start a
    // second overlapping restart + deeplink on the same app.
    if (!activeDevice || restartingDeviceKey !== null) return;
    setActionNotice(null);
    setRestartingDeviceKey(activeDeviceKey);
    const restartedDeviceKey = activeDeviceKey;
    try {
      const { label, reattachedPort, reattachError } = await restartAppOnDevice(
        {
          api: api.mobilePreview,
          device: activeDevice,
          projectId,
          taskId,
          appPath,
          androidProjectPath,
          reattach: resolveRestartReattach({
            isExpoApp,
            // Must be the same condition that produced `effectiveDevServerPort`
            // from live status. Gating on `devServerRunning` alone would
            // deeplink the *configured* port during a restart window, which
            // `launchExpo` rejects with an exact-port mismatch.
            hasLiveDevServerPort,
            device: activeDevice,
            metroPort: effectiveDevServerPort,
            appScheme,
          }),
        },
      );
      // Restarts are slow; the user may have picked a different device. A
      // success notice would otherwise claim the NEW device's app restarted.
      if (isDeviceSelectionSwitched(restartedDeviceKey)) return;
      // The app did restart even when the re-attach failed, so this is a
      // warning about the Metro connection, not a failed restart.
      if (reattachError) {
        addToast({
          message: `${label} restarted, but could not attach it to Metro on :${effectiveDevServerPort}: ${summarizeDeviceActionError(reattachError)}`,
          type: 'error',
        });
        return;
      }
      setActionNotice(
        reattachedPort
          ? `${label} restarted on :${reattachedPort}.`
          : `${label} restarted.`,
      );
    } catch (error) {
      if (isDeviceSelectionSwitched(restartedDeviceKey)) return;
      addToast({
        message: summarizeDeviceActionError(error),
        type: 'error',
      });
    } finally {
      setRestartingDeviceKey(null);
    }
  }, [
    activeDevice,
    addToast,
    activeDeviceKey,
    androidProjectPath,
    appPath,
    appScheme,
    effectiveDevServerPort,
    hasLiveDevServerPort,
    isDeviceSelectionSwitched,
    isExpoApp,
    projectId,
    restartingDeviceKey,
    taskId,
  ]);

  // Start = start Metro AND open the app on the selected device. Deferred to an
  // effect because the port to deeplink is only known once the run command
  // reports it (see `resolveStartLaunchDecision`).
  useEffect(() => {
    const decision = resolveStartLaunchDecision({
      isPending:
        startLaunchDeviceKeyRef.current === (activeDeviceKey || null),
      hasLiveDevServerPort,
      isLoadingDevices,
      device: activeDevice,
      isDeviceBooted: isActiveDeviceBooted,
      isExpoApp,
      metroPort: effectiveDevServerPort,
      appScheme,
    });
    if (decision.status === 'idle' || decision.status === 'waiting') return;
    // Cleared before the await so a slow deeplink cannot be fired twice by a
    // re-render, and so Stop is not needed to escape a stuck pending state.
    startLaunchDeviceKeyRef.current = null;
    startOperationActiveRef.current = false;
    // `activeDevice` is non-null for a 'launch' decision; re-checked for the
    // type narrowing.
    if (decision.status === 'skip' || !activeDevice) return;

    const launchedDeviceKey = activeDeviceKey;
    const launchedDeviceName = activeDevice.name;
    // Queued rather than called inline: a synchronous setState in an effect
    // body is the cascading-render pattern the React compiler rejects. Same
    // workaround as `useMobilePreviewExpoLaunch`. The gap is one microtask, so
    // no click can land inside it.
    queueMicrotask(() => setStartLaunchingDeviceKey(launchedDeviceKey));
    void api.mobilePreview
      .launchExpo({
        requestId: createStartLaunchRequestId(),
        taskId,
        projectId,
        appPath,
        platform: activeDevice.platform,
        deviceId: activeDevice.id,
        metroPort: decision.metroPort,
        appScheme: decision.appScheme,
      })
      .then(() => {
        if (isDeviceSelectionSwitched(launchedDeviceKey)) return;
        // Not "and opened": `launchExpo` resolves once the OS accepted the URL,
        // which proves nothing about the app finishing its boot.
        setActionNotice(
          `Opened ${launchedDeviceName} on Metro :${decision.metroPort}.`,
        );
      })
      .catch((error: unknown) => {
        if (isDeviceSelectionSwitched(launchedDeviceKey)) return;
        // Metro did start, so this is a warning about the app, not a failed
        // Start.
        addToast({
          message: `Metro started, but opening the app on ${launchedDeviceName} failed: ${summarizeDeviceActionError(error)}`,
          type: 'error',
        });
      })
      .finally(() => {
        // Keyed by device so a launch that resolves after the user switched
        // device does not unblock (or keep blocked) the wrong selection.
        setStartLaunchingDeviceKey((current) =>
          current === launchedDeviceKey ? null : current,
        );
      });
  }, [
    activeDevice,
    activeDeviceKey,
    addToast,
    appPath,
    appScheme,
    effectiveDevServerPort,
    hasLiveDevServerPort,
    isActiveDeviceBooted,
    isDeviceSelectionSwitched,
    isExpoApp,
    isLoadingDevices,
    projectId,
    taskId,
  ]);

  // True while Start's deeplink is in flight for the selected device.
  const isStartLaunchingActiveDevice =
    startLaunchingDeviceKey !== null &&
    startLaunchingDeviceKey === activeDeviceKey;

  const devServerTone: 'running' | 'stopped' | 'errored' =
    devServerStatus?.status === 'errored'
      ? 'errored'
      : devServerRunning
        ? 'running'
        : 'stopped';

  return (
    <div
      ref={paneRef}
      tabIndex={-1}
      onMouseDown={focusPane}
      style={{ width }}
      data-mobile-dev-pane
      // The project panel defers ⌘F to whichever pane owns a command log.
      data-command-logs-pane
      className="panel-edge-shadow bg-bg-0 relative flex h-full flex-col"
    >
      <div
        onMouseDown={handleMouseDown}
        className={clsx(
          'hover:bg-acc/50 absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors',
          isDragging && 'bg-acc/50',
        )}
      />

      <div
        className={clsx(
          'flex shrink-0 items-center justify-between px-4 py-2',
          TASK_PANEL_HEADER_HEIGHT_CLS,
        )}
      >
        <h3 className="text-ink-1 flex items-center gap-2 text-sm font-medium">
          <Smartphone className="size-4" aria-hidden />
          Mobile Dev
        </h3>
        <IconButton onClick={onClose} size="sm" icon={<X />} tooltip="Close" />
      </div>
      <Separator />

      {/* Fixed on top and capped: the controls keep their natural height and
          scroll internally rather than either being clipped by a short window
          or growing until they eat the log below. */}
      <div className="flex max-h-[55%] shrink-0 flex-col gap-3 overflow-y-auto px-4 py-3">
        {/* Device */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-ink-2 text-xs font-medium">Device</span>
            <IconButton
              onClick={() => void refetchDevices()}
              size="sm"
              icon={
                <RefreshCw
                  className={clsx(isFetchingDevices && 'animate-spin')}
                />
              }
              tooltip="Refresh devices"
            />
          </div>

          {deviceListError ? (
            <p className="text-xs break-words text-red-500">
              {deviceListError}
            </p>
          ) : devices.length === 0 ? (
            <p className="text-ink-3 text-xs">
              {isLoadingDevices
                ? // Naming the remembered device makes the wait feel anchored
                  // instead of looking like the selection was lost.
                  (persistedDeviceName
                    ? `Loading devices… (${persistedDeviceName})`
                    : 'Loading devices…')
                : 'No devices found.'}
            </p>
          ) : (
            <>
              {/* With favorites the chips ARE the picker: the full-width
                  combobox collapses into a "…" chip, which buys back a row of
                  vertical space in a pane that is mostly logs. */}
              {favorites.length === 0 && (
                <div className="flex items-center gap-2">
                  <Combobox
                    value={activeDeviceKey}
                    options={deviceOptions}
                    onChange={handleSelectDevice}
                    renderOptionTrailing={renderOptionTrailing}
                    onOpenChange={handlePickerOpenChange}
                    size="sm"
                    className="min-w-0 flex-1"
                    label="Select a device"
                    placeholder="Select a device…"
                    searchPlaceholder="Search devices…"
                    emptyLabel="No matching devices"
                  />
                  <IconButton
                    onClick={handleToggleFavorite}
                    size="sm"
                    disabled={!activeDevice}
                    icon={
                      <Star
                        className={clsx(
                          isActiveDeviceFavorite &&
                            'fill-current text-amber-400',
                        )}
                      />
                    }
                    tooltip={
                      isActiveDeviceFavorite
                        ? 'Remove from favorites'
                        : 'Add to favorites'
                    }
                  />
                </div>
              )}

              {/* One-click row for starred devices, so the common case skips
                  the dropdown entirely. */}
              {favorites.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {deviceChips.map((device) => {
                    const deviceKey = makeMobileDevDeviceKey({
                      platform: device.platform,
                      deviceId: device.id,
                    });
                    const isSelected = deviceKey === activeDeviceKey;
                    const platformLabel = PLATFORM_LABELS[device.platform];
                    return (
                      <button
                        key={deviceKey}
                        type="button"
                        onClick={() => handleSelectDevice(deviceKey)}
                        aria-pressed={isSelected}
                        title={
                          device.unavailableReason ??
                          `${device.name} · ${platformLabel}${
                            device.state === 'booted' ? ' · booted' : ''
                          }`
                        }
                        className={clsx(
                          'flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors',
                          isSelected
                            ? 'border-acc-line bg-acc/15 text-ink-1'
                            : 'border-line text-ink-2 hover:bg-bg-1',
                        )}
                      >
                        <span
                          aria-hidden
                          className={clsx(
                            'size-1.5 shrink-0 rounded-full',
                            device.state === 'booted'
                              ? 'bg-green-500'
                              : 'bg-ink-3/40',
                          )}
                        />
                        <span className="truncate">{device.name}</span>
                        {/* Names can repeat across platforms in one list. */}
                        <span className="text-ink-4 shrink-0 text-[10px]">
                          {platformLabel}
                        </span>
                      </button>
                    );
                  })}
                  <Combobox
                    value={activeDeviceKey}
                    options={deviceOptions}
                    onChange={handleSelectDevice}
                    renderOptionTrailing={renderOptionTrailing}
                    onOpenChange={handlePickerOpenChange}
                    size="sm"
                    // Matches the chips beside it (same pill, same border,
                    // same height) so the row reads as one control strip.
                    className="border-line text-ink-2 hover:bg-bg-1 !h-auto shrink-0 !rounded-full border !bg-transparent !px-2 !py-0.5 !text-xs"
                    label="Select a device"
                    searchPlaceholder="Search devices…"
                    emptyLabel="No matching devices"
                    triggerContent={
                      <MoreHorizontal className="size-3.5" aria-hidden />
                    }
                  />
                </div>
              )}
            </>
          )}

          {/* One platform's tooling can be missing while the other works.
              Say so, rather than silently listing half the devices. */}
          {devices.length > 0 && failedPlatforms.length > 0 && (
            <p className="text-ink-3 text-xs">
              {failedPlatforms.join(' and ')} devices could not be listed.
            </p>
          )}

          {bootError && (
            <p className="text-xs break-words text-red-500">{bootError}</p>
          )}

        </div>

        <Separator />

        {/* Metro */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <StatusDot
                tone={devServerTone}
                pulse={devServerStarting || devServerStopping}
              />
              <span className="text-ink-1 truncate text-xs font-medium">
                Metro
              </span>
              <span className="text-ink-3 shrink-0 font-mono text-xs">
                :{effectiveDevServerPort}
              </span>
            </span>
            <div className="flex items-center gap-2">
              {/* Boots the selected device. Lives on this row (not under the
                  device picker) so the device section stays one line tall. */}
              <Button
                onClick={handleBootDevice}
                size="sm"
                variant="secondary"
                loading={isActiveDeviceBooting}
                disabled={
                  !activeDeviceKey || isActiveDeviceBooted || isDeviceUnavailable
                }
                title={
                  isDeviceUnavailable
                    ? (activeDevice?.unavailableReason ??
                      'Device is unavailable')
                    : isActiveDeviceBooted
                      ? 'Device is already booted'
                      : 'Boot this device'
                }
              >
                {isActiveDeviceBooted ? 'Booted' : 'Boot'}
              </Button>
              {/* Build & run onto the selected device. The command comes from
                  project settings (or detection) and, where the CLI is
                  recognized, is pointed at this exact device rather than the
                  tool's own default simulator. */}
              <Button
                onClick={handleToggleBuild}
                size="sm"
                variant="secondary"
                loading={buildStarting || buildStopping}
                // No device selected means no build, full stop -- a build
                // always targets one device, and the command id is keyed by
                // it. Stated ahead of the `buildRunning` escape hatch so it
                // cannot be reached: without a device there is no command id
                // to be running.
                disabled={!activeDeviceKey || (!buildRunning && !build.command)}
                icon={buildRunning ? <Square /> : <Hammer />}
                title={
                  buildRunning
                    ? 'Stop the running build'
                    : (build.unavailableReason ??
                      `Build and run on ${activeDevice?.name ?? 'the selected device'}`)
                }
              >
                {buildRunning ? 'Stop' : 'Build'}
              </Button>
              <Button
                onClick={handleToggleDevServer}
                size="sm"
                variant="secondary"
                loading={devServerStarting || devServerStopping}
                icon={devServerRunning ? <Square /> : <Play />}
              >
                {devServerRunning ? 'Stop' : 'Start'}
              </Button>
            </div>
          </div>
          <p className="text-ink-3 truncate font-mono text-[11px]">
            {devServerCommand}
          </p>

          {/* App actions. Reload swaps the JS bundle in the running app;
              Restart relaunches the native process. */}
          <div className="flex items-center gap-2">
            <Button
              onClick={handleReload}
              size="sm"
              variant="secondary"
              className="flex-1"
              loading={isReloading}
              // Restart kills and relaunches the app; reloading during that
              // window would deeplink into a still-booting process and crash
              // it. See the guard in `handleReload`.
              disabled={
                !devServerRunning ||
                restartingDeviceKey !== null ||
                isStartLaunchingActiveDevice
              }
              icon={<RotateCw />}
              title={
                !devServerRunning
                  ? 'Start Metro to reload the app'
                  : restartingDeviceKey !== null
                    ? 'Wait for the restart to finish'
                    : isStartLaunchingActiveDevice
                      ? 'Wait for the app to open'
                      : 'Reload the JS bundle on the connected app (Metro reload)'
              }
            >
              Reload
            </Button>
            <Button
              onClick={handleRestartApp}
              size="sm"
              variant="secondary"
              className="flex-1"
              loading={restartingDeviceKey === activeDeviceKey}
              // Symmetric to Reload: a reload may have a deeplink in flight,
              // and killing the app underneath it is the same hazard.
              disabled={
                !activeDeviceKey ||
                !isActiveDeviceBooted ||
                isReloading ||
                isStartLaunchingActiveDevice
              }
              icon={<RotateCcw />}
              title={
                !activeDeviceKey
                  ? 'Select a device to restart its app'
                  : !isActiveDeviceBooted
                    ? 'Boot the device to restart its app'
                    : isReloading
                      ? 'Wait for the reload to finish'
                      : isStartLaunchingActiveDevice
                        ? 'Wait for the app to open'
                        : 'Restart the native app on the device'
              }
            >
              Restart
            </Button>
            <Button
              onClick={() => void handleCaptureScreenshot()}
              size="sm"
              variant="secondary"
              className="flex-1"
              loading={isCapturingScreenshot}
              disabled={!canCaptureScreenshot || isCapturingScreenshot}
              icon={<Camera />}
              title={
                !activeDevice
                  ? 'Select a device to capture a screenshot'
                  : !isScreenshotSupported
                    ? 'Screenshots are currently supported for iOS simulators and Android devices'
                    : !isActiveDeviceBooted &&
                        activeDevice.connection !== 'connected'
                      ? 'Boot or connect the device to capture a screenshot'
                      : 'Capture a PNG screenshot of the device screen'
              }
            >
              Screenshot
            </Button>
            <DeeplinkButton
              // Same hazard as Reload: a restart in flight means the app is
              // mid-relaunch, and deeplinking into a still-booting dev client
              // tears down its JS runtime (SIGSEGV). See `handleReload`.
              disabled={
                !activeDeviceKey ||
                !isActiveDeviceBooted ||
                isReloading ||
                restartingDeviceKey !== null
              }
              disabledReason={
                !activeDeviceKey
                  ? 'Select a device to open a deeplink'
                  : !isActiveDeviceBooted
                    ? 'Boot the device to open a deeplink'
                    : isReloading
                      ? 'Wait for the reload to finish'
                      : restartingDeviceKey !== null
                        ? 'Wait for the restart to finish'
                        : undefined
              }
              onOpenDeeplink={handleOpenDeeplink}
            />
            <IconButton
              onClick={() => void handleVerifyDeeplink()}
              size="sm"
              disabled={
                !activeDevice || !isActiveDeviceBooted || isVerifyingDeeplink
              }
              icon={
                <RefreshCw
                  className={clsx(isVerifyingDeeplink && 'animate-spin')}
                />
              }
              tooltip={
                !activeDevice
                  ? 'Select a device to verify its deeplink app'
                  : !isActiveDeviceBooted
                    ? 'Boot the device to verify its deeplink app'
                    : 'Refresh deeplink verification'
              }
              aria-label="Refresh deeplink verification"
            />
          </div>

          {actionNotice && (
            <p className="text-ink-3 text-xs break-words">{actionNotice}</p>
          )}
        </div>
      </div>

      <Separator />

      <CommandLogsSection
        className="flex-1"
        keyScopeRef={paneRef}
        virtualTabs={virtualTabs}
        emptyText="No logs yet. Start Metro or run a build to see output here."
        selectedCommandId={selectedCommandId}
        onSelectCommand={(id) => {
          if (id) setSelectedLogTab(id);
        }}
        runCommands={runCommands}
        commandAvailability={commandAvailability}
        taskId={taskId}
        projectId={projectId}
        workingDir={workingDir}
      />
    </div>
  );
}
