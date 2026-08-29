# PR Description Drafting — Design

Date: 2026-08-29

## Problem

Today the only place to write a PR description is `PrCreationForm`, which is a
*submit* form, not a *drafting* surface:

- It is reachable only through ⌘M → "Pull Request", and only renders when
  `canCreatePr` is satisfied and no matching PR exists for the branch.
- Pasted images live in React state (`stagedImages`) and are lost the moment the
  view closes.
- The diff-aware AI generator (`generatePrDescriptionForTask`) can only run
  *inside* `tasks:createPullRequest`, when title/description are blank. There is
  no way to preview or iterate on it.

Users want to accumulate a PR description — prose *and* screenshots — over the
life of a task, long before the PR exists.

## What already exists

```
PrCreationForm (src/features/task/ui-task-pr-view/pr-creation-form.tsx)
 ├─ title ────────► PrDraft.title ──┐
 ├─ description ──► PrDraft.desc ───┼─► zustand persist 'navigation' (localStorage) ✅
 ├─ stagedImages ─► React state ────┴─► LOST on close                               ❌
 ├─ ✨ button ────► useGenerateSummary  (task summary, not the PR generator)        ⚠️
 └─ [Create] ─────► tasks:createPullRequest
                      ├─ blank title/desc → generatePrDescriptionForTask()
                      ├─ commit → push → createPullRequest()
                      └─ upload images → swap jc-image:// → updatePullRequestDescription()
```

Supporting infrastructure already in place and reused as-is:

| Concern | Existing | Location |
| --- | --- | --- |
| View mode | `TaskViewMode = 'diff' \| 'pr' \| undefined` | `src/stores/navigation.ts:64` |
| View state hook | `usePrViewState(taskId)` | `navigation.ts:1417` |
| Text draft | `PrDraft { title?, description? }`, `usePrDraftState` | `navigation.ts:79`, `:1569` |
| Image placeholders | `jc-image://<token>` + `![alt](jc-image://t =WxH)` | `src/lib/markdown-image-size.ts` |
| Image processing | `processImageFile`, `getAzureAttachmentPayload`, `MAX_IMAGES` | `src/lib/image-utils.ts` |
| Attachment dir | `<worktreePath>/.jean-claude/tmp` | `electron/ipc/handlers.ts:1956` |
| Diff exclusion | `'**/.jean-claude/tmp/'` in `ignoredPaths` | `handlers.ts:5109` |
| Attachment deletion IPC | `fs.deleteAttachmentFile` (path-scoped) | `electron/ipc/attachment-file-deletion.ts` |
| AI generator | `generatePrDescriptionForTask(task, project)` | `electron/services/pr-description-generation-service.ts` |
| AI skill slot | `'pr-description'` | `shared/types.ts:985` |

