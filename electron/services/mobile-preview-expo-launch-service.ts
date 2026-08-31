import { isAbsolute, join, relative } from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import type {
  MobilePreviewExpoLaunchParams,
  MobilePreviewExpoLaunchResult,
  MobilePreviewOpenDeeplinkParams,
} from '../../shared/mobile-simulator-types';
import { createMobileDevServerCommandId } from '../../shared/mobile-preview-runtime';
import type { RunStatus } from '../../shared/run-command-types';

import { ProjectRepository, TaskRepository } from '../database/repositories';
import {
  resolvePathInsideRoot,
  resolveTrustedTaskRoot,
} from './mobile-preview-path-resolver';
import { isKnownPhysicalIosDevice } from './mobile-preview-ios-devicectl';
import { mobilePreviewService } from './mobile-preview-service';
import { runCommandService } from './run-command-service';

type ProjectScope = {
  id: string;
  path: string;
};

type TaskScope = {
  projectId: string;
  worktreePath: string | null;
};

const BLOCKED_PROTOCOLS = new Set([
  'about:',
  'app-prefs:',
  'app-settings:',
  'android-app:',
  'blob:',
  'browser:',
  'chrome:',
  'chrome-extension:',
  'content:',
  'data:',
  'devtools:',
  'edge:',
  'facetime:',
  'facetime-audio:',
  'file:',
  'filesystem:',
  'firefox:',
  'geo:',
  'intent:',
  'itms-apps:',
  'javascript:',
  'mailto:',
  'market:',
  'moz-extension:',
  'opera:',
  'prefs:',
  'resource:',
  'safari:',
  'settings:',
  'shortcuts:',
  'sms:',
  'tel:',
  'view-source:',
  'vbscript:',
  'workflow:',
  'x-apple.systempreferences:',
]);

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_STATIC_EXPO_CONFIG_BYTES = 64 * 1024;

class ExpoLaunchTransportError extends Error {
  readonly timedOut: boolean;
  readonly connectionRefused: boolean;

  constructor(
    message: string,
    timedOut = false,
    connectionRefused = false,
  ) {
    super(message);
    this.name = 'ExpoLaunchTransportError';
    this.timedOut = timedOut;
    this.connectionRefused = connectionRefused;
  }
}

function isConnectionRefused(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code)
      : '';
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    (cause instanceof Error && cause.message.includes('ECONNREFUSED'))
  );
}

function assertParams(
  params: MobilePreviewExpoLaunchParams,
): asserts params is MobilePreviewExpoLaunchParams {
  if (
    !params ||
    typeof params !== 'object' ||
    !['requestId', 'taskId', 'projectId', 'appPath', 'deviceId'].every(
      (key) =>
        typeof (params as unknown as Record<string, unknown>)[key] === 'string' &&
        Boolean((params as unknown as Record<string, string>)[key].trim()),
    ) ||
    (params.platform !== 'ios' && params.platform !== 'android')
  ) {
    throw new Error('Invalid Expo launch request');
  }
  if (
    !Number.isInteger(params.metroPort) ||
    params.metroPort < 1 ||
    params.metroPort > 65_535
  ) {
    throw new Error('Invalid Metro port');
  }
}

