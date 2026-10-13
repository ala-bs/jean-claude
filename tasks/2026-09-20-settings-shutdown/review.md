# Settings shutdown fix — Review
Date: 2026-09-20

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | Medium | Normal dev stop can leave storage flush/lock release to abrupt process teardown | `SIGINT`/`SIGTERM` did not explicitly enter Electron's awaited `before-quit` cleanup path | Route both signals through `app.quit()` and retain the existing flush and settle window | `electron/main.ts:711` |

## Before / after

```text
Before: Ctrl-C / TERM ──► process exits ──► Chromium flush/lock timing uncertain

After:  Ctrl-C / TERM ──► app.quit()
                         └► before-quit ─► flush ─► cleanup ─► settle ─► exit
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| A separate profile should be used for every worktree | This would reset localStorage per worktree and contradict the requirement to preserve shared settings. The profile-isolation attempt was removed. |
| Signal handlers need to delete stale `Local Storage/leveldb/LOCK` | The lock is kernel-managed; deleting the file would be unsafe and would not release an active lock. |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| Hard kills can still produce the protection toast | Keep the fail-closed guard and show the warning; or add a retry/recovery mechanism before surfacing it | Keep the guard, but reproduce with the diagnostics log before choosing recovery behavior. `SIGKILL` cannot run cleanup. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| Concurrent lock-skipping dev profiles can still contend | `dev:tmp`/`dev:symlink` intentionally use separate database-keyed profiles; changing that would alter their isolation contract. |

## Verification

- `pnpm install` passed.
- `pnpm test`: 6001 passed, 5 skipped; one SSH-agent integration test failed because the sandbox cannot bind an SSH-agent socket.
- `pnpm lint --fix` completed; existing import-order warnings remain.
- `pnpm ts-check` passed.
- `pnpm lint` completed with existing import-order warnings.
- `git diff --check` passed.
