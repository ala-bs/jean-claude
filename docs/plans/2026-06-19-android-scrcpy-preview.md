# Android Scrcpy Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace low-FPS Android PNG polling with a real scrcpy H264 stream while keeping PNG screenshots as fallback.

**Architecture:** Main process starts Android preview with scrcpy first. It pushes/starts the scrcpy server through `@yume-chan/adb-scrcpy`, forwards H264 chunks through existing mobile preview IPC, and renderer decodes with existing Yume Chan WebCodecs canvas. If scrcpy startup fails, Android adapter falls back to existing `adb exec-out screencap -p` polling and reports `adb-screenshot` strategy.

**Tech Stack:** Electron main process, TypeScript, `adb`, `@yume-chan/scrcpy`, `@yume-chan/adb-scrcpy`, existing `H264PreviewCanvas`, Vitest.

---

### Task 1: Add Scrcpy ADB Dependency

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Add dependency**

Run:
```bash
pnpm add @yume-chan/adb-scrcpy@2.3.0
```

Expected: `package.json` gains `@yume-chan/adb-scrcpy`; lockfile updates. Use `2.3.0` to match current `@yume-chan/scrcpy@^2.3.0` and avoid mixed protocol package versions.

**Step 2: Inspect installed types**

Read these files after install:
```text
node_modules/@yume-chan/adb-scrcpy/esm/index.d.ts
node_modules/@yume-chan/adb-scrcpy/esm/client.d.ts
node_modules/@yume-chan/adb-scrcpy/esm/options.d.ts
```

Expected: confirm exported `AdbScrcpyClient`, options/version helpers, server push/start APIs, and video stream shape.

**Step 3: Run dependency verification**

Run:
```bash
pnpm install
```

Expected: install completes. Existing Node engine warning may appear if local Node remains `v24.14.0`.

---

### Task 2: Add Test Seam For Scrcpy Startup

**Files:**
- Modify: `electron/services/mobile-preview-android-adapter.ts`
- Modify: `electron/services/mobile-preview-android-adapter.test.ts`

**Step 1: Add injectable scrcpy starter type**

In `mobile-preview-android-adapter.ts`, add a local type near imports:

```ts
type AndroidScrcpyStarter = (params: {
  deviceId: string;
  fps?: number;
  onFrame: (frame: Buffer) => void;
  onSize: (size: { width: number; height: number }) => void;
}) => Promise<{ stop: () => Promise<void> }>;
```

Add it to adapter factory options if current file already has a factory, or create a tiny internal factory:

```ts
export function createAndroidMobilePreviewAdapter({
  startScrcpyStream = startAndroidScrcpyStream,
}: {
  startScrcpyStream?: AndroidScrcpyStarter;
} = {}) {
  return { listDevices, startStream, sendInput };
}

export const androidAdapter = createAndroidMobilePreviewAdapter();
```

Keep existing exported helper functions unchanged for tests.

**Step 2: Write failing test for scrcpy default**

In `mobile-preview-android-adapter.test.ts`, add a test that injects `startScrcpyStream`, calls `startStream`, and asserts:

```ts
expect(session.frameFormat).toBe('h264');
expect(session.streamStrategy).toBe('scrcpy');
expect(startScrcpyStream).toHaveBeenCalledWith(
  expect.objectContaining({ deviceId: 'emulator-5554', fps: 30 }),
);
```

Also call the injected `onFrame(Buffer.from([0, 0, 0, 1]))` and assert adapter forwards that buffer via `onFrame`.

**Step 3: Run focused test to verify failure**

Run:
```bash
pnpm test electron/services/mobile-preview-android-adapter.test.ts
```

Expected: new scrcpy default test fails because adapter still uses screenshot polling.

---

### Task 3: Implement Scrcpy Default With Screenshot Fallback

**Files:**
- Modify: `electron/services/mobile-preview-android-adapter.ts`
- Modify: `electron/services/mobile-preview-android-adapter.test.ts`

