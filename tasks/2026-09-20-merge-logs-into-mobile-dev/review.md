# Merge Command Logs into Mobile Dev pane — Review
Date: 2026-09-20

Scope: uncommitted working diff (branch has no commits vs `main`). No design/plan
artifact existed, so round 2a ran as a conventions pass against AGENTS.md. No
`docs/guidelines/` tree, so round 2b was skipped.

14 findings survived round 1 dedup. Round 3 ran one independent adversarial
verifier per finding (batches of 3) plus a risk-map spend. **7 were refuted**,
including all three of the highest-severity ones — the risk-map spend, not the
correctness lenses, found the real bugs.

## Fixes
| # | Severity | Symptom | Root cause | Fix | File |
|---|---|---|---|---|---|
| 1 | HIGH | Running a group whose member can't be stopped does nothing at all — no tab, no toast, no error | The change added "always leave a log line" markers to the single-command and ad-hoc paths but not the group path; the renderer resets every member's log *before* `startGroup`, so a silent early return leaves an empty log, and a tab is visible iff `lineCount > 0 \|\| isRunning` | Emit the existing `[could not stop the previous instance…]` marker per failing member | `electron/services/run-command-service.ts:1655` |
| 2 | HIGH | Running an all-hidden group is a silent no-op | Same omission; `validCommands.length === 0` returned a plain `RunStatus`, which the renderer reads as success | Emit the existing `[command "X" is hidden - not started]` marker per member | `electron/services/run-command-service.ts:1573` |
| 3 | MED | Group refused for a port conflict left no record of why | Same omission on the group ports branch, which returned `PortsInUseError` without logging | Emit the existing `formatPortsInUseLogLine` marker for blocking members | `electron/services/run-command-service.ts:1677` |
| 4 | MED | Command palette listed "Open Mobile Dev" twice | The bare Mobile Dev entry was gated only on `mobileDevPaneEnabled`, while the cmd+L entry renders the same label whenever `logsShortcutTargetsMobileDev`; the symmetric guard existed for Command Logs but was never applied to its twin | Gate on `mobileDevPaneEnabled && !logsShortcutTargetsMobileDev`; move the mobile keywords onto the cmd+L entry conditionally so search still finds it | `src/features/task/ui-task-panel/index.tsx:2313` |
| 5 | MED | Two builds on two same-platform devices render two tabs both labelled "iOS build", indistinguishable even by tooltip | Build tabs were named from platform alone, discarding the `deviceId` the command id already carries; builds declare no ports, so nothing else disambiguated | New shared `formatMobileBuildTabName` + `abbreviateDeviceId`; name from the parsed command id (the stream's own key) rather than from `activeDevice` | `command-logs-pane/command-log-tabs.ts:31`, `mobile-dev-pane/utils-log-tabs.ts` |
| 6 | LOW | `utils-` prefix convention violated | New utility module landed as `log-pane-focus.ts` while the same change correctly added `utils-log-tabs.ts` | `git mv` to `utils-log-pane-focus.ts`, importers updated | `command-logs-pane/utils-log-pane-focus.ts` |
| 7 | LOW | Exported helper took two positional strings — the easiest possible pair to transpose | AGENTS.md prefers a single object param; the helper mirrored the internal store action instead | `setMobileDevPaneSelectedLogTab({ taskId, commandId })` | `src/stores/mobile-dev-pane.ts` |
| 8 | LOW | Dead `devServerPort` plumbing, with a unit test asserting it | The tab rail reads ports only from `buildCommandPortsById(status)` (running commands only), never from `ProjectCommand.ports` | Removed the param, the field and the dead assertion | `mobile-dev-pane/utils-log-tabs.ts` |
| 9 | LOW | The generation rule that makes the whole marker feature work was duplicated in two places with nothing tying them together | The main-process test re-implemented the renderer's filter locally, so flipping `<` to `<=` in the store left the suite green | Extracted `acceptsRunCommandLogGeneration` into `shared/` (the only dir both tsconfig projects include); both store call sites and the tests now go through it | `shared/run-command-types.ts:370` |

## Before / after — the bug class that was half-fixed

```
single command / ad-hoc          group  (BEFORE)          group  (AFTER)
 ┌──────────────┐                ┌──────────────┐         ┌──────────────┐
 │ refuse       │                │ refuse       │         │ refuse       │
 │  ↓ marker    │                │  ↓ (nothing) │         │  ↓ marker    │
 │ log: 1 line  │                │ log: EMPTY   │         │ log: 1 line  │
 │ → tab shown  │                │ → NO TAB     │         │ → tab shown  │
 └──────────────┘                └──────────────┘         └──────────────┘
      ✓ readable                  ✗ silent no-op            ✓ readable
```
The renderer resets every member's log *before* `startGroup`, so any group path
returning without writing a line is indistinguishable from "nothing happened".

## Refuted findings
| Claim | Why it was not a bug |
|---|---|
| Throwing log subscriber aborts the exit handler, leaving the process permanently "running" | `flushLogBatches` already called `notifyLog` on this path pre-change, so no new hazard class; and the claimed race (window destroyed between `isDestroyed()` and `send`) cannot occur — both are in one synchronous expression on a single-threaded main process |
| Restart leaks the previous process's exit marker into the freshly-cleared log | `runStart` is stop → resetLogs → start; the old process exits during the awaited `stop`, so its marker carries the OLD generation and is dropped. Raised by one lens, cleared by two — settled against quoted code and a passing test |
| ⌘⇧U double-fires (AI Usage + restart) | The bindings context calls `stopPropagation()` in document-capture, so the pane's window-bubble listener never runs; the pane handler also bails on `event.defaultPrevented`. Two independent guards |
| `nodePty.spawn` throw still leaves no tab | Verifier empirically ran this repo's node-pty: a deleted cwd and a missing shell both spawn fine and exit non-zero, so the new exit marker covers them. The stated trigger is factually wrong |
| Crafted command name forges a fake `[process exited with code 0]` line | Mechanism real but unreachable: the name field is a single-line `<input>`, there is no import/clone path, and nothing parses the markers programmatically. Cosmetic at worst |
| Ports-in-use marker double-reports alongside the KillPorts modal | The stated scenario is impossible — mobile dev passes `availablePort`, so the port is never blocking. Where it does fire, the retry resets logs; the residue only survives on cancel, where an accurate record is defensible |
| Two `useRunCommands` instances desync | The panes are mutually exclusive branches on one discriminated union; the project panel uses a namespaced pseudo task id that can never collide |
| `restartCommand`'s empty-deps `useCallback` captures a stale `projectId` | Every mutable input goes through `useLatestRef`; `projectId` is unused on the restart path. Pre-existing and byte-identical to the old pane |
| Synthetic `\n` mangles output after CR-only progress spinners | Verifier ran the real parser: `.replace(/\r\n/g,'\n')` collapses the prepended newline, so the marker lands on its own line. Proven over 6 input sequences |
| `formatProcessExitLogLine` / `formatPortsInUseLogLine` are dead exports | Used in production at three call sites |

## Parked — needs your decision
| Finding | The two behaviors | Recommendation |
|---|---|---|
| A group stage skipped because an earlier stage failed, and members refused because a *sibling* blocked the group, still leave empty logs and no tab | (a) write a new marker like `[not started: another command in the group could not start]` / `[skipped: "test" exited 1]`, or (b) accept the toast as sufficient for cascade failures | Lean (a) for consistency with the markers just added — but it invents new user-facing copy and needs a call on which members get it, so it is yours |
| The Restart button advertises `⌘⇧U`, but `__root` binds ⌘⇧U to AI Usage and wins via capture-phase `stopPropagation` — the hint is dead | (a) remove the misleading `<Kbd>` hint, or (b) rebind restart to a free key | Pre-existing (the standalone pane shipped this) but now shown in a second pane. (a) is the honest minimum |

## Not fixed (noted only)
| Issue | Why deferred |
|---|---|
| Plain keystrokes reach Metro's stdin when the Mobile Dev pane background has focus (arrows/space no longer scroll) | Verified ACCEPTABLE: the guard set and `paneRef` key scope are byte-identical to the shipped standalone logs pane. Genuinely new only for the *Mobile Dev* pane. Harden by scoping the terminal branch to the log body if it annoys you |
| A build tab briefly reads `iOS build · ABCD1234…9F2C` then re-labels to `iOS build · iPhone 15` once the device list loads | Cosmetic, documented in `resolveDeviceLabel`; ids are the selection key, not names |
| `scripts/list-shortcuts.mjs --check` exits 1 | Pre-existing: identical report before and after this change (~25 legacy candidate collisions). It checks double-binding, not doc/code sync |
| The cmd+L doc label is fed to the generator by a comment, since the live label is a ternary | Works and the row is accurate, but silently degrades to `—` if anything pushes the comment >4 lines from `shortcut:` |
| 19 `pull-request` test failures + 7 ts-check errors seen mid-review | Not this change: two untracked paths deleted back in commit `4d96d1d4` were resurrected on disk by a subagent's mis-popped stash. Quarantined to `/tmp/jc-quarantine`; suite green after |

## Verification
- `pnpm test` → **463 test files passed, 1 skipped**; 0 failures.
- `pnpm ts-check` → clean (both `tsconfig.web.json` and `tsconfig.node.json`).
- `pnpm lint` → **0 errors** (only pre-existing repo-wide `sort-imports` warnings).
- `node scripts/list-shortcuts.mjs --write` → regenerated; doc now points at the
  correct line (`index.tsx:2365`) after fix 4 shifted it.
- Mutation-tested fix 9: flipping `>=` to `>` in `acceptsRunCommandLogGeneration`
  fails 14 marker tests; reverted, green.
- Every fix above was grep-confirmed present on disk after the final test run.
