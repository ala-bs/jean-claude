import { BrowserWindow, type WebContents, WebContentsView } from 'electron';
import { join } from 'path';

import type {
  ReactNativeDevToolsEmbeddedBounds,
  ReactNativeDevToolsEmbeddedBoundsParams,
  ReactNativeDevToolsEmbeddedCloseParams,
  ReactNativeDevToolsEmbeddedOpenParams,
  ReactNativeDevToolsEmbeddedVisibilityParams,
  ReactNativeDevToolsOpenParams,
  ReactNativeDevToolsPanel,
  ReactNativeDevToolsResolveParams,
  ReactNativeDevToolsResolveResult,
  ReactNativeDevToolsTarget,
} from '@shared/mobile-simulator-types';

import { dbg } from '../lib/debug';

type MetroDevToolsTarget = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  appId?: unknown;
  deviceName?: unknown;
  webSocketDebuggerUrl?: unknown;
  devtoolsFrontendUrl?: unknown;
  reactNative?: {
    capabilities?: {
      nativePageReloads?: unknown;
    };
  };
};

const LEGACY_SYNTHETIC_PAGE_TITLE =
  'React Native Experimental (Improved Chrome Reloads)';
const WEBSOCKET_DIAGNOSTIC_EVENTS = new Set([
  'Network.webSocketCreated',
  'Network.webSocketWillSendHandshakeRequest',
  'Network.webSocketHandshakeResponseReceived',
  'Network.webSocketFrameError',
  'Network.webSocketClosed',
]);

const embeddedViews = new Map<
  string,
  {
    ownerWebContentsId: number;
    ownerWindow: BrowserWindow;
    view: WebContentsView;
    cleanupDiagnostics: () => void;
    cleanupOwnerListeners: () => void;
  }
>();

function asString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function isLoopbackHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function sanitizeUrlForLogs(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function getMetroBaseUrl(metroPort: unknown) {
  if (
    typeof metroPort !== 'number' ||
    !Number.isInteger(metroPort) ||
    metroPort < 1 ||
    metroPort > 65535
  ) {
    throw new Error('Invalid Metro port');
  }

  return `http://127.0.0.1:${metroPort}`;
}

function getEmbeddedViewKey(owner: WebContents, viewId: string) {
  return `${owner.id}:${viewId}`;
}

function validateViewId(viewId: unknown) {
  if (typeof viewId !== 'string' || viewId.trim().length === 0) {
    throw new Error('Invalid DevTools view id');
  }
}

function validateEmbeddedFrontendUrl(frontendUrl: unknown) {
  if (typeof frontendUrl !== 'string') {
    throw new Error('Invalid DevTools frontend URL');
  }

  const url = new URL(frontendUrl);
  if (
    url.protocol !== 'http:' ||
    !isLoopbackHostname(url.hostname)
  ) {
    throw new Error('DevTools frontend must be served from localhost Metro');
  }
  if (url.pathname !== '/debugger-frontend/rn_fusebox.html') {
    throw new Error('Unsupported DevTools frontend URL');
  }
  if (!url.searchParams.has('ws') && !url.searchParams.has('wss')) {
    throw new Error('DevTools frontend URL is missing websocket target');
  }
  validateEmbeddedWebSocketTarget(url, url.searchParams.get('ws'));
  validateEmbeddedWebSocketTarget(url, url.searchParams.get('wss'));

  return url.toString();
}

function validateEmbeddedWebSocketTarget(frontendUrl: URL, target: string | null) {
  if (!target) return;

  const targetUrl = target.startsWith('/')
    ? new URL(target, frontendUrl.origin)
    : new URL(
        target.startsWith('ws://') || target.startsWith('wss://')
          ? target
          : `ws://${target}`,
      );
  if (targetUrl.hostname !== frontendUrl.hostname) {
    throw new Error('DevTools websocket target must use the frontend host');
  }
  if (targetUrl.port !== frontendUrl.port) {
    throw new Error('DevTools websocket target must use the Metro port');
  }
}

function validateBounds(bounds: ReactNativeDevToolsEmbeddedBounds) {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every((value) => Number.isFinite(value))) {
    throw new Error('Invalid DevTools bounds');
  }

  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

function getPreloadPath() {
  return join(__dirname, '../preload/react-native-devtools.mjs');
}

function disposeEmbeddedView(key: string) {
  const entry = embeddedViews.get(key);
  if (!entry) return;

  entry.cleanupOwnerListeners();
  entry.cleanupDiagnostics();
  if (!entry.ownerWindow.isDestroyed()) {
    entry.ownerWindow.contentView.removeChildView(entry.view);
  }
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.close();
  }
  embeddedViews.delete(key);
}

