// Side-effect import: repoints `userData` for lock-skipping dev instances so
// they stop sharing the packaged app's Chromium profile (and its single
// Local Storage LevelDB). Must stay the FIRST import — `./database` resolves its
// default path at module scope, and module bodies run after their imports, so
// anything ordered ahead of this would capture the old path.
// eslint-disable-next-line import/order
import {
  recordBootDiagnostics,
  recordCleanupDone,
  recordProcessExit,
  recordQuitStarted,
} from './lib/localstorage-diagnostics';
import { hasExistingLocalStorageBucket } from './lib/user-data-dir';

import { join } from 'path';

import { app, BrowserWindow, Menu, protocol, session, shell } from 'electron';
import fixPath from 'fix-path';
import type { MenuItemConstructorOptions } from 'electron';

import {
  closeIdleOpenCodeSharedServerNow,
  killAllOpenCodeServersSync,
} from './services/agent-backends/opencode/opencode-backend';
import {
  decodeProxyUrl,
  fetchAuthenticatedImageStream,
} from './services/azure-image-proxy-service';
import {
  fetchLocalImage,
  LOCAL_IMAGE_PROTOCOL,
} from './services/local-image-protocol-service';
import {
  RELOAD_PREVIEW_FLUSH_SETTLE_MS,
  RELOAD_PREVIEW_PREVIOUS_PID_ENV,
  startReloadPreviewLogLimiter,
  waitForPreviousPreviewExit,
} from './services/reload-preview-service';
import {
  runBeforeQuitCleanups,
  stopVetoingQuit,
} from './services/mobile-preview-lifecycle';
import { agentMemorySchedulerService } from './services/agent-memory-scheduler-service';
import { agentService } from './services/agent-service';
import { cleanupOrphanedWorkspaces } from './services/system-project-service';
import { createReloadPreviewReadinessRegistrar } from './services/reload-preview-service';
import { dbg } from './lib/debug';
import { killOrphanedCoreSimulatorHelpers } from './services/mobile-preview-ios-idb-adapter';
import { migrateDatabase } from './database';
import { pipelineTrackingService } from './services/pipeline-tracking-service';
import { rawMessageCleanupService } from './services/raw-message-cleanup-service';
import { registerIpcHandlers } from './ipc/handlers';
import { runCommandService } from './services/run-command-service';
import { syncBuiltinSkillSymlinks } from './services/skill-management-service';
import { systemCalendarService } from './services/system-calendar-service';
import { upsertBuiltinSkills } from './services/builtin-skills-service';

// Register custom protocol scheme before app is ready
// This must be done synchronously before the app ready event
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'azure-image-proxy',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: LOCAL_IMAGE_PROTOCOL,
    privileges: {
      secure: true,
    },
  },
]);

dbg.main('Starting Jean-Claude main process');
dbg.main(
  'Node version: %s, Electron version: %s',
  process.versions.node,
  process.versions.electron,
);
dbg.main('Platform: %s, Arch: %s', process.platform, process.arch);

let canCreateMainWindow = false;
const reloadPreviewReadyFilePath =
  process.env.JC_PREVIEW_RESTART_READY_FILE;
const reloadPreviewAckFilePath = process.env.JC_PREVIEW_RESTART_ACK_FILE;
const reloadPreviewLogFilePath = process.env.JC_PREVIEW_RESTART_LOG_FILE;
startReloadPreviewLogLimiter({
  lifecycle: process,
  logFilePath: reloadPreviewLogFilePath,
  onError: (message, error) => dbg.main(`${message}: %O`, error),
});
const registerReloadPreviewReadiness = createReloadPreviewReadinessRegistrar({
  ackFilePath: reloadPreviewAckFilePath,
  lifecycle: process,
  logFilePath: reloadPreviewLogFilePath,
  onError: (message, error) => dbg.main(`${message}: %O`, error),
  readyFilePath: reloadPreviewReadyFilePath,
});

// Prevent multiple instances — a second launch would run recoverStaleTasks()
// and mark currently-running tasks as interrupted.
// Skip when JC_SKIP_INSTANCE_LOCK is set (dev:tmp / dev:tmp:reuse) so we
// can run multiple dev instances side-by-side for testing.
if (process.env.JC_SKIP_INSTANCE_LOCK) {
  dbg.main('JC_SKIP_INSTANCE_LOCK set — skipping single-instance lock');
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    dbg.main(
      'Another instance is already running. Quitting to avoid interrupting active tasks.',
    );
    app.quit();
  }
}