async function parseLaunchUrl(
  value: unknown,
  {
    getTrustedSchemes,
    responseScheme,
  }: {
    getTrustedSchemes: () => Promise<ReadonlySet<string>>;
    responseScheme?: string;
  },
): Promise<string> {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('Malformed Expo launch response: invalid URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Malformed Expo launch response: invalid URL');
  }

  const protocol = parsed.protocol.toLowerCase();
  if (BLOCKED_PROTOCOLS.has(protocol)) {
    throw new Error(
      `Malformed Expo launch response: unsafe or unsupported URL protocol ${protocol}`,
    );
  }
  const standardProtocol = ['exp:', 'exps:', 'http:', 'https:'].includes(
    protocol,
  );
  const customProtocol =
    !standardProtocol && /^[a-z][a-z\d+.-]*:/i.test(value);
  if (!standardProtocol && !customProtocol) {
    throw new Error(
      `Malformed Expo launch response: unsafe or unsupported URL protocol ${protocol}`,
    );
  }
  if (
    customProtocol &&
    responseScheme &&
    protocol !== `${responseScheme}:`
  ) {
    throw new Error(
      'Malformed Expo launch response: custom URL protocol does not match Expo response scheme',
    );
  }
  if (customProtocol) {
    const trustedSchemes = await getTrustedSchemes();
    const scheme = protocol.slice(0, -1);
    // Development builds are reached through `exp+<scheme>://`, which Expo
    // derives from the app's own (trusted) scheme.
    const devClientBase = scheme.startsWith('exp+') ? scheme.slice(4) : null;
    if (
      !trustedSchemes.has(scheme) &&
      !(devClientBase && trustedSchemes.has(devClientBase))
    ) {
      throw new Error(
        'Expo launch custom URL protocol is not configured by trusted app config',
      );
    }
  }
  return value;
}