**Step 1: Split existing screenshot stream into helper**

Extract current PNG loop from Android `startStream` into:

```ts
async function startAndroidScreenshotStream({
  deviceId,
  taskId,
  onFrame,
  onSession,
}: {
  deviceId: string;
  taskId: string;
  onFrame: (frame: Buffer) => void;
  onSession: (patch: Partial<MobilePreviewSession>) => void;
}): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }> {
  // existing PNG implementation, unchanged behavior
}
```

Session fields:
```ts
frameFormat: 'png'
streamStrategy: 'adb-screenshot'
```

**Step 2: Implement scrcpy-first `startStream`**

Change Android `startStream` flow:

```ts
async function startStream(params: {
  taskId: string;
  deviceId: string;
  fps?: number;
  onFrame: (frame: Buffer) => void;
  onSession: (patch: Partial<MobilePreviewSession>) => void;
}) {
  await assertAdbInstalled();
  const deviceId = await ensureAndroidDeviceReady(params.deviceId);

  const session: MobilePreviewSession = {
    id: randomUUID(),
    taskId: params.taskId,
    platform: 'android',
    deviceId,
    status: 'starting',
    width: null,
    height: null,
    frameFormat: 'h264',
    streamStrategy: 'scrcpy',
    inputStatus: 'ready',
    error: null,
  };

  try {
    const stream = await startScrcpyStream({
      deviceId,
      fps: params.fps,
      onFrame: params.onFrame,
      onSize: (size) => params.onSession(size),
    });
    params.onSession({ status: 'streaming' });
    return { session: { ...session, status: 'streaming' }, stop: stream.stop };
  } catch (error) {
    return startAndroidScreenshotStream({
      deviceId,
      taskId: params.taskId,
      onFrame: params.onFrame,
      onSession: params.onSession,
    });
  }
}
```

Do not surface fallback as fatal error. User sees `adb screenshots` strategy if scrcpy fails.

**Step 3: Add fallback test**

Add test with injected `startScrcpyStream` rejecting. Assert resulting session uses:

```ts
frameFormat: 'png'
streamStrategy: 'adb-screenshot'
```

Use existing screenshot test machinery so fallback emits a PNG frame.

**Step 4: Run focused tests**

Run:
```bash
pnpm test electron/services/mobile-preview-android-adapter.test.ts
```

Expected: Android adapter tests pass.

---

### Task 4: Build Real Scrcpy Starter

**Files:**
- Modify: `electron/services/mobile-preview-android-adapter.ts`
- Possibly create: `electron/services/mobile-preview-android-scrcpy.ts`

**Step 1: Prefer separate helper file if imports are noisy**

If `@yume-chan/adb-scrcpy` setup needs more than ~60 lines, create `mobile-preview-android-scrcpy.ts`. Otherwise keep in adapter file.

**Step 2: Implement `startAndroidScrcpyStream` against installed types**

Implementation requirements:

- Use `adb` command transport supported by `@yume-chan/adb-scrcpy`, not `scrcpy` CLI.
- Configure video only; disable audio/control unless required for stream startup.
- Request H264 codec.
- Respect selected FPS when API offers `maxFps` or equivalent.
- Forward raw H264 chunks to `onFrame(Buffer.from(chunk))`.
- Call `onSize({ width, height })` when metadata exposes dimensions.
- Return `stop()` that closes scrcpy client, streams, tunnels, and any spawned process.

Skeleton, adapt names to actual installed types:

```ts
async function startAndroidScrcpyStream({
  deviceId,
  fps,
  onFrame,
  onSize,
}: Parameters<AndroidScrcpyStarter>[0]) {
  const client = await AdbScrcpyClient.start(/* adb device/transport */, {
    version: SCRCPY_VERSION_2_3,
    video: true,
    audio: false,
    control: false,
    videoCodec: ScrcpyVideoCodecId.H264,
    maxFps: fps,
  });

  const reader = client.videoStream.stream.getReader();
  let stopped = false;

  void (async () => {
    while (!stopped) {
      const result = await reader.read();
      if (result.done) break;
      onFrame(Buffer.from(result.value));
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => undefined);
      await client.close?.();
    },
  };
}
```

