# Show turn messages with pending ask-question — Review

Date: 2026-09-19

Scope: working diff only (`src/features/agent/ui-message-stream/`). No design or
plan artifact exists for this change, so round 2 (conformance) was limited to
repo conventions.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | Medium | While paused on a question, the assistant message right before the question rendered twice — in full as an `AssistantMessageBlock`, then again as a truncated `…` row under "recent" in `RunningSummary`. | `RunningSummary` renders `activity.recentMessages`, built by `getRunningActivity` from *every* assistant message with no exclusion list. The completed-group path dedupes against `resultSummary`; the running path had no equivalent, and the new code added a second renderer of the same entries without telling the activity builder about them. | `getRunningActivity` / `getLatestActivityMessage` / `getAssistantPreviewMessage` take an optional `excludedAssistantEntryIds` set; the `activity` memo passes the ids of the messages already shown in full. Dedup is by entry id, not text, so trimming differences can't defeat it. | `ui-prompt-group-entry/index.tsx:77,98,127,242,255,1524` |
| 2 | Low | `isActiveGroup && (activity \|\| precedingLongMessages.length > 0)` plus an inner `{activity && …}` guard implied active groups can have `activity === null`. | `getRunningActivity` always returns an object (it force-pushes a `Working...` row), so `activity` is null only when `!isActiveGroup` — the added disjunct was unreachable and misleading to future readers. | Reverted the condition to `isActiveGroup && activity` and rendered `<RunningSummary>` unguarded inside it. | `ui-prompt-group-entry/index.tsx:1773,1788` |
| 3 | Low | New branch had zero test coverage (the file's only tests cover pure helpers). | No render-test infrastructure in this directory; helpers were module-private. | Exported `getRunningActivity` and `getLongAssistantMessages`; added two regression tests pinning the preview behavior and the exclusion. | `ui-prompt-group-entry/index.test.ts` |

## Before / after

```
paused on question, collapsed last group

BEFORE FIX 1                          AFTER FIX 1
┌ agent ─────────────────────┐        ┌ agent ─────────────────────┐
│ ① "I found two ways to do  │        │ ① "I found two ways to do  │
│    X, the tradeoff is …"   │        │    X, the tradeoff is …"   │
│ recent                     │        │ recent                     │
│  · I found two ways to d…  │ ← dup  │  · ⌗ read src/foo.ts       │ ← real
└────────────────────────────┘        └────────────────────────────┘
┌ ❓ Which option?  A / B    ┐        ┌ ❓ Which option?  A / B    ┐
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| `key={m.entryId}` could collide under streaming | Ids are backend-assigned per `NormalizedEntry`; the merger does not clone entries, and the completed branch already keys the identical list the same way. |
| Stale memo / re-render loop from the new `precedingLongMessages` dep | All read values are in the dep array, and the empty case returns the module-level `EMPTY_LONG_MESSAGES` constant, so identity is stable. |
| The feature may never trigger because a question-paused group isn't "active" | `src/stores/task-messages.ts:23-27` nulls `pendingQuestion` for `completed \| errored \| interrupted`, so a pending question implies step status `running`; and `isActiveGroup = isRunning \|\| (isLast && isTaskRunning)` holds even if the merger marks the group completed. |
| `CommentableWrapper` state lost when the question is answered | Its layout effects key on comments, not text, and `key={m.entryId}` is stable across the recompute. |

## Parked — resolved by the user

| Finding | The two behaviors | Decision |
| --- | --- | --- |
| Assistant messages shorter than `LONG_ASSISTANT_MESSAGE_MIN_CHARS` (280) are not surfaced. A short preamble — "I found two options, see below" — leaves the question with no added context. | (a) keep the 280-char bar shared with the completed-group view; (b) lower or drop the bar only when `hasPendingQuestion`, showing every assistant message of the turn. | **(a) keep the 280 bar for now** — user decision, 2026-09-19. The running and completed views stay on one threshold; revisit if short preambles turn out to be the common shape in practice. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| `AssistantMessageBlock` and `MarkdownContent` are not memoized, so each parent render re-parses markdown for every block. | Pre-existing; the completed-group view has rendered the same unmemoized list all along, and streaming is paused while a question is open. Widening scope was not warranted. |
| `electron/database/migrations/078_pr_workspace_support.test.ts` fails with `client.setAuthorizer is not a function`. | Pre-existing — reproduced on a clean tree via `git stash`. Untouched by this diff. |

## Verification

- `pnpm ts-check` — clean.
- `pnpm lint` — one pre-existing `sort-imports` warning in `feed-item-card.tsx`, untouched by this diff.
- `pnpm vitest run src/features/agent/ui-message-stream/ui-prompt-group-entry/index.test.ts` — 6 passed.
- `pnpm test` — 5813 passed, 2 failed: `078_pr_workspace_support` (fails on clean tree too) and `mobile-preview-process` (timing flake; passed on re-run: 11 passed). Both are main-process tests unrelated to this renderer-only diff.
