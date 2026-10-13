# Boot Device on Metro Start - Review
Date: 2026-09-18

## Fixes
| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | Start could boot and start Metro multiple times after rapid clicks. | Start had no synchronous operation guard while boot awaited IPC. | Added ref-based re-entry guard; clear it on completion, failure, cancellation, or stale selection. | `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx` |
| 2 | High | Start could open newly selected device instead of device selected when Start was pressed. | Pending launch was stored as a boolean, so effect used current selection after async boot. | Bind pending launch to selected device key and clear it when selection changes. | `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx` |
| 3 | Medium | Start tried booting unavailable simulators. | Start boot condition did not apply existing unavailable-device guard used by Boot action. | Skip automatic boot when `unavailableReason` exists. | `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx` |

## Before / after
```text
Before: Start -> pending=true -> async boot -> effect reads current device -> launch
After:  Start -> pending=device A -> boot A -> verify A still selected -> launch A
                         \-> selection changes -> clear pending -> no stale launch
```

## Refuted findings
| Claim | Why it was not a bug |
| --- | --- |
| Start boots unavailable devices | `!isDeviceUnavailable` now blocks automatic boot. |

## Parked - needs your decision
| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| Stop while an already-started deeplink is in flight | Allow OS URL request to finish, or add cancellation support to launch IPC. | Defer; behavior predates this change and cancellation contract is broader than current fix. |

## Not fixed (noted only)
| Issue | Why deferred |
| --- | --- |
| Device refresh failure after successful boot can prevent Metro start. | `refetchDevices` currently refreshes both platforms as one operation; changing tolerance needs product/recovery decision and broader tests. |

## Verification
- `pnpm install` - pass
- `pnpm ts-check` - pass
- `pnpm lint --fix` - pass
- `pnpm lint` - pass
- `pnpm exec vitest run src/features/task/ui-task-panel/mobile-dev-pane/utils-start-launch.test.ts` - 8 passed
- Full `pnpm test` - 5807 passed, 1 skipped, 1 unrelated failure: `client.setAuthorizer is not a function` in `078_pr_workspace_support.test.ts`