function attachDevToolsDiagnostics(view: WebContentsView, viewId: string) {
  const { webContents } = view;
  const handlePreloadError = (
    _event: Electron.Event,
    _preloadPath: string,
    _error: Error,
  ) => {
    dbg.mobilePreview('RN DevTools [%s] preload failed', viewId);
  };
  const handleFailedLoad = (
    _event: Electron.Event,
    code: number,
    _description: string,
    url: string,
  ) => {
    dbg.mobilePreview(
      'RN DevTools [%s] load failed code=%d url=%s',
      viewId,
      code,
      sanitizeUrlForLogs(url) ?? 'unknown',
    );
  };
  const handleFinishedLoad = () => {
    dbg.mobilePreview(
      'RN DevTools [%s] frontend loaded url=%s',
      viewId,
      sanitizeUrlForLogs(webContents.getURL()) ?? 'unknown',
    );
  };
  const handleRenderProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
    dbg.mobilePreview('RN DevTools [%s] renderer gone details=%O', viewId, details);
  };
  webContents.on('preload-error', handlePreloadError);
  webContents.on('did-fail-load', handleFailedLoad);
  webContents.on('did-finish-load', handleFinishedLoad);
  webContents.on('render-process-gone', handleRenderProcessGone);
  const removeLifecycleListeners = () => {
    webContents.removeListener('preload-error', handlePreloadError);
    webContents.removeListener('did-fail-load', handleFailedLoad);
    webContents.removeListener('did-finish-load', handleFinishedLoad);
    webContents.removeListener('render-process-gone', handleRenderProcessGone);
  };

  let cleanup = () => {};
  try {
    webContents.debugger.attach('1.3');
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const handleMessage = (
      _event: Electron.Event,
      method: string,
      params: Record<string, any>,
    ) => {
      if (!WEBSOCKET_DIAGNOSTIC_EVENTS.has(method)) return;

      let details: Record<string, unknown>;
      switch (method) {
        case 'Network.webSocketCreated':
          details = { url: sanitizeUrlForLogs(params.url) };
          break;
        case 'Network.webSocketWillSendHandshakeRequest':
          details = {
            url: sanitizeUrlForLogs(params.request?.url),
            origin:
              params.request?.headers?.Origin ?? params.request?.headers?.origin,
          };
          break;
        case 'Network.webSocketHandshakeResponseReceived':
          details = {
            url: sanitizeUrlForLogs(params.response?.url),
            status: params.response?.status,
            statusText: params.response?.statusText,
          };
          break;
        case 'Network.webSocketFrameError':
          details = { frameError: true };
          break;
        default:
          details = {};
      }
      dbg.mobilePreview('RN DevTools [%s] %s %O', viewId, method, details);
    };
    cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      removeLifecycleListeners();
      webContents.debugger.removeListener('message', handleMessage);
      if (!webContents.isDestroyed() && webContents.debugger.isAttached()) {
        webContents.debugger.detach();
      }
    };
    timeout = setTimeout(cleanup, 15_000);
    void webContents.debugger.sendCommand('Network.enable').catch(() => {
      dbg.mobilePreview(
        'RN DevTools [%s] could not enable CDP network diagnostics',
        viewId,
      );
      cleanup();
    });
    webContents.debugger.on('message', handleMessage);
    dbg.mobilePreview('RN DevTools [%s] CDP diagnostics attached', viewId);
  } catch {
    removeLifecycleListeners();
    dbg.mobilePreview(
      'RN DevTools [%s] could not attach CDP diagnostics',
      viewId,
    );
  }

  return cleanup;
}