The critical validated fact: `<worktreePath>/.jean-claude/tmp` is already in
`ignoredPaths`, so `gitAddAllExcept` never stages it. Draft screenshots stored
there **cannot** pollute the task diff or get swept into a `stageAll` commit.

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | The existing `'pr'` view becomes a persistent **draft editor**, always available for any task with a worktree + repo link | Drafting must work before the branch has commits |
| 2 | One editor, not two. **The component split was not done** — `PrCreationForm` still hosts editor + footer in one file | Avoids two divergent places to edit the same text. The `PrDraftEditor`/`PrSubmitFooter` split is deferred: it is pure code motion over a 1100-line file on the critical PR path, and doing it in the same change as the behavioural work would have made the diff unreviewable. Tracked as follow-up |
| 3 | Draft images stored on disk in `<worktreePath>/.jean-claude/tmp`, only file refs persisted | Mirrors `new-task-draft`; keeps localStorage small; already git-excluded |
| 4 | Draft **text** stays in the existing `PrDraft` zustand store | Smallest diff; text is small and localStorage-appropriate |
| 5 | New IPC `tasks:generatePrDescription` exposing `generatePrDescriptionForTask` standalone | Reuses the diff-aware generator and the `pr-description` skill slot |
| 6 | ✨ disabled with tooltip "No commits yet" when the branch has no commits | The generator is diff-driven; without a diff it would hallucinate |
| 7 | ✨ confirms before overwriting non-empty draft content | A draft may represent days of writing |
| 8 | Edit / Preview markdown toggle in v1 | Long-lived drafts need to be seen in final shape; renderer already exists |
| 9 | Matching-PR list demoted to a dismissible banner above the editor | Linking must not block drafting |
| 10 | Draft cleared on **successful** PR creation and on task deletion — not on click | Creation is a fire-and-forget background job; a failure must not lose the draft |
| 11 | ~~⌘P~~ ~~⌘⇧P~~ → **⌘⇧G** toggles the PR view, plus an item in the task header's overflow (⌘M) menu with a dot when a draft has content | **Revised twice.** ⌘P is the command palette (`routes/__root.tsx:101`), and dispatch is LIFO with no layer precedence, so a task-panel binding would have shadowed it app-wide. ⌘⇧P is *already double-booked* — `feed/ui-feed-list/index.tsx:1484` "Toggle Pin" and `agent/ui-worktree-actions/index.tsx:340` "Create Pull Request" — so it was not a safe home either. ⌘⇧G is the remaining free combo that is not an Electron menu role (⌘R/⌘⇧R = reload) nor a devtools key (⌘⇧I/C/J) |
| 12 | `MAX_PR_DRAFT_IMAGES = 10` (separate from the app-wide `MAX_IMAGES = 5`) | Before/after screenshots per change exceed 5 |

### Out of scope for v1

- Templates / reusable snippet library
- Drafts for tasks without a worktree
- Editing the description of an already-created PR from this UI (`PrDetail` owns that)
- Video→GIF changes (existing `VideoGifConverter` behavior kept as-is)

## Architecture

```
                       ⌘P  /  ⌘M ▸ Pull Request
                                  │
                        usePrViewState(taskId)  ── activeView: 'pr'
                                  │
                          ┌───────▼────────┐
                          │  TaskPrView    │
                          └───────┬────────┘
                    task.pullRequestId ?
                     ┌────────────┴─────────────┐
                     ▼                          ▼
                 PrDetail                 PrDraftView            ◄── NEW
                (read-only)                    │
                                ┌──────────────┼───────────────┐
                                ▼              ▼               ▼
                     [banner: PR exists]  PrDraftEditor   PrSubmitFooter
                       link it?            │                │
                                           ├ title input    ├ isDraft
                                           ├ Edit│Preview   ├ commitUnstaged
                                           ├ textarea/md    └ [Create PR]
                                           ├ ✨ generate
                                           └ image tray
                                              │
                          ┌───────────────────┴────────────────────┐
                          ▼                                        ▼
              usePrDraftState(taskId)                usePrDraftImages(taskId)
              title / description                    file refs → worktree tmp
              (zustand persist, localStorage)         (fs IPC read/write/delete)
```

### Data model

```ts
// src/stores/navigation.ts — extended
interface PrDraftImageRef {
  token: string;        // matches the jc-image://<token> placeholder
  filePath: string;     // <worktreePath>/.jean-claude/tmp/<uuid>.<ext>
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
}

interface PrDraft {
  title?: string;
  description?: string;
  images?: PrDraftImageRef[];   // NEW — refs only, never base64
}
```

`partialize` keeps `images` because it holds paths, not bytes — unlike
`new-task-draft`, which strips base64.

### New IPC

```ts
// electron/ipc/handlers.ts
'tasks:generatePrDescription': (taskId: string)
  => Promise<{ title: string; description: string }>
```

Thin wrapper over `generatePrDescriptionForTask(task, project)`. Rejects with a
typed error when the task has no worktree or no commits, so the renderer can
show the disabled-button tooltip without a second round trip.

Mirrored in `electron/preload.ts` (`tasks.generatePrDescription`) and typed in
`src/lib/api.ts`, with a mock impl alongside the existing PR mocks.

Renderer hook: `src/hooks/use-generate-pr-description.ts`.