function isSameOrChildPath(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function resolveOptionalConfigPath(
  appRoot: string,
  fileName: string,
): Promise<string | null> {
  try {
    const configPath = await realpath(join(appRoot, fileName));
    if (!isSameOrChildPath(appRoot, configPath)) {
      throw new Error('Expo config resolves outside validated app scope');
    }
    return configPath;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function readStaticExpoConfig(
  appRoot: string,
  fileName: string,
): Promise<Record<string, unknown> | null> {
  const configPath = await resolveOptionalConfigPath(appRoot, fileName);
  if (!configPath) return null;
  const handle = await open(
    configPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_STATIC_EXPO_CONFIG_BYTES) {
      throw new Error(
        `Static Expo config ${fileName} must be a file no larger than ${MAX_STATIC_EXPO_CONFIG_BYTES} bytes`,
      );
    }
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Static Expo config ${fileName} must contain an object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Static Expo config ${fileName} contains invalid JSON`);
    }
    throw error;
  } finally {
    await handle.close();
  }
}

function addTrustedScheme(schemes: Set<string>, value: unknown): void {
  if (typeof value !== 'string' || !/^[a-z][a-z\d+.-]*$/i.test(value)) {
    throw new Error('Expo scheme must be a valid URI scheme');
  }
  const scheme = value.toLowerCase();
  if (BLOCKED_PROTOCOLS.has(`${scheme}:`)) {
    throw new Error(`Expo scheme ${scheme} is an unsafe OS or control protocol`);
  }
  schemes.add(scheme);
}

function extractTrustedSchemes(config: Record<string, unknown>): Set<string> {
  const schemes = new Set<string>();
  if (config.scheme !== undefined) {
    const configuredSchemes = Array.isArray(config.scheme)
      ? config.scheme
      : [config.scheme];
    for (const scheme of configuredSchemes) addTrustedScheme(schemes, scheme);
  }
  if (config.slug !== undefined) {
    if (typeof config.slug !== 'string' || !config.slug.trim()) {
      throw new Error('Expo slug must be a non-empty string');
    }
    addTrustedScheme(schemes, `exp+${config.slug.trim()}`);
  }
  return schemes;
}

export async function resolveExpoAppSchemes(
  appPath: string,
): Promise<Set<string>> {
  const appRoot = await realpath(appPath);
  for (const fileName of [
    'app.config.js',
    'app.config.ts',
    'app.config.mjs',
    'app.config.cjs',
  ]) {
    if (await resolveOptionalConfigPath(appRoot, fileName)) {
      throw new Error(
        'Dynamic Expo config cannot be safely resolved for mobile launch. Define scheme and slug in static app.config.json, app.json, or package.json expo config.',
      );
    }
  }

  for (const fileName of ['app.config.json', 'app.json', 'package.json']) {
    const config = await readStaticExpoConfig(appRoot, fileName);
    if (!config) continue;
    const expoValue = config.expo;
    if (fileName === 'package.json' && expoValue === undefined) {
      return new Set();
    }
    const expoConfig =
      expoValue && typeof expoValue === 'object' && !Array.isArray(expoValue)
        ? (expoValue as Record<string, unknown>)
        : fileName === 'package.json'
          ? null
          : config;
    if (!expoConfig) {
      throw new Error(`Static Expo config ${fileName} has invalid expo config`);
    }
    return extractTrustedSchemes(expoConfig);
  }
  return new Set();
}

/**
 * Development builds register `exp+<scheme>://`, Expo Go registers `exp://`.
 * The dev server only tells them apart through `?choice=`, so pick based on
 * whether the app depends on `expo-dev-client`.
 */
function normalizeConfiguredScheme(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const scheme = value.trim().toLowerCase().replace(/:\/*$/, '');
  if (!scheme || !/^[a-z][a-z\d+.-]*$/.test(scheme)) return null;
  if (BLOCKED_PROTOCOLS.has(`${scheme}:`)) return null;
  return scheme;
}

export async function resolveUsesExpoDevClient(
  appPath: string,
): Promise<boolean> {
  const appRoot = await realpath(appPath);
  const packageJson = await readStaticExpoConfig(appRoot, 'package.json').catch(
    () => null,
  );
  if (!packageJson) return false;
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = packageJson[field];
    if (
      deps &&
      typeof deps === 'object' &&
      !Array.isArray(deps) &&
      Object.prototype.hasOwnProperty.call(deps, 'expo-dev-client')
    ) {
      return true;
    }
  }
  return false;
}

function parseOptionalScheme(
  value: Record<string, unknown>,
): string | undefined {
  if (!('scheme' in value) || value.scheme === null) return undefined;
  if (
    typeof value.scheme !== 'string' ||
    !/^[a-z][a-z\d+.-]*:?$/i.test(value.scheme)
  ) {
    throw new Error('Malformed Expo launch response: invalid scheme');
  }
  return value.scheme.replace(/:$/, '').toLowerCase();
}

function parseOptionalString(
  value: Record<string, unknown>,
  key: 'runtime',
): string | undefined {
  if (!(key in value)) return undefined;
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error(`Malformed Expo launch response: invalid ${key}`);
  }
  return field;
}

function parseOptionalAppId(
  value: Record<string, unknown>,
): string | null | undefined {
  if (!('appId' in value)) return undefined;
  const appId = value.appId;
  if (appId === null) return null;
  if (typeof appId !== 'string' || !appId.trim()) {
    throw new Error('Malformed Expo launch response: invalid appId');
  }
  return appId;
}

async function parseCurrentResponse(
  body: string,
  getTrustedSchemes: () => Promise<ReadonlySet<string>>,
): Promise<MobilePreviewExpoLaunchResult> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('Malformed Expo launch response: invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed Expo launch response: expected JSON object');
  }

  const record = value as Record<string, unknown>;
  if (record.url === null || record.url === undefined) {
    throw new Error(
      'Expo launch URL unavailable; check Expo project configuration',
    );
  }
  const runtime = parseOptionalString(record, 'runtime');
  const appId = parseOptionalAppId(record);
  const scheme = parseOptionalScheme(record);
  return {
    url: await parseLaunchUrl(record.url, {
      getTrustedSchemes,
      responseScheme: scheme,
    }),
    ...(runtime !== undefined && { runtime }),
    ...(appId !== undefined && { appId }),
  };
}

/**
 * Hosts that resolve to the machine issuing the request. On a physical device
 * these point at the PHONE's own loopback, where no Metro is listening.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackLaunchHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** Metro origin carried inside a dev-client link's `url` query parameter. */
function readNestedLaunchUrl(parsed: URL): URL | null {
  const nested = parsed.searchParams.get('url');
  if (!nested) return null;
  try {
    return new URL(nested);
  } catch {
    return null;
  }
}

/**
 * Whether `url` advertises a Metro host a physical device cannot reach.
 *
 * `exp+<slug>://expo-development-client/?url=http://127.0.0.1:8081` puts the
 * Metro origin in the query, not in the host, so both are checked.
 */
export function launchUrlNeedsLanRewrite(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname && isLoopbackLaunchHost(parsed.hostname)) return true;
  const nested = readNestedLaunchUrl(parsed);
  return Boolean(nested?.hostname && isLoopbackLaunchHost(nested.hostname));
}

/**
 * Replaces loopback hosts in an Expo launch URL with the Mac's LAN address.
 * Scheme, port, path and every other query parameter are preserved: the URL is
 * parsed, not string-substituted, so `exp://`, `exps://` and custom
 * `exp+<slug>://` links all round-trip. A URL with no loopback host is returned
 * unchanged (identical string, not a re-serialization).
 */
export function rewriteLaunchUrlToLanAddress({
  url,
  lanAddress,
}: {
  url: string;
  lanAddress: string;
}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  if (parsed.hostname && isLoopbackLaunchHost(parsed.hostname)) {
    parsed.hostname = lanAddress;
    changed = true;
  }
  const nested = readNestedLaunchUrl(parsed);
  if (nested?.hostname && isLoopbackLaunchHost(nested.hostname)) {
    nested.hostname = lanAddress;
    parsed.searchParams.set('url', nested.toString());
    changed = true;
  }
  return changed ? parsed.toString() : url;
}

export function createMobilePreviewExpoLaunchService(deps: {
  findProjectById: (id: string) => Promise<ProjectScope | undefined>;
  findTaskById: (id: string) => Promise<TaskScope | undefined>;
  resolveTaskRoot: typeof resolveTrustedTaskRoot;
  resolveAppPath: typeof resolvePathInsideRoot;
  resolveAppSchemes: (appPath: string) => Promise<Set<string>>;
  resolveUsesDevClient?: (appPath: string) => Promise<boolean>;
  getRunStatus: (taskId: string) => RunStatus;
  fetch: typeof fetch;
  openDeeplink: (
    params: MobilePreviewOpenDeeplinkParams,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * Injectable so the service stays testable. Backed by the physical-device
   * registry in `mobile-preview-ios-devicectl`; never inferred from the id
   * format (CoreDevice and CoreSimulator ids are both UUID-shaped).
   */
  isPhysicalIosDevice?: (deviceId: string) => boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  connectRetryWindowMs?: number;
}) {
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const transportRetryDelayMs = Math.min(250, Math.max(25, timeoutMs / 10));
  // Metro reports "running" (log line / port claim) slightly before it accepts
  // connections, so a connection-refused is usually "not ready yet".
  const connectRetryWindowMs = deps.connectRetryWindowMs ?? 30_000;
  const latestRequestIds = new Map<string, string>();
  const activeRequestControllers = new Map<string, AbortController>();
  const deviceOpenTails = new Map<string, Promise<void>>();

  async function waitForTurn(
    previous: Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    let rejectOnAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const onAbort = () => rejectOnAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([previous, aborted]);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function withDeviceOpenLock<T>(
    deviceKey: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = (deviceOpenTails.get(deviceKey) ?? Promise.resolve()).catch(
      () => {},
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    deviceOpenTails.set(deviceKey, current);
    void current.finally(() => {
      if (deviceOpenTails.get(deviceKey) === current) {
        deviceOpenTails.delete(deviceKey);
      }
    });
    try {
      await waitForTurn(previous, signal);
      signal.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  function cancelUnusedBody(response: Response): void {
    void response.body?.cancel().catch(() => {});
  }

  async function readBoundedBody(
    response: Response,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const contentLength = response.headers.get('content-length');
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > maxResponseBytes
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error(
        `Expo launch response exceeds ${maxResponseBytes} bytes`,
      );
    }
    if (!response.body) return '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let byteLength = 0;
    let rejectOnAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const onAbort = () => {
      void reader.cancel(signal.reason).catch(() => {});
      rejectOnAbort(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        signal.throwIfAborted();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maxResponseBytes) {
          void reader.cancel().catch(() => {});
          throw new Error(
            `Expo launch response exceeds ${maxResponseBytes} bytes`,
          );
        }
        body += decoder.decode(value, { stream: true });
      }
      return body + decoder.decode();
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        reader.releaseLock();
      } catch {
        // A cancelled pending read may retain the lock until it settles.
      }
    }
  }

  async function request<T>(
    url: URL,
    handleResponse: (
      response: Response,
      signal: AbortSignal,
    ) => Promise<T> | T,
    externalSignal: AbortSignal,
  ): Promise<T> {
    externalSignal.throwIfAborted();
    const timeoutController = new AbortController();
    const signal = AbortSignal.any([
      externalSignal,
      timeoutController.signal,
    ]);
    const timer = setTimeout(() => {
      timeoutController.abort(
        new DOMException('Expo launch request timed out', 'TimeoutError'),
      );
    }, timeoutMs);
    timer.unref();
    try {
      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (externalSignal.aborted) {
          externalSignal.throwIfAborted();
        }
        if (timeoutController.signal.aborted) {
          throw new ExpoLaunchTransportError(
            'Expo launch request timed out',
            true,
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        const cause = error instanceof Error ? error.cause : undefined;
        const causeMessage =
          cause instanceof Error
            ? `${cause.name}: ${cause.message}${
                'code' in cause && cause.code ? ` (${String(cause.code)})` : ''
              }`
            : cause
              ? String(cause)
              : 'none';
        console.error(
          '[expo-launch] fetch failed',
          JSON.stringify({
            url: url.toString(),
            message,
            cause: causeMessage,
          }),
        );
        throw new ExpoLaunchTransportError(
          `Expo launch request failed: ${message} (cause: ${causeMessage})`,
          false,
          isConnectionRefused(error),
        );
      }
      try {
        return await handleResponse(response, signal);
      } catch (error) {
        if (externalSignal.aborted) {
          externalSignal.throwIfAborted();
        }
        if (timeoutController.signal.aborted) {
          throw new ExpoLaunchTransportError(
            'Expo launch request timed out',
            true,
          );
        }
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestWithTransportRetry<T>(
    url: URL,
    handleResponse: (
      response: Response,
      signal: AbortSignal,
    ) => Promise<T> | T,
    signal: AbortSignal,
  ): Promise<T> {
    // Metro binds on the IPv6 wildcard in some setups; if the IPv4 loopback
    // is refused, `localhost` (which resolves to ::1 too) still reaches it.
    const hosts =
      url.hostname === '127.0.0.1' ? ['127.0.0.1', 'localhost'] : [url.hostname];
    const attemptUrl = (index: number) => {
      const next = new URL(url);
      next.hostname = hosts[index % hosts.length];
      return next;
    };

    const startedAt = Date.now();
    let attempt = 0;
    let delay = transportRetryDelayMs;
    for (;;) {
      try {
        return await request(attemptUrl(attempt), handleResponse, signal);
      } catch (error) {
        if (!(error instanceof ExpoLaunchTransportError) || error.timedOut) {
          throw error;
        }
        attempt += 1;
        const elapsed = Date.now() - startedAt;
        // Connection refused = dev server not accepting yet; keep waiting for
        // it within the readiness window. Other transport errors get one retry.
        const keepRetrying = error.connectionRefused
          ? elapsed + delay < connectRetryWindowMs
          : attempt < hosts.length;
        if (!keepRetrying) throw error;

        const waitMs = delay;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, waitMs);
          const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          timer.unref();
        });
        delay = Math.min(delay * 2, 2_000);
      }
    }
  }

  async function requestLegacy(
    baseUrl: URL,
    platform: MobilePreviewExpoLaunchParams['platform'],
    getTrustedSchemes: () => Promise<ReadonlySet<string>>,
    signal: AbortSignal,
    usesDevClient = false,
  ): Promise<MobilePreviewExpoLaunchResult> {
    const url = new URL('/_expo/link', baseUrl);
    url.searchParams.set('platform', platform);
    // Without `choice` the dev server always answers with the Expo Go link
    // (`exp://`), which a development build cannot open.
    url.searchParams.set(
      'choice',
      usesDevClient ? 'expo-dev-client' : 'expo-go',
    );
    return requestWithTransportRetry(url, async (response) => {
      cancelUnusedBody(response);
      if (response.status === 404) {
        throw new Error('Expo server does not support device launch');
      }
      if (response.status < 300 || response.status >= 400) {
        throw new Error(`Expo launch request failed: HTTP ${response.status}`);
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(
          'Malformed Expo launch response: legacy redirect has no Location',
        );
      }
      return {
        url: await parseLaunchUrl(location, { getTrustedSchemes }),
      };
    }, signal);
  }

  /**
   * Deeplink launching is simulator-only on iOS.
   *
   * The launch ends in `openDeeplink`, which on iOS is `xcrun simctl openurl` —
   * a CoreSimulator command that cannot address a CoreDevice. There is no
   * devicectl equivalent that opens a bare URL: `devicectl device process
   * launch` can carry a payload URL but requires the target bundle id, which
   * this request does not carry (and the app must already be installed).
   *
   * So we refuse up front instead of doing the Metro round-trip and the LAN
   * rewrite and then failing inside `openDeeplink` with a guard message that
   * says nothing about what the user should do instead.
   */
  function assertDeeplinkLaunchSupported(
    params: MobilePreviewExpoLaunchParams,
  ): void {
    if (params.platform !== 'ios') return;
    if (!(deps.isPhysicalIosDevice?.(params.deviceId) ?? false)) return;
    throw new Error(
      'Opening the dev server in an already-installed app is not supported on physical iOS devices yet. Use Build & Run instead (`expo run:ios --device`), which installs the app on the device and launches it against this dev server.',
    );
  }

  return {
    async launch(
      params: MobilePreviewExpoLaunchParams,
    ): Promise<MobilePreviewExpoLaunchResult> {
      assertParams(params);
      assertDeeplinkLaunchSupported(params);
      const ownerKey = `${params.platform}\0${params.deviceId}`;
      const previousRequestId = latestRequestIds.get(ownerKey);
      if (previousRequestId && previousRequestId !== params.requestId) {
        activeRequestControllers.get(previousRequestId)?.abort(
          new DOMException('Expo launch request superseded', 'AbortError'),
        );
      }
      activeRequestControllers.get(params.requestId)?.abort(
        new DOMException('Expo launch request superseded', 'AbortError'),
      );
      const requestController = new AbortController();
      const { signal } = requestController;
      activeRequestControllers.set(params.requestId, requestController);
      latestRequestIds.set(ownerKey, params.requestId);
      try {
        signal.throwIfAborted();
        const [project, task] = await Promise.all([
          deps.findProjectById(params.projectId),
          deps.findTaskById(params.taskId),
        ]);
        if (!project) throw new Error('Project not found');
        if (!task || task.projectId !== project.id) {
          throw new Error('Task not found for project');
        }
        signal.throwIfAborted();

        const rootPath = await deps.resolveTaskRoot({
          projectPath: project.path,
          worktreePath: task.worktreePath,
        });
        const appPath = await deps.resolveAppPath({
          rootPath,
          relativePath: params.appPath,
        });
        signal.throwIfAborted();
        const runStatus = deps.getRunStatus(params.taskId);
        const commandId = createMobileDevServerCommandId(params.appPath);
        const hasMatchingServer = runStatus.commands.some(
          (command) =>
            command.id === commandId &&
            command.status === 'running' &&
            command.ports?.length === 1 &&
            command.ports[0] === params.metroPort,
        );
        if (!hasMatchingServer) {
          throw new Error(
            'Mobile dev server is not running for requested task, app, and port',
          );
        }
        // An explicit project setting wins over config discovery, which throws
        // for dynamic `app.config.js` projects.
        const configuredScheme = normalizeConfiguredScheme(params.appScheme);
        let trustedSchemesPromise: Promise<ReadonlySet<string>> | undefined;
        const getTrustedSchemes = () => {
          trustedSchemesPromise ??= (async () => {
            let discovered: ReadonlySet<string> = new Set();
            try {
              discovered = await deps.resolveAppSchemes(appPath);
            } catch (error) {
              // Dynamic `app.config.js` cannot be resolved safely. That is only
              // fatal when no scheme was configured in project settings.
              if (!configuredScheme) throw error;
            }
            return configuredScheme
              ? new Set([...discovered, configuredScheme])
              : discovered;
          })();
          return trustedSchemesPromise;
        };

        const usesDevClient =
          (await deps.resolveUsesDevClient?.(appPath)) ?? false;
        signal.throwIfAborted();

        const baseUrl = new URL(`http://127.0.0.1:${params.metroPort}`);
        const currentUrl = new URL('/_expo/open', baseUrl);
        currentUrl.searchParams.set('platform', params.platform);
        currentUrl.searchParams.set('runtime', 'default');
        let result: MobilePreviewExpoLaunchResult;
        if (usesDevClient) {
          // `/_expo/open` has no dev-client hint, so it answers with the Expo Go
          // link. Go straight to `/_expo/link?choice=expo-dev-client`.
          result = await requestLegacy(
            baseUrl,
            params.platform,
            getTrustedSchemes,
            signal,
            true,
          );
        } else {
        try {
          const currentResult = await requestWithTransportRetry(
            currentUrl,
            async (response, signal) => {
              if (response.status === 404) {
                cancelUnusedBody(response);
                return null;
              }
              if (!response.ok) {
                cancelUnusedBody(response);
                throw new Error(
                  `Expo launch request failed: HTTP ${response.status}`,
                );
              }
              return parseCurrentResponse(
                await readBoundedBody(response, signal),
                getTrustedSchemes,
              );
            },
            signal,
          );
          result =
            currentResult ??
            (await requestLegacy(
              baseUrl,
              params.platform,
              getTrustedSchemes,
              signal,
              usesDevClient,
            ));
        } catch (error) {
          if (
            error instanceof ExpoLaunchTransportError &&
            !error.timedOut
          ) {
            result = await requestLegacy(
              baseUrl,
              params.platform,
              getTrustedSchemes,
              signal,
              usesDevClient,
            );
          } else {
            throw error;
          }
        }
        }

        // `assertDeeplinkLaunchSupported` already rejected physical iOS, so the
        // remaining targets (simulators, Android) share the Mac's network stack
        // and use Metro's URL byte-for-byte.
        const deeplinkUrl = result.url;

        await withDeviceOpenLock(ownerKey, signal, async () => {
          signal.throwIfAborted();
          if (latestRequestIds.get(ownerKey) !== params.requestId) {
            throw new Error('Expo launch request superseded');
          }
          await deps.openDeeplink({
            platform: params.platform,
            deviceId: params.deviceId,
            url: deeplinkUrl,
          }, signal);
        });
        return deeplinkUrl === result.url ? result : { ...result, url: deeplinkUrl };
      } finally {
        if (latestRequestIds.get(ownerKey) === params.requestId) {
          latestRequestIds.delete(ownerKey);
        }
        if (
          activeRequestControllers.get(params.requestId) === requestController
        ) {
          activeRequestControllers.delete(params.requestId);
        }
      }
    },

    cancel(requestId: string): boolean {
      const controller = activeRequestControllers.get(requestId);
      if (!controller) return false;
      activeRequestControllers.delete(requestId);
      for (const [ownerKey, activeRequestId] of latestRequestIds) {
        if (activeRequestId === requestId) latestRequestIds.delete(ownerKey);
      }
      controller.abort(new DOMException('Expo launch request cancelled', 'AbortError'));
      return true;
    },
  };
}

export const mobilePreviewExpoLaunchService =
  createMobilePreviewExpoLaunchService({
    findProjectById: ProjectRepository.findById,
    findTaskById: TaskRepository.findById,
    resolveTaskRoot: resolveTrustedTaskRoot,
    resolveAppPath: resolvePathInsideRoot,
    resolveAppSchemes: resolveExpoAppSchemes,
    resolveUsesDevClient: resolveUsesExpoDevClient,
    getRunStatus: (taskId) => runCommandService.getRunStatus(taskId),
    isPhysicalIosDevice: isKnownPhysicalIosDevice,
    fetch,
    openDeeplink: (params, signal) =>
      mobilePreviewService.openDeeplink(params, { signal }),
  });
