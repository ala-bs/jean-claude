import { BrowserWindow, session } from 'electron';

import type {
  TimesheetAction,
  TimesheetAuthStatus,
  TimesheetAxisLookupRequest,
  TimesheetAxisLookupResult,
  TimesheetAxisOption,
  TimesheetEntryInput,
  TimesheetRowDeletion,
  TimesheetSheetSummary,
} from '@shared/timesheet-types';
import type { EureciaSetting } from '@shared/types';

import {
  createEureciaReadService,
  EURECIA_REDACTED_SHEET_ID,
  EureciaBrowseDiscoveryError,
  type EureciaBrowseDiscoveryFailureReason,
  type EureciaReadFetch,
  EureciaTimesheetAccessError,
  type EureciaWriteFetch,
} from './timesheet-adapters/eurecia-read-service';
import { dbg } from '../lib/debug';
import { SettingsRepository } from '../database/repositories/settings';

export const EURECIA_PARTITION = 'persist:jean-claude-eurecia';

const BROWSE_PATH = '/eurecia/timesheet/Browse.do';
const OPEN_PATH = '/eurecia/timesheet/Open.do';
const LOOKUP_TIMEOUT_MS = 15_000;
const AUTH_PROBE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_EDITOR_HTML_BYTES = MAX_RESPONSE_BYTES;
const MAX_AXIS_OPTIONS = 1_000;
const MAX_AXIS_ID_CHARACTERS = 512;
const MAX_AXIS_ID_BYTES = 1_024;
const MAX_AXIS_LABEL_CHARACTERS = 4_096;
const MAX_AXIS_LABEL_BYTES = 8_192;
const MAX_SHEET_ID_CHARACTERS = 512;
const MAX_SHEET_ID_BYTES = 1_024;

type EureciaSession = {
  clearStorageData: () => Promise<void>;
  fetch: (url: string, init: Parameters<EureciaReadFetch>[1]) => Promise<Response>;
  setPermissionRequestHandler: (handler: (...args: any[]) => void) => void;
  setPermissionCheckHandler: (handler: (...args: any[]) => boolean) => void;
  on: (event: 'will-download', listener: (...args: any[]) => void) => void;
};

type EureciaReadFetchFactory = (partitionSession: EureciaSession) => EureciaReadFetch;

type EureciaWebContents = {
  getURL: () => string;
  executeJavaScript: (script: string) => Promise<unknown>;
  setWindowOpenHandler: (
    handler: (details: { url: string }) => { action: 'deny' },
  ) => void;
  on: (event: string, listener: (...args: any[]) => void) => void;
  removeListener: (event: string, listener: (...args: any[]) => void) => void;
};

type EureciaWindow = {
  webContents: EureciaWebContents;
  loadURL: (url: string) => Promise<void>;
  on: (event: string, listener: (...args: any[]) => void) => void;
  once: (event: string, listener: (...args: any[]) => void) => void;
  removeListener: (event: string, listener: (...args: any[]) => void) => void;
  close: () => void;
  destroy: () => void;
  focus: () => void;
  setTitle: (title: string) => void;
  isDestroyed: () => boolean;
};

type WindowFactory = (options: Electron.BrowserWindowConstructorOptions) => EureciaWindow;

type ReadService = ReturnType<typeof createEureciaReadService>;
type LookupBinding = {
  window: EureciaWindow;
  finalUrl: string;
  fingerprint: string;
};
const securedSessions = new WeakSet<object>();

function createAbortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (!body) return;
  void body.cancel().catch(() => {});
}

async function readBoundedText(response: Response, signal?: AbortSignal) {
  const contentLength = response.headers.get('content-length');
  if (/^\d+$/.test(contentLength ?? '') && Number(contentLength) > MAX_RESPONSE_BYTES) {
    cancelBody(response.body);
    throw new Error('Eurecia response exceeds the 10 MiB limit.');
  }
  if (!response.body) {
    const text = await raceWithAbort(response.text.call(response), signal);
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Eurecia response exceeds the 10 MiB limit.');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Eurecia response exceeds the 10 MiB limit.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export function createEureciaSessionFetch(partitionSession: {
  fetch: EureciaSession['fetch'];
}): EureciaReadFetch {
  return async (url, init) => {
    const response = await partitionSession.fetch(url, init);
    return {
      headers: response.headers,
      ok: response.ok,
      status: response.status,
      // Followed redirects land elsewhere; callers validate the landing URL.
      url: init.redirect === 'follow' ? response.url || url : url,
      text: () => readBoundedText(response, init.signal),
    };
  };
}

export function createEureciaSessionWriteFetch(partitionSession: {
  fetch: EureciaSession['fetch'];
}): EureciaWriteFetch {
  return async (url, init) => {
    const response = await partitionSession.fetch(
      url,
      init as unknown as Parameters<EureciaSession['fetch']>[1],
    );
    return {
      headers: response.headers,
      ok: response.ok,
      status: response.status,
      // Redirects are followed for writes, so the landed URL matters.
      url: response.url || url,
      text: () => readBoundedText(response, init.signal),
    };
  };
}

function secureSession(partitionSession: EureciaSession) {
  if (securedSessions.has(partitionSession)) return;
  partitionSession.setPermissionRequestHandler(
    (_webContents, _permission, callback: (allowed: boolean) => void) => {
      callback(false);
    },
  );
  partitionSession.setPermissionCheckHandler(() => false);
  partitionSession.on('will-download', (event: { preventDefault: () => void }) => {
    event.preventDefault();
  });
  securedSessions.add(partitionSession);
}

