# Mobile Dev Deeplink Verification Refresh — Design
Date: 2026-09-25

## Problem

The Mobile Dev pane can open arbitrary deeplinks, but it does not offer a quick,
explicit way to refresh the platform-specific app verification used to decide
whether deeplinking can reach the installed app. Users currently have to infer
this from the device/build state.

## Users & success criteria

- A developer can select an Android or iOS device and refresh deeplink
  verification from Mobile Dev.
- The result clearly identifies whether the app is installed and shows its
  resolved Android package name or iOS bundle identifier.
- Android and iOS use their existing status IPC contracts; no new native
  command or persistence is needed.
- A failed probe is shown as an error and never presented as verified.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Mobile Dev owns device selection and app actions | `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx` |
| Android status already resolves installation and package identity | `mobilePreview:getAndroidAppStatus` in `electron/ipc/handlers.ts` |
| iOS status already resolves installation and bundle identity | `mobilePreview:getIosAppStatus` in `electron/ipc/handlers.ts` |
| Platform-specific status calls already power the full preview pane | `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx` |

## Decisions

- “Verify” means refresh the installed-app status probe, not launch a deeplink.
- The selected device’s platform determines the status IPC call.
- Verification is local component state; it is not persisted or added to the
  shared device store because it is transient and device-specific.
- The button is disabled until a device is selected and booted/connected.

## Architecture

```text
MobileDevPane
  ├─ selected device + project config
  ├─ Verify button / loading / notice
  └─ verifyDeeplinkOnDevice()
       ├─ Android → getAndroidAppStatus(project, task, native path, device)
       └─ iOS     → getIosAppStatus(project, task, app path, device, requestId)
```

## Interfaces

```ts
type DeeplinkVerificationResult =
  | { platform: 'android'; appInstalled: boolean | null; appId: string | null }
  | { platform: 'ios'; appInstalled: boolean | null; appId: string | null }

verifyDeeplinkOnDevice({
  api,
  device,
  projectId,
  taskId,
  appPath,
  androidProjectPath,
}): Promise<DeeplinkVerificationResult>
```

The utility calls the existing typed API methods and leaves errors to the
caller, which formats them with the existing device error summarizer.

## State and error handling

- `isVerifyingDeeplink` prevents overlapping probes and drives the spinner.
- `deeplinkVerificationNotice` is cleared when the device changes or a new
  probe starts.
- `appInstalled === true` reports the package/bundle ID as verified.
- `appInstalled === false` reports that the app is not installed.
- `appInstalled === null` reports that installation could not be determined.
- Probe failures go to the existing toast path.

## Test strategy

- Unit-test the shared utility for Android and iOS parameter selection and
  result normalization.
- Run the Mobile Dev pane tests, then the repository-required test, type-check,
  and lint commands.

## Rollout

No migration, feature flag, or new IPC route. Removing the button and utility
fully reverts the feature.
