# Clear device on Metro stop — Review

Date: 2026-09-14

Scope: uncommitted working diff only (`src/features/task/ui-task-panel/mobile-dev-pane/index.tsx`). No design/plan artifact exists for this change, so Round 2 (conformance) was limited to repo conventions in AGENTS.md.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | Stop fails (IPC error, process ignores SIGTERM) → Metro still running, button still reads "Stop", but the device badge is gone and Boot/Restart are disabled with no error shown | The clear was applied optimistically before a fire-and-forget `stopCommand`. `useRunCommands.stopCommand` has `try/finally` with no `catch`, so it rethrows, and `devServerRunning` is derived from backend status — on failure the status stays `running` while local state had already been invalidated. Nothing rolls it back. | Clear only after the stop promise resolves: `stopCommand(id).then(() => selectDevice(null))` | mobile-dev-pane/index.tsx:463-476 |
| 2 | Medium | Click Boot (or Restart), then click Stop while it's in flight → a genuine boot/restart failure vanishes silently: no inline error, no toast, spinner just clears | `handleBootDevice`/`handleRestartApp` use `activeDeviceKeyRef.current !== capturedKey` to mean "user switched device, don't misattribute this result". Clearing the selection drives `activeDeviceKey` to `''` (no fallback in `utils-active-device.ts`), so the guard now also fires for "selection was emptied" — a state where there is no other device to misattribute to. | Extracted `isDeviceSelectionSwitched()`, which treats an empty selection as "not a switch" so results still surface | mobile-dev-pane/index.tsx:232-242, 452, 558, 574 |

## Before / after

```
BEFORE (finding 1)
  Stop clicked
     ├─ selectDevice(null) ──────► badge gone, Boot/Restart disabled
     └─ stopCommand() ──✗ rejects ─► status stays 'running', button says "Stop"
                                       └─► LIE: device cleared, Metro alive

AFTER
  Stop clicked
     └─ stopCommand()
           ├─ ✓ resolves ─► selectDevice(null) ─► badge gone   (truthful)
           └─ ✗ rejects  ─► selection intact, Metro still running, controls usable
```

```
BEFORE (finding 2)                    AFTER
  ref !== capturedKey ?                 ref !== '' && ref !== capturedKey ?
    ├ switched device  → drop           ├ switched device  → drop  (unchanged)
    └ selection empty  → drop  ✗        └ selection empty  → REPORT the error ✓
```

## Refuted findings

None — all three findings sent to independent verifiers came back CONFIRMED. (Two candidate concerns were dropped before verification: a re-render loop from the new `selectDevice` dep — refuted, it is a `useCallback` over a stable zustand action pulled by a primitive selector; and "an auto-select effect re-populates the cleared device, making the fix a no-op" — refuted, `selectDevice` has exactly two call sites and no effect repopulates it.)

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| **The same Metro command is stopped from three other places that don't clear the device** — `mobile-preview-pane/index.tsx:1495` (Stop) and `:1630` (Stop All), and `ui-running-commands-overlay/index.tsx:701`, all stop the identical `createMobileDevServerCommandId(appPath)` for the same task. Plus: Metro crashing (`status: 'errored'`), and app restart (selection is persisted to localStorage, run status is not). All leave a stale badge. | (a) Keep invalidating manually, and add the clear to each stop site. Cheap, but every future stop path can re-break it. (b) Make the badge *derived*: it renders only when the device is selected **and** that task's dev-server command is running. Correct by construction, but needs run-command status readable from the feed list — a new cross-feature data path. | (b), as a follow-up. The badge docstring currently claims it answers "which device is this task using", which (b) makes true for every exit path. I did not do it here: it's outside this diff's blast radius and changes what the badge means. |
| **Stopping Metro permanently forgets the device** — `selectDevice(null)` deletes the persisted entry, so a routine Stop/Start cycle forces re-picking from the combobox, and the "Loading devices… (iPhone 15)" anchor (`:640`) is lost too. Favorites survive, so favorited devices are one click back. | (a) Clear the selection (current behavior, literally what you asked for). (b) Keep the selection and hide the badge based on running state — i.e. option (b) above, which resolves both parks at once. | Same call as the park above. If you go with derived rendering, the destructive clear can be removed entirely. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| `void stopCommand(...)` still has no `.catch`, so a stop failure is an unhandled rejection with no toast (the overlay at `:701` does toast). | Pre-existing behavior, unchanged by this diff. Deliberately preserved rather than silently swallowed. |
| Narrow race: if the user picks a new device in the gap between clicking Stop and the stop resolving, the new pick is cleared. | Millisecond window, same behavior as the original diff, and self-correcting (re-pick). |

## Verification

- `pnpm test` → **5748 passed, 1 skipped, 0 failed** (444 files). One run mid-review showed 2 failures — `electron/services/merge-conflict-tracker.test.ts` and `electron/services/mobile-preview-process.test.ts`, both main-process tests untouched by this renderer-only diff. Re-ran in isolation: `pnpm vitest run` on both files → **26 passed**. Flaky under parallel load, not caused by this change.
- `pnpm ts-check` → clean (both `tsconfig.web.json` and `tsconfig.node.json`).
- `pnpm lint` → clean.
- `git diff` re-read after writing this report: every row's change is present on disk.