function validateSetting(setting: EureciaSetting) {
  const labels = [setting.axis1Label, setting.axis2Label, setting.axis3Label];
  if (labels.some((label) => typeof label !== 'string' || !label.trim())) {
    throw new Error('Eurecia setting is not configured.');
  }
  let url: URL;
  try {
    url = new URL(setting.baseUrl);
  } catch {
    throw new Error('Eurecia setting is not configured.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (setting.baseUrl !== url.origin && setting.baseUrl !== `${url.origin}/`)
  ) {
    throw new Error('Eurecia setting is not configured.');
  }
  return { setting, baseUrl: url.origin };
}

function getAllowedLoginUrl(value: string, baseUrl: string) {
  try {
    const url = new URL(value);
    const isEureciaHost =
      url.hostname === 'eurecia.com' || url.hostname.endsWith('.eurecia.com');
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.origin === baseUrl || isEureciaHost)
      ? url
      : null;
  } catch {
    return null;
  }
}

function safeNavigation(value: string, baseUrl: string) {
  const url = getAllowedLoginUrl(value, baseUrl);
  if (!url) {
    return { allowed: false, hostname: 'blocked', route: 'blocked' } as const;
  }
  const route = url.pathname === '/'
    ? 'root'
    : url.pathname === '/eurecia' || url.pathname.startsWith('/eurecia/')
      ? 'eurecia'
      : /(?:^|\/)(?:authenticate|login|sign-in|signin)(?:\/|$)/i.test(url.pathname)
        ? 'authentication'
        : 'other';
  return { allowed: true, hostname: url.hostname, route } as const;
}

function isAbortedLoadError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  if (
    record.code === -3 ||
    record.errno === -3 ||
    record.errorCode === -3 ||
    record.code === 'ERR_ABORTED' ||
    record.name === 'ERR_ABORTED'
  ) {
    return true;
  }
  return (
    typeof record.message === 'string' &&
    /^(?:Error:\s*)?ERR_ABORTED(?:\s|\(|:|$)/.test(record.message)
  );
}

function requireBoundedSheetId(sheetId: string) {
  if (
    typeof sheetId !== 'string' ||
    !sheetId ||
    sheetId.length > MAX_SHEET_ID_CHARACTERS ||
    Buffer.byteLength(sheetId, 'utf8') > MAX_SHEET_ID_BYTES
  ) {
    throw new Error('Eurecia timesheet ID is invalid or exceeds its limit.');
  }
  return sheetId;
}

const READ_SHEET_IDENTITY_SCRIPT = `(async () => {
    const elements = document.querySelectorAll('form[action*="timesheet/Open.do"] [name="idTimeSheet"]');
    if (elements.length === 0) return { status: 'absent', count: 0 };
    if (elements.length !== 1) return { status: 'duplicate', count: 2 };
    const element = elements[0];
    if (!(element instanceof HTMLInputElement)) return { status: 'invalid', count: 1 };
    const value = element.value;
    if (!value.trim()) return { status: 'empty', count: 1 };
    const bytes = new TextEncoder().encode(value);
    if (value.length > ${MAX_SHEET_ID_CHARACTERS} || bytes.byteLength > ${MAX_SHEET_ID_BYTES}) {
      return { status: 'oversized', count: 1 };
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let fingerprint = '';
    for (const byte of digest) fingerprint += byte.toString(16).padStart(2, '0');
    return { status: 'ok', count: 1, fingerprint };
  })()`;
const READ_EDITOR_HTML_SCRIPT = `(async () => {
  const elements = document.querySelectorAll('form[action*="timesheet/Open.do"] [name="idTimeSheet"]');
  if (elements.length === 0) return { status: 'absent', count: 0 };
  if (elements.length !== 1) return { status: 'duplicate', count: 2 };
  const element = elements[0];
  if (!(element instanceof HTMLInputElement)) return { status: 'invalid', count: 1 };
  const value = element.value;
  if (!value.trim()) return { status: 'empty', count: 1 };
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (value.length > ${MAX_SHEET_ID_CHARACTERS} || bytes.byteLength > ${MAX_SHEET_ID_BYTES}) {
    return { status: 'oversized', count: 1 };
  }
  const root = document.documentElement;
  if (!(root instanceof HTMLElement)) return { status: 'missing' };
  const clone = root.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return { status: 'missing' };
  const clonedElements = clone.querySelectorAll('form[action*="timesheet/Open.do"] [name="idTimeSheet"]');
  if (clonedElements.length !== 1) return { status: 'invalid', count: 1 };
  const clonedElement = clonedElements[0];
  if (!(clonedElement instanceof HTMLInputElement)) return { status: 'invalid', count: 1 };
  const placeholder = ${JSON.stringify(EURECIA_REDACTED_SHEET_ID)};
  clonedElement.value = placeholder;
  clonedElement.defaultValue = placeholder;
  clonedElement.setAttribute('value', placeholder);
  const html = clone.outerHTML;
  if (encoder.encode(html).byteLength > ${MAX_EDITOR_HTML_BYTES}) {
    return { status: 'too-large' };
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let fingerprint = '';
  for (const byte of digest) fingerprint += byte.toString(16).padStart(2, '0');
  return { status: 'ok', html, fingerprint };
})()`;

function parseSheetIdentityResult(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Eurecia sheet identity result is invalid.');
  }
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  if (
    result.status === 'ok' &&
    result.count === 1 &&
    typeof result.fingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(result.fingerprint) &&
    keys.length === 3 &&
    keys[0] === 'count' &&
    keys[1] === 'fingerprint' &&
    keys[2] === 'status'
  ) {
    return result.fingerprint;
  }
  const failureCounts: Record<string, number> = {
    absent: 0,
    duplicate: 2,
    empty: 1,
    invalid: 1,
    oversized: 1,
  };
  if (
    typeof result.status === 'string' &&
    failureCounts[result.status] === result.count &&
    keys.length === 2 &&
    keys[0] === 'count' &&
    keys[1] === 'status'
  ) {
    throw new Error('Eurecia lookup page has invalid timesheet identity.');
  }
  throw new Error('Eurecia sheet identity result is invalid.');
}