// Fix PATH for packaged macOS apps launched from Finder/Dock
// Only needed when NOT running from terminal (which already has correct PATH)
// Note: fixPath can cause issues with fish shell + jenv/volta configurations
// TODO: Re-enable with PATH cleanup for production Finder launches
if (!process.env.TERM) {
  dbg.main('Fixing PATH for non-terminal launch');
  fixPath();
}

/** Converts a live Menu back into a template we can rebuild from. */
function menuToTemplate(menu: Menu): MenuItemConstructorOptions[] {
  return menu.items.map((item): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' };

    // Submenu roles (e.g. 'windowMenu') regenerate Electron's defaults and
    // would reintroduce the Close item, so expand them explicitly instead.
    if (item.submenu) {
      return { label: item.label, submenu: menuToTemplate(item.submenu) };
    }

    return { role: item.role, label: item.label };
  });
}

/**
 * Rebuilds the application menu with the "Close Window" item stripped of its
 * Cmd+W accelerator, so the shortcut no longer closes the window.
 *
 * The item is kept (greyed out) rather than made invisible: a present-but-
 * accelerator-less item is skipped by macOS `performKeyEquivalent`, so the
 * keydown reaches the renderer and the in-app cmd+w binding ("Open Worktree
 * in Editor") keeps working.
 *
 * macOS only — Windows/Linux default menus have no 'close' role.
 */
function disableCloseWindowShortcut() {
  const menu = Menu.getApplicationMenu();
  if (!menu) {
    dbg.main('No application menu found; Cmd+W close is still active');
    return;
  }

  let stripped = false;
  const template = menuToTemplate(menu).map((topLevelItem) => {
    if (!Array.isArray(topLevelItem.submenu)) return topLevelItem;

    return {
      ...topLevelItem,
      submenu: topLevelItem.submenu.map((item) => {
        if (item.role !== 'close') return item;
        stripped = true;
        // Drop the role (and with it the accelerator + close behaviour).
        return { label: item.label ?? 'Close Window', enabled: false };
      }),
    };
  });

  if (!stripped) {
    dbg.main('No "Close Window" menu item found; nothing to disable');
    return;
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  dbg.main('Removed Cmd+W accelerator from "Close Window"');
}

function createWindow() {
  showDockIcon();

  const isDev = !!process.env.ELECTRON_RENDERER_URL;
  dbg.main('Creating main window (isDev: %s)', isDev);

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: isDev ? 'Jean-Claude 🚧 Dev' : 'Jean-Claude',
    icon: join(__dirname, '../../resources/icons/512x512.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      // Sampled here rather than in the renderer because loading the window is
      // itself what creates the bucket — by the time the renderer could look,
      // the answer is always "present". Passed as a launch argument so it is
      // readable synchronously in the preload, before any persisted store
      // hydrates; an IPC round-trip would resolve too late to be useful.
      additionalArguments: [
        `--jc-local-storage-bucket=${
          hasExistingLocalStorageBucket() ? 'present' : 'absent'
        }`,
      ],
    },
  });

  registerReloadPreviewReadiness(mainWindow.webContents);

  // Open external links in the system default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    dbg.main('External link requested: %s', url);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('windowState:fullscreen-changed', true);
  });

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('windowState:fullscreen-changed', false);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    dbg.main('Loading dev URL: %s', process.env.ELECTRON_RENDERER_URL);
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    const htmlPath = join(__dirname, '../renderer/index.html');
    dbg.main('Loading production HTML: %s', htmlPath);
    mainWindow.loadFile(htmlPath);
  }
}

function showDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return;

  app.setActivationPolicy('regular');
  void app.dock.show().catch((error) => {
    dbg.main('Failed to show Dock icon: %O', error);
  });
}

