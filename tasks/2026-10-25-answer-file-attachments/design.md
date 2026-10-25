# File attachments on question answers — Design
Date: 2026-10-25

## Problem
Question answers currently carry text, selections, and notes, but no file references. A user cannot give an agent a document that explains an individual answer.

## Users & success criteria
Users answering agent questions can attach several files to each answer, remove them before submission, and have the correct file references reach the waiting agent. A failed submission retains the draft.

## Codebase findings
| Finding | Evidence |
| --- | --- |
| Question drafts are keyed by task and request. | `src/stores/task-messages.ts` |
| The main process checks submitted answers against structured details. | `electron/services/agent-service.ts` |
| Prompt attachments already copy files into a task root and use an XML reference block. | `src/lib/file-attachment-utils.ts`, `electron/ipc/handlers.ts` |
| Questions appear both in the message stream and a separate task panel state. | `src/features/agent/ui-message-stream/index.tsx`, `src/features/task/ui-task-panel/index.tsx` |

## Decisions
| Decision | Chosen | Reason |
| --- | --- | --- |
| File association | Stable question key | Preserves the association across multiple questions and steps. |
| File storage | Existing prompt attachment IPC | Reuses the project temporary file location and size handling. |
| Agent delivery | Append escaped file references after answer validation for string answer backends | Validation and memory retain the user's actual answer. |
| Typed Codex elicitation | Keep typed answers intact and send references through an optional Jean-Claude schema field | Codex converts answers to schema values; appending XML to a boolean, number, or enum corrupts it. |
| Empty optional answers | Require an answer when files are attached | Prevents silent loss of attachments for skipped questions. |

## In scope
Multiple files per answer, removal, upload errors, submission gating during copying, draft retention on rejected submissions, and delivery through Jean-Claude `ask_question` on every backend. Other typed MCP elicitation forms hide the picker when their schema has no attachment field.

## Out of scope
Rendering document contents inline and storing file contents in question history.

## Architecture
```
Question UI ──► attachment IPC ──► task-root temporary file
    │
    └──► question draft ──► QuestionResponse.files ──► agent service
                                                    │
                                       validate answer and file shape
                                                    │
                                       route escaped file references
                                                    │
                               answer text or typed Codex schema field
```

## Interfaces and data model
`QuestionDraft.files` and `QuestionResponse.files` are optional maps from stable question key to `PromptFilePart[]`. No database migration is needed. `buildAttachedFilesXml(files)` is shared by prompt and question delivery.

## Error handling and security
The picker reports copy errors and blocks submission while copying, including after a form remount. Removing or canceling an unanswered request deletes temporary copies through the guarded deletion IPC. The main process rejects unknown question keys, malformed file records, files on skipped questions, and files on unsupported typed schemas. XML attributes are escaped. An agent receives file paths only when the answer is accepted.

## Test strategy
Check one picker per question and verify that a multi-question response delivers the attachment only with its associated answer while memory retains the original answer. Run the full test suite, lint, and TypeScript checks.

## Rollout and rollback
The fields are optional, so existing question requests and responses keep their current behavior. Reverting the optional response field and UI restores the previous flow without a migration.

## Open risks
The agent reads referenced files from disk, as it already does for normal prompt attachments; files removed from disk externally after submission cannot be recovered by the question response.
