# Leave empty question option — Design
Date: 2026-11-05

## Problem
The ask-question form requires an answer to every required question. “Decide for me” sends a deferral to the agent, but users also need to explicitly leave an individual question unanswered.

## Users & success criteria
The user can select “Leave empty” for any question, submit the rest, and the agent sees that this question was intentionally left blank. The blank is not captured as a preference.

## Codebase findings
| Finding | Evidence |
| --- | --- |
| Question inputs and drafts are shared across text, single-choice, and multi-choice forms. | `src/features/agent/ui-question-options/index.tsx`, `src/stores/task-messages.ts` |
| The renderer and main process independently construct and validate canonical answers. | `src/features/agent/ui-question-options/question-response.ts`, `electron/services/agent-service.ts` |
| The MCP question broker requires nonempty answers by default and emits a text summary. | `electron/services/question-broker-service.ts` |

## Decisions
| # | Decision | Chosen | Why | Rejected alternative |
| --- | --- | --- | --- | --- |
| 1 | Represent an intentional blank | Empty answer plus `leftEmptyQuestionKeys` | Distinguishes a user choice from an accidentally missing required answer | Reuse “Decide for me,” which asks the agent to choose |
| 2 | Persist selection | Store a per-question flag in the question draft | Survives a form remount | Component-only state |
| 3 | Render the MCP result | Show `[left empty]` beside the question | Makes the omission explicit to the agent | Omit the question entirely, which could look accidental |

## In scope (v1)
Show “Leave empty” for all three input modes, including fixed-choice questions. Clear the answer, note, and attachments when selected. Clear the flag when the user enters another answer. Preserve question order for provider backends.

## Out of scope
Making questions optional by default. Third-party Codex elicitation schemas that cannot represent a blank do not show the new option.

## Constraints & dependencies
No schema migration. Existing response validation must still reject a missing required answer unless the explicit blank marker is present.

## Approach chosen (and rejected)
Use the existing question draft and response pipeline with one explicit marker. A UI-only sentinel string would be simpler but would turn an unanswered question into a misleading answer.

## Architecture
```text
Question UI -> draft flag -> response builder -> main validation
                                         |             |
                                         |             +-> provider answer: empty string
                                         +-> MCP broker -> “[left empty]” summary
```

## Data flow
1. Selecting “Leave empty” clears that question’s answer, note, and attachments, and sets its draft flag.
2. Submission sends an empty string and the question key in `leftEmptyQuestionKeys`.
3. The main process accepts the pair only when both agree and there is no memory detail or attachment.
4. The provider receives an empty answer; the MCP broker identifies the intentional blank in its summary.
5. Entering a different answer clears the flag.

## Data model / migrations
`QuestionDraft.leftEmptyQuestionKeys?: Record<string, boolean>` and `QuestionResponse.leftEmptyQuestionKeys?: string[]`. No database change.

## Interfaces
`buildQuestionResponse` accepts `leftEmptyQuestionKeys` and emits an empty answer with the key marker. `QuestionBrokerService.answerRequest` accepts an optional array of keys left empty. Existing callers may omit it.

## Error handling
Reject unknown or duplicate blank keys, missing empty values, nonempty values marked blank, and blank answers carrying memory details or files. Keep the question pending on validation failure.

## Security
The main process validates blank markers against server-assigned question keys. No new data is exposed.

## Test strategy
Cover rendering and submission for a required fixed-choice question, response construction without memory, main-process provider delivery, and MCP summary formatting. Run the repository test, lint, and TypeScript checks.

## Rollout & rollback
No flag or migration. Reverting the UI and response marker restores previous behavior.

## Open risks
Provider SDKs may format empty string answers differently; adapters must preserve an unanswered slot. Third-party schemas with required numeric or boolean fields cannot represent an explicit blank, so the UI hides the option for those forms.
