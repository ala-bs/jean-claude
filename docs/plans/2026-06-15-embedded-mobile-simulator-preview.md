# Embedded Mobile Simulator Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add hidden iOS Simulator and Android Emulator previews inside Jean-Claude task panes using `idb` and `scrcpy`/`adb` adapters.

**Architecture:** Main process owns simulator preview sessions and child processes. Renderer receives MJPEG frames over IPC first, renders them to a canvas, and sends pointer/keyboard input back to main. Keep adapters isolated so iOS (`idb`) and Android (`scrcpy`/`adb`) can evolve independently.

**Tech Stack:** Electron IPC, Node child processes, React canvas, `idb`, `scrcpy`, `adb`, `xcrun simctl`.

---

## Decisions

| Topic | Decision |
|---|---|
| First video format | MJPEG frames over IPC. Simpler than H264/MSE/WebCodecs. |
| iOS backend | Require installed `idb` + `idb_companion`. Boot via `simctl`, stream/input via `idb`. |
| Android backend | Prefer `scrcpy` later for low latency. MVP can use `adb exec-out screenrecord` only for probe, but real Android preview should use `scrcpy --no-window --record=-` or protocol client. |
| UI location | Existing task right pane. Add `mobilePreview` pane type. |
| Persistence | No DB migration in MVP. Session state in memory, keyed by `taskId`. |
| Security | Renderer never runs shell. Main validates platform/device/session. |

## Phase 1: Shared Types And IPC

### Task 1: Add Shared Simulator Types

**Files:**
- Create: `shared/mobile-simulator-types.ts`

**Step 1: Add types**

```ts
export type MobilePlatform = 'ios' | 'android';

export type MobilePreviewStatus =
  | 'idle'
  | 'checking-tools'
  | 'starting'
  | 'streaming'
  | 'stopped'
  | 'error';

export type MobilePreviewFrameFormat = 'mjpeg';

export type MobilePreviewDevice = {
  id: string;
  name: string;
  platform: MobilePlatform;
  state: 'booted' | 'shutdown' | 'unknown';
};

export type MobilePreviewSession = {
  id: string;
  taskId: string;
  platform: MobilePlatform;
  deviceId: string;
  status: MobilePreviewStatus;
  width: number | null;
  height: number | null;
  frameFormat: MobilePreviewFrameFormat;
  error: string | null;
};

export type MobilePreviewStartParams = {
  taskId: string;
  projectPath: string;
  platform: MobilePlatform;
  deviceId: string;
};

export type MobilePreviewInputEvent =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: 'home' | 'back' | 'enter' };

export type MobilePreviewFrameEvent = {
  sessionId: string;
  frameBase64: string;
};

export type MobilePreviewSessionEvent = {
  session: MobilePreviewSession;
};
```

**Step 2: Run typecheck**

Run: `pnpm ts-check`

Expected: PASS or unrelated existing errors only.

### Task 2: Extend Renderer API Contract

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `electron/preload.ts`

**Step 1: Import shared types**

Add imports in `src/lib/api.ts` and `electron/preload.ts`.

**Step 2: Add API shape**

Add to `Api`:

```ts
mobilePreview: {
  listDevices: (platform: MobilePlatform) => Promise<MobilePreviewDevice[]>;
  start: (params: MobilePreviewStartParams) => Promise<MobilePreviewSession>;
  stop: (sessionId: string) => Promise<void>;
  sendInput: (sessionId: string, event: MobilePreviewInputEvent) => Promise<void>;
  onFrame: (callback: (event: MobilePreviewFrameEvent) => void) => UnsubscribeFn;
  onSession: (callback: (event: MobilePreviewSessionEvent) => void) => UnsubscribeFn;
};
```

**Step 3: Add preload bridge**

```ts
mobilePreview: {
  listDevices: (platform) => ipcRenderer.invoke('mobilePreview:listDevices', platform),
  start: (params) => ipcRenderer.invoke('mobilePreview:start', params),
  stop: (sessionId) => ipcRenderer.invoke('mobilePreview:stop', sessionId),
  sendInput: (sessionId, event) => ipcRenderer.invoke('mobilePreview:sendInput', sessionId, event),
  onFrame: (callback) => {
    const handler = (_: unknown, event: MobilePreviewFrameEvent) => callback(event);
    ipcRenderer.on('mobilePreview:frame', handler);
    return () => ipcRenderer.removeListener('mobilePreview:frame', handler);
  },
  onSession: (callback) => {
    const handler = (_: unknown, event: MobilePreviewSessionEvent) => callback(event);
    ipcRenderer.on('mobilePreview:session', handler);
    return () => ipcRenderer.removeListener('mobilePreview:session', handler);
  },
},
```

