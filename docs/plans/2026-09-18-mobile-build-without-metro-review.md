# Mobile Build Without Metro — Review
Date: 2026-09-18

## Fixes
| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | Medium | Custom build wrappers receive unsupported framework flags and can fail. | Stack metadata was treated as proof that every configured command accepts Expo or React Native CLI arguments. | Inject flags only for recognized CLI commands or package-manager script runners; leave opaque custom commands unchanged. | `src/features/task/ui-task-panel/mobile-dev-pane/utils-build-command.ts` |
| 2 | High | React Native command in mixed Expo/React Native app receives `--no-bundler`, which React Native does not accept. | Stack precedence selected Expo before inspecting actual command. | Command text now selects CLI flag first: React Native gets `--no-packager`; Expo gets `--no-bundler`. | `src/features/task/ui-task-panel/mobile-dev-pane/utils-build-command.ts` |
| 3 | Medium | Compound shell commands receive bundler flag after final command, so Expo still starts Metro. | Helper appended flag to entire shell string without checking command boundaries. | Skip bundler-flag injection for compound commands. | `src/features/task/ui-task-panel/mobile-dev-pane/utils-build-command.ts` |

## Before / after
```text
BEFORE
  stacks: [expo, react-native]
  command: npx react-native run-ios
      |
      +--> npx react-native run-ios --no-bundler   (wrong)

AFTER
  command identifies React Native
      |
      +--> npx react-native run-ios --no-packager  (correct)

  opaque wrapper / compound shell command
      |
      +--> unchanged; no unsupported flag injection
```

## Refuted findings
| Claim | Why it was not a bug |
| --- | --- |
| Build start failure leaves stale watched-build UI. | Existing `startAdHocCommand` handling owns command lifecycle; no new state or async path changed by this diff. No concrete regression found. |
| Existing no-bundler detection always duplicates flags. | Normal CLI output uses whitespace-delimited flags and is covered by test; unusual shell formatting remains outside supported command parsing. |

## Parked — needs your decision
| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| Compound commands still receive device selector from pre-existing `applyDeviceToBuildCommand`. | Preserve existing targeting behavior vs parse shell commands safely. | Defer; unrelated to Metro suppression and requires broader command parser change. |

## Not fixed (noted only)
| Issue | Why deferred |
| --- | --- |
| Leading, quoted, or `--no-bundler=value` forms are not recognized as existing flags. | Low-probability custom syntax; current supported command shapes use standard CLI flags. |

## Verification
- `pnpm install` — pass.
- `pnpm vitest run src/features/task/ui-task-panel/mobile-dev-pane/utils-build-command.test.ts src/features/task/ui-task-panel/mobile-dev-pane/build-button.test.tsx` — 13 passed.
- `pnpm ts-check` — pass.
- `pnpm lint --fix` — pass.
- `pnpm lint` — pass.
- `pnpm test` — 449 files passed, 1 skipped; unrelated failure in `electron/database/migrations/078_pr_workspace_support.test.ts` because `client.setAuthorizer` is unavailable.