function disposeEmbeddedViewsForOwner(ownerWebContentsId: number) {
  for (const [key, entry] of embeddedViews) {
    if (entry.ownerWebContentsId === ownerWebContentsId) {
      disposeEmbeddedView(key);
    }
  }
}

function normalizeTarget(target: MetroDevToolsTarget): ReactNativeDevToolsTarget | null {
  const id = asString(target.id);
  const title = asString(target.title);
  const webSocketDebuggerUrl = asString(target.webSocketDebuggerUrl);
  if (!id || !title || !webSocketDebuggerUrl) return null;

  return {
    id,
    title,
    description: asString(target.description),
    appId: asString(target.appId),
    deviceName: asString(target.deviceName),
    webSocketDebuggerUrl,
    devtoolsFrontendUrl: asString(target.devtoolsFrontendUrl),
    nativePageReloads:
      target.reactNative?.capabilities?.nativePageReloads === true,
  };
}

function isCompatibleTarget(target: ReactNativeDevToolsTarget) {
  return target.title === LEGACY_SYNTHETIC_PAGE_TITLE || target.nativePageReloads;
}

function getPanelParam(panel: ReactNativeDevToolsPanel | undefined) {
  switch (panel) {
    case 'network':
      return 'network';
    case 'components':
      return 'components';
    case 'console':
    default:
      return 'console';
  }
}

