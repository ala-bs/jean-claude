import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  MobilePlatform,
  MobilePreviewTextSize,
} from '@shared/mobile-simulator-types';

import { api } from '@/lib/api';
import { formatError } from './utils-preview-error';
import { parsePort } from './utils-device-setup';
import { useMobilePreviewDeepLinksStore } from '@/stores/mobile-preview-deep-links';

const EMPTY_DEEP_LINKS: Array<{ url: string; pinned: boolean }> = [];

export type MobilePreviewAction = 'deeplink' | 'port' | 'text-size';

type ActionsMenuHandle = { toggle: () => void } | null;

/**
 * One-shot device actions: deeplink, dev menu, reload, port forward, text size,
 * copy device id.
 *
 * All of these shared an identical `setIsRunningAction(true) / try / catch ->
 * setInputNotice(formatError(e) ?? fallback) / finally setIsRunningAction(false)`
 * shell, so it lives in `runAction` once.
 *
 * Note: `showActionNotice` deliberately ignores any success message and only
 * clears a stale error — successful actions stay silent. The success strings
 * that used to be passed at each call site were therefore dead and are gone.
 */
export function useMobilePreviewActions({
  platform,
  deviceId,
  projectId,
  metroPort,
  setInputNotice,
  showActionNotice,
}: {
  platform: MobilePlatform;
  deviceId: string;
  projectId: string;
  metroPort: number;
  setInputNotice: (notice: string | null) => void;
  showActionNotice: () => void;
}) {
  const [activeAction, setActiveAction] = useState<MobilePreviewAction | null>(
    null,
  );
  const [deeplinkUrl, setDeeplinkUrl] = useState('');
  const [hostPort, setHostPort] = useState('3000');
  const [devicePort, setDevicePort] = useState('3000');
  const [textSize, setTextSize] = useState<MobilePreviewTextSize>('normal');
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [copiedDeviceId, setCopiedDeviceId] = useState(false);

  const mobileActionsMenuRef = useRef<ActionsMenuHandle>(null);
  const deeplinkInputRef = useRef<HTMLInputElement | null>(null);

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

  // Reset the "copied" affordance whenever the target device changes.
  useEffect(() => {
    queueMicrotask(() => setCopiedDeviceId(false));
  }, [deviceId]);

  const runAction = useCallback(
    async (fallbackError: string, run: () => Promise<void>) => {
      setIsRunningAction(true);
      try {
        await run();
        showActionNotice();
      } catch (error) {
        setInputNotice(formatError(error) ?? fallbackError);
      } finally {
        setIsRunningAction(false);
      }
    },
    [setInputNotice, showActionNotice],
  );

  const handleCopyDeviceId = useCallback(async () => {
    if (!deviceId) return;
    await navigator.clipboard.writeText(deviceId);
    setCopiedDeviceId(true);
    showActionNotice();
  }, [deviceId, showActionNotice]);

  const handleOpenDeeplink = useCallback(async () => {
    if (!deviceId || !deeplinkUrl.trim()) return;
    await runAction('Failed to open deeplink', async () => {
      await api.mobilePreview.openDeeplink({
        platform,
        deviceId,
        url: deeplinkUrl.trim(),
      });
      recordDeepLinkOpened(projectId, deeplinkUrl);
    });
  }, [
    deeplinkUrl,
    deviceId,
    platform,
    projectId,
    recordDeepLinkOpened,
    runAction,
  ]);

  const handleOpenDevMenu = useCallback(async () => {
    if (!deviceId) return;
    await runAction('Failed to open dev menu', () =>
      api.mobilePreview.openDevMenu({ platform, deviceId, metroPort }),
    );
  }, [deviceId, metroPort, platform, runAction]);

  const handleReloadExpo = useCallback(
    () =>
      runAction('Failed to reload Expo', () =>
        api.mobilePreview.reloadExpo({ metroPort }),
      ),
    [metroPort, runAction],
  );

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
    await runAction('Failed to forward port', () =>
      api.mobilePreview.forwardPort({
        platform,
        deviceId,
        hostPort: parsedHostPort,
        devicePort: parsedDevicePort,
      }),
    );
  }, [deviceId, parsedDevicePort, parsedHostPort, platform, runAction]);

  const handleSetTextSize = useCallback(async () => {
    if (!deviceId) return;
    await runAction('Failed to set text size', () =>
      api.mobilePreview.setTextSize({ platform, deviceId, size: textSize }),
    );
  }, [deviceId, platform, runAction, textSize]);

  return {
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
  };
}