function restoreOrCreateWindow() {
  showDockIcon();

  const mainWindow = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed(),
  );

  if (!mainWindow) {
    if (!canCreateMainWindow) {
      dbg.main('No windows open, main window creation is not ready yet');
      return;
    }

    dbg.main('No windows open, creating new window');
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function loadMigrationWindowContent({
  window,
  errorMessage,
}: {
  window: BrowserWindow;
  errorMessage?: string;
}) {
  const isError = Boolean(errorMessage);
  const safeErrorMessage = (errorMessage ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        height: 100vh;
        display: grid;
        place-items: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #111827;
        color: #f9fafb;
      }
      main {
        width: min(520px, calc(100vw - 56px));
        padding: 28px;
        text-align: center;
      }
      .spinner {
        width: 34px;
        height: 34px;
        margin: 0 auto 18px;
        border: 3px solid rgba(249, 250, 251, 0.22);
        border-top-color: #f9fafb;
        border-radius: 999px;
        animation: spin 900ms linear infinite;
      }
      .error-icon {
        width: 34px;
        height: 34px;
        margin: 0 auto 18px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: #7f1d1d;
        color: #fecaca;
        font-size: 22px;
        font-weight: 700;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 17px;
        font-weight: 650;
      }
      p {
        margin: 0;
        color: #cbd5e1;
        font-size: 13px;
        line-height: 1.5;
      }
      pre {
        max-height: 260px;
        margin: 16px 0 0;
        padding: 12px;
        overflow: auto;
        white-space: pre-wrap;
        text-align: left;
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.9);
        color: #fecaca;
        font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      ${
        isError
          ? `<div class="error-icon">!</div><h1>Migration failed</h1><p>Jean-Claude could not finish database migration.</p><pre>${safeErrorMessage}</pre>`
          : '<div class="spinner"></div><h1>Updating Jean-Claude</h1><p>Preparing your database. This can take a moment.</p>'
      }
    </main>
  </body>
</html>`;

  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createMigrationWindow() {
  const migrationWindow = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    autoHideMenuBar: true,
    title: 'Jean-Claude Update',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  loadMigrationWindowContent({ window: migrationWindow });
  migrationWindow.once('ready-to-show', () => migrationWindow.show());

  return migrationWindow;
}

// When a second instance is launched, focus the existing window instead
app.on('second-instance', () => {
  restoreOrCreateWindow();
});

app.whenReady().then(async () => {
  dbg.main('App ready, initializing...');

  // ── Reload-preview handoff. MUST be the first thing in `whenReady`. ────────
  //
  // Chromium's `Local Storage/leveldb` admits one process at a time (fcntl LOCK
  // held by the browser process), and a process that cannot open it comes up
  // with an EMPTY store — every persisted zustand store then rehydrates to
  // defaults, which reads as "the restart wiped my settings".
  //
  // `orchestrateReloadedPreview` keeps the outgoing process alive until this
  // one signals ready, so we must (a) signal before touching the store and
  // (b) not touch the store until the predecessor's pid is gone.
  //
  // "Before touching the store" is earlier than it looks. It is NOT window
  // creation: `protocol.handle()` opens the LevelDB on its own, verified
  // against Electron 42.7.0 with no window ever created —
  //
  //     MODE=none    whenReady lockExists=false → final lockExists=false
  //     MODE=handle  whenReady lockExists=false → after-protocol.handle=true
  //
  // — and this file registers two protocol handlers below. An earlier version
  // of this fix sat after them and was therefore inert. Anything added above
  // this block must be verified not to touch `session.defaultSession`.
  registerReloadPreviewReadiness.signalNow();

  const previousPreviewPid = Number(
    process.env[RELOAD_PREVIEW_PREVIOUS_PID_ENV],
  );
  if (process.env[RELOAD_PREVIEW_PREVIOUS_PID_ENV]) {
    const { exited, attempts } = await waitForPreviousPreviewExit({
      pid: previousPreviewPid,
    });
    dbg.main(
      'Reload-preview predecessor %d exited=%s after %d checks',
      previousPreviewPid,
      exited,
      attempts,
    );
    if (!exited) {
      // Proceeding is the lesser evil: a session with possibly-empty
      // localStorage is recoverable next launch, a permanently blank app is
      // not. The boot guard still refuses to overwrite good data on disk.
      dbg.main(
        'Reload-preview predecessor %d never exited — continuing anyway; ' +
          'localStorage may come up empty for this session',
        previousPreviewPid,
      );
    }
  }
  // ── End handoff. The LevelDB is free from here. ───────────────────────────

  // Sampled after the handoff so it describes the store we will actually get,
  // and before anything opens it — `protocol.handle` below would create the
  // bucket and make a genuine first run look like a failed read.
  recordBootDiagnostics({ bucketExists: hasExistingLocalStorageBucket() });
  showDockIcon();

  // Reap framebuffer helpers left behind by a previous run (they otherwise keep
  // encoding frames at full CPU forever).
  void killOrphanedCoreSimulatorHelpers();

  // Register azure-image-proxy protocol handler
  dbg.main('Registering azure-image-proxy protocol handler...');
  protocol.handle('azure-image-proxy', async (request) => {
    const decoded = decodeProxyUrl(request.url);
    if (!decoded) {
      dbg.main('Failed to decode proxy URL: %s', request.url);
      return new Response('Invalid proxy URL', { status: 400 });
    }

    const { providerId, imageUrl } = decoded;
    dbg.main(
      'Proxying image request: providerId=%s, url=%s',
      providerId,
      imageUrl,
    );

    // Stream the response directly from Azure DevOps
    return fetchAuthenticatedImageStream({
      providerId,
      imageUrl,
      signal: request.signal,
    });
  });
  dbg.main('azure-image-proxy protocol handler registered');

  dbg.main('Registering local image protocol handler...');
  protocol.handle(LOCAL_IMAGE_PROTOCOL, (request) =>
    fetchLocalImage(request.url),
  );
  dbg.main('local image protocol handler registered');

  dbg.main('Running database migrations...');
  let shouldQuitOnMigrationWindowClose = false;
  const migrationWindowRef: { current: BrowserWindow | null } = {
    current: null,
  };
  const migrationWindowTimer = setTimeout(() => {
    migrationWindowRef.current = createMigrationWindow();
    migrationWindowRef.current.on('closed', () => {
      migrationWindowRef.current = null;
      if (shouldQuitOnMigrationWindowClose) {
        app.quit();
      }
    });
  }, 500);

  try {
    await migrateDatabase();
  } catch (error) {
    clearTimeout(migrationWindowTimer);
    const errorMessage =
      error instanceof Error ? error.stack || error.message : String(error);

    shouldQuitOnMigrationWindowClose = true;
    if (!migrationWindowRef.current) {
      migrationWindowRef.current = createMigrationWindow();
      migrationWindowRef.current.on('closed', () => {
        migrationWindowRef.current = null;
        app.quit();
      });
    }
    loadMigrationWindowContent({
      window: migrationWindowRef.current,
      errorMessage,
    });
    migrationWindowRef.current.setClosable(true);
    migrationWindowRef.current.show();
    return;
  }

  clearTimeout(migrationWindowTimer);
  migrationWindowRef.current?.close();
  dbg.main('Database migrations complete');

  const isDev = !!process.env.ELECTRON_RENDERER_URL;
  dbg.main('Upserting builtin skills...');
  await upsertBuiltinSkills({ preserveExisting: isDev });
  await syncBuiltinSkillSymlinks();
  dbg.main('Builtin skills upserted');

  systemCalendarService.start();
  pipelineTrackingService.start();
  rawMessageCleanupService.start();
  agentMemorySchedulerService.start();

  dbg.main('Registering IPC handlers...');
  registerIpcHandlers();
  dbg.main('IPC handlers registered');

  // Recover any tasks that were left in running/waiting state from a previous crash
  dbg.main('Recovering stale tasks...');
  await agentService.recoverStaleTasks();

  // Clean up orphaned skill workspaces from previous sessions
  cleanupOrphanedWorkspaces().catch((err) => {
    dbg.main('Failed to cleanup orphaned workspaces: %O', err);
  });

  disableCloseWindowShortcut();
  // Set immediately before the window it guards: `second-instance` can fire at
  // any await above and calls `restoreOrCreateWindow()`, which creates a window
  // as soon as this flag is true.
  canCreateMainWindow = true;
  createWindow();
  dbg.main('Main window created, app ready');

  app.on('activate', () => {
    dbg.main('App activated');
    restoreOrCreateWindow();
  });
});

let isQuittingAfterCleanup = false;
const QUIT_CLEANUP_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Quit cleanup timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

app.on('before-quit', (event) => {
  if (isQuittingAfterCleanup) return;

  event.preventDefault();
  isQuittingAfterCleanup = true;
  recordQuitStarted();

  // Chromium buffers localStorage in memory and commits to its LevelDB store on
  // a delayed timer, so a write made shortly before quitting can still be
  // uncommitted here. Post the commit first, then hold the settle window open
  // below before `app.quit()` tears the renderer down.
  //
  // Speculative hardening, not a diagnosed fix: a graceful `app.quit()` is
  // *supposed* to flush storage during renderer teardown, and the one exit path
  // known to drop writes (`app.exit(0)` in the reload-preview handoff) already
  // flushes for itself. This covers ordinary quits cheaply in case that
  // guarantee does not hold. Do not treat lost-persisted-state reports as
  // resolved by this alone — the `[ls-debug]` boot warning in
  // `src/lib/debug-local-storage.ts` is still what identifies the real cause.
  //
  // Best-effort and never fatal: failing to flush must not block the quit.
  const flushStartedAt = Date.now();
  try {
    session.defaultSession.flushStorageData();
    dbg.main('Flushed renderer storage data before quit');
  } catch (error) {
    dbg.main('Failed to flush storage data before quit: %O', error);
  }

  void (async () => {
    try {
      await withTimeout(
        (async () => {
          dbg.main('App quitting, stopping agents and commands...');
          await agentService.stopAll({ reason: 'shutdown' });
          dbg.main('All agents stopped');
          await closeIdleOpenCodeSharedServerNow();
          dbg.main('Idle shared OpenCode server stopped');
          await runCommandService.stopAllCommands();
          dbg.main('All commands stopped');
          // Stops mobile preview sessions and their helper processes. Awaited
          // here so this handler stays the single owner of app.quit(): the
          // registry must not quit while agents/DB writes are still in flight.
          await runBeforeQuitCleanups();
          dbg.main('Mobile preview sessions stopped');
        })(),
        QUIT_CLEANUP_TIMEOUT_MS,
      );
    } catch (error) {
      dbg.main('Error during quit cleanup: %O', error);
      runCommandService.killAllProcessGroupsSync();
      killAllOpenCodeServersSync();
    } finally {
      // `flushStorageData()` posts the commit to Chromium's storage sequence and
      // reports no completion, so it needs a settle window before the renderer
      // goes away. The cleanup above usually covers it, but must not be relied
      // on: a quiet quit (no agents, no run commands, no preview sessions)
      // resolves in a few microtasks and would leave ~0ms. Wait only for the
      // remainder, so a slow cleanup adds nothing. Well inside
      // QUIT_CLEANUP_TIMEOUT_MS, and outside it so a cleanup timeout still gets
      // the window.
      const elapsed = Date.now() - flushStartedAt;
      if (elapsed < RELOAD_PREVIEW_FLUSH_SETTLE_MS) {
        await new Promise((resolve) =>
          setTimeout(resolve, RELOAD_PREVIEW_FLUSH_SETTLE_MS - elapsed),
        );
      }

      recordCleanupDone();

      // A timed-out or failed preview cleanup must not leave the registry
      // vetoing quits forever.
      stopVetoingQuit();
      app.quit();
    }
  })();

  systemCalendarService.stop();
  pipelineTrackingService.stop();
  rawMessageCleanupService.stop();
  agentMemorySchedulerService.stop();
});

// Synchronous last-resort cleanup: kill all process groups when the Node.js
// process exits (covers SIGINT, SIGTERM, uncaught exceptions — not kill -9).
process.on('exit', () => {
  runCommandService.killAllProcessGroupsSync();
  killAllOpenCodeServersSync();
  // Last write of the lifecycle breadcrumb: the next boot compares this against
  // its own start time to see whether the two processes overlapped.
  recordProcessExit();
});

app.on('window-all-closed', () => {
  dbg.main('All windows closed');
  showDockIcon();
  if (process.platform !== 'darwin') {
    dbg.main('Non-macOS platform, quitting app');
    app.quit();
  }
});
