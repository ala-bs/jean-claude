# Mobile dev pane — Reload re-attaches to Metro — Review

Date: 2026-09-15

Scope: uncommitted changes only (`HEAD` == `git merge-base HEAD main`). No
design/plan artifact exists for this change, so round 2 was limited to repo
conventions (`AGENTS.md`).

Files under review:

- `src/features/task/ui-task-panel/mobile-dev-pane/utils-reload-app.ts` (new)
- `src/features/task/ui-task-panel/mobile-dev-pane/utils-reload-app.test.ts` (new)
- `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx` (`handleReload` + the
  Reload/Restart buttons)

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | Click Restart, then click Reload during the relaunch → app dies with `SIGSEGV` in `jsi::Object::~Object` ~2s after launch; the restart then also reports a bogus re-attach timeout. | The new reload path deeplinks whenever the peer count is 0. Its doc comment justified skipping the startup wait with "the app was never killed" — true only if Reload runs alone. Neither button gated on the other's in-flight state (`disabled={!devServerRunning}` vs `disabled={!activeDeviceKey \|\| !isActiveDeviceBooted}`), so the 8s `RESTART_REATTACH_WAIT_MS` window was clickable, and during it the app is killed-and-booting, i.e. legitimately 0 peers. | Early-return guard `if (isReloading \|\| restartingDeviceKey !== null) return;` in `handleReload`, plus mutual `disabled`/`title` gating on both buttons. | `index.tsx` |
| 2 | Medium | Selected simulator is shut down → Reload shows the raw `Unable to lookup in current state: Shutdown` from `xcrun simctl openurl` instead of the actionable no-client message. | `resolveRestartReattach` checks `isExpoApp`, `hasLiveDevServerPort` and physical-iOS but never boot state — it never had to, because the Restart button already guarantees `isActiveDeviceBooted`. Reload's button only gates on the dev server, so it fed an unusable device into the shared gate. Nothing in the `launchExpo` → `openDeeplink` path boots the device (`grep ensureDeviceBooted electron/services/` → no hits). | Gate the reattach on `activeDevice && isActiveDeviceBooted` at the call site, so the path falls back to the existing no-client message. | `index.tsx` |
| 3 | Medium | Green notice "App re-attached to Metro on :N **and reloaded**." shown when the app cold-started and redboxed, or never came up at all. | `launchExpo` resolves as soon as `deps.openDeeplink` returns — `simctl openurl` / `am start` reporting the OS accepted the URL. It verifies no peer state. (`/_expo/open` and `connectRetryWindowMs` are host-side Metro HTTP, not device evidence.) The sibling restart path only claims success after `waitForMetroClient` observed a new peer id; the reload path copied the wording without the evidence. | Downgrade to what is proven: `Re-pointed the app at Metro on :N.` | `index.tsx` |
| 4 | Low | "…and re-attaching **this device** failed" can read against a simulator that was never touched. | The deeplink is slow and the device `Combobox` is never disabled, so the selection can move before the toast lands. `handleRestartApp`/`handleBootDevice` solve this with `isDeviceSelectionSwitched`; `handleReload` kept the old reload-era shape, where nothing was device-scoped. | Capture `activeDevice?.name` before the await and name the device in the toast. | `index.tsx` |
| 5 | Low | A `reloadExpo` rejection could be silently reclassified as `no-client` by a future edit, turning "Metro unreachable" into "open the app and try again". | The awaited `reloadExpo` sits outside any `try` deliberately, but nothing pinned that. | Added a test asserting the rejection propagates and `launchExpo` is not called. Also added the missing `not.toHaveBeenCalled()` on the `device: null` case. | `utils-reload-app.test.ts` |

## Before / after

```
BEFORE this review — both buttons independently enabled

  Restart ──kill app──> [ app booting, 0 peers, 8s window ] ──waitForMetroClient──> …
                               ▲
  Reload  ─────────────────────┘  peers==0 → launchExpo deeplink → SIGSEGV 💥

AFTER

  Restart in flight ──> Reload disabled ("Wait for the restart to finish")
  Reload  in flight ──> Restart disabled ("Wait for the reload to finish")
                        + early-return guard, since a device switch re-enables
```

