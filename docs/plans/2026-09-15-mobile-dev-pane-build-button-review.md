# Mobile Dev Pane Build Button — Review

Date: 2026-09-15

Scope: uncommitted working diff only (branch is level with `main`). No design or
plan artifact exists for this change, so round 2 covered repo conventions only.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | Start a build on iPhone, switch to Pixel while it runs: the log box goes blank, the status dot reads stopped, the button offers "Build" (starting a *second* build), and Clear/⌘K resets the Pixel's never-started stream while the iOS output keeps accumulating out of reach. Same on Metro stop, which clears the device selection. | The log selector was a bare `'metro' \| 'build'` enum, but build command ids are device-scoped (`getMobileBuildCommandId` embeds `deviceId`). A flag cannot name *which* build is being watched, so every derived value silently re-pointed at whatever device happened to be selected. | Store the watched **command id** (tagged with its task) instead of an enum; `logCommandId`, the tab state, Clear and the log box's `isRunning` all follow the watched build, not the current selection. | `mobile-dev-pane/index.tsx` |
| 2 | Medium | A build that finished successfully renders the identical grey dot as a device that was never built. | The runner's `CommandStatus` is only `'running' \| 'stopped' \| 'errored'` and `run-command-service.ts:1100` maps exit 0 to `'stopped'` — the same value a never-run command's *absent* entry falls through to. My dot collapsed both into `'stopped'`. The preview pane normalizes `stopped → completed`; the new code did not. | Derive a `buildOutcome` (`building`/`built`/`failed`/`none`) that distinguishes "has a status entry" from "has none", and label it in words next to the dot. | `mobile-dev-pane/index.tsx` |
| 3 | Low | A whitespace-only `iosBuildCommand` in project settings reported "No iOS build command is configured" even when a perfectly good detected command existed. | Precedence was resolved with `??` *before* validation, so `"   "` won the fallback chain and then failed the trim check. Settings normalize an emptied field to `null` but not to whitespace. | `firstUsableCommand` validates each candidate before choosing it. | `utils-build-command.ts` |
| 4 | Low | Clicking Build when no command is configured expanded the log panel onto an empty build stream without starting anything. | `setLogSource`/`setLogsExpanded` ran before the `!build.command` guard. | Guards moved above all UI state mutation. | `mobile-dev-pane/index.tsx` |
| 5 | Doc | Comment claimed the build is "never the CLI's own default simulator" — untrue when the CLI cannot be recognized. | Comment written from the intended path, not the fallback path. | Comment now states the guarantee holds where the CLI is recognized, and points at `build.notice` otherwise. | `mobile-dev-pane/index.tsx` |

## Before / after

```
BEFORE — logSource is a flag; the stream follows the SELECTED device
  select iPhone ──▶ Build ──▶ logs: build:ios:IOS-1  (running)
  select Pixel  ─────────────▶ logs: build:android:AND-1  (empty, never started)
                               button: "Build"   dot: ● grey
                               Clear ─▶ resets the Pixel stream
                               iOS build: still running, invisible, unstoppable here

AFTER — the watched command id is sticky
  select iPhone ──▶ Build ──▶ watched = build:ios:IOS-1
  select Pixel  ─────────────▶ watched = build:ios:IOS-1  (unchanged)
                               logs: still the iOS build
                               Clear ─▶ resets the iOS stream
                               Metro tab ─▶ back to Metro; Build tab ─▶ back to it
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| Untargeted build (`simulator` / `unknown-command` / `device-not-running`) leaves the button enabled with no warning | Deliberate, shared behavior. `notApplied` documents "stay quiet for simulators, nag for real hardware", and the preview pane's disable predicate (`utils-setup-step-actions.ts:85-95`) checks no `reason` either — blocking only in the dev pane would create the divergence `utils-build-command.ts` explicitly forbids. Only the overstated comment was real (fix 5). |
| `{{device}}` inside user-written double quotes allows shell injection | Pre-existing path, untouched, and inert: the substituted value is `connectionId ?? id` — a simctl UUID, devicectl UDID, adb serial or `avdmanager`-constrained AVD name. The free-text `name` is never substituted. |
| `void startAdHocCommand(...)` swallows errors, unlike the rest of the file | The file's own `handleToggleDevServer` and every run-command toggle in the preview pane do exactly this. `handleReload`/`handleRestartApp` catch because they call raw device IPC — a different class. Consistent, not a regression. |
| Clicking Build before the status snapshot loads kills an in-flight build | Real mechanism, but the preview pane uses the identical `buildStatus?.status === 'running'` predicate on its click path; its `runCommands.status === null` check only feeds a setup banner. Pre-existing and symmetric. |
| Metro stop orphans a running build permanently | PLAUSIBLE, not confirmed: re-selecting the same device recomputes the identical command id and the build reappears with a working Stop. Fix 1 removes the log/Clear half of it; run commands are independent processes, so nothing is killed. |

## Decided (were parked)

| Finding | Decision |
| --- | --- |
| A build running for a device other than the selected one cannot be stopped from this pane. | **Keep the button scoped to the selection, and block it outright when no device is selected.** Made explicit rather than incidental: the disabled predicate now leads with `!activeDeviceKey`, `handleToggleBuild` guards on `!activeDevice` before anything else, and a test pins it. Recovery for the other-device build is re-selecting it, the preview pane, or the run-commands overlay. |
| Both panes share one build command id, and `startAdHocCommand` hard-restarts a running id and wipes its logs. | **Accepted as-is.** The shared id is the point — one build, one status, one log stream, whichever pane you drive it from. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| Dev pane falls back to `detectedApps[0]` with no disambiguation, while the preview pane blocks on `needsAppSelection`. In a monorepo with two undetected-selection apps, Build targets app #0. | Pre-existing in `utils-app-path.ts`; the build button makes it more consequential, but fixing it changes app-selection behavior for the whole pane. |
| Dev pane never reads `runCommands.portsInUseError`, so a Metro port conflict is silent here. | Pre-existing, Metro-only; builds use `ports: []`. |
| `appPath` is concatenated into a cwd with no traversal check. | Config-controlled, pre-existing, shared with the preview pane. |

## Verification

- `pnpm vitest run src/features/task/ui-task-panel/mobile-dev-pane` → 12 files, 76 tests passed.
- Mutation check: reverting `logCommandId` to the device-scoped form fails the new
  regression test (`keeps clearing the watched build log after the device
  selection changes`) — the test catches the bug it was written for.
- `pnpm test` → 446 files, 5760 passed, 1 skipped. (One run showed a flake in
  `ui-pr-run-control/index.test.ts`; it passes in isolation and on a stashed
  clean tree, and the full suite is green on re-run.)
- `pnpm ts-check` → clean. `pnpm lint` → clean.
