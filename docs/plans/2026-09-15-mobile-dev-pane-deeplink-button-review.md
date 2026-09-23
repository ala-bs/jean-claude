# Mobile Dev Pane — Deeplink Button — Review

Date: 2026-09-15

Scope: uncommitted working diff only (branch has no commits vs `main`). No design/plan
artifact exists for this change, so round 2 was conventions-conformance only.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | Submitting a deeplink while a Restart is in flight kills the dev client (SIGSEGV) — the exact hazard the Reload button guards against | The new button's `disabled` expression was copied from **Restart** (`!activeDeviceKey \|\| !isActiveDeviceBooted \|\| isReloading`) rather than **Reload**. That expression is correct for Restart, which is itself the thing setting `restartingDeviceKey` and has its own re-entrancy guard, so the missing `restartingDeviceKey !== null` term is invisible when read next to its neighbour | Added `restartingDeviceKey !== null` to `disabled` + a matching `disabledReason`, plus a handler-level guard in `handleOpenDeeplink` (the trigger's disabled state does not gate an already-open menu) | `mobile-dev-pane/index.tsx` |
| 2 | Medium | Dismissing the dropdown while a deeplink is in flight makes it pop back open on resolve and steal keyboard focus | `Dropdown` exposes only `toggle()` — an unconditional flip (`return !wasOpen`), with no `close()` and no `onClose`. The post-await close assumed toggle meant "close" | Track menu mount state with a `MenuOpenTracker` child (the menu's children unmount on close) and only `toggle()` while genuinely open | `ui-deeplink-button/index.tsx` |
| 3 | Low | Reopening the dropdown shows the previous failure's red error as if it just happened | `error` was only cleared on input change and on submit; `DeeplinkButton` stays mounted when the menu closes, so the state survives the close/reopen cycle | `onOpen={() => setError(null)}` | `ui-deeplink-button/index.tsx` |
| 4 | Low | `normalizeUrls` — the only sanitizer between untrusted localStorage and the rendered list — had zero tests | Tests were written against the store's public actions only; the rehydration path is reached through `persist`'s `merge`, not through any action, so action-level tests can't touch it | Exported `normalizeUrls` and added 3 tests (corrupt payloads, non-string/blank entries, pre-persisted duplicates + over-cap) | `mobile-dev-deeplinks.{ts,test.ts}` |

## Before / after

```
BEFORE — restart window is unguarded for Deeplink
  [Restart clicked] ──> restartingDeviceKey = A
        │
        ├─ Reload    : disabled ✓ (restartingDeviceKey !== null)
        └─ Deeplink  : ENABLED ✗ ──> openDeeplink ──> app mid-relaunch ──> SIGSEGV

AFTER
        ├─ Reload    : disabled ✓
        └─ Deeplink  : disabled ✓  "Wait for the restart to finish"
                        └─ + handler guard, for a menu already open


BEFORE — toggle() on a closed menu re-opens it
  submit ──> await IPC ─────────────(user presses Esc: menu closes)────> toggle() ──> RE-OPENS ✗

AFTER
  submit ──> await IPC ─────────────(user presses Esc: children unmount,
                                     openRef = false)──> if(openRef) … ──> no-op ✓
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| `handleOpenDeeplink` lacks the `isDeviceSelectionSwitched` guard its siblings use | Premise false: `handleReload` has no such guard either. The guard exists for *deictic* notices (`"${label} restarted"`); the deeplink notice names the device explicitly (`Opened ${url} on ${activeDevice.name}.`), which stays true after a switch. Separately, mousing to the combobox closes the dropdown on `mousedown` via `RootOverlay`, so the switch isn't reachable mid-flight |
| `isOpening` re-entrancy guard reads render state, so two submits could double-fire | Both entry points are `disabled={… \|\| isOpening}`, and React 18 flushes each discrete event synchronously — the second event cannot observe `isOpening === false`. Key auto-repeat produces separate discrete events, not a batch |
| Shell injection via the URL | `runCommand` uses `spawn(command, args)` with no `shell: true`, and both adapters pass argv arrays. No host-side interpolation |
| Deeplink URLs with auth tokens persisted unencrypted to localStorage | Not a regression: `src/stores/mobile-preview-deep-links.ts` already does exactly this. An attacker with localStorage read access already has full `api.*` IPC access |
| Long device-tooling error dumps blow out the `w-72` dropdown | `summarizeDeviceActionError` keeps the first non-empty line and caps at 200 chars; the `<p>` uses `break-words` |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| Two deeplink history stores now exist: the new global `mobile-dev-deeplinks` and the pre-existing per-project `mobile-preview-deep-links` (used by the mobile **preview** pane, with pinning). They never share entries | (a) Keep them separate — you explicitly asked for *global* history, and the preview pane's per-project + pinned model is a different product shape. (b) Unify on one store, which means changing the preview pane's scoping or the new pane's | Keep separate for now; unifying changes persisted data shape for an existing feature, which is outside this change's blast radius |
| Keyboard-only users cannot reach the history list or the per-entry remove "✕" | Focus starts in the input; Dropdown's arrow bindings are `ignoreIfInput: true`, so `focusedIndex` never leaves `-1`. Fixing properly needs either arrow-key handling inside the input or a change to the shared `Dropdown` | Worth a follow-up if keyboard-first use matters to you; I did not touch shared `Dropdown` |
| Tab-then-Enter on the "Open" button does nothing (mouse click works) | `RootKeyboardBindings` listens in **capture** phase and `preventDefault()`s when a handler returns `true`; Dropdown's `enter` handler returns `true` even at `focusedIndex === -1`, cancelling the implicit form submit. Not interceptable from inside my component | Real but the fix belongs in shared `Dropdown` (return `false` when nothing is focused) — a behavior change for every dropdown in the app, so I parked it |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| `throw new Error(summarizeDeviceActionError(error))` drops the original error (no `cause`) | Cosmetic; `summarizeDeviceActionError`→`cleanIpcError` already produces a readable message for non-Error rejections |
| `assertDeeplinkUrl` only checks `new URL()` parses and `protocol !== 'file:'`; on Android the URL reaches the **device's** shell via `adb shell am start`, so `myapp://x;reboot` executes on the emulator | Pre-existing main-process code this diff only reaches. The "attacker" is the developer typing into their own dev tool |
| `clear()` on the new store is exported but unused | Reasonable store API surface |

## Verification

```
pnpm ts-check                                   → clean (both tsconfigs)
pnpm lint                                       → clean (oxlint, 0 warnings)
pnpm vitest run src/stores/mobile-dev-deeplinks.test.ts
                                                → 8 passed
pnpm test                                       → 5774 passed, 1 failed, 1 skipped
```

The single failure is `electron/database/migrations/078_pr_workspace_support.test.ts`
(`client.setAuthorizer is not a function`). Confirmed **pre-existing**: re-run with this
change stashed (`git stash -u`) and it still fails 1/8. Unrelated to this diff.