### Image lifecycle

```
paste / drop / picker
   │
   ▼
processImageFile()  ──► base64 in memory
   │
   ├─► window.api.fs.writeAttachmentFile({ worktreePath, filename, data })   ◄── NEW IPC
   │      writes <worktreePath>/.jean-claude/tmp/<uuid>.<ext>
   │
   ├─► PrDraft.images += { token, filePath, ... }        (persisted)
   └─► description += ![name](jc-image://<token> =WxH)   (persisted)

render (edit tray / preview)
   └─► local-image-protocol-service serves the file by path

Create PR (existing handleCreate flow, unchanged in shape)
   ├─ stripUnresolvedImagePlaceholders() for the initial description
   ├─ createPullRequest()
   ├─ read each ref from disk → uploadPullRequestAttachment()
   ├─ replaceMarkdownImageUrl(token → real Azure URL)
   ├─ updatePullRequestDescription()
   └─ on success: clearPrDraft(taskId) + deleteAttachmentFiles(refs)
```

`writeAttachmentFile` reuses the same path-scoping guard as
`attachment-file-deletion.ts`: resolve the target and assert it lies inside
`<worktreePath>/.jean-claude/tmp` before writing.

## Error handling

| Failure | Behavior |
| --- | --- |
| PR creation fails | Draft (text + images) **preserved**; background job reports the error; user can retry from the same editor |
| Image write to disk fails | Image not added; inline error toast; description untouched |
| Draft image file missing on render (worktree deleted, manual cleanup) | Placeholder renders as a broken-image chip with "attachment missing"; ref pruned on next edit |
| Attachment upload fails after PR created | PR still exists; description keeps `jc-image://` stripped; surfaced as a warning. **The draft and every unpublished image file are retained** — only files that actually reached the host are reclaimed (`deleteImageFiles(uploadedTokens)`) |
| Submit attempted while draft images are still loading from disk | Blocked: `canSubmit` and `handleCreate` both gate on `isHydrating`. Without this the empty image list would publish raw `jc-image://` links and then delete the files |
| Draft ref whose file has vanished | Filtered out of the upload set; its placeholder is stripped by the unconditional `stripUnresolvedImagePlaceholders` before the create call, so no 0-byte attachment is posted |
| `generatePrDescription` fails | Toast with the underlying message; draft untouched |
| No commits on branch | ✨ disabled with "No commits yet" tooltip; Create PR unchanged (existing gating applies) |
| Worktree deleted while a draft exists | Editor shows a read-only notice; text still visible, images unavailable |

## Testing

- **Unit** — `writeAttachmentFile` path-scoping (reject traversal outside
  `.jean-claude/tmp`), mirroring `attachment-file-deletion.test.ts`.
- **Unit** — draft reducers: add/remove image keeps `description` placeholders
  and `images[]` in sync; pruning of orphaned refs.
- **Unit** — `tasks:generatePrDescription` handler: no worktree / no commits
  produce the typed errors the renderer branches on.
- **Component** — `PrDraftEditor`: paste image → placeholder inserted + ref
  persisted; Edit/Preview toggle renders placeholders; ✨ with existing content
  prompts for confirmation.
- **Integration** — create-PR flow: draft survives a simulated creation failure;
  draft and image files are removed only on success.
- **Regression** — a `.jean-claude/tmp` file in a worktree never appears in
  `getWorktreeStatus` / `commitWorktreeChanges` output.

## Implementation order

1. `writeAttachmentFile` IPC + path guard + tests
2. `PrDraft.images` in the navigation store + `usePrDraftImages`
3. `tasks:generatePrDescription` IPC + preload + api types + hook
4. Split `PrCreationForm` → `PrDraftEditor` + `PrSubmitFooter`
5. `PrDraftView`: always-editor, link-PR banner, Edit/Preview toggle
6. `TaskPrView` routing + always-visible ⌘M entry for worktree tasks
7. ⌘P shortcut + draft-present dot indicator
8. Cleanup wiring: clear on PR success and on task deletion
