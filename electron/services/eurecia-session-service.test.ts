import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

const debug = vi.hoisted(() => ({
  dbg: { timesheet: vi.fn() },
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
}));

vi.mock('../database/repositories/settings', () => ({
  SettingsRepository: { get: vi.fn() },
}));

vi.mock('../lib/debug', () => debug);

import {
  createEureciaSessionFetch,
  createEureciaSessionService,
  EURECIA_PARTITION,
} from './eurecia-session-service';

const BASE_URL = 'https://tenant.example';
const BROWSE_URL = `${BASE_URL}/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&id=sheet`;
const OPEN_URL = `${BASE_URL}/eurecia/timesheet/Open.do?id=sheet`;
const INTERNAL_SHEET_ID = 'internal-sheet-42';
const REDACTED_SHEET_ID = '__JEAN_CLAUDE_REDACTED_TIMESHEET_ID__';
const SETTING = {
  baseUrl: BASE_URL,
  axis1Label: 'Project',
  axis2Label: 'Activity',
  axis3Label: 'Role',
};

function authenticatedResponse(url = `${BASE_URL}/eurecia/api/v3/users/me/initData`) {
  return {
    url,
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ navigation: { url: BROWSE_URL } }),
  } as Response;
}

function browseResponse(url: string, sheetNavigationUrl = BROWSE_URL) {
  const cells = Array.from({ length: 13 }, (_, index) => {
    if (index === 0) return `<a href="${sheetNavigationUrl}">Edit</a>`;
    if (index === 2) return 'July sheet';
    if (index === 3) return '01/07/2026';
    if (index === 4) return '31/07/2026';
    if (index === 12) return 'Open';
    return '';
  });
  return {
    url,
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () =>
      `<table class="ibody"><tbody><tr class="clickable">${cells
        .map((cell) => `<td>${cell}</td>`)
        .join('')}</tr></tbody></table>`,
  } as Response;
}

function emptyBrowseResponse(url: string) {
  return {
    ...browseResponse(url),
    text: async () => '<table class="ibody"><tbody></tbody></table>',
  } as Response;
}

function openHtml(sheetIds = ['sheet']) {
  return `<html><body><form action="/eurecia/timesheet/Open.do?id=sheet">${sheetIds
    .map(
      (sheetId) =>
        `<input name="idTimeSheet" value="${sheetId.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}">`,
    )
    .join('')}</form></body></html>`;
}

function sheetFingerprint(sheetId: string) {
  return createHash('sha256').update(sheetId).digest('hex');
}

class FakeWebContents extends EventEmitter {
  url = '';
  script = '';
  scripts: string[] = [];
  capturedReply: unknown[] = [
    true,
    [
      ['', 'Choose'],
      ['one', 'One'],
    ],
    'one',
    false,
  ];
  executeGate?: Promise<void>;
  sheetIds = ['sheet'];
  outerHtml: unknown = openHtml();
  driftUrlAfterHtml?: string;
  driftUrlAfterAxis?: string;
  sheetIdsAfterAxis?: string[];
  sheetIdentityResults: unknown[] = [];
  identityResultOverrides: unknown[] = [];
  editorExtractionResults: unknown[] = [];
  editorExtractionResultOverrides: unknown[] = [];
  openHandler?: (details: { url: string }) => { action: 'deny' };

  getURL() {
    return this.url;
  }

  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'deny' },
  ) {
    this.openHandler = handler;
  }

  async executeJavaScript(script: string) {
    this.script = script;
    this.scripts.push(script);
    if (script.includes('querySelectorAll') && !script.includes('cloneNode')) {
      const result = this.identityResultOverrides.length > 0
        ? this.identityResultOverrides.shift()
        : this.sheetIds.length === 0
          ? { status: 'absent', count: 0 }
          : this.sheetIds.length > 1
            ? { status: 'duplicate', count: 2 }
            : !this.sheetIds[0].trim()
              ? { status: 'empty', count: 1 }
              : this.sheetIds[0].length > 512 ||
                  Buffer.byteLength(this.sheetIds[0], 'utf8') > 1_024
                ? { status: 'oversized', count: 1 }
                : {
                    status: 'ok',
                    count: 1,
                    fingerprint: sheetFingerprint(this.sheetIds[0]),
                  };
      this.sheetIdentityResults.push(result);
      return result;
    }
    await this.executeGate;
    if (
      script.includes('document.documentElement.outerHTML') ||
      script.includes('cloneNode')
    ) {
      if (this.driftUrlAfterHtml) this.url = this.driftUrlAfterHtml;
      if (this.editorExtractionResultOverrides.length > 0) {
        const result = this.editorExtractionResultOverrides.shift();
        this.editorExtractionResults.push(result);
        return result;
      }
      let result: unknown;
      if (this.sheetIds.length === 0) result = { status: 'absent', count: 0 };
      else if (this.sheetIds.length > 1) result = { status: 'duplicate', count: 2 };
      else if (!this.sheetIds[0].trim()) result = { status: 'empty', count: 1 };
      else if (
        this.sheetIds[0].length > 512 ||
        Buffer.byteLength(this.sheetIds[0], 'utf8') > 1_024
      ) {
        result = { status: 'oversized', count: 1 };
      } else if (typeof this.outerHtml !== 'string') {
        result = { status: 'missing' };
      } else {
        const escapedSheetId = this.sheetIds[0]
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;');
        const redactedHtml = this.outerHtml.replace(
          `name="idTimeSheet" value="${escapedSheetId}"`,
          `name="idTimeSheet" value="${REDACTED_SHEET_ID}"`,
        );
        result = Buffer.byteLength(redactedHtml, 'utf8') > 10 * 1024 * 1024
          ? { status: 'too-large' }
          : {
              status: 'ok',
              html: redactedHtml,
              fingerprint: sheetFingerprint(this.sheetIds[0]),
            };
      }
      this.editorExtractionResults.push(result);
      return result;
    }
    if (this.driftUrlAfterAxis) this.url = this.driftUrlAfterAxis;
    if (this.sheetIdsAfterAxis) this.sheetIds = this.sheetIdsAfterAxis;
    const tuples = this.capturedReply[1] as unknown[][];
    return {
      options: tuples
        .map((tuple) => ({ id: String(tuple[0]), label: String(tuple[1]) }))
        .filter(({ id }) => id !== ''),
      selectedId: this.capturedReply[2] as string,
    };
  }
}

class FakeWindow extends EventEmitter {
  /** Inspectable even after destruction; production code must not use this. */
  rawWebContents = new FakeWebContents();
  destroyed = false;
  focused = false;
  autoFinish = true;
  finalUrl?: string;
  loadEvent?: { event: 'will-navigate' | 'will-redirect'; url: string };
  loadEventPreventDefault = vi.fn();
  loadGate?: Promise<void>;
  loadError?: Error;
  didFailLoad?: {
    errorCode: number;
    errorDescription: string;
    validatedUrl: string;
    isMainFrame: boolean;
  };
  delayClosed = false;
  vetoClose = false;
  closeCalls = 0;
  destroyCalls = 0;
  title = '';

  async loadURL(url: string) {
    this.rawWebContents.url = url;
    if (this.loadEvent) {
      this.rawWebContents.emit(
        this.loadEvent.event,
        { preventDefault: this.loadEventPreventDefault },
        this.loadEvent.url,
      );
    }
    await this.loadGate;
    if (this.didFailLoad) {
      const failure = this.didFailLoad;
      this.rawWebContents.emit(
        'did-fail-load',
        {},
        failure.errorCode,
        failure.errorDescription,
        failure.validatedUrl,
        failure.isMainFrame,
      );
    }
    if (this.loadError) throw this.loadError;
    this.rawWebContents.url = this.finalUrl ?? url;
    if (this.autoFinish) this.rawWebContents.emit('did-finish-load');
  }

  close() {
    this.closeCalls += 1;
    if (this.vetoClose) return;
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.delayClosed) this.emit('closed');
  }

  destroy() {
    this.destroyCalls += 1;
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.delayClosed) this.emit('closed');
  }

  focus() {
    this.focused = true;
  }

  setTitle(title: string) {
    this.title = title;
  }

  isDestroyed() {
    return this.destroyed;
  }

  /** Electron throws on `window.webContents` once the window is destroyed. */
  get webContents(): FakeWebContents {
    if (this.destroyed) {
      throw new TypeError('Object has been destroyed');
    }
    return this.rawWebContents;
  }

  emitClosed() {
    this.emit('closed');
  }
}