function parseEditorExtractionResult(
  value: unknown,
  expectedFingerprint: string,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Eurecia editor HTML extraction returned invalid HTML.');
  }
  const extraction = value as Record<string, unknown>;
  const keys = Object.keys(extraction).sort();
  if (
    extraction.status === 'too-large' &&
    keys.length === 1 &&
    keys[0] === 'status'
  ) {
    throw new Error('Eurecia editor HTML exceeds the 10 MiB limit.');
  }
  if (
    extraction.status === 'missing' &&
    keys.length === 1 &&
    keys[0] === 'status'
  ) {
    throw new Error('Eurecia editor HTML extraction returned invalid HTML.');
  }
  if (extraction.status !== 'ok') {
    parseSheetIdentityResult(value);
    throw new Error('Eurecia editor HTML extraction returned invalid HTML.');
  }
  if (
    typeof extraction.html !== 'string' ||
    typeof extraction.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(extraction.fingerprint) ||
    keys.length !== 3 ||
    keys[0] !== 'fingerprint' ||
    keys[1] !== 'html' ||
    keys[2] !== 'status'
  ) {
    throw new Error('Eurecia editor HTML extraction returned invalid HTML.');
  }
  if (extraction.fingerprint !== expectedFingerprint) {
    throw new Error('Eurecia lookup page binding changed.');
  }
  if (Buffer.byteLength(extraction.html, 'utf8') > MAX_EDITOR_HTML_BYTES) {
    throw new Error('Eurecia editor HTML exceeds the 10 MiB limit.');
  }
  return extraction.html;
}

async function readLookupPageIdentity(
  webContents: EureciaWebContents,
  baseUrl: string,
  signal?: AbortSignal,
) {
  const finalUrlBefore = validateLookupPageUrl(webContents.getURL(), baseUrl);
  const value = await raceWithAbort(
    webContents.executeJavaScript(READ_SHEET_IDENTITY_SCRIPT),
    signal,
  );
  const fingerprint = parseSheetIdentityResult(value);
  const finalUrlAfter = validateLookupPageUrl(webContents.getURL(), baseUrl);
  if (finalUrlAfter !== finalUrlBefore) {
    throw new Error('Eurecia lookup page binding changed.');
  }
  return { finalUrl: finalUrlAfter, fingerprint };
}

function validateLookupNavigationUrl(value: string, baseUrl: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Eurecia sheet navigation URL is invalid.');
  }
  if (
    url.origin !== baseUrl ||
    url.pathname !== BROWSE_PATH ||
    url.username ||
    url.password
  ) {
    throw new Error('Eurecia sheet navigation URL must be a same-origin Browse.do URL.');
  }
  return url.toString();
}

function validateLookupPageUrl(value: string, baseUrl: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Eurecia lookup page URL is invalid.');
  }
  if (
    url.origin !== baseUrl ||
    url.pathname !== OPEN_PATH ||
    url.username ||
    url.password
  ) {
    throw new Error('Eurecia sheet did not open same-origin Open.do editor.');
  }
  return url.toString();
}

function requireBoundedAxisText(
  value: unknown,
  kind: 'ID' | 'label',
) {
  const maxCharacters =
    kind === 'ID' ? MAX_AXIS_ID_CHARACTERS : MAX_AXIS_LABEL_CHARACTERS;
  const maxBytes = kind === 'ID' ? MAX_AXIS_ID_BYTES : MAX_AXIS_LABEL_BYTES;
  if (
    typeof value !== 'string' ||
    value.length > maxCharacters ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new Error(`Eurecia axis lookup returned an invalid ${kind}.`);
  }
  return value;
}

function normalizeOptions(value: unknown): TimesheetAxisOption[] {
  if (!Array.isArray(value) || value.length > MAX_AXIS_OPTIONS) {
    throw new Error('Eurecia axis lookup returned invalid options.');
  }
  return value.map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      throw new Error('Eurecia axis lookup returned invalid options.');
    }
    const record = option as Record<string, unknown>;
    return {
      id: requireBoundedAxisText(record.id, 'ID'),
      label: requireBoundedAxisText(record.label, 'label'),
    };
  });
}

