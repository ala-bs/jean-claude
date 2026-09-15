# Mobile dev pane — Start triggers the open-app deeplink — Review

Date: 2026-09-15

Scope: uncommitted working diff only (branch HEAD equals `main` merge-base
`cf5043c4`). Files: `mobile-dev-pane/index.tsx`, new `utils-start-launch.ts` and
`utils-start-launch.test.ts`. No design/plan artifact exists for this change, so
round 2 was a repo-convention check only.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | Critical | Restart (or Reload) is clickable while Start's deeplink is still in flight; pressing it can SIGSEGV the dev client — the documented crash in `restartAppOnDevice` where the bundle URL is swapped while the first bundle is still loading. | Reload/Restart gate on `isReloading` and `restartingDeviceKey`. The new Start launch was the only deeplink path that published no in-flight state at all, so the pre-existing mutual-exclusion scheme could not see it. | Added `startLaunchingDeviceKey` state, set (via `queueMicrotask`, to satisfy the React-compiler no-sync-setState-in-effect rule) before `launchExpo` and cleared in `.finally`, keyed by device; both buttons now also gate on it with a "Wait for the app to open" title. | `index.tsx` |
| 2 | High | Press Start on a cold-opened pane with a persisted device: Metro starts, the app never opens, and nothing says why — Start behaves exactly like the old build. | `activeDevice` is derived by matching the persisted selection against the device-list query, so it is `null` both for "nothing selected" and for "list still loading". `resolveStartLaunchDecision` collapsed both into `skip`, and the pending flag is cleared before the skip check, so there is no retry once the devices arrive. | Added an `isLoadingDevices` input returning `waiting`, mirroring the preview pane's auto-launch ("Restoring device selection"). `isLoading` goes false on query error too, so this cannot stick. | `utils-start-launch.ts` |
| 3 | Medium | A deeplink fires later that the user never asked for in this pane. | The pending flag was cleared only by `.catch()`, but `runStart` **resolves** `{started:false}` on a ports-in-use conflict and when superseded — it rejects only on a hard error. The flag stayed armed, and `devServerCommandId` is shared with the mobile preview pane, so that pane starting the same command later flipped `hasLiveDevServerPort` and fired the stale launch. | Consume the resolved value: `if (!started) isStartLaunchPendingRef.current = false;` | `index.tsx` |

## Before / after

```
BEFORE this review's fixes
[Start] ──> Metro live ──> launchExpo ─────────────> app cold-starting
                             (invisible to the UI)      ▲
   user clicks [Restart] ─── enabled! ── kill+relaunch ──┘   ← SIGSEGV window

   devices still loading ──> activeDevice=null ──> skip ──> flag cleared, never retried
   port conflict ─────────> resolves {started:false} ──> flag stays armed forever

AFTER
[Start] ──> Metro live ──> devices loaded? ──no──> wait (retry on next render)
                                 │yes
                                 ├─ no device / not booted / bare RN / iOS hw ──> skip
                                 └─ launchExpo ──> [Reload][Restart] disabled
                                                    until it settles (per device)
   port conflict ──> {started:false} ──> flag cleared
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| The new effect has no cleanup: no `active` flag and no `cancelExpoLaunch`, unlike `useMobilePreviewExpoLaunch` — so closing the pane mid-launch leaks a toast and an uncancelled launch. | The identical shape is the established pattern in this very file: pre-existing `handleReload` (`:523`) and `handleRestartApp` (`:629`) also guard only with `isDeviceSelectionSwitched(...)`, never with an unmount flag. React 19 makes post-unmount `setState` a silent no-op; only the global-store toast is visible, and that is pre-existing behavior for every async action here. Not a regression introduced by this diff. |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| Start with a **shut-down** selected device silently skips the deeplink. | (a) Skip quietly — Start means "start Metro", booting someone's device is a separate deliberate click (matches `canAutoStartMobilePreviewDevice`, which refuses to auto-boot). (b) Boot the device, then deeplink — "Start" means "run the app". | Keep (a) for physical hardware regardless; (b) is defensible for simulators/emulators but is a product call and would widen this change into the boot flow. Currently (a). |
| A skipped launch is silent — no inline notice explains why nothing opened. | (a) Stay silent. (b) Show `actionNotice` copy per skip reason (no device / not booted / bare RN). | (b) is a small copy addition and would make the parked item above much less confusing, but the wording is yours. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| `resolveStartLaunchDecision` checks `isDeviceBooted` but not `isDeviceUnavailable` (`index.tsx:234`), so a booted-but-unavailable device could still be deeplinked. | Pre-existing: `resolveRestartReattach` has exactly the same gap on the restart/reload paths. Fixing it belongs in that shared helper, outside this diff's blast radius. |
| `078_pr_workspace_support.test.ts` fails with `client.setAuthorizer is not a function`. | Pre-existing — verified failing with this change stashed. better-sqlite3 version drift, unrelated to this diff. |

## Verification

- `pnpm vitest run src/features/task/ui-task-panel/mobile-dev-pane` — 12 files, **83 passed** (7 → 8 tests in `utils-start-launch.test.ts`; added the device-list-loading case).
- `pnpm test` — 446 passed, **1 failed**: `078_pr_workspace_support`. Re-run with `git stash -u`: still fails → pre-existing, not caused by this change.
- `pnpm ts-check` — clean (both web and node projects).
- `pnpm lint` — clean, no warnings.
- `git diff` re-read after fixing: every row above verified present on disk
  (`isStartLaunchingActiveDevice` at `index.tsx:797,1041,1049,1068,1078`;
  `isLoadingDevices` at `utils-start-launch.ts:46,56,71`; `if (!started)` at
  `index.tsx:519`).
