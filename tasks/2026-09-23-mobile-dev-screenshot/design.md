# Mobile Dev Pane Screenshots — Design
Date: 2026-09-23

## Problem

The lightweight Mobile Dev pane displays a real simulator/emulator window but
does not offer a way to capture that device screen. Users must leave Jean-Claude
and use platform-specific tools or OS screenshots.

## Users & success criteria

- A developer can capture the selected booted iOS simulator or connected/booted
  Android device from the Mobile Dev pane.
- The capture is delivered as a PNG through the existing Save dialog.
- Metro and the app do not need to be running.
- Unsupported physical iOS devices are visibly disabled rather than failing
  after a click.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| The Mobile Dev pane owns device selection and app actions. | `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx` |
| Android already captures PNG frames with validated ADB arguments. | `electron/services/mobile-preview-android-adapter.ts` |
| iOS already captures simulator screenshots to temporary files. | `electron/services/mobile-preview-ios-framebuffer.ts` |
| The full preview already uses the typed dialog save path. | `src/features/task/ui-task-panel/mobile-preview-pane/use-mobile-preview-recording.ts` |

## Decisions

- Support iOS simulators and Android emulators/physical devices in v1.
- Keep physical iOS devices visible but disable Screenshot for them.
- Put Screenshot beside Reload and Restart in the app actions row.
- Enable capture for any supported booted/connected device, independent of Metro.
- Open the existing Save dialog with a timestamped PNG default path.
- Use one typed IPC method returning PNG bytes; platform adapters own CLI details.
- Log capture start, success byte count, and failure reason in the main process.

## Architecture

```text
MobileDevPane
  └─ api.mobilePreview.captureScreenshot({ platform, deviceId })
       └─ mobilePreviewService.captureScreenshot(...)
            ├─ iOS simulator: simctl → temporary PNG bytes
            └─ Android: adb exec-out screencap -p → PNG bytes
       └─ api.dialog.saveFile({ content, defaultPath, PNG filter })
```

- `MobileDevPane` derives capture availability from the selected device,
  manages the in-flight state, and surfaces concise toast errors.
- `mobilePreviewService` validates the platform and delegates to the adapter.
- The Android adapter resolves the ADB serial and runs the existing safe
  screenshot command builder.
- The iOS adapter rejects physical devices and uses a PNG variant of the
  existing simctl screenshot helper.
- Preload/API/IPC expose the operation without exposing Node APIs to the
  renderer.

## Interfaces

```ts
type MobilePreviewCaptureScreenshotParams = {
  platform: MobilePlatform;
  deviceId: string;
};

type MobilePreviewCaptureScreenshotResult = {
  content: Uint8Array;
  mimeType: 'image/png';
  extension: 'png';
};
```

## Data flow

1. User selects a device and clicks Screenshot.
2. Renderer disables the action and invokes the typed IPC method.
3. Main process captures PNG bytes with the platform CLI.
4. Renderer opens the existing Save dialog with a timestamped `.png` name.
5. A successful save shows a success notice; capture/save failures show a toast.

Failure paths:

- No device, shutdown device, or physical iOS: action disabled with an
  explanatory tooltip.
- Missing platform CLI, disconnected device, or CLI failure: operation rejects,
  main process logs the reason, and renderer shows a concise toast.
- User cancels the Save dialog: no error toast; capture remains successful.

## State and security

Capture state is local component state. Device IDs are validated by the
platform adapters using the existing selector/serial validation. Temporary iOS
files are deleted in `finally`; screenshot bytes are only returned to the
requesting renderer and are not persisted by the main process.

## Test strategy

- Unit-test the iOS PNG command/helper and Android command invocation.
- Test service delegation and unsupported platform/device behavior.
- Test Mobile Dev pane button disabled, loading, success/save, and error paths.
- Run repository-required install, test, lint-fix, type-check, and lint commands.

## Rollout

No migration or feature flag. The IPC method is additive. Rollback removes the
button and capture method without affecting existing preview streams.
