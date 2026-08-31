import { BrowserWindow, type WebContents, WebContentsView } from 'electron';
import { join } from 'path';

import type {
  ReactNativeDevToolsEmbeddedBounds,
  ReactNativeDevToolsEmbeddedBoundsParams,
  ReactNativeDevToolsEmbeddedCloseParams,
  ReactNativeDevToolsEmbeddedOpenParams,
  ReactNativeDevToolsEmbeddedReloadParams,
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
    viewId: string;
    view: WebContentsView;
    lastUsedTick: number;
    cleanupDiagnostics: () => void;
    cleanupOwnerListeners: () => void;
  }
>();

/**
 * Views deliberately outlive the pane that opened them, so nothing in the
 * renderer reliably releases one that is never returned to (a pane reopened on
 * a different device, or the transient `:none` device id). Bound the number of
 * retained views per window and evict the least recently shown, so retention
 * cannot grow into an unbounded pile of live Chromium renderers.
 */
const MAX_EMBEDDED_VIEWS_PER_OWNER = 6;
let embeddedViewTick = 0;

function evictExcessEmbeddedViews(ownerWebContentsId: number) {
  const ownerEntries = Array.from(embeddedViews.entries())
    .filter(([, entry]) => entry.ownerWebContentsId === ownerWebContentsId)
    .sort(([, a], [, b]) => a.lastUsedTick - b.lastUsedTick);
  const excess = ownerEntries.length - MAX_EMBEDDED_VIEWS_PER_OWNER;
  if (excess <= 0) return;

  ownerEntries.slice(0, excess).forEach(([key, entry]) => {
    dbg.mobilePreview(
      'RN DevTools evicting least-recently-used view [%s]',
      entry.viewId,
    );
    disposeEmbeddedView(key);
  });
}

/**
 * Renderer-side view ids look like `rn-devtools:<taskId>:<platform>:<deviceId>`.
 * Views outlive the pane being closed, so task-scoped teardown matches on the
 * task segment rather than the full key.
 */
const EMBEDDED_VIEW_ID_PREFIX = 'rn-devtools:';

function getTaskIdFromViewId(viewId: string) {
  if (!viewId.startsWith(EMBEDDED_VIEW_ID_PREFIX)) return null;
  const rest = viewId.slice(EMBEDDED_VIEW_ID_PREFIX.length);
  const separatorIndex = rest.indexOf(':');
  const taskId = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);
  return taskId.length > 0 ? taskId : null;
}

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

/**
 * The frontend reloads whenever its URL changes, which wipes console and
 * network history. A random per-resolve launch id therefore threw away the
 * session on every refetch, so derive a stable one from the debug target.
 */
