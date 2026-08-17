import type {
  MobileColorScheme,
  MobilePreviewDevice,
  MobilePreviewInputEvent,
  MobilePreviewIosAppRestartParams,
  MobilePreviewIosAppRestartResult,
  MobilePreviewIosAppStatus,
  MobilePreviewIosAppStatusParams,
  MobilePreviewIosCreateDeviceParams,
  MobilePreviewIosDeviceType,
  MobilePreviewIosRenameDeviceParams,
  MobilePreviewIosRuntime,
  MobilePreviewIosToolStatus,
  MobilePreviewQuality,
  MobilePreviewSession,
  MobilePreviewTextSize,
  MobileRotationDirection,
} from '../../shared/mobile-simulator-types';

import {
  activeCoreSimulatorStreamStops,
  activeHidHelpersByDeviceId,
  activeIosSessionIds,
  activeIosTouchesByDeviceId,
  activeScreenshotStreamStops,
  bumpIosInputGeneration,
  coreSimulatorPool,
  debug,
  elapsedMs,
  fallbackTouchesByDeviceId,
  getIosInputGeneration,
  getIosKeyboardInputQueue,
  hidHelperReferenceCountsByDeviceId,
  inputScreenDimensionsByDeviceId,
  iosInputErrorByDeviceId,
  iosTouchInputQueues,
  isIosPreviewDisposed,
  pendingCoreSimulatorPoolEntries,
  pendingHidHelpersByDeviceId,
  pendingIosSimulatorBootsByDeviceId,
  setIosPreviewDisposed,
} from './mobile-preview-ios-shared-state';
import {
  assertDeeplinkUrl,
  assertDeviceId,
  assertIdbAvailable,
  assertSafeSimctlDeviceSelector,
  assertSafeSimctlValue,
  assertXcrunAvailable,
  ensureIosSimulatorBooted,
  getCommandPath,
  parseSimctlDevices,
  parseSimctlDeviceTypes,
  parseSimctlRuntimes,
} from './mobile-preview-ios-simctl';
import {
  cancelIosNonTouchInputs,
  compensateIosTouch,
  enqueueIosKeyboardInput,
  enqueueIosTouchInput,
  IOS_HID_BACKSPACE_KEYCODE,
  isTouchLifecycleEvent,
  ownIosStream,
  pasteIosText,
  runIosNonTouchInput,
  sendFallbackTouchLifecycleEvent,
  sendIdbUiInputEvent,
  sendIosHidKeyPress,
  sendIosHidLifecycleEvent,
  sendIosHidText,
  showIosSoftwareKeyboard,
} from './mobile-preview-ios-hid-input';
import {
  commandExists,
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
  runCommand,
} from './mobile-preview-process';
import {
  createCoreSimulatorFramebufferStream,
  createScreenshotStream,
  getSimulatorScreenshotSize,
} from './mobile-preview-ios-framebuffer';
import {
  isAppNotRunningError,
  parseSimctlInstalledApps,
  resolveIosApp,
  resolveTrustedIosAppRoot,
} from './mobile-preview-ios-bundle-resolver';
import { createIdbRawVideoStream } from './mobile-preview-ios-idb-stream';

export {
  getPendingIosBootWaiterCountForTests,
  parseSimctlDeviceTypes,
  parseSimctlDevices,
  parseSimctlRuntimes,
} from './mobile-preview-ios-simctl';
export {
  buildIdbInputArgs,
  getIosActiveTouchSessionForTests,
  getIosFallbackTouchSessionForTests,
} from './mobile-preview-ios-hid-input';
export {
  createMjpegFrameParser,
  killOrphanedCoreSimulatorHelpers,
  resetOrphanedHelperSweepForTests,
  CORE_SIMULATOR_FIRST_FRAME_TIMEOUT_MS,
  FIRST_FRAME_TIMEOUT_MS,
  MAX_MJPEG_PENDING_BYTES,
  SCREENSHOT_POLL_INTERVAL_MS,
} from './mobile-preview-ios-framebuffer';
export { MAX_STREAM_STDERR_BYTES } from './mobile-preview-ios-shared-state';