function setup(
  fetchImpl: typeof fetch = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    return url.includes('/api/v3/users/me/initData')
      ? authenticatedResponse(url)
      : browseResponse(url);
  }),
  config: {
    hiddenLoadEvent?: {
      event: 'will-navigate' | 'will-redirect';
      url: string;
    };
    hiddenLoadGate?: Promise<void>;
    executeGate?: Promise<void>;
    authProbeTimeoutMs?: number;
    getSetting?: () => Promise<typeof SETTING>;
    clearStorageData?: () => Promise<void>;
    hiddenDelayClosed?: boolean;
    hiddenSheetIds?: string[];
    hiddenOuterHtml?: unknown;
    hiddenDriftUrlAfterHtml?: string;
    hiddenDriftUrlAfterAxis?: string;
    hiddenSheetIdsAfterAxis?: string[];
    hiddenIdentityResultOverrides?: unknown[];
    hiddenEditorExtractionResultOverrides?: unknown[];
    hiddenCapturedReply?: unknown[];
    vetoClose?: boolean;
    loginAutoFinish?: boolean;
    loginDidFailLoad?: FakeWindow['didFailLoad'];
    loginLoadError?: Error;
    loginLoadEvent?: {
      event: 'will-navigate' | 'will-redirect';
      url: string;
    };
  } = {},
) {
  const clearStorageData = vi.fn(config.clearStorageData ?? (async () => {}));
  let permissionRequestHandler:
    | ((
        webContents: unknown,
        permission: string,
        callback: (allowed: boolean) => void,
        details: unknown,
      ) => void)
    | undefined;
  let permissionCheckHandler:
    | ((
        webContents: unknown,
        permission: string,
        requestingOrigin: string,
        details: unknown,
      ) => boolean)
    | undefined;
  let willDownloadHandler:
    | ((event: { preventDefault: () => void }) => void)
    | undefined;
  const setPermissionRequestHandler = vi.fn((handler) => {
    permissionRequestHandler = handler;
  });
  const setPermissionCheckHandler = vi.fn((handler) => {
    permissionCheckHandler = handler;
  });
  const on = vi.fn((event: string, handler) => {
    if (event === 'will-download') willDownloadHandler = handler;
  });
  const partitionSession = {
    clearStorageData,
    fetch: fetchImpl,
    setPermissionRequestHandler,
    setPermissionCheckHandler,
    on,
  };
  const createReadFetch = vi.fn(() => fetchImpl);
  const windows: Array<{
    options: Electron.BrowserWindowConstructorOptions;
    window: FakeWindow;
  }> = [];
  const service = createEureciaSessionService({
    getSetting: config.getSetting ?? (async () => SETTING),
    getSession: () => partitionSession,
    createReadFetch,
    createWindow: (windowOptions) => {
      const window = new FakeWindow();
      window.vetoClose = config.vetoClose ?? false;
      if (windowOptions.show === false) {
        window.finalUrl = OPEN_URL;
        window.loadEvent = config.hiddenLoadEvent;
        window.loadGate = config.hiddenLoadGate;
        window.rawWebContents.executeGate = config.executeGate;
        window.rawWebContents.sheetIds = config.hiddenSheetIds ?? ['sheet'];
        window.rawWebContents.outerHtml = Object.hasOwn(config, 'hiddenOuterHtml')
          ? config.hiddenOuterHtml
          : openHtml();
        window.rawWebContents.driftUrlAfterHtml = config.hiddenDriftUrlAfterHtml;
        window.rawWebContents.driftUrlAfterAxis = config.hiddenDriftUrlAfterAxis;
        window.rawWebContents.sheetIdsAfterAxis = config.hiddenSheetIdsAfterAxis;
        window.rawWebContents.identityResultOverrides =
          config.hiddenIdentityResultOverrides ?? [];
        window.rawWebContents.editorExtractionResultOverrides =
          config.hiddenEditorExtractionResultOverrides ?? [];
        if (config.hiddenCapturedReply) {
          window.rawWebContents.capturedReply = config.hiddenCapturedReply;
        }
        window.delayClosed = config.hiddenDelayClosed ?? false;
      } else {
        window.autoFinish = config.loginAutoFinish ?? true;
        window.didFailLoad = config.loginDidFailLoad;
        window.loadError = config.loginLoadError;
        window.loadEvent = config.loginLoadEvent;
      }
      windows.push({ options: windowOptions, window });
      return window;
    },
    authProbeTimeoutMs: config.authProbeTimeoutMs,
  });
  return {
    service,
    windows,
    clearStorageData,
    fetchImpl,
    partitionSession,
    createReadFetch,
    setPermissionRequestHandler,
    setPermissionCheckHandler,
    on,
    getPermissionRequestHandler: () => permissionRequestHandler,
    getPermissionCheckHandler: () => permissionCheckHandler,
    getWillDownloadHandler: () => willDownloadHandler,
  };
}

describe('createEureciaSessionFetch', () => {
  const init = {
    method: 'GET' as const,
    redirect: 'manual' as const,
    credentials: 'include' as const,
  };

  it('reads a normal streamed response and preserves requested URL', async () => {
    const response = new Response('authenticated', {
      headers: { 'content-type': 'text/plain' },
    });
    const fetch = createEureciaSessionFetch({ fetch: vi.fn(async () => response) });

    const result = await fetch(`${BASE_URL}/eurecia/test`, init);

    expect(result.url).toBe(`${BASE_URL}/eurecia/test`);
    await expect(result.text()).resolves.toBe('authenticated');
  });

  it('preserves the Session.fetch receiver', async () => {
    type FetchSession = {
      fetch: (
        url: string,
        init: {
          method: 'GET';
          redirect: 'manual' | 'follow';
          credentials: 'include';
          signal?: AbortSignal;
        },
      ) => Promise<Response>;
    };
    let partitionSession: FetchSession;
    partitionSession = {
      fetch: vi.fn(async function (this: FetchSession) {
        if (this !== partitionSession) throw new Error('Session.fetch lost receiver.');
        return new Response('authenticated');
      }),
    };
    const readFetch = createEureciaSessionFetch(partitionSession);

    const result = await readFetch(`${BASE_URL}/eurecia/test`, init);

    await expect(result.text()).resolves.toBe('authenticated');
  });

  it('rejects content-length above the response limit before reading', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      { headers: { 'content-length': String(10 * 1024 * 1024 + 1) } },
    );
    const fetch = createEureciaSessionFetch({ fetch: vi.fn(async () => response) });

    const result = await fetch(`${BASE_URL}/eurecia/test`, init);

    await expect(result.text()).rejects.toThrow('10 MiB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects and cancels a chunked response that crosses the response limit', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(6 * 1024 * 1024);
    let sent = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk);
          sent += 1;
        },
        cancel,
      }),
    );
    const fetch = createEureciaSessionFetch({ fetch: vi.fn(async () => response) });

    const result = await fetch(`${BASE_URL}/eurecia/test`, init);

    await expect(result.text()).rejects.toThrow('10 MiB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a pending stream reader when aborted', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel }),
    );
    const fetch = createEureciaSessionFetch({ fetch: vi.fn(async () => response) });
    const controller = new AbortController();
    const result = await fetch(`${BASE_URL}/eurecia/test`, {
      ...init,
      signal: controller.signal,
    });
    const text = result.text();

    controller.abort();

    await expect(text).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('uses bounded fallback text when Response.body is unavailable', async () => {
    const response = {
      body: null,
      headers: new Headers(),
      ok: true,
      status: 200,
      text: vi.fn(async () => 'fallback'),
      url: '',
    } as unknown as Response;
    const fetch = createEureciaSessionFetch({ fetch: vi.fn(async () => response) });

    const result = await fetch(`${BASE_URL}/eurecia/test`, init);

    await expect(result.text()).resolves.toBe('fallback');
    expect(response.text).toHaveBeenCalledOnce();
  });

  it('rejects oversized fallback text when Response.body is unavailable', async () => {
    const response = {
      body: null,
      headers: new Headers(),
      ok: true,
      status: 200,
      text: vi.fn(async () => 'x'.repeat(10 * 1024 * 1024 + 1)),
      url: '',
    } as unknown as Response;
    const fetch = createEureciaSessionFetch({ fetch: vi.fn(async () => response) });

    const result = await fetch(`${BASE_URL}/eurecia/test`, init);

    await expect(result.text()).rejects.toThrow('10 MiB');
  });
});