**Step 4: Add fallback stubs**

In non-Electron fallback object, return empty devices and no-op subscriptions.

## Phase 2: Main Process Service

### Task 3: Add Process Helpers

**Files:**
- Create: `electron/services/mobile-preview-process.ts`
- Test: `electron/services/mobile-preview-process.test.ts`

**Behavior:**
- `commandExists(command)` runs `which <command>`.
- `runCommand(command, args, options)` captures stdout/stderr with timeout.
- `spawnManaged(command, args, options)` returns child + cleanup.

**Tests:**
- command missing returns false.
- timeout kills process.
- stdout captured.

Run: `pnpm test electron/services/mobile-preview-process.test.ts`

### Task 4: Add iOS IDB Adapter

**Files:**
- Create: `electron/services/mobile-preview-ios-idb-adapter.ts`
- Test: `electron/services/mobile-preview-ios-idb-adapter.test.ts`

**Public methods:**

```ts
export const iosIdbAdapter = {
  async listDevices(): Promise<MobilePreviewDevice[]>;
  async startStream(params: { taskId: string; deviceId: string; onFrame: (frame: Buffer) => void; onSession: (patch: Partial<MobilePreviewSession>) => void }): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }>;
  async sendInput(deviceId: string, event: MobilePreviewInputEvent): Promise<void>;
};
```

**Implementation:**
- Tool check: `which idb`, `which xcrun`.
- Devices: `xcrun simctl list devices --json`, map booted/shutdown iOS devices.
- Boot hidden: `xcrun simctl boot <udid>` when shutdown. Do not open Simulator.app.
- Stream: `idb video-stream --udid <udid> --format mjpeg --fps 15 --compression-quality 0.6`.
- Frame parser: MJPEG stream split on JPEG SOI/EOI markers (`0xffd8` / `0xffd9`).
- Input:
  - tap: `idb ui tap <x> <y> --udid <udid>`
  - swipe: `idb ui swipe <x1> <y1> <x2> <y2> --duration <seconds> --udid <udid>`
  - text: `idb ui text <text> --udid <udid>`
  - key home: `idb ui button HOME --udid <udid>`

**Tests:**
- simctl JSON maps devices.
- MJPEG parser emits complete frames.
- tap builds expected args.

### Task 5: Add Android Adapter Skeleton

**Files:**
- Create: `electron/services/mobile-preview-android-adapter.ts`
- Test: `electron/services/mobile-preview-android-adapter.test.ts`

**MVP behavior:**
- Tool check: `adb` required, `scrcpy` optional.
- Devices: `adb devices -l`, map emulator/device rows.
- Input:
  - tap: `adb -s <id> shell input tap <x> <y>`
  - swipe: `adb -s <id> shell input swipe <x1> <y1> <x2> <y2> <durationMs>`
  - text: escape spaces and run `adb -s <id> shell input text <text>`
  - back/home/enter: `adb -s <id> shell input keyevent KEYCODE_BACK|KEYCODE_HOME|KEYCODE_ENTER`
- Stream:
  - If `scrcpy` missing, return error: `scrcpy is required for Android preview`.
  - Do not implement protocol in this phase unless needed.

**Follow-up implementation choices:**
- Option A: use `scrcpy --no-window --record=- --record-format=mkv`, pipe to ffmpeg/WebCodecs. More dependency complexity.
- Option B: embed scrcpy server/client protocol in Node. More work, best long-term.

### Task 6: Add Mobile Preview Service

**Files:**
- Create: `electron/services/mobile-preview-service.ts`
- Test: `electron/services/mobile-preview-service.test.ts`

**Behavior:**
- Keeps `Map<string, ActiveSession>` by `sessionId`.
- `listDevices(platform)` delegates adapter.
- `start(params)` stops existing session for same `taskId`, starts adapter, stores session.
- `stop(sessionId)` kills stream child and removes session.
- `sendInput(sessionId, event)` delegates platform adapter.
- Emits `mobilePreview:frame` and `mobilePreview:session` to all windows or requesting webContents.
- Cleans sessions on `app.before-quit`.

**Tests:**
- Starting second session for same task stops first.
- Stop calls cleanup once.
- Frame callback emits base64 event.

### Task 7: Register IPC Handlers

**Files:**
- Modify: `electron/ipc/handlers.ts`

**Add imports:**

```ts
import { mobilePreviewService } from '../services/mobile-preview-service';
```

**Add handlers near other app/tool handlers:**

```ts
ipcMain.handle('mobilePreview:listDevices', (_, platform) =>
  mobilePreviewService.listDevices(platform),
);
ipcMain.handle('mobilePreview:start', (event, params) =>
  mobilePreviewService.start(params, event.sender),
);
ipcMain.handle('mobilePreview:stop', (_, sessionId) =>
  mobilePreviewService.stop(sessionId),
);
ipcMain.handle('mobilePreview:sendInput', (_, sessionId, input) =>
  mobilePreviewService.sendInput(sessionId, input),
);
```