function buildAxisLookupScript(input: {
  axis: 1 | 2 | 3;
  rowIndex: number;
  parentSelectedId: string;
}) {
  return `(() => {
    const describeError = (error) => ({
      __lookupError: String((error && error.message) || error || 'unknown error'),
    });
    const run = () => {
    const input = ${JSON.stringify(input)};
    const encoder = new TextEncoder();
    const requireText = (value, kind, maxCharacters, maxBytes) => {
      if (typeof value !== 'string' || value.length > maxCharacters || encoder.encode(value).byteLength > maxBytes) {
        throw new Error('Eurecia axis lookup returned an invalid ' + kind + '.');
      }
      return value;
    };
    const boundOptions = (options) => {
      if (!Array.isArray(options) || options.length > ${MAX_AXIS_OPTIONS}) {
        throw new Error('Eurecia axis lookup returned too many options.');
      }
      return options;
    };
    const makeOption = (id, label) => ({
      id: requireText(String(id ?? ''), 'ID', ${MAX_AXIS_ID_CHARACTERS}, ${MAX_AXIS_ID_BYTES}),
      label: requireText(String(label ?? ''), 'label', ${MAX_AXIS_LABEL_CHARACTERS}, ${MAX_AXIS_LABEL_BYTES}),
    });
    const boundSelectedId = (value) => value == null || value === ''
      ? null
      : requireText(String(value), 'selected ID', ${MAX_AXIS_ID_CHARACTERS}, ${MAX_AXIS_ID_BYTES});
    if (input.axis === 1) {
      const select = document.getElementById('imputationStructureId1_' + input.rowIndex);
      if (!(select instanceof HTMLSelectElement)) throw new Error('Eurecia axis select not found.');
      const sourceKey = select.getAttribute('source');
      const source = sourceKey && window.CC && window.CC.comboboxSources
        ? window.CC.comboboxSources[sourceKey]
        : null;
      const options = Array.isArray(source)
        ? source.map((option) => makeOption(option.value, option.label)).filter((option) => option.id !== '')
        : Array.from(select.options).map((option) => makeOption(option.value, option.text)).filter((option) => option.id !== '');
      return { options: boundOptions(options), selectedId: boundSelectedId(select.value) };
    }
    const userIdElement = document.getElementById('idUserForListValueHidden');
    const conditionElement = document.getElementById('numberAxeContainsElementConditions');
    const parentSelect = document.getElementById(
      'imputationStructureId' + (input.axis - 1) + '_' + input.rowIndex,
    );
    const dwr = window.AllDwrFunction;
    if (!(userIdElement instanceof HTMLInputElement) || !(conditionElement instanceof HTMLInputElement) || !(parentSelect instanceof HTMLSelectElement) || !dwr || typeof dwr.dwrGetImputationStructureLinkedOptionList !== 'function') {
      throw new Error('Eurecia axis lookup context not found.');
    }
    const parentSelectedId = input.parentSelectedId || parentSelect.value;
    // A linked axis has no options until its parent is chosen, and Eurecia does
    // not answer that call with an option list.
    if (!parentSelectedId) return { options: [], selectedId: null };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Eurecia axis lookup timed out.')), ${LOOKUP_TIMEOUT_MS});
      dwr.dwrGetImputationStructureLinkedOptionList(
        userIdElement.value,
        parentSelectedId,
        input.axis - 1,
        input.rowIndex,
        conditionElement.value,
        null,
        (reply) => {
          clearTimeout(timeout);
          try {
            if (reply == null) {
              resolve({ options: [], selectedId: null });
              return;
            }
            if (!Array.isArray(reply) || !Array.isArray(reply[1])) {
              const shape = Array.isArray(reply)
                ? 'array(' + reply.length + ') entry1=' + (typeof reply[1])
                : typeof reply;
              reject(
                new Error(
                  'Eurecia axis lookup returned an invalid reply. Shape: ' + shape + '.',
                ),
              );
              return;
            }
            if (reply[1].length > ${MAX_AXIS_OPTIONS}) {
              reject(new Error('Eurecia axis lookup returned too many options.'));
              return;
            }
            const options = reply[1]
              .filter((tuple) => Array.isArray(tuple) && tuple.length >= 2)
              .map((tuple) => makeOption(tuple[0], tuple[1]))
              .filter((option) => option.id !== '');
            const selectedId = reply[2] == null || reply[2] === '' ? null : String(reply[2]);
            resolve({ options: boundOptions(options), selectedId: boundSelectedId(selectedId) });
          } catch (error) {
            reject(error);
          }
        },
      );
    });
    };
    try {
      const result = run();
      return result && typeof result.then === 'function'
        ? result.then(undefined, describeError)
        : result;
    } catch (error) {
      return describeError(error);
    }
  })()`;
}

