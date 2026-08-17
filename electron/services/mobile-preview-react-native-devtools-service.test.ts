import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

const electronMocks = vi.hoisted(() => {
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  const ownerWindow = {
    contentView: { addChildView, removeChildView },
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  const fromWebContents = vi.fn(() => ownerWindow);
  const log = vi.fn();
  const state = { failDebuggerAttach: false };
  const views: Array<{
    options: unknown;
    setBounds: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
    webContents: {
      close: ReturnType<typeof vi.fn>;
      debugger: {
        attach: ReturnType<typeof vi.fn>;
        detach: ReturnType<typeof vi.fn>;
        isAttached: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        removeListener: ReturnType<typeof vi.fn>;
        sendCommand: ReturnType<typeof vi.fn>;
      };
      getURL: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
    };
  }> = [];

  class WebContentsView {
    options: unknown;
    setBounds = vi.fn();
    setVisible = vi.fn();
    webContents: (typeof views)[number]['webContents'];

    constructor(options: unknown) {
      this.options = options;
      let currentUrl = '';
      this.webContents = {
        close: vi.fn(),
        debugger: {
          attach: vi.fn(() => {
            if (state.failDebuggerAttach) {
              throw new Error('attach failed with token=secret');
            }
          }),
          detach: vi.fn(),
          isAttached: vi.fn(() => false),
          on: vi.fn(),
          removeListener: vi.fn(),
          sendCommand: vi.fn().mockResolvedValue(undefined),
        },
        getURL: vi.fn(() => currentUrl),
        isDestroyed: vi.fn(() => false),
        loadURL: vi.fn(async (url: string) => {
          currentUrl = url;
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      };
      views.push(this);
    }
  }

  return {
    addChildView,
    fromWebContents,
    log,
    ownerWindow,
    removeChildView,
    views,
    WebContentsView,
    state,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  WebContentsView: electronMocks.WebContentsView,
}));
vi.mock('../lib/debug', () => ({
  dbg: { mobilePreview: electronMocks.log },
}));

import {
  closeEmbeddedReactNativeDevTools,
  openEmbeddedReactNativeDevTools,
  resolveReactNativeDevTools,
  setEmbeddedReactNativeDevToolsVisibility,
} from './mobile-preview-react-native-devtools-service';

const FRONTEND_URL =
  'http://127.0.0.1:8081/debugger-frontend/rn_fusebox.html?ws=%2Finspector%2Fdebug%3Fdevice%3Ddevice-1%26page%3D1';
const BOUNDS = { x: 10, y: 20, width: 300, height: 400 };

type MockOwner = WebContents & {
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

function createOwner(id: number) {
  return {
    id,
    once: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as MockOwner;
}

describe('React Native DevTools service', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    electronMocks.state.failDebuggerAttach = false;
    electronMocks.views.length = 0;
  });

  it('normalizes a localhost target to the Metro frontend host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 'device-1',
              title: 'Example app',
              appId: 'com.example',
              deviceName: 'iPhone',
              webSocketDebuggerUrl:
                'ws://localhost:8081/inspector/debug?device=device-1&page=1',
              devtoolsFrontendUrl:
                '/debugger-frontend/rn_fusebox.html?ws=localhost%3A8081%2Finspector%2Fdebug%3Fdevice%3Ddevice-1%26page%3D1',
              reactNative: { capabilities: { nativePageReloads: true } },
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const result = await resolveReactNativeDevTools({
      metroPort: 8081,
      panel: 'console',
    });

    expect(result.error).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8081/json/list',
      expect.any(Object),
    );
    const frontendUrl = new URL(result.frontendUrl!);
    expect(frontendUrl.origin).toBe('http://127.0.0.1:8081');
    expect(frontendUrl.searchParams.get('ws')).toBe(
      '/inspector/debug?device=device-1&page=1',
    );
  });

  it('rejects unsupported frontend URLs and invalid bounds', async () => {
    const owner = createOwner(1);

    await expect(
      openEmbeddedReactNativeDevTools(owner, {
        viewId: 'view-1',
        frontendUrl:
          'https://example.com/debugger-frontend/rn_fusebox.html?ws=%2Finspector%2Fdebug',
        bounds: BOUNDS,
      }),
    ).rejects.toThrow('DevTools frontend must be served from localhost Metro');
    await expect(
      openEmbeddedReactNativeDevTools(owner, {
        viewId: 'view-1',
        frontendUrl: FRONTEND_URL,
        bounds: { ...BOUNDS, width: Number.NaN },
      }),
    ).rejects.toThrow('Invalid DevTools bounds');
    expect(electronMocks.views).toHaveLength(0);
  });

  it('reuses and disposes an embedded view for the same owner and id', async () => {
    const owner = createOwner(2);

    await openEmbeddedReactNativeDevTools(owner, {
      viewId: 'view-2',
      frontendUrl: FRONTEND_URL,
      bounds: BOUNDS,
    });
    await openEmbeddedReactNativeDevTools(owner, {
      viewId: 'view-2',
      frontendUrl: FRONTEND_URL,
      bounds: { ...BOUNDS, width: 500 },
    });

    expect(electronMocks.views).toHaveLength(1);
    const [view] = electronMocks.views;
    expect(view.options).toMatchObject({
      webPreferences: { sandbox: false },
    });
    expect(electronMocks.addChildView).toHaveBeenCalledOnce();
    expect(view.webContents.loadURL).toHaveBeenCalledOnce();
    expect(view.setBounds).toHaveBeenNthCalledWith(2, {
      ...BOUNDS,
      width: 500,
    });
    setEmbeddedReactNativeDevToolsVisibility(owner, {
      viewId: 'view-2',
      visible: false,
    });
    setEmbeddedReactNativeDevToolsVisibility(owner, {
      viewId: 'view-2',
      visible: true,
    });
    expect(view.setVisible).toHaveBeenNthCalledWith(1, false);
    expect(view.setVisible).toHaveBeenNthCalledWith(2, true);

    const disposeForOwner = owner.once.mock.calls.find(
      ([event]) => event === 'destroyed',
    )?.[1];
    expect(disposeForOwner).toBeTypeOf('function');
    disposeForOwner();

    expect(electronMocks.removeChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(owner.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
  });

  it('redacts diagnostics and removes listeners after the startup window', async () => {
    vi.useFakeTimers();
    const owner = createOwner(3);

    await openEmbeddedReactNativeDevTools(owner, {
      viewId: 'view-3',
      frontendUrl: FRONTEND_URL,
      bounds: BOUNDS,
    });
    const [view] = electronMocks.views;
    const failedLoadHandler = view.webContents.on.mock.calls.find(
      ([event]) => event === 'did-fail-load',
    )?.[1];
    const debuggerMessageHandler = view.webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];

    failedLoadHandler(
      {},
      -1,
      'failed with token=secret',
      'http://127.0.0.1:8081/debugger-frontend/rn_fusebox.html?token=secret',
    );
    debuggerMessageHandler({}, 'Network.webSocketCreated', {
      url: 'ws://127.0.0.1:8081/inspector/debug?token=secret',
    });
    expect(JSON.stringify(electronMocks.log.mock.calls)).not.toContain('secret');

    await vi.advanceTimersByTimeAsync(15_000);

    expect(view.webContents.removeListener).toHaveBeenCalledWith(
      'did-fail-load',
      failedLoadHandler,
    );
    expect(view.webContents.debugger.removeListener).toHaveBeenCalledWith(
      'message',
      debuggerMessageHandler,
    );
    closeEmbeddedReactNativeDevTools(owner, { viewId: 'view-3' });
  });

  it('removes lifecycle diagnostics when debugger attachment fails', async () => {
    electronMocks.state.failDebuggerAttach = true;
    const owner = createOwner(4);

    await openEmbeddedReactNativeDevTools(owner, {
      viewId: 'view-4',
      frontendUrl: FRONTEND_URL,
      bounds: BOUNDS,
    });
    const [view] = electronMocks.views;

    expect(view.webContents.removeListener).toHaveBeenCalledWith(
      'preload-error',
      expect.any(Function),
    );
    expect(JSON.stringify(electronMocks.log.mock.calls)).not.toContain('secret');
    closeEmbeddedReactNativeDevTools(owner, { viewId: 'view-4' });
  });
});
