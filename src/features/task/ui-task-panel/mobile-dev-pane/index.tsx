import {
  ChevronRight,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Smartphone,
  Square,
  Star,
  Trash2,
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
import { createMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';
import { IconButton } from '@/common/ui/icon-button';
import { InteractiveLog } from '@/features/common/interactive-log';
import { Separator } from '@/common/ui/separator';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useMobileDevPaneWidth } from '@/stores/navigation';
import { useMobilePreviewDevices } from '@/hooks/use-mobile-preview';
import { useRunCommands } from '@/hooks/use-run-commands';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';

import {
  buildDeviceOptions,
  getFavoriteDevices,
  isFavoriteDevice,
  PLATFORM_LABELS,
} from './utils-device-options';
import { resolveActiveDevice } from './utils-active-device';
import { resolveAndroidProjectPath } from './utils-android-project-path';
import { resolveDeviceListStatus } from './utils-device-list-status';
import { resolveMobileDevAppPath } from './utils-app-path';
import { resolveMobileDevDetectedApp } from './utils-detected-app';
import { resolveRestartReattach } from './utils-restart-reattach';
import { restartAppOnDevice } from './utils-restart-app';
import { summarizeDeviceActionError } from './utils-action-error';
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

  const { selectedDevice, logsExpanded, selectDevice, setLogsExpanded } =
    useMobileDevPaneTaskState(taskId);
  const { favoriteDevices, toggleFavoriteDevice } = useMobileDevPaneFavorites();

  const [bootingDeviceKey, setBootingDeviceKey] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const [restartingDeviceKey, setRestartingDeviceKey] = useState<string | null>(
    null,
  );
  // Only success/progress copy lives inline; failures go to a toast because
  // device errors (devicectl dumps) are far too long for this narrow pane.
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const addToast = useToastStore((state) => state.addToast);
  const activeDeviceKeyRef = useRef('');
  const paneRef = useRef<HTMLDivElement>(null);
  const [bootError, setBootError] = useState<string | null>(null);

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
  // `isBooting` guards re-entrancy; the per-device flags drive the UI, so
  // switching device mid-boot does not show a spinner on the new selection.
  const isBooting = bootingDeviceKey !== null;
  const isActiveDeviceBooting =
    bootingDeviceKey !== null && bootingDeviceKey === activeDeviceKey;
  useEffect(() => {
    activeDeviceKeyRef.current = activeDeviceKey;
  }, [activeDeviceKey]);

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

  // Subscribing only while the log section is expanded keeps Metro's very
  // chatty output from re-rendering a collapsed pane.
  const devServerLog =
    useTaskMessagesStore((state) =>
      logsExpanded
        ? state.runCommandLogs[taskId]?.[devServerCommandId]
        : undefined,
    ) ?? null;

  // Bump the generation before the IPC call so late chunks from the old
  // generation are dropped instead of repopulating the box after the clear.
  const resetRunCommandLogs = useTaskMessagesStore(
    (state) => state.resetRunCommandLogs,
  );
  const handleClearLogs = useCallback(() => {
    const generation = resetRunCommandLogs(taskId, devServerCommandId);
    void api.runCommands.resetLogs({
      taskId,
      runCommandId: devServerCommandId,
      generation,
    });
  }, [devServerCommandId, resetRunCommandLogs, taskId]);

  // Scoped to the pane: ⌘K is already bound elsewhere (command logs pane, run
  // commands overlay), so this must only fire while focus is inside here.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== 'k') return;

      const target = event.target;
      if (!(target instanceof Node) || !paneRef.current?.contains(target)) {
        return;
      }

      event.preventDefault();
      handleClearLogs();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClearLogs]);

  // Without this the pane never holds focus (clicks land on body, and the only
  // focusable child is the log box, which exists only while expanded), so the
  // containment gate above would reject every ⌘K. Interactive targets are left
  // alone so the device combobox keeps managing its own focus.
  const focusPane = useCallback((event: ReactMouseEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, select, button, [contenteditable]')
    ) {
      return;
    }
    paneRef.current?.focus();
  }, []);

  const handleSelectDevice = useCallback(
    (deviceKey: string) => {
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
      if (activeDeviceKeyRef.current !== bootedDeviceKey) return;
      setBootError(cleanIpcError(error));
    } finally {
      setBootingDeviceKey(null);
    }
  }, [activeDevice, activeDeviceKey, isBooting, refetchDevices]);

  const handleToggleDevServer = useCallback(() => {
    if (devServerRunning) {
      void runCommands.stopCommand(devServerCommandId);
      return;
    }
    void runCommands.startAdHocCommand({
      runCommandId: devServerCommandId,
      // Must match the preview pane, which starts this same runCommandId --
      // otherwise the shared command's label flips depending on who started it.
      name: 'Mobile dev server',
      command: devServerCommand,
      ports: [configuredDevServerPort],
      availablePort: { provider: 'args' },
    });
  }, [
    configuredDevServerPort,
    devServerCommand,
    devServerCommandId,
    devServerRunning,
    runCommands,
  ]);

  // Reload = swap the JS bundle in the already-running app, via Metro's own
  // reload command. Restart = relaunch the native app process on the device.
  // Same split (and wording) as the full preview pane.
  const handleReload = useCallback(async () => {
    setActionNotice(null);
    setIsReloading(true);
    try {
      await api.mobilePreview.reloadExpo({ metroPort: effectiveDevServerPort });
      setActionNotice('Reload sent to Metro.');
    } catch (error) {
      addToast({
        message: summarizeDeviceActionError(error),
        type: 'error',
      });
    } finally {
      setIsReloading(false);
    }
  }, [addToast, effectiveDevServerPort]);

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
      if (activeDeviceKeyRef.current !== restartedDeviceKey) return;
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
      if (activeDeviceKeyRef.current !== restartedDeviceKey) return;
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
    isExpoApp,
    projectId,
    restartingDeviceKey,
    taskId,
  ]);

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

      {/* Scrollable rather than shrink-0 so a short window clips nothing: the
          controls keep their natural height and scroll internally instead of
          pushing the logs (or the Start/Stop buttons) out of the pane. */}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
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
                <Button
                  onClick={handleBootDevice}
                  size="sm"
                  variant="secondary"
                  loading={isActiveDeviceBooting}
                  disabled={
                    !activeDeviceKey ||
                    isActiveDeviceBooted ||
                    isDeviceUnavailable
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
              </div>

              {/* One-click row for starred devices, so the common case skips
                  the dropdown entirely. */}
              {favorites.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {favorites.map((device) => {
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
              disabled={!devServerRunning}
              icon={<RotateCw />}
              title={
                devServerRunning
                  ? 'Reload the JS bundle on the connected app (Metro reload)'
                  : 'Start Metro to reload the app'
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
              disabled={!activeDeviceKey || !isActiveDeviceBooted}
              icon={<RotateCcw />}
              title={
                !activeDeviceKey
                  ? 'Select a device to restart its app'
                  : !isActiveDeviceBooted
                    ? 'Boot the device to restart its app'
                    : 'Restart the native app on the device'
              }
            >
              Restart
            </Button>
          </div>

          {actionNotice && (
            <p className="text-ink-3 text-xs break-words">{actionNotice}</p>
          )}
        </div>
      </div>

      <Separator />

      {/* Logs */}
      <div className="flex shrink-0 items-center justify-between pr-2">
        <button
          type="button"
          onClick={() => setLogsExpanded(!logsExpanded)}
          className="text-ink-2 hover:bg-bg-1 flex flex-1 items-center gap-1.5 px-4 py-2 text-xs font-medium"
          aria-expanded={logsExpanded}
        >
          <ChevronRight
            aria-hidden
            className={clsx(
              'size-3.5 transition-transform',
              logsExpanded && 'rotate-90',
            )}
          />
          Logs
        </button>
        <IconButton
          onClick={handleClearLogs}
          size="sm"
          icon={<Trash2 />}
          tooltip="Clear logs (⌘K)"
        />
      </div>

      {logsExpanded && (
        <InteractiveLog
          log={devServerLog}
          taskId={taskId}
          runCommandId={devServerCommandId}
          isRunning={devServerRunning}
          workingDir={workingDir}
          ignoreBrowserShortcuts
          emptyText="Start Metro to see output."
          // The floor matters because the logs box has flex-basis 0: without it
          // flexbox hands every pixel of a squeeze to the controls block above
          // and the log silently renders at zero height.
          className="min-h-[120px] overflow-hidden"
        />
      )}
    </div>
  );
}
