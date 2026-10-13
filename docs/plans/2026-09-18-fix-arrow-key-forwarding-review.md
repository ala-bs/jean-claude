# Arrow Key Forwarding - Review
Date: 2026-09-18

## Fixes
| # | Severity | Symptom | Root cause | Fix | File |
|---|---|---|---|---|---|
| 1 | Medium | Arrow navigation stopped working after command exit while log kept focus | Stopped interactive logs remained classified as input, while log handler returned without forwarding keys | Expose input marker only while command is running | `src/features/common/interactive-log/index.tsx` |

## Before / after
```text
Before:
Arrow -> capture binding sees log as input -> skips overlay navigation
      -> stopped log handler returns -> no action

After:
Running log: Arrow -> capture binding skips -> InteractiveLog forwards to PTY
Stopped log: Arrow -> capture binding handles -> overlay selects command
```

## Refuted findings
| Claim | Why it was not a bug |
|---|---|
| Modifier-specific arrow sequences are broken | Pre-existing conversion behavior, outside changed code |
| `sendInput` rejection is introduced | Forwarding and ignored promise predate this change |
| Broad terminal input/security behavior is introduced | Existing `InteractiveLog` already forwards printable and special keys |
| `event.target` can crash global handler | Pre-existing cast and access pattern, unrelated to selector change |

## Parked - needs your decision
| Finding | The two behaviors | Recommendation |
|---|---|---|
| None | - | - |

## Not fixed (noted only)
| Issue | Why deferred |
|---|---|
| No dedicated regression test for document capture ordering | Existing test infrastructure lacks direct keyboard-binding utility coverage; behavior verified through direct call-site review |

## Verification
- `pnpm install` passed
- `pnpm ts-check` passed
- `pnpm lint --fix` passed before review fix
- `pnpm lint` passed before review fix
- `pnpm test -- src/features/task/ui-task-panel/command-log-rendering.test.tsx`: 449 files passed, 1 unrelated failure in `electron/database/migrations/078_pr_workspace_support.test.ts` (`client.setAuthorizer is not a function`)
- Review rounds: correctness, conformance skipped because no design/plan artifact exists, adversarial verification completed