export function createEureciaSessionService({
  getSetting = () => SettingsRepository.get('eurecia'),
  getSession = () => session.fromPartition(EURECIA_PARTITION),
  createReadFetch = createEureciaSessionFetch,
  createWriteFetch = createEureciaSessionWriteFetch,
  createWindow = (options) => new BrowserWindow(options) as unknown as EureciaWindow,
  authProbeTimeoutMs = AUTH_PROBE_TIMEOUT_MS,
}: {
  getSetting?: () => Promise<EureciaSetting>;
  getSession?: () => EureciaSession;
  createReadFetch?: EureciaReadFetchFactory;
  createWriteFetch?: (partitionSession: EureciaSession) => EureciaWriteFetch;
  createWindow?: WindowFactory;
  authProbeTimeoutMs?: number;
} = {}) {
  const loginWindows = new Map<string, EureciaWindow>();
  const loginPromises = new Map<string, Promise<TimesheetAuthStatus>>();
  const lookupWindows = new Map<string, EureciaWindow>();
  const lookupWindowPromises = new Map<string, Promise<EureciaWindow>>();
  const lookupBindings = new Map<string, LookupBinding>();
  const listedSheets = new Map<string, string>();
  const activeControllers = new Set<AbortController>();
  const lookupOperationControllers = new Set<AbortController>();
  let readState: { key: string; service: ReadService } | null = null;
  let epoch = 0;
  let teardownInProgress = false;
  let sheetListGeneration = 0;
  let activeSheetListRefresh: {
    generation: number;
    promise: Promise<TimesheetSheetSummary[]>;
  } | null = null;

  function partitionSession() {
    const value = getSession();
    secureSession(value);
    return value;
  }

  function cancellationError() {
    return new Error('Eurecia operation was cancelled because the session changed.');
  }

  function assertEpoch(expectedEpoch: number) {
    if (epoch !== expectedEpoch) throw cancellationError();
  }

  async function awaitCurrent<T>(promise: Promise<T>, expectedEpoch: number) {
    try {
      const result = await promise;
      assertEpoch(expectedEpoch);
      return result;
    } catch (error) {
      assertEpoch(expectedEpoch);
      throw error;
    }
  }

  function destroyLookupWindows() {
    for (const window of [...lookupWindows.values()]) {
      if (!window.isDestroyed()) window.destroy();
    }
    lookupWindows.clear();
    lookupWindowPromises.clear();
    lookupBindings.clear();
  }

  function destroyLookupWindow(
    navigationUrl: string,
    window: EureciaWindow,
  ) {
    if (lookupWindows.get(navigationUrl) === window) {
      lookupWindows.delete(navigationUrl);
    }
    if (lookupBindings.get(navigationUrl)?.window === window) {
      lookupBindings.delete(navigationUrl);
    }
    if (!window.isDestroyed()) window.destroy();
  }

  async function requireLookupBinding(
    navigationUrl: string,
    window: EureciaWindow,
    baseUrl: string,
    signal?: AbortSignal,
  ) {
    const expected = lookupBindings.get(navigationUrl);
    if (!expected || expected.window !== window) {
      throw new Error('Eurecia lookup page binding is missing.');
    }
    let current: { finalUrl: string; fingerprint: string };
    try {
      current = await readLookupPageIdentity(window.webContents, baseUrl, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Eurecia lookup page binding changed.');
    }
    if (
      current.finalUrl !== expected.finalUrl ||
      current.fingerprint !== expected.fingerprint
    ) {
      throw new Error('Eurecia lookup page binding changed.');
    }
    return expected;
  }

  function destroyLoginWindows() {
    for (const window of [...loginWindows.values()]) {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  function abortActiveControllers() {
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    lookupOperationControllers.clear();
  }

  function abortLookupOperationControllers() {
    for (const controller of lookupOperationControllers) controller.abort();
    lookupOperationControllers.clear();
  }

  function invalidateForSettingChange() {
    epoch += 1;
    abortActiveControllers();
    destroyLoginWindows();
    destroyLookupWindows();
    readState?.service.invalidateSheetList();
    listedSheets.clear();
    readState = null;
    activeSheetListRefresh = null;
  }

  function createOperationController(trackLookupOperation = false) {
    const controller = new AbortController();
    activeControllers.add(controller);
    if (trackLookupOperation) lookupOperationControllers.add(controller);
    return {
      controller,
      release: () => {
        activeControllers.delete(controller);
        lookupOperationControllers.delete(controller);
      },
    };
  }

  async function context() {
    if (teardownInProgress) {
      throw new Error('Eurecia logout is in progress.');
    }
    const startingEpoch = epoch;
    const { setting, baseUrl } = validateSetting(await getSetting());
    if (teardownInProgress) {
      throw new Error('Eurecia logout is in progress.');
    }
    assertEpoch(startingEpoch);
    const key = JSON.stringify(setting);
    if (!readState || readState.key !== key) {
      if (readState) invalidateForSettingChange();
      const eureciaSession = partitionSession();
      readState = {
        key,
        service: createEureciaReadService({
          baseUrl,
          axisLabels: {
            axis1: setting.axis1Label,
            axis2: setting.axis2Label,
            axis3: setting.axis3Label,
          },
          fetch: createReadFetch(eureciaSession),
          writeFetch: createWriteFetch(eureciaSession),
        }),
      };
    }
    return { baseUrl, readService: readState.service, epoch };
  }

  async function probe(readService: ReadService, controller: AbortController) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const discovery = readService.discoverBrowseUrl(controller.signal);
    // Promise.race observes discovery, and this handler also consumes any late rejection.
    void discovery.catch(() => {});
    try {
      await Promise.race([
        discovery,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Eurecia authentication probe timed out.'));
            controller.abort();
          }, authProbeTimeoutMs);
        }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            reject(new Error('Eurecia authentication probe was cancelled.'));
          };
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async function requireAuthenticated(trackLookupOperation = false) {
    const value = await context();
    const operation = createOperationController(trackLookupOperation);
    try {
      await probe(value.readService, operation.controller);
      assertEpoch(value.epoch);
    } catch {
      operation.release();
      assertEpoch(value.epoch);
      throw new Error('Eurecia session is not authenticated.');
    }
    return { ...value, ...operation };
  }

  async function waitForActiveSheetListRefresh() {
    const refresh = activeSheetListRefresh;
    if (!refresh) return;
    try {
      await refresh.promise;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Eurecia sheet refresh failed: ${message}`, { cause: error });
    }
  }

  function listSheets() {
    if (activeSheetListRefresh) return activeSheetListRefresh.promise;

    const generation = sheetListGeneration + 1;
    sheetListGeneration = generation;
    const promise = (async () => {
      abortLookupOperationControllers();
      listedSheets.clear();
      readState?.service.invalidateSheetList();
      destroyLookupWindows();
      const operation = await requireAuthenticated();
      try {
        const sheets = await awaitCurrent(
          raceWithAbort(
            operation.readService.listSheets(operation.controller.signal),
            operation.controller.signal,
          ),
          operation.epoch,
        );
        listedSheets.clear();
        for (const sheet of sheets) {
          listedSheets.set(sheet.id, sheet.navigationUrl);
        }
        return sheets;
      } finally {
        operation.release();
      }
    })();
    activeSheetListRefresh = { generation, promise };
    const clearRefresh = () => {
      if (activeSheetListRefresh?.generation === generation) {
        activeSheetListRefresh = null;
      }
    };
    void promise.then(clearRefresh, clearRefresh);
    return promise;
  }

  async function classifiedAuthStatus(externalSignal?: AbortSignal): Promise<
    | {
        status: TimesheetAuthStatus;
        outcome: 'authenticated';
      }
    | {
        status: TimesheetAuthStatus;
      outcome: 'unauthenticated';
      reason: EureciaBrowseDiscoveryFailureReason;
      }
    | {
        status: TimesheetAuthStatus;
        outcome: 'timesheet-access-unavailable';
        error: EureciaTimesheetAccessError;
      }
  > {
    let value: Awaited<ReturnType<typeof context>>;
    try {
      value = await context();
    } catch {
      return {
        status: { configured: false, authenticated: false, baseUrl: '' },
        outcome: 'unauthenticated',
        reason: 'unknown',
      };
    }
    const operation = createOperationController();
    const abortOperation = () => operation.controller.abort();
    if (externalSignal?.aborted) abortOperation();
    else externalSignal?.addEventListener('abort', abortOperation, { once: true });
    try {
      await probe(value.readService, operation.controller);
      assertEpoch(value.epoch);
      return {
        status: { configured: true, authenticated: true, baseUrl: value.baseUrl },
        outcome: 'authenticated',
      };
    } catch (error) {
      assertEpoch(value.epoch);
      if (error instanceof EureciaTimesheetAccessError) {
        return {
          status: { configured: true, authenticated: false, baseUrl: value.baseUrl },
          outcome: 'timesheet-access-unavailable',
          error,
        };
      }
      return {
        status: { configured: true, authenticated: false, baseUrl: value.baseUrl },
        outcome: 'unauthenticated',
        reason:
          error instanceof EureciaBrowseDiscoveryError
            ? error.reason
            : operation.controller.signal.aborted
              ? 'timeout-or-cancel'
              : 'unknown',
      };
    } finally {
      externalSignal?.removeEventListener('abort', abortOperation);
      operation.release();
    }
  }

  async function authStatus(): Promise<TimesheetAuthStatus> {
    return (await classifiedAuthStatus()).status;
  }

  async function login() {
    const { baseUrl } = await context();
    const existing = loginWindows.get(baseUrl);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return loginPromises.get(baseUrl)!;
    }

    const loginStartedAt = Date.now();
    const loginWindow = createWindow({
      width: 900,
      height: 720,
      show: true,
      title: 'Sign in to Eurecia',
      webPreferences: {
        partition: EURECIA_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    dbg.timesheet(
      'login window created hostname=%s elapsedMs=%d',
      new URL(baseUrl).hostname,
      Date.now() - loginStartedAt,
    );
    loginWindows.set(baseUrl, loginWindow);
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    let failLoad = (_error: unknown) => {};
    const loginController = new AbortController();
    const promise = new Promise<TimesheetAuthStatus>((resolve, reject) => {
      let settled = false;
      let probing = false;
      let pendingProbe = false;
      let cleaned = false;
      let pollInterval: ReturnType<typeof setInterval> | undefined;
      const cleanup = (
        outcome: 'access-failed' | 'cancelled' | 'load-failed' | 'succeeded',
      ) => {
        if (cleaned) return;
        cleaned = true;
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = undefined;
        pendingProbe = false;
        loginController.abort();
        if (loginWindows.get(baseUrl) === loginWindow) {
          loginWindows.delete(baseUrl);
        }
        if (loginPromises.get(baseUrl) === promise) {
          loginPromises.delete(baseUrl);
        }
        loginWindow.webContents.removeListener('will-navigate', onWillNavigate);
        loginWindow.webContents.removeListener('will-redirect', onWillNavigate);
        loginWindow.webContents.removeListener('page-title-updated', onPageTitleUpdated);
        loginWindow.webContents.removeListener('did-finish-load', onLoad);
        loginWindow.webContents.removeListener('did-fail-load', onDidFailLoad);
        loginWindow.removeListener('closed', onClosed);
        dbg.timesheet(
          'login cleanup outcome=%s elapsedMs=%d',
          outcome,
          Date.now() - loginStartedAt,
        );
      };
      const finishProbe = () => {
        probing = false;
        if (settled || !pendingProbe) return;
        pendingProbe = false;
        void runProbe('coalesced');
      };
      const runProbe = async (
        trigger: 'coalesced' | 'immediate' | 'interval' | 'load',
      ) => {
        if (settled) return;
        if (probing) {
          pendingProbe = true;
          return;
        }
        probing = true;
        const probeStartedAt = Date.now();
        const navigation = safeNavigation(
          loginWindow.webContents.getURL() || `${baseUrl}/eurecia/`,
          baseUrl,
        );
        dbg.timesheet(
          `login probe trigger trigger=${trigger} hostname=%s route=%s elapsedMs=%d`,
          navigation.hostname,
          navigation.route,
          probeStartedAt - loginStartedAt,
        );
        let result: Awaited<ReturnType<typeof classifiedAuthStatus>>;
        try {
          result = await classifiedAuthStatus(loginController.signal);
        } catch {
          dbg.timesheet(
            'login probe result outcome=error elapsedMs=%d',
            Date.now() - probeStartedAt,
          );
          finishProbe();
          return;
        }
        if (result.outcome === 'authenticated') {
          dbg.timesheet(
            'login probe result outcome=%s elapsedMs=%d',
            result.outcome,
            Date.now() - probeStartedAt,
          );
        } else {
          dbg.timesheet(
            'login probe result outcome=%s reason=%s elapsedMs=%d',
            result.outcome,
            result.outcome === 'timesheet-access-unavailable'
              ? result.error.reason
              : result.reason,
            Date.now() - probeStartedAt,
          );
        }
        probing = false;
        if (settled) return;
        if (result.outcome === 'authenticated') {
          settled = true;
          dbg.timesheet('login success elapsedMs=%d', Date.now() - loginStartedAt);
          cleanup('succeeded');
          resolve(result.status);
          if (!loginWindow.isDestroyed()) loginWindow.destroy();
          return;
        }
        if (result.outcome === 'timesheet-access-unavailable') {
          settled = true;
          cleanup('access-failed');
          reject(result.error);
          if (!loginWindow.isDestroyed()) loginWindow.destroy();
          return;
        }
        finishProbe();
      };
      const onLoad = () => void runProbe('load');
      const onDidFailLoad = (
        _event: unknown,
        errorCode: number,
        _errorDescription: string,
        _validatedUrl: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame && errorCode !== -3) failLoad(errorCode);
      };
      const onWillNavigate = (event: { preventDefault: () => void }, url: string) => {
        const navigation = safeNavigation(url, baseUrl);
        dbg.timesheet(
          'login navigation hostname=%s route=%s outcome=%s elapsedMs=%d',
          navigation.hostname,
          navigation.route,
          navigation.allowed ? 'allowed' : 'blocked',
          Date.now() - loginStartedAt,
        );
        if (!navigation.allowed) event.preventDefault();
      };
      const onPageTitleUpdated = (event: { preventDefault: () => void }) => {
        event.preventDefault();
        const current = getAllowedLoginUrl(loginWindow.webContents.getURL(), baseUrl);
        loginWindow.setTitle(
          `Sign in to Eurecia (${current?.hostname ?? new URL(baseUrl).hostname})`,
        );
      };
      const onClosed = () => {
        if (settled) return;
        settled = true;
        dbg.timesheet('login cancelled elapsedMs=%d', Date.now() - loginStartedAt);
        cleanup('cancelled');
        reject(new Error('Eurecia sign-in was cancelled.'));
      };
      failLoad = () => {
        if (settled) return;
        settled = true;
        dbg.timesheet(
          'login load failed outcome=load-failed elapsedMs=%d',
          Date.now() - loginStartedAt,
        );
        cleanup('load-failed');
        reject(new Error('Eurecia sign-in page failed to load.'));
        if (!loginWindow.isDestroyed()) loginWindow.destroy();
      };
      loginWindow.webContents.on('will-navigate', onWillNavigate);
      loginWindow.webContents.on('will-redirect', onWillNavigate);
      loginWindow.webContents.on('page-title-updated', onPageTitleUpdated);
      loginWindow.webContents.on('did-finish-load', onLoad);
      loginWindow.webContents.on('did-fail-load', onDidFailLoad);
      loginWindow.on('closed', onClosed);
      pollInterval = setInterval(() => void runProbe('interval'), 1_000);
      void runProbe('immediate');
    });
    loginPromises.set(baseUrl, promise);
    void loginWindow.loadURL(`${baseUrl}/eurecia/`).catch((error: unknown) => {
      if (!isAbortedLoadError(error)) failLoad(error);
    });
    return promise;
  }

  async function logout() {
    if (teardownInProgress) {
      throw new Error('Eurecia logout is already in progress.');
    }
    teardownInProgress = true;
    try {
      invalidateForSettingChange();
      await partitionSession().clearStorageData();
    } finally {
      teardownInProgress = false;
    }
  }

  async function getLookupWindow(
    navigationUrl: string,
    baseUrl: string,
    signal?: AbortSignal,
  ) {
    const pending = lookupWindowPromises.get(navigationUrl);
    if (pending) return raceWithAbort(pending, signal);
    const cached = lookupWindows.get(navigationUrl);
    if (cached && !cached.isDestroyed()) {
      try {
        await requireLookupBinding(navigationUrl, cached, baseUrl, signal);
        return cached;
      } catch (error) {
        destroyLookupWindow(navigationUrl, cached);
        throw error;
      }
    }

    const creation = (async () => {
      const lookupWindow = createWindow({
        show: false,
        webPreferences: {
          partition: EURECIA_PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      lookupWindows.set(navigationUrl, lookupWindow);
      lookupWindow.once('closed', () => {
        if (lookupWindows.get(navigationUrl) === lookupWindow) {
          lookupWindows.delete(navigationUrl);
        }
        if (lookupBindings.get(navigationUrl)?.window === lookupWindow) {
          lookupBindings.delete(navigationUrl);
        }
      });
      lookupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      let locked = false;
      let prohibitedNavigation = false;
      const guardNavigation = (
        eventType: 'navigation' | 'redirect',
        event: { preventDefault: () => void },
        rawUrl: string,
      ) => {
        if (!locked) {
          try {
            const url = new URL(rawUrl);
            if (
              rawUrl === navigationUrl ||
              (eventType === 'redirect' &&
                url.origin === baseUrl &&
                url.pathname === OPEN_PATH &&
                !url.username &&
                !url.password)
            ) {
              return;
            }
          } catch {
            // Block malformed navigation below.
          }
        }
        prohibitedNavigation = true;
        event.preventDefault();
        destroyLookupWindow(navigationUrl, lookupWindow);
      };
      const onNavigate = (event: { preventDefault: () => void }, url: string) =>
        guardNavigation('navigation', event, url);
      const onRedirect = (event: { preventDefault: () => void }, url: string) =>
        guardNavigation('redirect', event, url);
      lookupWindow.webContents.on('will-navigate', onNavigate);
      lookupWindow.webContents.on('will-redirect', onRedirect);
      try {
        await raceWithAbort(lookupWindow.loadURL(navigationUrl), signal);
        if (prohibitedNavigation) {
          throw new Error('Eurecia lookup navigation attempted a prohibited redirect.');
        }
        if (lookupWindow.isDestroyed()) throw createAbortError();
        const identity = await readLookupPageIdentity(
          lookupWindow.webContents,
          baseUrl,
          signal,
        );
        lookupBindings.set(navigationUrl, { ...identity, window: lookupWindow });
        locked = true;
      } catch (error) {
        destroyLookupWindow(navigationUrl, lookupWindow);
        throw error;
      }
      return lookupWindow;
    })();
    lookupWindowPromises.set(navigationUrl, creation);
    void creation.then(
      () => {
        if (lookupWindowPromises.get(navigationUrl) === creation) {
          lookupWindowPromises.delete(navigationUrl);
        }
      },
      () => {
        if (lookupWindowPromises.get(navigationUrl) === creation) {
          lookupWindowPromises.delete(navigationUrl);
        }
      },
    );
    return creation;
  }

  return {
    authStatus,
    invalidateForSettingChange,
    login,
    logout,
    listSheets,

    async inspectSheet(params: { sheetId: string; navigationUrl: string }) {
      await waitForActiveSheetListRefresh();
      const operation = await requireAuthenticated(true);
      let lookupWindow: EureciaWindow | undefined;
      try {
        if (listedSheets.get(params.sheetId) !== params.navigationUrl) {
          throw new Error('Eurecia sheet must be selected from latest Browse result.');
        }
        requireBoundedSheetId(params.sheetId);
        const expectedRevision = operation.readService.beginSheetInspection(params);
        const navigationUrl = validateLookupNavigationUrl(
          params.navigationUrl,
          operation.baseUrl,
        );
        lookupWindow = await awaitCurrent(
          getLookupWindow(
            navigationUrl,
            operation.baseUrl,
            operation.controller.signal,
          ),
          operation.epoch,
        );
        const bindingBefore = await awaitCurrent(
          requireLookupBinding(
            navigationUrl,
            lookupWindow,
            operation.baseUrl,
            operation.controller.signal,
          ),
          operation.epoch,
        );
        const value = await awaitCurrent(
          raceWithAbort(
            lookupWindow.webContents.executeJavaScript(READ_EDITOR_HTML_SCRIPT),
            operation.controller.signal,
          ),
          operation.epoch,
        );
        const html = parseEditorExtractionResult(
          value,
          bindingBefore.fingerprint,
        );
        const bindingAfter = await awaitCurrent(
          requireLookupBinding(
            navigationUrl,
            lookupWindow,
            operation.baseUrl,
            operation.controller.signal,
          ),
          operation.epoch,
        );
        if (bindingAfter.finalUrl !== bindingBefore.finalUrl) {
          throw new Error('Eurecia lookup page binding changed.');
        }
        if (listedSheets.get(params.sheetId) !== params.navigationUrl) {
          throw new Error('Eurecia sheet list changed during inspection.');
        }
        const result = operation.readService.inspectSheetHtml({
          ...params,
          pageUrl: bindingAfter.finalUrl,
          html,
          expectedRevision,
        });
        assertEpoch(operation.epoch);
        return result;
      } catch (error) {
        if (lookupWindow) {
          destroyLookupWindow(params.navigationUrl, lookupWindow);
        }
        throw error;
      } finally {
        operation.release();
      }
    },

    async lookupAxisOptions(
      request: TimesheetAxisLookupRequest,
    ): Promise<TimesheetAxisLookupResult> {
      if (![1, 2, 3].includes(request.axis)) {
        throw new Error('Eurecia axis must be 1, 2, or 3.');
      }
      if (!Number.isInteger(request.rowIndex) || request.rowIndex < 0) {
        throw new Error('Eurecia row index must be a non-negative integer.');
      }
      await waitForActiveSheetListRefresh();
      const operation = await requireAuthenticated(true);
      let lookupWindow: EureciaWindow | undefined;
      try {
        if (listedSheets.get(request.sheetId) !== request.navigationUrl) {
          throw new Error('Eurecia sheet must be selected from latest Browse result.');
        }
        requireBoundedSheetId(request.sheetId);
        const expectedRevision = operation.readService.beginSheetInspection({
          sheetId: request.sheetId,
          navigationUrl: request.navigationUrl,
        });
        const navigationUrl = validateLookupNavigationUrl(
          request.navigationUrl,
          operation.baseUrl,
        );
        const parentSelectedId =
          request.axis === 2
            ? request.selectedAxisIds.axis1Id
            : request.axis === 3
              ? request.selectedAxisIds.axis2Id
              : '';
        if (parentSelectedId) requireBoundedAxisText(parentSelectedId, 'ID');
        lookupWindow = await awaitCurrent(
          getLookupWindow(
            navigationUrl,
            operation.baseUrl,
            operation.controller.signal,
          ),
          operation.epoch,
        );
        const bindingBefore = await awaitCurrent(
          requireLookupBinding(
            navigationUrl,
            lookupWindow,
            operation.baseUrl,
            operation.controller.signal,
          ),
          operation.epoch,
        );
        const rawResult = await awaitCurrent(
          raceWithAbort(
            lookupWindow.webContents.executeJavaScript(
              buildAxisLookupScript({
                axis: request.axis,
                rowIndex: request.rowIndex,
                parentSelectedId,
              }),
            ),
            operation.controller.signal,
          ),
          operation.epoch,
        );
        operation.readService.assertSheetInspectionCurrent({
          sheetId: request.sheetId,
          navigationUrl: request.navigationUrl,
          expectedRevision,
        });
        if (listedSheets.get(request.sheetId) !== request.navigationUrl) {
          throw new Error('Eurecia sheet list changed during axis lookup.');
        }
        const bindingAfter = await awaitCurrent(
          requireLookupBinding(
            navigationUrl,
            lookupWindow,
            operation.baseUrl,
            operation.controller.signal,
          ),
          operation.epoch,
        );
        operation.readService.assertSheetInspectionCurrent({
          sheetId: request.sheetId,
          navigationUrl: request.navigationUrl,
          expectedRevision,
        });
        if (
          listedSheets.get(request.sheetId) !== request.navigationUrl ||
          bindingAfter.finalUrl !== bindingBefore.finalUrl
        ) {
          throw new Error('Eurecia lookup page binding changed.');
        }
        if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
          throw new Error('Eurecia axis lookup returned an invalid result.');
        }
        const result = rawResult as Record<string, unknown>;
        if (typeof result.__lookupError === 'string') {
          throw new Error(`Eurecia axis lookup failed: ${result.__lookupError}`);
        }
        return {
          axis: request.axis,
          options: normalizeOptions(result.options),
          selectedId:
            result.selectedId === null
              ? null
              : requireBoundedAxisText(result.selectedId, 'ID'),
        };
      } catch (error) {
        if (lookupWindow) {
          destroyLookupWindow(request.navigationUrl, lookupWindow);
        }
        throw error;
      } finally {
        operation.release();
      }
    },

    async dryRun(params: {
      sheetId: string;
      entries: TimesheetEntryInput[];
      action: TimesheetAction;
      deletions?: TimesheetRowDeletion[];
    }) {
      const { readService, epoch: operationEpoch } = await context();
      const result = readService.prepareDryRun(params);
      assertEpoch(operationEpoch);
      return result;
    },

    async save(params: {
      sheetId: string;
      entries: TimesheetEntryInput[];
      action: TimesheetAction;
      deletions?: TimesheetRowDeletion[];
    }) {
      const { readService, epoch: operationEpoch } = await context();
      const operation = createOperationController();
      try {
        const result = await readService.save({
          ...params,
          signal: operation.controller.signal,
        });
        assertEpoch(operationEpoch);
        dbg.timesheet(
          'saved timesheet entries',
          result.summary.entryCount,
          'added rows',
          result.summary.addedRowCount,
        );
        return result;
      } finally {
        operation.release();
      }
    },
  };
}

export const eureciaSessionService = createEureciaSessionService();