const IOS_CONTENT_SIZE: Record<MobilePreviewTextSize, string> = {
  small: 'small',
  normal: 'large',
  large: 'extra-large',
  'x-large': 'accessibility-large',
};

type ActiveIosAppStatus = {
  promise: Promise<MobilePreviewIosAppStatus>;
  abortController: AbortController;
};
const activeIosAppStatuses = new Set<ActiveIosAppStatus>();
type ActiveIosAppRestart = {
  promise: Promise<MobilePreviewIosAppRestartResult>;
  abortController: AbortController;
};
const activeIosAppRestarts = new Set<ActiveIosAppRestart>();

export async function resetCoreSimulatorFramebufferPoolForTests(): Promise<void> {
  setIosPreviewDisposed(true);
  bumpIosInputGeneration();
  activeIosSessionIds.clear();
  const nonTouchInputs = cancelIosNonTouchInputs();
  const pendingBoots = Array.from(pendingIosSimulatorBootsByDeviceId.values());
  const activeStatuses = Array.from(activeIosAppStatuses);
  const activeRestarts = Array.from(activeIosAppRestarts);
  activeStatuses.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  activeRestarts.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  pendingBoots.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  await Promise.allSettled([
    nonTouchInputs,
    ...activeStatuses.map(({ promise }) => promise),
    ...activeRestarts.map(({ promise }) => promise),
    ...pendingBoots.map(({ promise }) => promise),
  ]);
  const pendingBuilds = Array.from(pendingCoreSimulatorPoolEntries.values());
  pendingBuilds.forEach(({ abortController }) => abortController.abort());
  await Promise.allSettled(pendingBuilds.map(({ promise }) => promise));
  const entries = Array.from(coreSimulatorPool.values());
  const screenshotStops = Array.from(activeScreenshotStreamStops);
  const hidHelpers = Array.from(activeHidHelpersByDeviceId.values());
  coreSimulatorPool.clear();
  activeIosAppStatuses.clear();
  activeIosAppRestarts.clear();
  pendingIosSimulatorBootsByDeviceId.clear();
  pendingCoreSimulatorPoolEntries.clear();
  activeScreenshotStreamStops.clear();
  activeCoreSimulatorStreamStops.clear();
  activeHidHelpersByDeviceId.clear();
  pendingHidHelpersByDeviceId.clear();
  iosTouchInputQueues.clear();
  hidHelperReferenceCountsByDeviceId.clear();
  fallbackTouchesByDeviceId.clear();
  activeIosTouchesByDeviceId.clear();
  inputScreenDimensionsByDeviceId.clear();
  iosInputErrorByDeviceId.clear();
  await Promise.all(
    [
      ...entries.map((entry) => {
        if (entry.cleanupTimer) {
          clearTimeout(entry.cleanupTimer);
          entry.cleanupTimer = null;
        }
        return entry.stream.stop();
      }),
      ...screenshotStops.map((stop) => stop()),
      ...hidHelpers.map((helper) => helper.stream.stop()),
    ],
  );
  setIosPreviewDisposed(false);
}