describe('eureciaSessionService', () => {
  it('logs sanitized login navigation and successful lifecycle diagnostics', async () => {
    debug.dbg.timesheet.mockClear();
    const navigationUrl =
      'https://credential-user:credential-password@tenant.example/eurecia/login?token=secret-query#secret-fragment';
    const { service, windows } = setup(undefined, {
      loginLoadEvent: {
        event: 'will-navigate',
        url: navigationUrl,
      },
    });
    const login = service.login();
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    await login;

    const calls = debug.dbg.timesheet.mock.calls;
    const emitted = JSON.stringify(calls);
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login window created hostname=%s elapsedMs=%d',
      'tenant.example',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login navigation hostname=%s route=%s outcome=%s elapsedMs=%d',
      'blocked',
      'blocked',
      'blocked',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login probe trigger trigger=immediate hostname=%s route=%s elapsedMs=%d',
      'tenant.example',
      'eurecia',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login probe result outcome=%s elapsedMs=%d',
      'authenticated',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login success elapsedMs=%d',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login cleanup outcome=%s elapsedMs=%d',
      'succeeded',
      expect.any(Number),
    );
    expect(emitted).not.toContain(navigationUrl);
    expect(emitted).not.toContain(`${BASE_URL}/eurecia/login`);
    expect(emitted).not.toContain('secret-query');
    expect(emitted).not.toContain('secret-fragment');
    expect(emitted).not.toContain('?token=');
    expect(emitted).not.toContain('credential-user');
    expect(emitted).not.toContain('credential-password');
  });

  it('redacts path tokens and uses fixed placeholders for blocked URL schemes and hosts', async () => {
    debug.dbg.timesheet.mockClear();
    const { service, windows } = setup(
      vi.fn(async () => {
        throw new Error('not authenticated');
      }),
    );
    const login = service.login();
    const observedLogin = login.catch((error: unknown) => error);
    await vi.waitFor(() => expect(windows).toHaveLength(1));

    const navigationUrls = [
      `${BASE_URL}/eurecia/login/path-secret-token?query-secret#fragment-secret`,
      'data:text/plain,data-path-secret',
      'file:///tmp/file-path-secret',
      'https://external.example/external-path-secret',
      'malformed-url-secret',
    ];
    for (const url of navigationUrls) {
      windows[0].window.rawWebContents.emit(
        'will-navigate',
        { preventDefault: vi.fn() },
        url,
      );
    }

    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login navigation hostname=%s route=%s outcome=%s elapsedMs=%d',
      'tenant.example',
      'eurecia',
      'allowed',
      expect.any(Number),
    );
    expect(
      debug.dbg.timesheet.mock.calls.filter(
        ([format, hostname, route, outcome]) =>
          format === 'login navigation hostname=%s route=%s outcome=%s elapsedMs=%d' &&
          hostname === 'blocked' &&
          route === 'blocked' &&
          outcome === 'blocked',
      ),
    ).toHaveLength(4);
    const emitted = JSON.stringify(debug.dbg.timesheet.mock.calls);
    for (const token of [
      'path-secret-token',
      'query-secret',
      'fragment-secret',
      'data-path-secret',
      'file-path-secret',
      'external-path-secret',
      'external.example',
      'malformed-url-secret',
    ]) {
      expect(emitted).not.toContain(token);
    }

    windows[0].window.close();
    await observedLogin;
  });

  it('logs timesheet access errors as a dedicated safe probe outcome', async () => {
    debug.dbg.timesheet.mockClear();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => ({
      ...authenticatedResponse(String(input)),
      text: async () => JSON.stringify({ navigation: {} }),
    }));
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    await expect(login).rejects.toThrow(
      'Signed in to Eurecia, but Timesheet access or configuration is unavailable.',
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login probe result outcome=%s reason=%s elapsedMs=%d',
      'timesheet-access-unavailable',
      'missing-timesheet-browse',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).not.toHaveBeenCalledWith(
      'login probe result outcome=%s elapsedMs=%d',
      'unauthenticated',
      expect.any(Number),
    );
    await expect(service.authStatus()).resolves.toEqual({
      configured: true,
      authenticated: false,
      baseUrl: BASE_URL,
    });
    expect(windows[0].window.destroyed).toBe(true);
    expect(windows[0].window.rawWebContents.listenerCount('did-finish-load')).toBe(0);
    expect(windows[0].window.listenerCount('closed')).toBe(0);
  });

  it('logs a fixed discovery reason without error, response, or URL secrets', async () => {
    debug.dbg.timesheet.mockClear();
    const secrets = [
      'secret-error',
      'secret-response',
      'secret-query',
      'secret-fragment',
      'secret-token',
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError(
        `secret-error ${BASE_URL}/eurecia/?query=secret-query#secret-fragment token=secret-token body=secret-response`,
      );
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login probe result outcome=%s reason=%s elapsedMs=%d',
      'unauthenticated',
      'network',
      expect.any(Number),
    );
    const emitted = JSON.stringify(debug.dbg.timesheet.mock.calls);
    for (const secret of secrets) expect(emitted).not.toContain(secret);

    windows[0].window.close();
    await expect(login).rejects.toThrow('cancelled');
  });

  it('logs fixed cancellation and load-failure outcomes without raw errors', async () => {
    debug.dbg.timesheet.mockClear();
    const cancelled = setup(
      vi.fn(async () => {
        throw new Error('not authenticated');
      }),
    );
    const cancelledLogin = cancelled.service.login();
    await vi.waitFor(() => expect(cancelled.windows).toHaveLength(1));
    cancelled.windows[0].window.close();
    await expect(cancelledLogin).rejects.toThrow('cancelled');

    const failed = setup(undefined, {
      loginLoadError: new Error(
        'ERR_FAILED https://tenant.example/eurecia/?credential=secret-load',
      ),
    });
    await expect(failed.service.login()).rejects.toThrow('failed to load');

    const calls = debug.dbg.timesheet.mock.calls;
    const emitted = JSON.stringify(calls);
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login cancelled elapsedMs=%d',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login load failed outcome=load-failed elapsedMs=%d',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login cleanup outcome=%s elapsedMs=%d',
      'cancelled',
      expect.any(Number),
    );
    expect(debug.dbg.timesheet).toHaveBeenCalledWith(
      'login cleanup outcome=%s elapsedMs=%d',
      'load-failed',
      expect.any(Number),
    );
    expect(
      calls.filter(([format]) => String(format).includes('login cleanup')),
    ).toHaveLength(2);
    expect(emitted).not.toContain('secret-load');
    expect(emitted).not.toContain('ERR_FAILED');
  });

  it('rejects a later main-frame load failure and cleans up safely', async () => {
    vi.useFakeTimers();
    debug.dbg.timesheet.mockClear();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('not authenticated');
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();

    try {
      await vi.advanceTimersByTimeAsync(0);
      windows[0].window.rawWebContents.emit(
        'did-fail-load',
        {},
        -105,
        'ERR_NAME_NOT_RESOLVED secret-description',
        `${BASE_URL}/eurecia/login?token=secret-failed-url`,
        true,
      );

      await expect(login).rejects.toThrow('Eurecia sign-in page failed to load.');
      expect(vi.getTimerCount()).toBe(0);
      expect(windows[0].window.destroyed).toBe(true);
      expect(windows[0].window.rawWebContents.listenerCount('did-fail-load')).toBe(0);
      const emitted = JSON.stringify(debug.dbg.timesheet.mock.calls);
      expect(emitted).not.toContain('secret-description');
      expect(emitted).not.toContain('secret-failed-url');
      expect(emitted).not.toContain('ERR_NAME_NOT_RESOLVED');
    } finally {
      windows[0]?.window.close();
      vi.useRealTimers();
    }
  });

  it.each([
    ['subframe failure', -105, false],
    ['redirect cancellation', -3, true],
  ] as const)('ignores %s from did-fail-load', async (_label, errorCode, isMainFrame) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('not authenticated');
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    let settled = false;
    const observedLogin = login.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    windows[0].window.rawWebContents.emit(
      'did-fail-load',
      {},
      errorCode,
      'ignored secret error',
      `${BASE_URL}/eurecia/login?token=ignored-secret`,
      isMainFrame,
    );
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(windows[0].window.destroyed).toBe(false);
    windows[0].window.close();
    await expect(observedLogin).resolves.toMatchObject({
      message: expect.stringContaining('cancelled'),
    });
  });

  it('settles initial load rejection and did-fail-load only once', async () => {
    debug.dbg.timesheet.mockClear();
    const { service } = setup(undefined, {
      loginDidFailLoad: {
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED secret-race',
        validatedUrl: `${BASE_URL}/eurecia/?token=secret-race-url`,
        isMainFrame: true,
      },
      loginLoadError: new Error('ERR_FAILED secret-rejection'),
    });

    await expect(service.login()).rejects.toThrow('failed to load');
    expect(
      debug.dbg.timesheet.mock.calls.filter(
        ([format]) => format === 'login cleanup outcome=%s elapsedMs=%d',
      ),
    ).toHaveLength(1);
    const emitted = JSON.stringify(debug.dbg.timesheet.mock.calls);
    expect(emitted).not.toContain('secret-race');
    expect(emitted).not.toContain('secret-rejection');
  });

  it.each([
    [
      'numeric code',
      Object.assign(new Error('secret numeric code'), { code: -3 }),
    ],
    [
      'numeric errno',
      Object.assign(new Error('secret numeric errno'), { errno: -3 }),
    ],
    [
      'ERR_ABORTED code',
      Object.assign(new Error('secret string code'), { code: 'ERR_ABORTED' }),
    ],
    [
      'ERR_ABORTED name',
      Object.assign(new Error('secret error name'), { name: 'ERR_ABORTED' }),
    ],
    [
      'ERR_ABORTED message',
      new Error(`ERR_ABORTED (-3) loading '${BASE_URL}/eurecia/?token=secret-abort'`),
    ],
  ])('ignores loadURL rejection with %s', async (_label, loadError) => {
    vi.useFakeTimers();
    debug.dbg.timesheet.mockClear();
    let authenticated = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!authenticated) throw new Error('not authenticated');
      return authenticatedResponse(String(input));
    });
    const { service, windows } = setup(fetchImpl, {
      loginAutoFinish: false,
      loginLoadError: loadError,
    });
    const observedLogin = service.login().then(
      (status) => status,
      (error: unknown) => error,
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(windows[0].window.destroyed).toBe(false);

      authenticated = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(observedLogin).resolves.toMatchObject({ authenticated: true });
      const emitted = JSON.stringify(debug.dbg.timesheet.mock.calls);
      expect(emitted).not.toContain('secret');
      expect(emitted).not.toContain('ERR_ABORTED');
    } finally {
      windows[0]?.window.close();
      vi.useRealTimers();
    }
  });

  it('ignores combined did-fail-load and loadURL ERR_ABORTED signals', async () => {
    vi.useFakeTimers();
    let authenticated = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!authenticated) throw new Error('not authenticated');
      return authenticatedResponse(String(input));
    });
    const { service, windows } = setup(fetchImpl, {
      loginAutoFinish: false,
      loginDidFailLoad: {
        errorCode: -3,
        errorDescription: 'ERR_ABORTED secret-description',
        validatedUrl: `${BASE_URL}/eurecia/?token=secret-combined`,
        isMainFrame: true,
      },
      loginLoadError: new Error('ERR_ABORTED (-3) secret-rejection'),
    });
    const observedLogin = service.login().then(
      (status) => status,
      (error: unknown) => error,
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(windows[0].window.destroyed).toBe(false);

      authenticated = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(observedLogin).resolves.toMatchObject({ authenticated: true });
    } finally {
      windows[0]?.window.close();
      vi.useRealTimers();
    }
  });

  it('rejects an ordinary loadURL error and removes login resources', async () => {
    vi.useFakeTimers();
    debug.dbg.timesheet.mockClear();
    const { service, windows } = setup(
      vi.fn(async () => {
        throw new Error('not authenticated');
      }),
      {
        loginAutoFinish: false,
        loginLoadError: new Error('ERR_FAILED secret-ordinary-rejection'),
      },
    );
    const observedLogin = service.login().catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(0);
      await expect(observedLogin).resolves.toMatchObject({
        message: expect.stringContaining('failed to load'),
      });
      expect(windows[0].window.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(windows[0].window.rawWebContents.listenerCount('did-fail-load')).toBe(0);
      const emitted = JSON.stringify(debug.dbg.timesheet.mock.calls);
      expect(emitted).not.toContain('secret-ordinary-rejection');
      expect(emitted).not.toContain('ERR_FAILED');
    } finally {
      windows[0]?.window.close();
      vi.useRealTimers();
    }
  });

  it('uses fixed partition read adapter and reports authenticated status without secrets', async () => {
    const { service, fetchImpl, partitionSession, createReadFetch } = setup();

    await expect(service.authStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      baseUrl: BASE_URL,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE_URL}/eurecia/api/v3/users/me/initData`,
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        credentials: 'include',
      }),
    );
    expect(createReadFetch).toHaveBeenCalledOnce();
    expect(createReadFetch).toHaveBeenCalledWith(partitionSession);
    expect(EURECIA_PARTITION).toBe('persist:jean-claude-eurecia');
  });

  it('secures the shared login and hidden-window partition exactly once', async () => {
    const {
      service,
      windows,
      partitionSession,
      createReadFetch,
      setPermissionRequestHandler,
      setPermissionCheckHandler,
      on,
      getPermissionRequestHandler,
      getPermissionCheckHandler,
      getWillDownloadHandler,
    } = setup();

    await service.login();
    await service.listSheets();
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });
    await service.authStatus();
    const secondService = createEureciaSessionService({
      getSetting: async () => SETTING,
      getSession: () => partitionSession,
      createReadFetch,
    });
    await secondService.authStatus();

    expect(windows).toHaveLength(2);
    for (const { options } of windows) {
      expect(options.webPreferences?.partition).toBe(EURECIA_PARTITION);
    }
    expect(setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith('will-download', expect.any(Function));

    const permissionCallback = vi.fn();
    getPermissionRequestHandler()?.(null, 'media', permissionCallback, {});
    expect(permissionCallback).toHaveBeenCalledWith(false);
    expect(getPermissionCheckHandler()?.(null, 'media', BASE_URL, {})).toBe(false);
    const downloadEvent = { preventDefault: vi.fn() };
    getWillDownloadHandler()?.(downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it.each(['', 'https://incorrect.example/response-url'])(
    'logs in through partition Session.fetch when Electron reports response URL %j',
    async (reportedUrl) => {
      let electronResponse: Response;
      electronResponse = {
        ...authenticatedResponse(reportedUrl),
        text: async function () {
          if (this !== electronResponse) throw new Error('Response.text lost receiver.');
          return JSON.stringify({ navigation: { url: BROWSE_URL } });
        },
      } as Response;
      const fetchImpl = vi.fn(async () => electronResponse);
      const partitionSession = {
        clearStorageData: vi.fn(async () => {}),
        fetch: fetchImpl,
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        on: vi.fn(),
      };
      const windows: FakeWindow[] = [];
      const service = createEureciaSessionService({
        getSetting: async () => SETTING,
        getSession: () => partitionSession,
        createWindow: () => {
          const window = new FakeWindow();
          windows.push(window);
          return window;
        },
      });

      await expect(service.login()).resolves.toMatchObject({ authenticated: true });
      expect(fetchImpl).toHaveBeenCalledWith(
        `${BASE_URL}/eurecia/api/v3/users/me/initData`,
        expect.objectContaining({
          credentials: 'include',
          redirect: 'manual',
        }),
      );
      expect(windows[0].destroyed).toBe(true);
    },
  );

  it('keeps manual redirect Location validation authoritative', async () => {
    const initialUrl = `${BASE_URL}/eurecia/api/v3/users/me/initData`;
    const redirectedUrl = `${initialUrl}?authenticated=1`;
    const responses = [
      {
        url: initialUrl,
        status: 302,
        ok: false,
        headers: new Headers({ location: redirectedUrl }),
        text: async () => '',
      },
      {
        url: redirectedUrl,
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ navigation: { url: BROWSE_URL } }),
      },
    ] as Response[];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected fetch');
      return response;
    });
    const { service } = setup(fetchImpl);

    await expect(service.authStatus()).resolves.toMatchObject({ authenticated: true });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      initialUrl,
      redirectedUrl,
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.redirect)).toEqual([
      'manual',
      'manual',
    ]);
  });

  it('rejects cross-origin manual redirect Location without fetching it', async () => {
    const crossOriginUrl =
      'https://attacker.example/eurecia/api/v3/users/me/initData?token=secret';
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ({
        url: '',
        status: 302,
        ok: false,
        headers: new Headers({ location: crossOriginUrl }),
        text: async () => '',
      }) as Response,
    );
    const { service } = setup(fetchImpl);

    await expect(service.authStatus()).resolves.toMatchObject({ authenticated: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain(crossOriginUrl);
  });

  it('creates a secure login window in the partition and auto-closes after auth', async () => {
    const { service, windows } = setup(undefined, { vetoClose: true });

    await expect(service.login()).resolves.toMatchObject({ authenticated: true });

    expect(windows).toHaveLength(1);
    expect(windows[0].options).toMatchObject({ width: 900, height: 720, show: true });
    expect(windows[0].options.webPreferences).toEqual({
      partition: EURECIA_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(windows[0].window.rawWebContents.openHandler?.({ url: BASE_URL })).toEqual({
      action: 'deny',
    });
    expect(windows[0].window.destroyed).toBe(true);
    expect(windows[0].window.closeCalls).toBe(0);
    expect(windows[0].window.destroyCalls).toBe(1);
  });

  it('focuses an existing login window and returns cancellation on close', async () => {
    const { service, windows } = setup(
      vi.fn(async () => {
        throw new Error('not authenticated');
      }),
    );
    const first = service.login();
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    const second = service.login();
    await vi.waitFor(() => expect(windows[0].window.focused).toBe(true));
    windows[0].window.close();

    await expect(first).rejects.toThrow('cancelled');
    await expect(second).rejects.toThrow('cancelled');
    expect(windows[0].window.closeCalls).toBe(1);
    expect(windows[0].window.destroyCalls).toBe(0);
  });

  it('settles as cancelled when the window closes mid-probe so the UI can show sign-in again', async () => {
    // Electron destroys webContents before 'closed' fires; cleanup must not throw
    // there, or the login promise would hang and strand the UI on "Signing in...".
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('not authenticated');
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    windows[0].window.close();

    await expect(login).rejects.toThrow('Eurecia sign-in was cancelled.');
    // A retry gets a fresh window rather than a stale, never-settling promise.
    const retry = service.login();
    await vi.waitFor(() => expect(windows).toHaveLength(2));
    windows[1].window.close();
    await expect(retry).rejects.toThrow('Eurecia sign-in was cancelled.');
  });

  it('polls for authentication after an initial probe fails without another navigation', async () => {
    vi.useFakeTimers();
    let authenticated = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!authenticated) throw new Error('not authenticated');
      return authenticatedResponse(String(input));
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    let outcome: unknown = 'pending';
    const observedLogin = login.then(
      (status) => {
        outcome = status;
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledOnce();

      authenticated = true;
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchImpl).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(outcome).toMatchObject({ authenticated: true });
      expect(debug.dbg.timesheet).toHaveBeenCalledWith(
        'login probe trigger trigger=interval hostname=%s route=%s elapsedMs=%d',
        'tenant.example',
        'eurecia',
        expect.any(Number),
      );
    } finally {
      windows[0]?.window.close();
      await observedLogin;
      vi.useRealTimers();
    }
  });

  it('serializes repeated login triggers while an authentication probe is active', async () => {
    let releaseProbe!: (response: Response) => void;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      try {
        return await new Promise<Response>((resolve) => {
          releaseProbe = resolve;
        });
      } finally {
        activeFetches -= 1;
      }
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    windows[0].window.rawWebContents.emit('did-finish-load');
    windows[0].window.rawWebContents.emit('did-finish-load');
    windows[0].window.rawWebContents.emit('did-finish-load');

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(maxActiveFetches).toBe(1);
    releaseProbe(authenticatedResponse());
    await expect(login).resolves.toMatchObject({ authenticated: true });
    expect(maxActiveFetches).toBe(1);
  });

  it('coalesces a fixed interval tick while a slow probe is active', async () => {
    vi.useFakeTimers();
    let releaseFirstProbe!: () => void;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (fetchImpl.mock.calls.length === 1) {
        await new Promise<void>((_resolve, reject) => {
          releaseFirstProbe = () => reject(new Error('not authenticated'));
        });
      }
      return authenticatedResponse(String(input));
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchImpl).toHaveBeenCalledOnce();

      releaseFirstProbe();
      await vi.advanceTimersByTimeAsync(0);
      await expect(login).resolves.toMatchObject({ authenticated: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(debug.dbg.timesheet).toHaveBeenCalledWith(
        'login probe trigger trigger=coalesced hostname=%s route=%s elapsedMs=%d',
        'tenant.example',
        'eurecia',
        expect.any(Number),
      );
    } finally {
      windows[0]?.window.close();
      vi.useRealTimers();
    }
  });

  it('coalesces repeated load events into one follow-up probe', async () => {
    let releaseFirstProbe!: () => void;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (fetchImpl.mock.calls.length === 1) {
        await new Promise<void>((_resolve, reject) => {
          releaseFirstProbe = () => reject(new Error('not authenticated'));
        });
      }
      return authenticatedResponse(String(input));
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    windows[0].window.rawWebContents.emit('did-finish-load');
    windows[0].window.rawWebContents.emit('did-finish-load');
    windows[0].window.rawWebContents.emit('did-finish-load');
    expect(fetchImpl).toHaveBeenCalledOnce();

    releaseFirstProbe();
    await expect(login).resolves.toMatchObject({ authenticated: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('probes after an allowed Eurecia identity-provider page finishes loading', async () => {
    let authenticated = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (!authenticated) throw new Error('not authenticated');
      return authenticatedResponse(String(input));
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    authenticated = true;
    windows[0].window.rawWebContents.url =
      'https://plateforme-idp.eurecia.com/sign-in';
    windows[0].window.rawWebContents.emit('did-finish-load');

    await expect(login).resolves.toMatchObject({ authenticated: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('clears future authentication polling when the login popup closes', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('not authenticated');
    });
    const { service, windows } = setup(fetchImpl, { loginAutoFinish: false });
    const login = service.login();
    const observedLogin = login.then(
      () => null,
      (error: unknown) => error,
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledOnce();

      windows[0].window.close();
      await expect(observedLogin).resolves.toMatchObject({
        message: expect.stringContaining('cancelled'),
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(windows[0].window.rawWebContents.listenerCount('will-navigate')).toBe(0);
      expect(windows[0].window.rawWebContents.listenerCount('will-redirect')).toBe(0);
      expect(windows[0].window.rawWebContents.listenerCount('did-finish-load')).toBe(0);
      expect(windows[0].window.listenerCount('closed')).toBe(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      windows[0]?.window.close();
      await observedLogin;
      vi.useRealTimers();
    }
  });

  it('cancels login polling and removes listeners on logout', async () => {
    vi.useFakeTimers();
    const { service, windows } = setup(
      vi.fn(async () => {
        throw new Error('not authenticated');
      }),
    );
    const login = service.login();

    try {
      await vi.advanceTimersByTimeAsync(0);
      await service.logout();

      await expect(login).rejects.toThrow('cancelled');
      expect(vi.getTimerCount()).toBe(0);
      expect(windows[0].window.rawWebContents.listenerCount('will-navigate')).toBe(0);
      expect(windows[0].window.rawWebContents.listenerCount('will-redirect')).toBe(0);
      expect(windows[0].window.rawWebContents.listenerCount('did-finish-load')).toBe(0);
      expect(windows[0].window.listenerCount('closed')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['close', 'logout'] as const)(
    'promptly settles an abort-insensitive probe on %s',
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Promise<Response>(() => {}),
      );
      const { service, windows } = setup(fetchImpl);
      const login = service.login();
      const observedLogin = login.catch((error: unknown) => error);

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        if (action === 'close') windows[0].window.close();
        else await service.logout();
        await vi.advanceTimersByTimeAsync(0);

        await expect(observedLogin).resolves.toMatchObject({
          message: expect.stringContaining('cancelled'),
        });
        expect(Date.now()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(windows[0].window.rawWebContents.listenerCount('will-navigate')).toBe(0);
        expect(windows[0].window.rawWebContents.listenerCount('will-redirect')).toBe(0);
        expect(windows[0].window.rawWebContents.listenerCount('did-finish-load')).toBe(0);
        expect(windows[0].window.listenerCount('closed')).toBe(0);
      } finally {
        windows[0]?.window.close();
        await observedLogin;
        vi.useRealTimers();
      }
    },
  );

  it('allows only configured origin and Eurecia HTTPS login hosts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('not authenticated');
    });
    const { service, windows } = setup(fetchImpl);
    void service.login().catch(() => {});
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    const preventDefault = vi.fn();
    windows[0].window.rawWebContents.emit('will-navigate', { preventDefault }, 'https://attacker.example/phish');
    windows[0].window.rawWebContents.emit('will-redirect', { preventDefault }, 'http://bad.example');
    expect(preventDefault).toHaveBeenCalledTimes(2);

    const allowBase = vi.fn();
    const allowIdp = vi.fn();
    windows[0].window.rawWebContents.emit(
      'will-navigate',
      { preventDefault: allowBase },
      `${BASE_URL}/eurecia/login`,
    );
    windows[0].window.rawWebContents.emit(
      'will-redirect',
      { preventDefault: allowIdp },
      'https://plateforme-idp.eurecia.com/sign-in',
    );
    expect(allowBase).not.toHaveBeenCalled();
    expect(allowIdp).not.toHaveBeenCalled();

    windows[0].window.rawWebContents.url =
      'https://plateforme-idp.eurecia.com/sign-in';
    const preventTitle = vi.fn();
    windows[0].window.rawWebContents.emit('page-title-updated', {
      preventDefault: preventTitle,
    });
    expect(preventTitle).toHaveBeenCalledOnce();
    expect(windows[0].window.title).toBe(
      'Sign in to Eurecia (plateforme-idp.eurecia.com)',
    );
    windows[0].window.close();
    expect(windows[0].window.rawWebContents.listenerCount('page-title-updated')).toBe(0);
  });

  it('clears only partition storage and closes Eurecia windows on logout', async () => {
    const { service, windows, clearStorageData } = setup();
    await service.listSheets();
    await service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    }).catch(() => {});

    await service.logout();

    expect(clearStorageData).toHaveBeenCalledOnce();
    expect(windows.every(({ window }) => window.destroyed)).toBe(true);
  });

  it('invalidates session state after a setting change without clearing partition storage', async () => {
    const { service, windows, clearStorageData, createReadFetch } = setup();
    await service.listSheets();
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });

    service.invalidateForSettingChange();

    expect(clearStorageData).not.toHaveBeenCalled();
    expect(windows[0].window.destroyed).toBe(true);
    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('latest Browse result');
    await service.listSheets();
    expect(createReadFetch).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending list, clears its refresh, and ignores its late result after a setting change', async () => {
    let browseRequestCount = 0;
    let releaseStaleBrowse!: (response: Response) => void;
    let staleSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v3/users/me/initData')) {
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      if (browseRequestCount === 1) {
        staleSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          releaseStaleBrowse = resolve;
        });
      }
      return emptyBrowseResponse(url);
    });
    const { service, clearStorageData } = setup(fetchImpl);
    const staleList = service.listSheets();
    await vi.waitFor(() => expect(browseRequestCount).toBe(1));

    service.invalidateForSettingChange();

    expect(staleSignal?.aborted).toBe(true);
    await expect(staleList).rejects.toThrow('cancelled');
    await expect(service.listSheets()).resolves.toEqual([]);
    releaseStaleBrowse(browseResponse(BROWSE_URL));
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('latest Browse result');
    expect(clearStorageData).not.toHaveBeenCalled();
  });

  it('promptly cancels in-flight inspect and axis operations after a setting change', async () => {
    const executeGate = new Promise<void>(() => {});
    const { service, windows } = setup(undefined, { executeGate });
    await service.listSheets();
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    const lookup = service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    });
    await vi.waitFor(() =>
      expect(windows[0].window.rawWebContents.scripts).toEqual(
        expect.arrayContaining([
          expect.stringContaining('outerHTML'),
          expect.stringContaining('imputationStructureId1_'),
        ]),
      ),
    );

    service.invalidateForSettingChange();

    const results = await Promise.race([
      Promise.all([
        inspection.catch((error: unknown) => error),
        lookup.catch((error: unknown) => error),
      ]),
      new Promise<'timed out'>((resolve) =>
        setTimeout(() => resolve('timed out'), 50),
      ),
    ]);
    expect(results).not.toBe('timed out');
    expect(results).toEqual([
      expect.objectContaining({ message: expect.stringContaining('cancelled') }),
      expect.objectContaining({ message: expect.stringContaining('cancelled') }),
    ]);
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('promptly cancels login and does not reuse its late completion after a setting change', async () => {
    let releaseOldProbe!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (fetchImpl.mock.calls.length === 1) {
        return new Promise<Response>((resolve) => {
          releaseOldProbe = resolve;
        });
      }
      return authenticatedResponse(String(input));
    });
    const { service, windows, clearStorageData } = setup(fetchImpl, {
      loginAutoFinish: false,
    });
    const oldLogin = service.login();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    service.invalidateForSettingChange();

    const oldResult = await Promise.race([
      oldLogin.catch((error: unknown) => error),
      new Promise<'timed out'>((resolve) =>
        setTimeout(() => resolve('timed out'), 50),
      ),
    ]);
    expect(oldResult).toMatchObject({ message: expect.stringContaining('cancelled') });
    expect(windows[0].window.destroyed).toBe(true);
    releaseOldProbe(authenticatedResponse());
    await Promise.resolve();

    await expect(service.login()).resolves.toMatchObject({ authenticated: true });
    expect(windows).toHaveLength(2);
    expect(clearStorageData).not.toHaveBeenCalled();
  });

  it('binds lookup to the latest sheet list and uses captured DWR semantics', async () => {
    const { service, windows } = setup();
    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('latest Browse result');

    await service.listSheets();
    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: 'https://evil.example/eurecia/timesheet/Browse.do',
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('latest Browse result');
    await expect(
      service.lookupAxisOptions({
        sheetId: 'other-sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('latest Browse result');

    const lookup = service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 2,
      axis: 2,
      selectedAxisIds: { axis1Id: 'parent', axis2Id: '', axis3Id: '' },
    });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    await expect(lookup).resolves.toEqual({
      axis: 2,
      options: [{ id: 'one', label: 'One' }],
      selectedId: 'one',
    });
    const axisScript = windows[0].window.rawWebContents.scripts.find((script) =>
      script.includes('dwrGetImputationStructureLinkedOptionList'),
    )!;
    expect(axisScript).toContain('dwrGetImputationStructureLinkedOptionList');
    expect(axisScript).toContain('TextEncoder');
    expect(axisScript).toContain('options.length > 1000');
    expect(axisScript).toContain(
      "document.getElementById('idUserForListValueHidden')",
    );
    expect(axisScript).toContain(
      "document.getElementById('imputationStructureId1_' + input.rowIndex)",
    );
    expect(axisScript).toContain("select.getAttribute('source')");
    expect(axisScript).toContain('window.CC.comboboxSources[sourceKey]');
    expect(axisScript).toContain('option.value');
    expect(axisScript).toContain('option.label');
    expect(axisScript).toContain(".filter((option) => option.id !== '')");
    expect(axisScript).toContain(
      "document.getElementById('numberAxeContainsElementConditions')",
    );
    expect(axisScript).toContain(
      "'imputationStructureId' + (input.axis - 1) + '_' + input.rowIndex",
    );
    expect(axisScript).toMatch(
      /parentSelectedId,\s*input\.axis - 1,\s*input\.rowIndex,\s*conditionElement\.value,\s*null,\s*\(reply\)/,
    );
    expect(axisScript).toContain('Array.isArray(reply[1])');
    // Linked axes short-circuit instead of asking DWR without a parent.
    expect(axisScript).toContain(
      'if (!parentSelectedId) return { options: [], selectedId: null };',
    );
    expect(axisScript).toContain('if (reply == null) {');
    expect(axisScript).toContain('tuple[0]');
    expect(axisScript).toContain('tuple[1]');
    expect(axisScript).toContain('"parentSelectedId":"parent"');
    expect(axisScript).not.toContain('Open.do');
    expect(axisScript).not.toMatch(/fetch\s*\(|\.submit\s*\(/);
  });

  it('rejects invalid axis and row values before creating a window', async () => {
    const { service, windows } = setup();
    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: -1,
        axis: 3,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('row index');
    expect(windows).toHaveLength(0);
  });

  it('rejects inspect mismatches against the latest sheet list', async () => {
    const { service } = setup();
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: `${BROWSE_URL}&changed=1` }),
    ).rejects.toThrow('latest Browse result');
    await expect(
      service.inspectSheet({ sheetId: 'unlisted', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('latest Browse result');
  });

  it('inspects distinct Browse and internal form IDs through one guarded hidden window', async () => {
    const { service, windows, fetchImpl } = setup(undefined, {
      hiddenLoadEvent: { event: 'will-redirect', url: OPEN_URL },
      hiddenSheetIds: [INTERNAL_SHEET_ID],
      hiddenOuterHtml: openHtml([INTERNAL_SHEET_ID]),
    });
    const fetchMock = vi.mocked(fetchImpl);
    await service.listSheets();
    const fetchCallsBeforeInspection = fetchMock.mock.calls.length;

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).resolves.toMatchObject({ rows: [] });

    expect(windows).toHaveLength(1);
    expect(windows[0].options.show).toBe(false);
    expect(windows[0].window.loadEventPreventDefault).not.toHaveBeenCalled();
    expect(windows[0].window.rawWebContents.scripts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cloneNode'),
      ]),
    );
    expect(windows[0].window.rawWebContents.scripts.join('\n')).toContain(
      'TextEncoder',
    );
    expect(windows[0].window.rawWebContents.sheetIdentityResults).toEqual(
      expect.arrayContaining([
        {
          status: 'ok',
          count: 1,
          fingerprint: sheetFingerprint(INTERNAL_SHEET_ID),
        },
      ]),
    );
    expect(
      await service.dryRun({
        sheetId: 'sheet',
        entries: [
          {
            date: '2026-07-01',
            fraction: 0.25,
            axis1Id: 'one',
            axis2Id: '',
            axis3Id: '',
            comment: '',
            sourceDraftIds: ['draft-1'],
          },
        ],
        action: 'save',
      }),
    ).toMatchObject({ sheetId: 'sheet' });
    expect(
      fetchMock.mock.calls
        .slice(fetchCallsBeforeInspection)
        .map(([input]) => String(input)),
    ).toEqual([`${BASE_URL}/eurecia/api/v3/users/me/initData`]);
  });

  it('atomically fingerprints and redacts editor HTML without exposing the live ID', async () => {
    debug.dbg.timesheet.mockClear();
    const internalSheetId = 'internal";globalThis.compromised=true;//';
    const { service, windows } = setup(undefined, {
      hiddenSheetIds: [internalSheetId],
      hiddenOuterHtml: openHtml([internalSheetId]),
    });
    await service.listSheets();

    const result = await service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });

    const extraction = windows[0].window.rawWebContents.editorExtractionResults[0];
    expect(extraction).toEqual({
      status: 'ok',
      html: expect.stringContaining(REDACTED_SHEET_ID),
      fingerprint: sheetFingerprint(internalSheetId),
    });
    expect(JSON.stringify(extraction)).not.toContain(internalSheetId);
    expect(JSON.stringify(result)).not.toContain(internalSheetId);
    expect(JSON.stringify(debug.dbg.timesheet.mock.calls)).not.toContain(internalSheetId);
    const extractionScript = windows[0].window.rawWebContents.scripts.find((script) =>
      script.includes('outerHTML'),
    )!;
    expect(extractionScript).toContain('cloneNode');
    expect(extractionScript).toContain("digest('SHA-256'");
    expect(extractionScript).toContain('defaultValue');
    expect(extractionScript).toContain('setAttribute');
    expect(extractionScript).not.toContain('element.value = placeholder');
    expect(extractionScript).not.toContain(internalSheetId);
  });

  it('rejects and destroys when atomic extraction fingerprint differs from live probes', async () => {
    const { service, windows } = setup(undefined, {
      hiddenSheetIds: [INTERNAL_SHEET_ID],
      hiddenOuterHtml: openHtml([INTERNAL_SHEET_ID]),
      hiddenEditorExtractionResultOverrides: [
        {
          status: 'ok',
          html: openHtml([REDACTED_SHEET_ID]),
          fingerprint: sheetFingerprint('different-internal-sheet'),
        },
      ],
    });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('binding changed');
    expect(windows[0].window.destroyed).toBe(true);
    expect(windows[0].window.rawWebContents.sheetIdentityResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: sheetFingerprint(INTERNAL_SHEET_ID),
        }),
      ]),
    );
  });

  it.each([
    ['absent', { status: 'absent', count: 0 }],
    ['duplicate', { status: 'duplicate', count: 2 }],
    ['oversized', { status: 'oversized', count: 1 }],
  ])('rejects tagged %s identity failure from atomic extraction', async (_case, extraction) => {
    const { service, windows } = setup(undefined, {
      hiddenEditorExtractionResultOverrides: [extraction],
    });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('identity');
    expect(windows[0].window.destroyed).toBe(true);
    const extractionScript = windows[0].window.rawWebContents.scripts.find((script) =>
      script.includes('outerHTML'),
    )!;
    expect(extractionScript).toContain("status: 'absent'");
    expect(extractionScript).toContain("status: 'duplicate'");
    expect(extractionScript).toContain("status: 'oversized'");
  });

  it.each([
    [
      'missing fingerprint',
      { status: 'ok', html: openHtml([REDACTED_SHEET_ID]) },
    ],
    [
      'invalid fingerprint',
      {
        status: 'ok',
        html: openHtml([REDACTED_SHEET_ID]),
        fingerprint: 'z'.repeat(64),
      },
    ],
    [
      'extra raw field',
      {
        status: 'ok',
        html: openHtml([REDACTED_SHEET_ID]),
        fingerprint: sheetFingerprint('sheet'),
        value: 'private-sheet-id',
      },
    ],
  ])('rejects malformed atomic extraction result with %s', async (_case, extraction) => {
    const { service, windows } = setup(undefined, {
      hiddenEditorExtractionResultOverrides: [extraction],
    });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('invalid HTML');
    expect(windows[0].window.destroyed).toBe(true);
  });

  it.each([
    ['cross-origin', 'https://evil.example/eurecia/timesheet/Open.do'],
    ['wrong-path', `${BASE_URL}/eurecia/timesheet/Other.do`],
  ])('blocks and destroys a hidden-window %s redirect', async (_case, url) => {
    const { service, windows } = setup(undefined, {
      hiddenLoadEvent: { event: 'will-redirect', url },
    });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('prohibited');
    expect(windows[0].window.loadEventPreventDefault).toHaveBeenCalledOnce();
    expect(windows[0].window.destroyed).toBe(true);
  });

  it.each([
    ['absent value', []],
    ['empty value', ['']],
    ['oversized value', ['x'.repeat(513)]],
    ['oversized byte value', ['€'.repeat(400)]],
    ['many fields', Array.from({ length: 10_000 }, () => 'sheet')],
  ])('rejects %s using bounded sheet identity result', async (_case, ids) => {
    const { service, windows } = setup(undefined, { hiddenSheetIds: ids });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('identity');

    const results = windows[0].window.rawWebContents.sheetIdentityResults;
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(JSON.stringify(result).length).toBeLessThan(80);
      expect(JSON.stringify(result)).not.toContain('x'.repeat(100));
    }
    const identityScript = windows[0].window.rawWebContents.scripts.find((script) =>
      script.includes('querySelectorAll'),
    )!;
    expect(identityScript).toContain("status: 'ok'");
    expect(identityScript).toContain("digest('SHA-256'");
  });

  it('rejects oversized trusted sheet ID before creating a window or script', async () => {
    const sheetId = 'x'.repeat(513);
    const navigationUrl = `${BASE_URL}/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&id=${sheetId}`;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.includes('/api/v3/users/me/initData')
        ? authenticatedResponse(url)
        : browseResponse(url, navigationUrl);
    });
    const { service, windows } = setup(fetchImpl);
    const [sheet] = await service.listSheets();

    await expect(
      service.inspectSheet({
        sheetId: sheet.id,
        navigationUrl: sheet.navigationUrl,
      }),
    ).rejects.toThrow('timesheet ID');
    expect(windows).toHaveLength(0);
  });

  it('never embeds, returns, or logs a crafted internal form ID', async () => {
    debug.dbg.timesheet.mockClear();
    const internalSheetId = 'internal";globalThis.compromised=true;//';
    const { service, windows } = setup(undefined, {
      hiddenSheetIds: [internalSheetId],
      hiddenOuterHtml: openHtml([internalSheetId]),
    });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).resolves.toMatchObject({ rows: [] });

    const identityScript = windows[0].window.rawWebContents.scripts.find((script) =>
      script.includes('querySelectorAll'),
    )!;
    expect(identityScript).not.toContain(internalSheetId);
    expect(JSON.stringify(windows[0].window.rawWebContents.sheetIdentityResults)).not.toContain(
      internalSheetId,
    );
    expect(JSON.stringify(debug.dbg.timesheet.mock.calls)).not.toContain(internalSheetId);
  });

  it.each([
    ['duplicate', ['sheet', 'sheet']],
  ])('rejects and destroys an inspected page with %s sheet IDs', async (_case, ids) => {
    const { service, windows } = setup(undefined, { hiddenSheetIds: ids });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('invalid timesheet identity');
    expect(windows[0].window.destroyed).toBe(true);
  });

  it.each([
    ['non-string', null],
    ['invalid', '<html><body>login</body></html>'],
    ['too large', 'x'.repeat(10 * 1024 * 1024 + 1)],
  ])('rejects %s extracted editor HTML', async (_case, html) => {
    const { service, windows } = setup(undefined, { hiddenOuterHtml: html });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow(/HTML|authenticated/);
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('rejects and destroys the lookup window when its URL drifts during extraction', async () => {
    const { service, windows } = setup(undefined, {
      hiddenDriftUrlAfterHtml: `${OPEN_URL}&drifted=1`,
    });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('binding changed');
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('cancels HTML extraction and closes its window on logout', async () => {
    const executeGate = new Promise<void>(() => {});
    const { service, windows } = setup(undefined, { executeGate });
    await service.listSheets();
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    await vi.waitFor(() => expect(windows).toHaveLength(1));

    await service.logout();

    const result = await Promise.race([
      inspection.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ message: expect.stringContaining('cancelled') });
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('promptly cancels a pending hidden-window load on logout', async () => {
    const { service, windows } = setup(undefined, {
      hiddenLoadGate: new Promise<void>(() => {}),
    });
    await service.listSheets();
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    await vi.waitFor(() => expect(windows).toHaveLength(1));

    await service.logout();

    const result = await Promise.race([
      inspection.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ message: expect.stringContaining('cancelled') });
  });

  it('promptly cancels pending inspect load when refresh starts', async () => {
    let rejectLoad!: (error: Error) => void;
    const loadGate = new Promise<void>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const { service, windows } = setup(undefined, { hiddenLoadGate: loadGate });
    await service.listSheets();
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    await vi.waitFor(() => expect(windows).toHaveLength(1));

    await service.listSheets();

    const result = await Promise.race([
      inspection.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ name: 'AbortError' });
    rejectLoad(new Error('late load rejection'));
    await Promise.resolve();
  });

  it('promptly cancels pending inspect script when refresh starts', async () => {
    let rejectExecute!: (error: Error) => void;
    const executeGate = new Promise<void>((_resolve, reject) => {
      rejectExecute = reject;
    });
    const { service, windows } = setup(undefined, { executeGate });
    await service.listSheets();
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    await vi.waitFor(() =>
      expect(windows[0].window.rawWebContents.scripts).toEqual(
        expect.arrayContaining([expect.stringContaining('outerHTML')]),
      ),
    );

    await service.listSheets();

    const result = await Promise.race([
      inspection.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ name: 'AbortError' });
    rejectExecute(new Error('late script rejection'));
    await Promise.resolve();
  });

  it('rejects hidden-window inspection when a concurrent refresh retains the same URL', async () => {
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const { service, windows } = setup(undefined, { executeGate });
    await service.listSheets();
    const inspection = service
      .inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL })
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    await vi.waitFor(() =>
      expect(
        windows[0].window.rawWebContents.scripts.some((script) =>
          script.includes('cloneNode'),
        ),
      ).toBe(true),
    );

    await expect(service.listSheets()).resolves.toEqual([
      expect.objectContaining({ id: 'sheet', navigationUrl: BROWSE_URL }),
    ]);
    releaseExecute();

    await expect(inspection).resolves.toMatchObject({ name: 'AbortError' });
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('waits for a same-sheet refresh before inspecting it', async () => {
    let initRequestCount = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/api/v3/users/me/initData')) {
        initRequestCount += 1;
        if (initRequestCount === 3) await refreshGate;
        return authenticatedResponse(url);
      }
      return browseResponse(url);
    });
    const { service } = setup(fetchImpl);
    await service.listSheets();

    const refresh = service.listSheets();
    await vi.waitFor(() => expect(initRequestCount).toBe(3));
    const concurrentRefresh = service.listSheets();
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    releaseRefresh();
    await expect(Promise.all([refresh, concurrentRefresh])).resolves.toEqual([
      [expect.objectContaining({ id: 'sheet', navigationUrl: BROWSE_URL })],
      [expect.objectContaining({ id: 'sheet', navigationUrl: BROWSE_URL })],
    ]);

    await expect(inspection).resolves.toMatchObject({ rows: [] });
  });

  it('rejects inspection when an active refresh changes the sheet navigation URL', async () => {
    const changedUrl = `${BROWSE_URL}&revision=2`;
    let initRequestCount = 0;
    let browseRequestCount = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/eurecia/api/v3/users/me/initData')) {
        initRequestCount += 1;
        if (initRequestCount === 3) await refreshGate;
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      return browseResponse(
        url,
        browseRequestCount === 1 ? BROWSE_URL : changedUrl,
      );
    });
    const { service, windows } = setup(fetchImpl);
    await service.listSheets();

    const refresh = service.listSheets();
    await vi.waitFor(() => expect(initRequestCount).toBe(3));
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    releaseRefresh();

    await expect(refresh).resolves.toEqual([
      expect.objectContaining({ navigationUrl: changedUrl }),
    ]);
    await expect(inspection).rejects.toThrow('latest Browse result');
    expect(windows).toHaveLength(0);
  });

  it('rejects inspection when an active refresh removes the sheet', async () => {
    let initRequestCount = 0;
    let browseRequestCount = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/eurecia/api/v3/users/me/initData')) {
        initRequestCount += 1;
        if (initRequestCount === 3) await refreshGate;
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      return browseRequestCount === 1
        ? browseResponse(url)
        : emptyBrowseResponse(url);
    });
    const { service, windows } = setup(fetchImpl);
    await service.listSheets();

    const refresh = service.listSheets();
    await vi.waitFor(() => expect(initRequestCount).toBe(3));
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    releaseRefresh();

    await expect(refresh).resolves.toEqual([]);
    await expect(inspection).rejects.toThrow('latest Browse result');
    expect(windows).toHaveLength(0);
  });

  it('propagates an active refresh failure to waiting inspection and keeps stale state invalid', async () => {
    let browseRequestCount = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/eurecia/api/v3/users/me/initData')) {
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      if (browseRequestCount === 2) {
        await refreshGate;
        throw new Error('refresh transport failed');
      }
      return browseResponse(url);
    });
    const { service } = setup(fetchImpl);
    await service.listSheets();

    const refresh = service.listSheets();
    await vi.waitFor(() => expect(browseRequestCount).toBe(2));
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });
    releaseRefresh();

    await expect(refresh).rejects.toThrow('refresh transport failed');
    await expect(inspection).rejects.toThrow(
      'Eurecia sheet refresh failed: refresh transport failed',
    );
    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('latest Browse result');
  });

  it('waits for an active same-sheet refresh before looking up axis options', async () => {
    let initRequestCount = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/eurecia/api/v3/users/me/initData')) {
        initRequestCount += 1;
        if (initRequestCount === 3) await refreshGate;
        return authenticatedResponse(url);
      }
      return browseResponse(url);
    });
    const { service, windows } = setup(fetchImpl);
    await service.listSheets();

    const refresh = service.listSheets();
    await vi.waitFor(() => expect(initRequestCount).toBe(3));
    const lookup = service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    });
    await Promise.resolve();
    expect(windows).toHaveLength(0);
    releaseRefresh();

    await expect(refresh).resolves.toEqual([
      expect.objectContaining({ id: 'sheet', navigationUrl: BROWSE_URL }),
    ]);
    await expect(lookup).resolves.toMatchObject({ axis: 1 });
  });

  it('leaves a prior sheet unusable after refresh failure', async () => {
    let browseRequestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/api/v3/users/me/initData')) {
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      if (browseRequestCount === 2) throw new Error('refresh failed');
      return browseResponse(url);
    });
    const { service } = setup(fetchImpl);
    await service.listSheets();

    await expect(service.listSheets()).rejects.toThrow('refresh failed');

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('latest Browse result');
  });

  it('destroys stale lookup DOM and creates a fresh window after same-URL refresh', async () => {
    const { service, windows } = setup();
    await service.listSheets();
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });
    const staleWindow = windows[0].window;

    await service.listSheets();

    expect(staleWindow.destroyed).toBe(true);
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });
    expect(windows).toHaveLength(2);
    expect(windows[1].window.destroyed).toBe(false);
  });

  it('destroys and clears a pending lookup window when refresh starts', async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { service, windows } = setup(undefined, { hiddenLoadGate: loadGate });
    await service.listSheets();
    const inspection = service
      .inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL })
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    await vi.waitFor(() => expect(windows).toHaveLength(1));

    await service.listSheets();

    expect(windows[0].window.destroyed).toBe(true);
    releaseLoad();
    await expect(inspection).resolves.toBeInstanceOf(Error);
  });

  it('destroys stale lookup DOM and leaves none after refresh failure', async () => {
    let browseRequestCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/api/v3/users/me/initData')) {
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      if (browseRequestCount === 2) throw new Error('refresh failed');
      return browseResponse(url);
    });
    const { service, windows } = setup(fetchImpl);
    await service.listSheets();
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });

    await expect(service.listSheets()).rejects.toThrow('refresh failed');

    expect(windows[0].window.destroyed).toBe(true);
    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('latest Browse result');
    expect(windows).toHaveLength(1);
  });

  it('uses destroy for forced logout even when window close is vetoed', async () => {
    const { service, windows } = setup(undefined, { vetoClose: true });
    await service.listSheets();
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });

    await service.logout();

    expect(windows[0].window.destroyed).toBe(true);
    expect(windows[0].window.closeCalls).toBe(0);
    expect(windows[0].window.destroyCalls).toBe(1);
  });

  it('reuses the inspected hidden window for axis lookup', async () => {
    const { service, windows } = setup();
    await service.listSheets();
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });

    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).resolves.toMatchObject({ axis: 1 });
    expect(windows).toHaveLength(1);
  });

  it('requires cached reuse to preserve final URL and form fingerprint binding', async () => {
    const sheetIds = [INTERNAL_SHEET_ID];
    const { service, windows } = setup(undefined, {
      hiddenSheetIds: sheetIds,
      hiddenOuterHtml: openHtml([INTERNAL_SHEET_ID]),
    });
    await service.listSheets();
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });
    sheetIds.splice(0, 1, 'changed-internal-sheet');

    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('binding changed');
    expect(windows).toHaveLength(1);
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('rejects an axis result invalidated by a concurrent refresh', async () => {
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const { service, windows } = setup(undefined, { executeGate });
    await service.listSheets();
    const lookup = service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    });
    const result = lookup.then(
      (value) => value,
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(windows[0].window.rawWebContents.script).toContain(
        'imputationStructureId1_',
      ),
    );

    await service.listSheets();
    releaseExecute();

    await expect(result).resolves.toMatchObject({ name: 'AbortError' });
  });

  it.each([
    ['query', `${OPEN_URL}&drifted=1`],
    ['fragment', `${OPEN_URL}#drifted`],
  ])('rejects axis result after same-document %s URL drift', async (_case, url) => {
    const { service, windows } = setup(undefined, {
      hiddenDriftUrlAfterAxis: url,
    });
    await service.listSheets();

    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('changed');
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('rejects axis result after form fingerprint drift', async () => {
    const { service, windows } = setup(undefined, {
      hiddenSheetIdsAfterAxis: ['other-sheet'],
    });
    await service.listSheets();

    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('binding changed');
    expect(windows[0].window.destroyed).toBe(true);
  });

  it.each([
    [
      'option count',
      [true, Array.from({ length: 1_001 }, (_, index) => [`id-${index}`, 'x']), null],
    ],
    ['ID length', [true, [['x'.repeat(513), 'label']], null]],
    ['ID byte length', [true, [['€'.repeat(400), 'label']], null]],
    ['label length', [true, [['id', 'x'.repeat(4_097)]], null]],
    ['label byte length', [true, [['id', '€'.repeat(3_000)]], null]],
    ['selected ID length', [true, [['id', 'label']], 'x'.repeat(513)]],
  ])('rejects axis result exceeding %s limit', async (_case, capturedReply) => {
    const { service } = setup(undefined, { hiddenCapturedReply: capturedReply });
    await service.listSheets();

    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow(/axis lookup|options|selected/i);
  });

  it('rejects oversized parent axis ID before creating a lookup window', async () => {
    const { service, windows } = setup();
    await service.listSheets();

    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 2,
        selectedAxisIds: {
          axis1Id: 'x'.repeat(513),
          axis2Id: '',
          axis3Id: '',
        },
      }),
    ).rejects.toThrow('invalid ID');
    expect(windows).toHaveLength(0);
  });

  it('destroys the inspected hidden window when settings change', async () => {
    let setting = SETTING;
    const { service, windows } = setup(undefined, {
      getSetting: async () => setting,
      vetoClose: true,
    });
    await service.listSheets();
    await service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL });

    setting = { ...SETTING, axis1Label: 'Changed project label' };
    await service.authStatus();

    expect(windows).toHaveLength(1);
    expect(windows[0].window.destroyed).toBe(true);
    expect(windows[0].window.closeCalls).toBe(0);
    expect(windows[0].window.destroyCalls).toBe(1);
  });

  it('blocks all hidden-window navigation after load', async () => {
    const { service, windows } = setup();
    await service.listSheets();
    await service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    });

    const lookupWindow = windows[0].window;
    const preventNavigation = vi.fn();
    const preventRedirect = vi.fn();
    lookupWindow.rawWebContents.emit(
      'will-navigate',
      { preventDefault: preventNavigation },
      OPEN_URL,
    );
    lookupWindow.rawWebContents.emit(
      'will-redirect',
      { preventDefault: preventRedirect },
      BROWSE_URL,
    );
    expect(preventNavigation).toHaveBeenCalledOnce();
    expect(preventRedirect).toHaveBeenCalledOnce();
  });

  it('allows lookup when internal form ID differs from Browse sheet token', async () => {
    const { service, windows } = setup(undefined, {
      hiddenSheetIds: [INTERNAL_SHEET_ID],
      hiddenOuterHtml: openHtml([INTERNAL_SHEET_ID]),
    });
    await service.listSheets();

    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).resolves.toMatchObject({ axis: 1 });
    expect(windows[0].window.destroyed).toBe(false);
  });

  it('rejects duplicate lookup sheet fields even when one is empty', async () => {
    const { service } = setup(undefined, {
      hiddenSheetIds: ['sheet', ''],
    });
    await service.listSheets();

    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('invalid timesheet identity');
  });

  it('rechecks form fingerprint before reusing a cached lookup page', async () => {
    const sheetIds = ['sheet'];
    const { service, windows } = setup(undefined, {
      hiddenSheetIds: sheetIds,
    });
    await service.listSheets();
    const request = {
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1 as const,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    };
    await service.lookupAxisOptions(request);
    sheetIds.splice(0, 1, 'other-sheet');

    await expect(service.lookupAxisOptions(request)).rejects.toThrow('binding changed');
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('destroys and rejects a cached lookup window whose final URL drifted', async () => {
    const { service, windows } = setup();
    await service.listSheets();
    const request = {
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1 as const,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    };
    await service.lookupAxisOptions(request);
    const driftedWindow = windows[0].window;
    driftedWindow.rawWebContents.url = 'https://evil.example/changed';

    await expect(service.lookupAxisOptions(request)).rejects.toThrow('binding changed');

    expect(driftedWindow.destroyed).toBe(true);
    expect(windows).toHaveLength(1);
  });

  it.each([
    ['non-object', 'not-an-object'],
    ['bad status', { status: 'ok', count: 1, fingerprint: 'z'.repeat(64) }],
    ['wrong digest size', { status: 'ok', count: 1, fingerprint: 'a'.repeat(63) }],
    ['extra raw value', { status: 'ok', count: 1, fingerprint: 'a'.repeat(64), value: 'secret' }],
  ])('rejects malformed renderer identity result: %s', async (_case, result) => {
    const { service, windows } = setup(undefined, {
      hiddenIdentityResultOverrides: [result],
    });
    await service.listSheets();

    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('identity result');
    expect(windows[0].window.destroyed).toBe(true);
  });

  it('deduplicates concurrent hidden window creation', async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { service, windows } = setup(undefined, { hiddenLoadGate: loadGate });
    await service.listSheets();
    const request = {
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1 as const,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    };

    const first = service.lookupAxisOptions(request);
    const second = service.lookupAxisOptions(request);
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    expect(windows[0].window.destroyed).toBe(false);
    releaseLoad();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(windows).toHaveLength(1);
  });

  it('deduplicates concurrent sheet list refreshes', async () => {
    let browseRequestCount = 0;
    let releaseBrowse!: () => void;
    const browseGate = new Promise<void>((resolve) => {
      releaseBrowse = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/eurecia/api/v3/users/me/initData')) {
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      await browseGate;
      return browseResponse(url);
    });
    const { service } = setup(fetchImpl);

    const first = service.listSheets();
    const second = service.listSheets();
    await vi.waitFor(() => expect(browseRequestCount).toBeGreaterThan(0));
    const isSamePromise = first === second;
    releaseBrowse();
    const results = await Promise.allSettled([first, second]);

    expect(isSamePromise).toBe(true);
    expect(browseRequestCount).toBe(1);
    expect(results).toEqual([
      { status: 'fulfilled', value: expect.any(Array) },
      { status: 'fulfilled', value: expect.any(Array) },
    ]);
  });

  it('promptly cancels inspection waiting on a sheet refresh during logout', async () => {
    let browseRequestCount = 0;
    let refreshSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/eurecia/api/v3/users/me/initData')) {
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      if (browseRequestCount === 1) return browseResponse(url);
      refreshSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        refreshSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const { service } = setup(fetchImpl);
    await service.listSheets();
    const refresh = service.listSheets();
    const refreshResult = refresh.catch((error: unknown) => error);
    await vi.waitFor(() => expect(browseRequestCount).toBe(2));
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });

    await service.logout();

    expect(refreshSignal?.aborted).toBe(true);
    const result = await Promise.race([
      inspection.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ message: expect.stringContaining('cancelled') });
    await expect(refreshResult).resolves.toMatchObject({
      message: expect.stringContaining('cancelled'),
    });
  });

  it('promptly cancels inspection waiting on a sheet refresh after settings change', async () => {
    let setting = SETTING;
    let browseRequestCount = 0;
    let refreshSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/eurecia/api/v3/users/me/initData')) {
        return authenticatedResponse(url);
      }
      browseRequestCount += 1;
      if (browseRequestCount === 1) return browseResponse(url);
      refreshSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        refreshSignal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const { service } = setup(fetchImpl, {
      getSetting: async () => setting,
    });
    await service.listSheets();
    const refreshResult = service.listSheets().catch((error: unknown) => error);
    await vi.waitFor(() => expect(browseRequestCount).toBe(2));
    const inspection = service.inspectSheet({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
    });

    setting = { ...SETTING, axis1Label: 'Changed project' };
    await service.authStatus();

    expect(refreshSignal?.aborted).toBe(true);
    const result = await Promise.race([
      inspection.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ message: expect.stringContaining('cancelled') });
    await expect(refreshResult).resolves.toMatchObject({
      message: expect.stringContaining('cancelled'),
    });
  });

  it('cancels a delayed list without restoring bindings after logout', async () => {
    let browseSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/v3/users/me/initData')) {
        return authenticatedResponse(url);
      }
      browseSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        browseSignal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    const { service } = setup(fetchImpl);
    const listing = service.listSheets();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));

    await service.logout();

    expect(browseSignal?.aborted).toBe(true);
    await expect(listing).rejects.toThrow('cancelled');
    await expect(
      service.lookupAxisOptions({
        sheetId: 'sheet',
        navigationUrl: BROWSE_URL,
        rowIndex: 0,
        axis: 1,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).rejects.toThrow('latest Browse result');
  });

  it('cancels a delayed lookup result after logout', async () => {
    const executeGate = new Promise<void>(() => {});
    const { service, windows } = setup(undefined, { executeGate });
    await service.listSheets();
    const lookup = service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    });
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    await vi.waitFor(() =>
      expect(windows[0].window.rawWebContents.script).toContain(
        'imputationStructureId1_',
      ),
    );

    await service.logout();

    const result = await Promise.race([
      lookup.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ message: expect.stringContaining('cancelled') });
  });

  it('promptly cancels a delayed lookup result after settings change', async () => {
    let setting = SETTING;
    const { service, windows } = setup(undefined, {
      executeGate: new Promise<void>(() => {}),
      getSetting: async () => setting,
    });
    await service.listSheets();
    const lookup = service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    });
    await vi.waitFor(() =>
      expect(windows[0].window.rawWebContents.script).toContain(
        'imputationStructureId1_',
      ),
    );

    setting = { ...SETTING, axis1Label: 'Changed' };
    await service.authStatus();

    const result = await Promise.race([
      lookup.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ message: expect.stringContaining('cancelled') });
  });

  it('promptly cancels pending axis script when refresh starts', async () => {
    let rejectExecute!: (error: Error) => void;
    const executeGate = new Promise<void>((_resolve, reject) => {
      rejectExecute = reject;
    });
    const { service, windows } = setup(undefined, { executeGate });
    await service.listSheets();
    const lookup = service.lookupAxisOptions({
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    });
    await vi.waitFor(() =>
      expect(windows[0].window.rawWebContents.script).toContain(
        'imputationStructureId1_',
      ),
    );

    await service.listSheets();

    const result = await Promise.race([
      lookup.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    expect(result).toMatchObject({ name: 'AbortError' });
    rejectExecute(new Error('late axis rejection'));
    await Promise.resolve();
  });

  it('times out a hanging login probe and retries on a later load', async () => {
    let fetchCount = 0;
    let timedOutSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        timedOutSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          timedOutSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return authenticatedResponse(String(input));
    });
    const { service, windows } = setup(fetchImpl, {
      authProbeTimeoutMs: 5,
      loginAutoFinish: false,
    });
    const login = service.login();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(timedOutSignal?.aborted).toBe(true);
    windows[0].window.rawWebContents.emit('did-finish-load');

    await expect(login).resolves.toMatchObject({ authenticated: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('closes and cancels an old login when the setting changes', async () => {
    const nextBaseUrl = 'https://next-tenant.example';
    let setting = SETTING;
    let oldSignal: AbortSignal | undefined;
    let fetchCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        oldSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          oldSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      const url = String(input);
      return {
        ...authenticatedResponse(url),
        text: async () =>
          JSON.stringify({
            navigation: {
              url: `${nextBaseUrl}/eurecia/timesheet/Browse.do?ctrl=list&action=Edit&id=sheet`,
            },
          }),
      } as Response;
    });
    const { service, windows } = setup(fetchImpl, {
      getSetting: async () => setting,
    });
    const oldLogin = service.login();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    setting = { ...SETTING, baseUrl: nextBaseUrl };
    await expect(service.authStatus()).resolves.toMatchObject({
      baseUrl: nextBaseUrl,
      authenticated: true,
    });

    expect(oldSignal?.aborted).toBe(true);
    expect(windows[0].window.destroyed).toBe(true);
    await expect(oldLogin).rejects.toThrow('cancelled');
  });

  it('blocks operations until deferred logout storage clearing finishes', async () => {
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const { service, clearStorageData } = setup(undefined, {
      clearStorageData: () => clearGate,
    });
    await service.listSheets();
    const logout = service.logout();
    await vi.waitFor(() => expect(clearStorageData).toHaveBeenCalledOnce());

    await expect(service.listSheets()).rejects.toThrow('logout is in progress');
    await expect(
      service.inspectSheet({ sheetId: 'sheet', navigationUrl: BROWSE_URL }),
    ).rejects.toThrow('logout is in progress');

    releaseClear();
    await expect(logout).resolves.toBeUndefined();
    await expect(service.listSheets()).resolves.toHaveLength(1);
  });

  it('clears the logout gate when storage clearing fails', async () => {
    const { service } = setup(undefined, {
      clearStorageData: async () => {
        throw new Error('clear failed');
      },
    });

    await expect(service.logout()).rejects.toThrow('clear failed');
    await expect(service.authStatus()).resolves.toMatchObject({
      authenticated: true,
    });
  });

  it('does not let a delayed old closed event untrack its replacement', async () => {
    const { service, windows } = setup(undefined, { hiddenDelayClosed: true });
    await service.listSheets();
    const request = {
      sheetId: 'sheet',
      navigationUrl: BROWSE_URL,
      rowIndex: 0,
      axis: 1 as const,
      selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
    };
    await service.lookupAxisOptions(request);
    const oldWindow = windows[0].window;
    oldWindow.rawWebContents.url = 'https://evil.example/drifted';
    await expect(service.lookupAxisOptions(request)).rejects.toThrow(
      'binding changed',
    );
    await service.lookupAxisOptions(request);
    expect(windows).toHaveLength(2);

    oldWindow.emitClosed();
    await service.lookupAxisOptions(request);

    expect(windows).toHaveLength(2);
    expect(windows[1].window.destroyed).toBe(false);
  });
});