Expected adaptation: actual `@yume-chan/adb-scrcpy` API may use `AdbScrcpyClient.start(adb, path, version, options)` or a similar method. Follow installed `.d.ts` exactly.

**Step 3: Add unit test for cleanup**

If helper is testable without real adb, add a mock stream reader test. Assert `stop()` cancels reader and closes client. If API resists mocking, skip unit and rely on injected starter tests from Tasks 2-3.

**Step 4: Run focused tests**

Run:
```bash
pnpm test electron/services/mobile-preview-android-adapter.test.ts
```

Expected: pass.

---

### Task 5: Renderer UX Cleanup

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`
- Modify: `src/hooks/use-mobile-preview.ts` only if needed

**Step 1: Keep existing H264 canvas path**

Do not rewrite `H264PreviewCanvas`. It already imports:

```ts
import { ScrcpyVideoCodecId, type ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy';
import { WebCodecsVideoDecoder } from '@yume-chan/scrcpy-decoder-webcodecs';
```

It already decodes H264 access units. Scrcpy stream should feed this path through `frameFormat: 'h264'`.

**Step 2: Update labels if needed**

Ensure `getStreamStrategyLabel('scrcpy')` returns `scrcpy`; already present. Ensure Android FPS select is enabled for `scrcpy` sessions if current UI disables FPS for all Android.

Minimal change:
```ts
const isFpsDisabled = platform === 'android' && session?.streamStrategy === 'adb-screenshot';
```

If there is no active session yet, leave FPS enabled for Android because scrcpy is default.

**Step 3: Run renderer type check**

Run:
```bash
pnpm ts-check
```

Expected: no TypeScript errors.

---

### Task 6: End-To-End Verification

**Files:**
- No code changes unless failures appear.

**Step 1: Required install**

Run:
```bash
pnpm install
```

Expected: completes. Node engine warning acceptable if using local Node `v24.14.0`.

**Step 2: Full tests**

Run:
```bash
pnpm test
```

Expected: all tests pass.

**Step 3: Lint autofix**

Run:
```bash
pnpm lint --fix
```

Expected: exits 0 or applies formatting-only changes.

**Step 4: Type check**

Run:
```bash
pnpm ts-check
```

Expected: exits 0.

**Step 5: Final lint**

Run:
```bash
pnpm lint
```

Expected: exits 0.

**Step 6: Manual smoke test**

Start app via normal dev flow if needed, open Android mobile preview, select a booted emulator or shutdown AVD, and verify:

- status label shows `scrcpy`
- preview moves at interactive FPS, not PNG polling cadence
- FPS select remains usable for Android scrcpy
- tap/swipe/text input still works through existing `adb input`
- if scrcpy startup fails, preview still appears with `adb screenshots`

---

### Task 7: Optional Cleanup After Scrcpy Works

**Files:**
- Modify: `electron/services/mobile-preview-android-adapter.ts`
- Modify: `electron/services/mobile-preview-android-adapter.test.ts`
- Modify: `shared/mobile-simulator-types.ts`

**Step 1: Decide whether to remove `adb-screenrecord` path**

If no caller can select `adb-screenrecord`, remove:

- `buildAdbScreenrecordArgs`
- `ANDROID_SCREENRECORD_BIT_RATE`
- tests only covering unused screenrecord args
- `adb-screenrecord` from `MobilePreviewStreamStrategy`
- UI label for `adb-screenrecord`

Keep it if user wants experimental H264 screenrecord fallback.

**Step 2: Run full checks again**

Run:
```bash
pnpm test
pnpm lint --fix
pnpm ts-check
pnpm lint
```

Expected: all pass.