async function disposeIosPreviewResources(): Promise<void> {
  const stopErrors: unknown[] = [];
  const collectStopErrors = (results: PromiseSettledResult<unknown>[]) => {
    for (const result of results) {
      if (result.status === 'rejected') stopErrors.push(result.reason);
    }
  };
  bumpIosInputGeneration();
  activeIosSessionIds.clear();
  const nonTouchInputs = cancelIosNonTouchInputs();
  const establishedTouches = Array.from(
    activeIosTouchesByDeviceId,
    ([deviceId, touch]) => ({ deviceId, sessionId: touch.sessionId }),
  );
  setIosPreviewDisposed(true);
  const pendingBoots = Array.from(pendingIosSimulatorBootsByDeviceId.values());
  const activeStatuses = Array.from(activeIosAppStatuses);
  const activeRestarts = Array.from(activeIosAppRestarts);
  debug(
    'iOS preview disposal aborting active statuses=%d active restarts=%d pending boots=%d',
    activeStatuses.length,
    activeRestarts.length,
    pendingBoots.length,
  );
  activeStatuses.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  activeRestarts.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  pendingBoots.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  await Promise.all(
    establishedTouches.map(({ deviceId, sessionId }) =>
      enqueueIosTouchInput(deviceId, async () => {
        await compensateIosTouch(deviceId, sessionId, true);
      }),
    ),
  );
  await Promise.allSettled([
    ...activeStatuses.map(({ promise }) => promise),
    ...activeRestarts.map(({ promise }) => promise),
    ...pendingBoots.map(({ promise }) => promise),
  ]);
  const pendingBuilds = Array.from(pendingCoreSimulatorPoolEntries.values());
  pendingBuilds.forEach(({ abortController }) => abortController.abort());
  await Promise.allSettled(pendingBuilds.map(({ promise }) => promise));
  const queuedInput = [
    getIosKeyboardInputQueue(),
    ...Array.from(iosTouchInputQueues.values()),
  ];
  const pendingStarts = [
    ...Array.from(pendingHidHelpersByDeviceId.values()),
  ];
  for (const pending of pendingStarts) {
    void pending.catch(() => undefined);
  }
  const earlyHidHelpers = Array.from(activeHidHelpersByDeviceId.values());
  const earlyHidStops = earlyHidHelpers.map((helper) => helper.stream.stop());
  const [, earlyStopResults] = await Promise.all([
    Promise.allSettled([...queuedInput, nonTouchInputs]),
    Promise.allSettled(earlyHidStops),
  ]);
  collectStopErrors(earlyStopResults);
  const poolEntries = Array.from(coreSimulatorPool.values());
  const activeStops = Array.from(activeCoreSimulatorStreamStops);
  const screenshotStops = Array.from(activeScreenshotStreamStops);
  coreSimulatorPool.clear();
  activeIosAppStatuses.clear();
  activeIosAppRestarts.clear();
  pendingIosSimulatorBootsByDeviceId.clear();
  pendingCoreSimulatorPoolEntries.clear();
  activeScreenshotStreamStops.clear();
  activeCoreSimulatorStreamStops.clear();
  collectStopErrors(
    await Promise.allSettled([
      ...activeStops.map((stop) => stop()),
      ...screenshotStops.map((stop) => stop()),
    ]),
  );
  const hidHelpers = Array.from(activeHidHelpersByDeviceId.values());
  activeHidHelpersByDeviceId.clear();
  pendingHidHelpersByDeviceId.clear();
  iosTouchInputQueues.clear();
  hidHelperReferenceCountsByDeviceId.clear();
  fallbackTouchesByDeviceId.clear();
  activeIosTouchesByDeviceId.clear();
  inputScreenDimensionsByDeviceId.clear();
  iosInputErrorByDeviceId.clear();
  collectStopErrors(
    await Promise.allSettled([
      ...poolEntries.map((entry) => {
        if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
        return entry.stream.stop();
      }),
      ...hidHelpers.map((helper) => helper.stream.stop()),
    ]),
  );
  if (stopErrors.length > 0) {
    const messages = stopErrors.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    throw new AggregateError(
      stopErrors,
      `Failed to dispose iOS preview resources: ${messages.join('; ')}`,
    );
  }
}