function buildDevToolsFrontendUrl({
  metroBaseUrl,
  target,
  panel,
  launchId,
}: {
  metroBaseUrl: string;
  target: ReactNativeDevToolsTarget;
  panel?: ReactNativeDevToolsPanel;
  launchId?: string;
}) {
  const targetUrl = new URL(target.webSocketDebuggerUrl);
  const metroUrl = new URL(metroBaseUrl);
  if (
    isLoopbackHostname(targetUrl.hostname) &&
    isLoopbackHostname(metroUrl.hostname) &&
    targetUrl.hostname !== metroUrl.hostname
  ) {
    targetUrl.hostname = metroUrl.hostname;
  }
  const params = new URLSearchParams({
    'sources.hide_add_folder': 'true',
    panel: getPanelParam(panel),
  });
  const wsValue =
    targetUrl.host === metroUrl.host
      ? `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
      : `${targetUrl.host}${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  params.set(targetUrl.protocol === 'wss:' ? 'wss' : 'ws', wsValue);
  params.set('unstable_enableNetworkPanel', 'true');
  if (target.appId) params.set('appId', target.appId);
  if (launchId) params.set('launchId', launchId);

  return `${metroUrl.origin}/debugger-frontend/rn_fusebox.html?${params.toString()}`;
}

function absolutizeDevToolsFrontendUrl({
  metroBaseUrl,
  target,
  panel,
  launchId,
}: {
  metroBaseUrl: string;
  target: ReactNativeDevToolsTarget;
  panel?: ReactNativeDevToolsPanel;
  launchId?: string;
}) {
  return buildDevToolsFrontendUrl({ metroBaseUrl, target, panel, launchId });
}

export async function resolveReactNativeDevTools({
  metroPort,
  panel,
}: ReactNativeDevToolsResolveParams): Promise<ReactNativeDevToolsResolveResult> {
  let metroBaseUrl: string;
  try {
    metroBaseUrl = getMetroBaseUrl(metroPort);
  } catch (error) {
    return {
      metroBaseUrl: 'http://localhost',
      frontendUrl: null,
      targets: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const response = await fetch(`${metroBaseUrl}/json/list`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      throw new Error(`Metro returned ${response.status}`);
    }

    const body = await response.json();
    const targets = Array.isArray(body)
      ? body.flatMap((target) => {
          const normalized = normalizeTarget(target as MetroDevToolsTarget);
          return normalized ? [normalized] : [];
        })
      : [];
    const launchId = crypto.randomUUID();
    const compatibleTargets = targets.filter(isCompatibleTarget).map((target) => ({
      ...target,
      devtoolsFrontendUrl: absolutizeDevToolsFrontendUrl({
        metroBaseUrl,
        target,
        panel,
        launchId,
      }),
    }));
    const target = compatibleTargets[compatibleTargets.length - 1] ?? null;

    dbg.mobilePreview(
      'RN DevTools resolved metro=%s targets=%d compatible=%d',
      metroBaseUrl,
      targets.length,
      compatibleTargets.length,
    );

    return {
      metroBaseUrl,
      frontendUrl: target
        ? absolutizeDevToolsFrontendUrl({ metroBaseUrl, target, panel, launchId })
        : null,
      targets: compatibleTargets,
      error: target ? null : 'No Hermes debug targets found. Launch app and reload it.',
    };
  } catch (error) {
    return {
      metroBaseUrl,
      frontendUrl: null,
      targets: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function openReactNativeDevTools({
  metroPort,
  panel,
  targetId,
}: ReactNativeDevToolsOpenParams): Promise<void> {
  const metroBaseUrl = getMetroBaseUrl(metroPort);
  const url = new URL('/open-debugger', metroBaseUrl);
  if (targetId) url.searchParams.set('target', targetId);
  url.searchParams.set('panel', getPanelParam(panel));

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Metro could not open DevTools (${response.status})`);
  }
}

export async function openEmbeddedReactNativeDevTools(
  owner: WebContents,
  { viewId, frontendUrl, bounds }: ReactNativeDevToolsEmbeddedOpenParams,
): Promise<void> {
  validateViewId(viewId);
  const safeUrl = validateEmbeddedFrontendUrl(frontendUrl);
  const safeBounds = validateBounds(bounds);
  const ownerWindow = BrowserWindow.fromWebContents(owner);
  if (!ownerWindow) {
    throw new Error('DevTools owner window not found');
  }

  const key = getEmbeddedViewKey(owner, viewId);
  const existing = embeddedViews.get(key);
  const view =
    existing?.view ??
    new WebContentsView({
      webPreferences: {
        partition: 'persist:react-native-devtools',
        preload: getPreloadPath(),
        sandbox: false,
      },
    });

  if (!existing) {
    const disposeForOwner = () => disposeEmbeddedViewsForOwner(owner.id);
    const cleanupDiagnostics = attachDevToolsDiagnostics(view, viewId);
    embeddedViews.set(key, {
      ownerWebContentsId: owner.id,
      ownerWindow,
      view,
      cleanupDiagnostics,
      cleanupOwnerListeners: () => {
        owner.removeListener('destroyed', disposeForOwner);
        ownerWindow.removeListener('closed', disposeForOwner);
      },
    });
    ownerWindow.contentView.addChildView(view);
    owner.once('destroyed', disposeForOwner);
    ownerWindow.once('closed', disposeForOwner);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  view.setBounds(safeBounds);
  if (view.webContents.getURL() !== safeUrl) {
    dbg.mobilePreview(
      'RN DevTools [%s] loading frontend url=%s',
      viewId,
      sanitizeUrlForLogs(safeUrl) ?? 'unknown',
    );
    await view.webContents.loadURL(safeUrl);
  }
}

export function setEmbeddedReactNativeDevToolsBounds(
  owner: WebContents,
  { viewId, bounds }: ReactNativeDevToolsEmbeddedBoundsParams,
): void {
  validateViewId(viewId);
  const entry = embeddedViews.get(getEmbeddedViewKey(owner, viewId));
  if (!entry) return;

  entry.view.setBounds(validateBounds(bounds));
}

export function setEmbeddedReactNativeDevToolsVisibility(
  owner: WebContents,
  { viewId, visible }: ReactNativeDevToolsEmbeddedVisibilityParams,
): void {
  validateViewId(viewId);
  const entry = embeddedViews.get(getEmbeddedViewKey(owner, viewId));
  if (!entry) return;

  entry.view.setVisible(visible);
}

export function closeEmbeddedReactNativeDevTools(
  owner: WebContents,
  { viewId }: ReactNativeDevToolsEmbeddedCloseParams,
): void {
  validateViewId(viewId);
  disposeEmbeddedView(getEmbeddedViewKey(owner, viewId));
}
