# Codex Server Interactions — Review
Date: 2026-09-20

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
|---|---|---|---|---|---|
| 1 | Medium | A steered prompt appeared twice in the message stream. | `turn/steer` emitted a locally synthetic user prompt, and the Codex app-server then emitted the authoritative `item/started` `userMessage` for the same prompt. The following `item/completed` event was only the completion of that same item. | Removed the synthetic Codex entry and rely on the protocol `userMessage` event. Added a regression test covering the real notification path. | `electron/services/agent-backends/codex/codex-backend.ts:299`, `electron/services/agent-backends/codex/codex-backend.test.ts:190` |

## Before / after

```text
Before:
  renderer steer
       │
       ├── local synthetic user-prompt ──► visible prompt #1
       └── turn/steer
              └── item/started userMessage ──► visible prompt #2
                    └── item/completed ──► same item completed

After:
  renderer steer
       │
       └── turn/steer
              └── item/started userMessage ──► one visible prompt
                    └── item/completed ──► same item completed
```

## Guideline violations

No `docs/guidelines/` tree exists, so no guideline pass was applicable.

| Rule | File:line | What breaks it | Fixed / parked |
|---|---|---|---|
| None | — | — | — |

## Guideline candidates

| Proposed rule (imperative) | Area | Evidence it recurred |
|---|---|---|
| Do not synthesize a protocol-backed user prompt when the backend emits an authoritative user-message item. | Agent protocol integration | This review found a synthetic Codex steer entry duplicating a real app-server user-message event. |

## Refuted findings

| Claim | Why it was not a bug |
|---|---|
| `wait` was sent twice because both `item/started` and `item/completed` were present. | Both notifications carried the same Codex item identity; completion is the lifecycle end of the started item, not a second user submission. |
| Removing the synthetic entry means the steer disappears. | The attached mapping contains a real `item/started` `userMessage`, and the regression test confirms it is normalized into the visible user prompt. |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
|---|---|---|
| Codex questions marked `isSecret` are not masked by the shared question UI. | Preserve the existing question control, or introduce a secret-input field across the shared question contract and UI. | Keep parked as a separate UI contract change. |

## Not fixed (noted only)

- The full suite still has one unrelated SSH-agent failure because the sandbox cannot bind the real SSH agent socket. The Codex backend suite passes.

## Verification

- Codex backend tests: **35 passed**.
- Full suite: **6013 passed, 5 skipped, 1 unrelated environment failure**.
- TypeScript check: **passed**.
- Lint: **passed with existing import-order warnings**.
- `git diff --check`: **passed**.