function getStableLaunchId({
  metroPort,
  target,
}: {
  metroPort: number;
  target: ReactNativeDevToolsTarget;
}) {
  return `jc-${metroPort}-${encodeURIComponent(target.id)}`;
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


/**
 * Metro may bind the IPv6 wildcard only, so try `localhost` when the IPv4
 * loopback is refused before declaring the dev server unreachable.
 */
async function fetchMetroJsonList(metroPort: number): Promise<Response> {
  let lastError: unknown;
  for (const host of ['127.0.0.1', 'localhost']) {
    try {
      return await fetch(`http://${host}:${metroPort}/json/list`, {
        signal: AbortSignal.timeout(2500),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function describeMetroFetchError(error: unknown, metroPort: number): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message !== 'fetch failed') return message;
  // undici hides the real reason in `cause`; surface something actionable.
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code)
      : '';
  if (code === 'ECONNREFUSED' || code === 'AggregateError' || !code) {
    return `Metro dev server is not reachable on port ${metroPort}. Start it from the Metro tab, then Refresh.`;
  }
  return `Metro dev server request failed on port ${metroPort} (${code})`;
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
    const response = await fetchMetroJsonList(metroPort);
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
    const compatibleTargets = targets.filter(isCompatibleTarget).map((target) => ({
      ...target,
      devtoolsFrontendUrl: absolutizeDevToolsFrontendUrl({
        metroBaseUrl,
        target,
        panel,
        launchId: getStableLaunchId({ metroPort, target }),
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
        ? absolutizeDevToolsFrontendUrl({
            metroBaseUrl,
            target,
            panel,
            launchId: getStableLaunchId({ metroPort, target }),
          })
        : null,
      targets: compatibleTargets,
      error: target ? null : 'No Hermes debug targets found. Launch app and reload it.',
    };
  } catch (error) {
    return {
      metroBaseUrl,
      frontendUrl: null,
      targets: [],
      error: describeMetroFetchError(error, metroPort),
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
      viewId,
      view,
      lastUsedTick: (embeddedViewTick += 1),
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

  const entry = embeddedViews.get(key);
  if (entry) entry.lastUsedTick = (embeddedViewTick += 1);
  // Evict before the await so a burst of opens cannot pile up past the cap.
  evictExcessEmbeddedViews(owner.id);

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

  // Showing a view marks it as recently used, so the view the user is actually
  // looking at is never the eviction candidate.
  if (visible) entry.lastUsedTick = (embeddedViewTick += 1);
  entry.view.setVisible(visible);
}

/**
 * Forces the DevTools frontend to reload.
 *
 * The frontend URL is now a pure function of the Metro port and target id, so
 * a view that survived a Metro or app restart can stay bound to a dead
 * websocket with an identical URL and would never reload on its own. This is
 * the user's escape hatch, wired to the DevTools tab's Refresh button.
 */
export function reloadEmbeddedReactNativeDevTools(
  owner: WebContents,
  { viewId }: ReactNativeDevToolsEmbeddedReloadParams,
): void {
  validateViewId(viewId);
  const entry = embeddedViews.get(getEmbeddedViewKey(owner, viewId));
  if (!entry || entry.view.webContents.isDestroyed()) return;

  dbg.mobilePreview('RN DevTools [%s] reloading frontend', viewId);
  entry.view.webContents.reload();
}

export function closeEmbeddedReactNativeDevTools(
  owner: WebContents,
  { viewId }: ReactNativeDevToolsEmbeddedCloseParams,
): void {
  validateViewId(viewId);
  disposeEmbeddedView(getEmbeddedViewKey(owner, viewId));
}

function disposeEmbeddedViewsWhere(
  predicate: (viewId: string) => boolean,
  reason: string,
): void {
  const keys = Array.from(embeddedViews.entries())
    .filter(([, entry]) => predicate(entry.viewId))
    .map(([key]) => key);
  if (keys.length === 0) return;

  dbg.mobilePreview(
    'RN DevTools disposing %d view(s) (%s)',
    keys.length,
    reason,
  );
  keys.forEach(disposeEmbeddedView);
}

/**
 * Builds the renderer's view id for one device. Must stay in sync with
 * `devToolsViewId` in the mobile preview pane.
 */
export function getReactNativeDevToolsViewId({
  taskId,
  platform,
  deviceId,
}: {
  taskId: string;
  platform: string;
  deviceId: string;
}) {
  return `${EMBEDDED_VIEW_ID_PREFIX}${taskId}:${platform}:${deviceId || 'none'}`;
}

/**
 * Destroys the DevTools view for a single preview session.
 *
 * A task can run previews on several devices at once, each with its own view,
 * so stopping one device must not take down another device's console/network
 * history for the same still-running task.
 */
export function disposeReactNativeDevToolsForSession(params: {
  taskId: string;
  platform: string;
  deviceId: string;
}): void {
  if (typeof params.taskId !== 'string' || params.taskId.length === 0) return;

  const viewId = getReactNativeDevToolsViewId(params);
  disposeEmbeddedViewsWhere(
    (entryViewId) => entryViewId === viewId,
    `session ${viewId}`,
  );
}

/**
 * Destroys every DevTools view belonging to a task, across all windows.
 *
 * Embedded views deliberately survive the preview pane closing so console and
 * network history is still there when it reopens. This is the real teardown
 * point: the preview stopped, or the task was completed or deleted, so the
 * debugger session it was attached to is gone for good.
 */
export function disposeReactNativeDevToolsForTask(taskId: string): void {
  if (typeof taskId !== 'string' || taskId.length === 0) return;

  disposeEmbeddedViewsWhere(
    (viewId) => getTaskIdFromViewId(viewId) === taskId,
    `task ${taskId}`,
  );
}