## Phase 3: Renderer Hooks And UI

### Task 8: Add Hook

**Files:**
- Create: `src/hooks/use-mobile-preview.ts`

**Behavior:**
- `useMobilePreviewDevices(platform)` uses React Query.
- `useMobilePreviewSession(taskId)` stores current session + latest frame URL.
- Subscribe to `api.mobilePreview.onFrame` and `onSession`.
- Revoke old object URLs to prevent leaks.
- Expose `start`, `stop`, `sendInput` mutations.

### Task 9: Add Preview Pane Component

**Files:**
- Create: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`

**UI:**
- Header: platform select, device select, Start/Stop, close.
- Body states: missing tools, idle, starting, streaming, error.
- Canvas/image preview centered on dark background.
- Pointer mapping:
  - measure rendered image rect
  - map client coords to device coords
  - click -> `tap`
  - drag > threshold -> `swipe`
- Keyboard when focused:
  - Escape/backspace -> Android back only
  - Enter -> key enter
  - plain text input -> `text`

**Notes:**
- Use `<img src={frameUrl}>` first. Canvas can come later if overlays needed.
- If frame dimensions unknown, infer after image load via `naturalWidth/height`.

### Task 10: Add Pane State

**Files:**
- Modify: `src/stores/navigation.ts`

**Changes:**
- Add `| { type: 'mobilePreview' }` to `RightPane`.
- Add action `openMobilePreview(taskId: string)` in `useTaskState` return.
- Add width constants if needed later; MVP can reuse command logs pane width class in component.

### Task 11: Wire Task Panel Menu

**Files:**
- Modify: `src/features/task/ui-task-panel/index.tsx`

**Changes:**
- Import `Smartphone` from `lucide-react`.
- Import `MobilePreviewPane`.
- Pull `openMobilePreview` from `useTaskState(taskId)`.
- Add dropdown item near view toggles:

```tsx
<DropdownItem
  icon={<Smartphone />}
  onClick={openMobilePreview}
  checked={rightPane?.type === 'mobilePreview'}
>
  Mobile Preview
</DropdownItem>
```

- Render pane:

```tsx
{rightPane?.type === 'mobilePreview' && (
  <MobilePreviewPane
    taskId={taskId}
    projectPath={taskRootPath}
    onClose={closeRightPane}
  />
)}
```

## Phase 4: Manual Validation

### Task 12: iOS Smoke Test

**Prereqs:**
- `brew tap facebook/fb`
- `brew install idb-companion`
- `pipx install fb-idb` or `pip install fb-idb`

**Steps:**
- Open RN task.
- Open Mobile Preview.
- Select iOS simulator.
- Start.
- Expected: simulator remains hidden unless already open.
- Expected: stream visible in pane.
- Click preview.
- Expected: tap lands in simulator app.
- Type text in focused preview.
- Expected: text input receives text.

### Task 13: Android Smoke Test

**Prereqs:**
- Android SDK platform-tools.
- `brew install scrcpy`.
- Boot Android emulator manually or via future device manager.

**Steps:**
- Open Mobile Preview.
- Select Android emulator.
- Start.
- Expected for MVP skeleton: clear error if streaming not implemented yet, input methods unit-tested.
- Follow-up: implement scrcpy streaming and verify same as iOS.

## Phase 5: H264/WebCodecs Upgrade

### Task 14: Replace MJPEG With H264 Where Supported

**Files:**
- Modify: `electron/services/mobile-preview-ios-idb-adapter.ts`
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`

**Approach:**
- iOS: `idb video-stream --format h264`.
- Renderer: WebCodecs `VideoDecoder` if available.
- Fallback: MJPEG.
- Android: use scrcpy H264 stream/protocol.

**Acceptance:**
- Less CPU than MJPEG.
- Lower latency.
- Fallback still works.

## Final Verification

Run in required repo order:

```bash
pnpm install
pnpm test
pnpm lint:fix
pnpm ts-check
pnpm lint
```

## Risks

| Risk | Mitigation |
|---|---|
| `idb` install friction | Show actionable missing-tool message. Keep `simctl screenshot` fallback later. |
| MJPEG CPU cost | Cap FPS to 10-15. Add H264 phase. |
| IPC frame volume | Drop frames when renderer lags; send latest only later if needed. |
| Android scrcpy protocol work | Treat Android preview as second milestone after iOS MVP. |
| Hidden simulator quirks | If stream/input fails, offer “Open Simulator” action, but do not require by default. |