export const iosIdbAdapter = {
  getIosAppStatus(
    params: MobilePreviewIosAppStatusParams & {
      trustedRoot: string;
      signal?: AbortSignal;
    },
  ): Promise<MobilePreviewIosAppStatus> {
    const abortController = new AbortController();
    const abortFromExternalSignal = () =>
      abortController.abort(params.signal?.reason);
    if (params.signal?.aborted) abortFromExternalSignal();
    else {
      params.signal?.addEventListener('abort', abortFromExternalSignal, {
        once: true,
      });
    }
    let entry: ActiveIosAppStatus;
    const startedAt = performance.now();
    const promise = (async () => {
      if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');
      debug(
        'iOS app status started deviceId=%s appPath=%s',
        params.deviceId,
        params.appPath,
      );
      assertSafeSimctlDeviceSelector('iOS simulator deviceId', params.deviceId);
      const appPath = await resolveTrustedIosAppRoot({
        trustedRoot: params.trustedRoot,
        appPath: params.appPath,
      });
      abortController.signal.throwIfAborted();
      const resolvedApp = await resolveIosApp({
        ...params,
        appPath,
        signal: abortController.signal,
      });
      abortController.signal.throwIfAborted();
      if (!resolvedApp.bundleId) {
        return {
          appInstalled: null,
          bundleId: null,
          nativeProjectExists: resolvedApp.nativeProjectExists,
        };
      }

      await ensureIosSimulatorBooted(params.deviceId, abortController.signal);
      abortController.signal.throwIfAborted();
      const { stdout } = await runCommand(
        'xcrun',
        ['simctl', 'listapps', params.deviceId, '--json'],
        { signal: abortController.signal },
      );
      const installedApps = await parseSimctlInstalledApps({
        deviceId: params.deviceId,
        output: stdout,
        signal: abortController.signal,
      });
      return {
        ...resolvedApp,
        appInstalled: Object.prototype.hasOwnProperty.call(
          installedApps,
          resolvedApp.bundleId,
        ),
      };
    })().finally(() => {
      debug(
        'iOS app status completed deviceId=%s elapsedMs=%d',
        params.deviceId,
        elapsedMs(startedAt),
      );
      activeIosAppStatuses.delete(entry);
      params.signal?.removeEventListener('abort', abortFromExternalSignal);
    });
    entry = { abortController, promise };
    activeIosAppStatuses.add(entry);
    return promise;
  },

  restartIosApp(
    params: MobilePreviewIosAppRestartParams & { trustedRoot: string },
  ): Promise<MobilePreviewIosAppRestartResult> {
    const abortController = new AbortController();
    let entry: ActiveIosAppRestart;
    const promise = (async () => {
      if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');
      assertSafeSimctlDeviceSelector('iOS simulator deviceId', params.deviceId);
      const appPath = await resolveTrustedIosAppRoot({
        trustedRoot: params.trustedRoot,
        appPath: params.appPath,
      });
      abortController.signal.throwIfAborted();
      const { bundleId } = await resolveIosApp({
        ...params,
        appPath,
        signal: abortController.signal,
      });
      abortController.signal.throwIfAborted();
      if (!bundleId) {
        throw new Error('Unable to detect iOS bundle identifier.');
      }

      try {
        await runCommand('xcrun', [
          'simctl',
          'terminate',
          params.deviceId,
          bundleId,
        ], { signal: abortController.signal });
      } catch (error) {
        if (abortController.signal.aborted || !isAppNotRunningError(error)) {
          throw error;
        }
      }
      abortController.signal.throwIfAborted();
      await runCommand('xcrun', [
        'simctl',
        'launch',
        params.deviceId,
        bundleId,
      ], { signal: abortController.signal });
      return { bundleId, restartedAt: new Date().toISOString() };
    })().finally(() => activeIosAppRestarts.delete(entry));
    entry = { abortController, promise };
    activeIosAppRestarts.add(entry);
    return promise;
  },

  async getIosToolStatus(): Promise<MobilePreviewIosToolStatus> {
    const xcrunPath = (await commandExists('xcrun'))
      ? await getCommandPath('xcrun')
      : null;

    return {
      xcrunPath,
      missingTools: xcrunPath ? [] : ['xcrun'],
    };
  },

  async listIosRuntimes(): Promise<MobilePreviewIosRuntime[]> {
    await assertXcrunAvailable();
    const { stdout } = await runCommand('xcrun', [
      'simctl',
      'list',
      'runtimes',
      '--json',
    ]);
    return parseSimctlRuntimes(stdout);
  },

  async listIosDeviceTypes(): Promise<MobilePreviewIosDeviceType[]> {
    await assertXcrunAvailable();
    const { stdout } = await runCommand('xcrun', [
      'simctl',
      'list',
      'devicetypes',
      '--json',
    ]);
    return parseSimctlDeviceTypes(stdout);
  },

  async createIosDevice(
    params: MobilePreviewIosCreateDeviceParams,
  ): Promise<string> {
    await assertXcrunAvailable();
    assertSafeSimctlValue('iOS simulator name', params.name);
    assertSafeSimctlValue('iOS simulator device type', params.deviceTypeId);
    assertSafeSimctlValue('iOS simulator runtime', params.runtimeId);
    const { stdout } = await runCommand('xcrun', [
      'simctl',
      'create',
      params.name,
      params.deviceTypeId,
      params.runtimeId,
    ]);
    const deviceId = stdout.trim();
    if (!deviceId) {
      throw new Error('xcrun simctl create did not return a device id.');
    }
    return deviceId;
  },

  async deleteIosDevice(deviceId: string): Promise<void> {
    await assertXcrunAvailable();
    assertSafeSimctlDeviceSelector('iOS simulator deviceId', deviceId);
    await runCommand('xcrun', ['simctl', 'delete', deviceId]);
  },

  async eraseIosDevice(deviceId: string): Promise<void> {
    await assertXcrunAvailable();
    assertSafeSimctlDeviceSelector('iOS simulator deviceId', deviceId);
    await runCommand('xcrun', ['simctl', 'erase', deviceId]);
  },

  async renameIosDevice(
    params: MobilePreviewIosRenameDeviceParams,
  ): Promise<void> {
    await assertXcrunAvailable();
    assertSafeSimctlDeviceSelector('iOS simulator deviceId', params.deviceId);
    assertSafeSimctlValue('iOS simulator name', params.name);
    await runCommand('xcrun', [
      'simctl',
      'rename',
      params.deviceId,
      params.name,
    ]);
  },

  async listDevices(): Promise<MobilePreviewDevice[]> {
    await assertXcrunAvailable();
    const { stdout } = await runCommand('xcrun', [
      'simctl',
      'list',
      'devices',
      '--json',
    ]);
    return parseSimctlDevices(stdout);
  },

  async startStream(params: {
    taskId: string;
    deviceId: string;
    fps?: number;
    quality?: MobilePreviewQuality;
    signal?: AbortSignal;
    onFrame: (frame: Buffer) => void;
    onSession: (patch: Partial<MobilePreviewSession>) => void;
  }): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }> {
    const startedAt = performance.now();
    debug(
      'iOS preview start requested taskId=%s deviceId=%s',
      params.taskId,
      params.deviceId,
    );
    params.signal?.throwIfAborted();
    await assertXcrunAvailable(params.signal);
    assertDeviceId(params.deviceId);
    if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');

    const device = await ensureIosSimulatorBooted(
      params.deviceId,
      params.signal,
    );
    params.signal?.throwIfAborted();
    if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');
    debug(
      'iOS preview device resolved deviceId=%s name=%s state=%s elapsedMs=%d',
      device.id,
      device.name,
      device.state,
      elapsedMs(startedAt),
    );

    if (process.env.JC_MOBILE_PREVIEW_IOS_RAW_STREAM !== '1') {
      if (process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR !== '0') {
        try {
          return ownIosStream(
            await createCoreSimulatorFramebufferStream(params, null),
          );
        } catch (error) {
          params.signal?.throwIfAborted();
          // Fall back to simctl screenshots below.
          debug(
            'iOS preview CoreSimulator framebuffer start FAILED, falling back to simctl screenshots deviceId=%s elapsedMs=%d error=%s stack=%s',
            params.deviceId,
            elapsedMs(startedAt),
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error.stack : '',
          );
        }
      }
      if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');

      debug(
        'iOS preview screenshot size probe starting deviceId=%s elapsedMs=%d',
        params.deviceId,
        elapsedMs(startedAt),
      );
      const screenshotSize = await getSimulatorScreenshotSize(
        params.deviceId,
        params.signal,
      );
      params.signal?.throwIfAborted();
      if (isIosPreviewDisposed()) throw new Error('iOS preview is shutting down.');
      debug(
        'iOS preview screenshot size probe completed deviceId=%s width=%d height=%d elapsedMs=%d',
        params.deviceId,
        screenshotSize.width,
        screenshotSize.height,
        elapsedMs(startedAt),
      );
      return ownIosStream(createScreenshotStream(params, screenshotSize));
    }

    await assertIdbAvailable(params.signal);

    return ownIosStream(await createIdbRawVideoStream(params));
  },

  async sendInput(
    deviceId: string,
    event: MobilePreviewInputEvent,
    sessionId?: string,
  ): Promise<void> {
    if (isIosPreviewDisposed()) {
      throw new Error('iOS preview is shutting down.');
    }

    if (event.type === 'showKeyboard') {
      await runIosNonTouchInput(sessionId, (signal) =>
        enqueueIosKeyboardInput(
          () => showIosSoftwareKeyboard(signal),
          sessionId,
        ),
      );
      return;
    }

    if (event.type === 'text') {
      await runIosNonTouchInput(sessionId, (signal) =>
        enqueueIosKeyboardInput(async (isCurrent) => {
          const paste = (text: string) => pasteIosText(text, signal);
          // Prefer device-level HID typing: it does not steal focus from the
          // app window the way Simulator paste (AppleScript) does. Paste stays
          // available (and idb-independent) for unmappable characters.
          try {
            await assertIdbAvailable();
          } catch {
            if (!isCurrent()) return;
            await paste(event.text);
            return;
          }
          if (!isCurrent()) return;
          await sendIosHidText({
            deviceId,
            text: event.text,
            isCurrent,
            paste,
          });
        }, sessionId),
      );
      return;
    }

    if (event.type === 'key' && event.key === 'backspace') {
      await runIosNonTouchInput(sessionId, () =>
        enqueueIosKeyboardInput(async (isCurrent) => {
          await assertIdbAvailable();
          if (!isCurrent()) return;
          await sendIosHidKeyPress(
            deviceId,
            IOS_HID_BACKSPACE_KEYCODE,
            isCurrent,
          );
        }, sessionId),
      );
      return;
    }

    if (event.type === 'key' && event.key === 'enter') {
      await runIosNonTouchInput(sessionId, (signal) =>
        enqueueIosKeyboardInput(async (isCurrent) => {
          await assertIdbAvailable();
          if (!isCurrent()) return;
          await sendIdbUiInputEvent(deviceId, event, isCurrent, signal);
        }, sessionId),
      );
      return;
    }

    if (isTouchLifecycleEvent(event)) {
      await enqueueIosTouchInput(deviceId, async (isCurrent) => {
        await assertIdbAvailable();
        if (!isCurrent()) return;
        const activeTouch = activeIosTouchesByDeviceId.get(deviceId);
        const fallbackTouch = fallbackTouchesByDeviceId.get(deviceId);
        if (event.type === 'touchDown') {
          if (activeTouch && activeTouch.sessionId !== sessionId) {
            const released = await compensateIosTouch(
              deviceId,
              activeTouch.sessionId,
            );
            if (!released || !isCurrent()) return;
          }
          if (fallbackTouch && fallbackTouch.sessionId !== sessionId) {
            await compensateIosTouch(deviceId, fallbackTouch.sessionId);
            if (!isCurrent()) return;
          }
        } else if (activeTouch) {
          if (activeTouch.sessionId !== sessionId) return;
        } else if (fallbackTouch?.sessionId === sessionId) {
          await sendFallbackTouchLifecycleEvent(
            deviceId,
            event,
            sessionId,
            isCurrent,
          );
          return;
        } else {
          return;
        }
        const previousTouch = activeIosTouchesByDeviceId.get(deviceId);
        let provisionalTouch:
          | { sessionId?: string; x: number; y: number }
          | undefined;
        const rollbackProvisionalTouch = () => {
          if (
            provisionalTouch &&
            activeIosTouchesByDeviceId.get(deviceId) === provisionalTouch
          ) {
            if (previousTouch) {
              activeIosTouchesByDeviceId.set(deviceId, previousTouch);
            } else {
              activeIosTouchesByDeviceId.delete(deviceId);
            }
          }
        };
        try {
          const sent = await sendIosHidLifecycleEvent(
            deviceId,
            event,
            isCurrent,
            event.type === 'touchDown'
              ? () => {
                  provisionalTouch = {
                    sessionId,
                    x: event.x,
                    y: event.y,
                  };
                  activeIosTouchesByDeviceId.set(deviceId, provisionalTouch);
                }
              : undefined,
          );
          if (!sent) {
            rollbackProvisionalTouch();
            return;
          }
          if (event.type === 'touchDown') {
            // Provisional ownership becomes final after successful write.
          } else if (event.type === 'touchMove') {
            const touch = activeIosTouchesByDeviceId.get(deviceId);
            if (touch && touch.sessionId === sessionId) {
              touch.x = event.x;
              touch.y = event.y;
            }
          } else if (
            activeIosTouchesByDeviceId.get(deviceId)?.sessionId === sessionId
          ) {
            activeIosTouchesByDeviceId.delete(deviceId);
          }
        } catch (error) {
          rollbackProvisionalTouch();
          if (!isCurrent()) return;
          debug(
            'iOS HID helper input failed; falling back to idb gesture synthesis deviceId=%s event=%s error=%s',
            deviceId,
            event.type,
            error instanceof Error ? error.message : String(error),
          );
          await sendFallbackTouchLifecycleEvent(
            deviceId,
            event,
            sessionId,
            isCurrent,
          );
        }
      }, sessionId);
      return;
    }

    const inputGeneration = getIosInputGeneration();
    const isCurrent = () =>
      !isIosPreviewDisposed() &&
      inputGeneration === getIosInputGeneration() &&
      (!sessionId || activeIosSessionIds.has(sessionId));
    await runIosNonTouchInput(sessionId, async (signal) => {
      await assertIdbAvailable();
      if (!isCurrent()) return;
      await sendIdbUiInputEvent(deviceId, event, isCurrent, signal);
    });
  },

  dispose: disposeIosPreviewResources,

  async openDeeplink(
    deviceId: string,
    url: string,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(
      MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
    );
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
    signal.throwIfAborted();
    await assertXcrunAvailable(signal);
    assertDeviceId(deviceId);
    assertDeeplinkUrl(url);
    try {
      await runCommand('xcrun', ['simctl', 'openurl', deviceId, url], {
        signal,
        timeoutMs: MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('LSApplicationWorkspaceErrorDomain')) {
        const scheme = url.split(':')[0];
        throw new Error(
          `Simulator has no app registered for "${scheme}://". Install the dev client (or Expo Go) on this simulator, then retry.`,
        );
      }
      throw error;
    }
  },

  async setTextSize(
    deviceId: string,
    size: MobilePreviewTextSize,
  ): Promise<void> {
    await assertXcrunAvailable();
    assertDeviceId(deviceId);
    await runCommand('xcrun', [
      'simctl',
      'ui',
      deviceId,
      'content_size',
      IOS_CONTENT_SIZE[size],
    ]);
  },

  async setColorScheme(
    deviceId: string,
    scheme: MobileColorScheme,
  ): Promise<void> {
    await assertXcrunAvailable();
    await runCommand('xcrun', ['simctl', 'ui', deviceId, 'appearance', scheme]);
  },

  async rotate(
    _deviceId: string,
    _direction: MobileRotationDirection,
  ): Promise<void> {
    // iOS preview rotation is applied in the renderer. simctl has no scoped
    // rotate command, and Simulator menu automation can target the wrong window.
  },
};