```
Reload, peers == 0

  device not booted ─────────> no-client toast ("Restart, or Build & Run")   [fix 2]
  device booted + deeplinkable
        └─ launchExpo ok ────> "Re-pointed the app at Metro on :N."          [fix 3]
        └─ launchExpo throws ─> "…re-attaching <device name> failed: …"      [fix 4]
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| `effectiveDevServerPort` falls back to the *configured* port while `hasLiveDevServerPort` stays true, so `launchExpo`'s exact-port guard throws. | `run-command-service.ts:119-126` returns `[allocatedPort]` for a conflict-allocated port, and the port-learning path at `:1068-1070` *replaces* rather than empties `ports`. A running dev-server command always carries its port. `ports: []` only occurs for a command declaring no ports, where the configured port is the only one that ever existed. Also **pre-existing**: Restart already passed the identical `effectiveDevServerPort` through the identical gate. |
| Test gap: `metroPort` and `reattach.metroPort` are the same value in every test, so a regression to the broadcast port would go unnoticed. | The two are literally the same expression at the sole production call site (`index.tsx` passes `effectiveDevServerPort` to both), so the hypothesised regression has no observable effect. The cited contrast with `utils-restart-app.test.ts` is also false — `restartAppOnDevice` has no top-level `metroPort` parameter for its `8082` to differ from. |
| Reload's deeplink supersedes the mobile-preview pane's auto-launch (shared `${platform}\0${deviceId}` owner key) and paints a spurious error in both panes. | The two are route-exclusive: `MobileDevPane` mounts only at `ui-task-panel/index.tsx:3371` under `visibleRightPane?.type === 'mobileDev'`; `useMobilePreviewExpoLaunch` has one non-test caller, reached only via `/all/mobile/$taskId`. They never render in the same tree. The owner-key supersede logic is real but unreachable from here. |
| Double-click re-entrancy on Reload itself. | `Button` sets `disabled={disabled \|\| isLoading}` and `setIsReloading(true)` is synchronous. (Guarded anyway now, as a side effect of fix 1.) |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| Should Reload *verify* the re-attach rather than just report it? Fix 3 makes the message honest; it does not make the outcome confirmed. | (a) Report what is proven and return immediately — current. (b) Mirror the restart path: `waitForMetroClient` after the deeplink, then say "reloaded" or warn on timeout. (b) is more truthful but adds a multi-second wait to a button labelled "Reload", and picking the timeout budget is a product call. | Ship (a); move to (b) if the notice turns out to be wrong in practice. |
| The **mobile preview pane** (`mobile-preview-pane/use-mobile-preview-actions.ts:123-139`) still has the un-repaired path: `reloadExpo` → `connectedClients === 0` → hard error. Same user action, same root cause, now two different behaviors. | (a) Leave divergent. (b) Port `reloadAppOnMetro` over — it is pane-agnostic and that hook already has `platform`, `deviceId`, `metroPort`, `projectId`; it would need `taskId`, `appPath` and an `isExpoApp`/live-port gate. | Unify (b) — but it widens this diff into a second pane, so it is your call. |
| Metro port allocation hands out ephemeral high ports (`getAvailablePort()` = `listen(0)` → `:49801`). This is the upstream cause of the original bug report. | (a) Keep ephemeral. (b) Walk `8082, 8083, …` so ports stay in the recognisable Metro range. | (b), as a separate change. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| A **live** app can still sample `connectedClients === 0` if its dev-client socket rebuild exceeds `DEV_CLIENT_RECONNECT_GRACE_MS = 1_000`, in which case Reload now hard-reloads (deeplinks) it rather than just showing a toast. The 1s figure is extrapolated — the repo's sweep only exercises up to `reconnectAfterMs: 200`, and there is **no Android-specific measurement at all** (the cited mechanism, `RCTPackagerConnection+EXDevLauncherPackagerConnectionInterceptor`, is iOS-flavoured). | Inherent to the repair the change exists to provide, and unquantified on Android. Raising the grace window is a tuning decision, not a defect fix. Related to the first parked item. |
| The reload deeplink never updates `completedLaunchOwnerKeys` (`mobile-preview-expo-launch-store.ts:10-22`), which the preview workspace consults via `hasCompletedExpoLaunch` for the same owner key. | Consequence not traced; the two panes are route-exclusive so there is no confirmed failure. Pre-existing store design. |
| `createReloadLaunchRequestId` duplicates `createRestartLaunchRequestId` and `use-mobile-preview-expo-launch`'s `createRequestId` — a load-bearing uniqueness invariant now asserted in three places. | Pure duplication, no failure scenario. A shared `utils-launch-request-id.ts` taking a prefix would be a tidy follow-up. |
| The no-client message says "Restart, or Build & Run", but after fix 2 the non-booted device reaches it with the Restart button disabled (Boot first). | Pre-existing wording; fix 2 restores the message that state always produced before this change. |
| `src/lib/api.ts:2922` stubs `reloadExpo: async () => ({ connectedClients: -1 })` for the non-Electron fallback, so the deeplink path is unreachable there. | Benign and correct — `-1` means "count unavailable", which must not trigger a repair. |

## Verification

```
pnpm vitest run src/features/task/ui-task-panel/mobile-dev-pane
  → 11 files, 75 tests passed (8 in utils-reload-app.test.ts)
pnpm ts-check   → clean (tsconfig.web.json + tsconfig.node.json)
pnpm lint       → clean (oxlint)
pnpm test       → 446 files passed | 1 skipped, 5766 tests passed | 1 skipped
                  0 failures
```

Note on earlier runs: before these review fixes, two full-suite runs of the same
tree reported different failure sets (6 files/13 tests, then 3 files/4 tests) in
`merge-conflict-tracker`, `ui-changelog-modal` and `ui-pr-run-control` — none of
which import anything under `mobile-dev-pane/`. They passed 57/57 in isolation,
and the final full run above is clean, confirming they were load-dependent
flakes rather than anything caused by this diff.

Live diagnosis that motivated the original change (measured, not inferred):

```
:8081   getpeers = { "socket#39": "role=ios", "socket#40": null }   app attached here
:49801  getpeers = { "socket#6": null }                            pane's Metro, empty
```
