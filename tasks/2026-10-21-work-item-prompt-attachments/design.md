# Work item attachments in task prompts — Design
Date: 2026-10-21

## Problem

Task creation uses work item text and embedded images, but omits files in Azure DevOps `AttachedFile` relations. An agent may not be able to open a private Azure URL without the provider token.

## Users and success criteria

When a user creates a task from work items, the agent receives local paths for every downloadable attachment. A failed download does not stop task creation; the missing filename appears in the task prompt and in a toast.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Azure work item objects already include attachment names and URLs | `electron/services/azure-devops-service.ts` |
| Both task creation screens construct the final prompt in the renderer | `src/features/new-task/ui-new-task-overlay/index.tsx`, `src/routes/projects/$projectId/tasks/new.tsx` |
| Prompt files use `<attached_files>` with local paths | `src/lib/file-attachment-utils.ts` |
| Azure image proxy already validates hosts and authenticated redirects | `electron/services/azure-image-proxy-service.ts` |

## Decisions

| Decision | Chosen | Reason |
| --- | --- | --- |
| Delivery | Authenticated download to managed project temp directory | The agent can read bytes without the Azure credential. URLs alone may be inaccessible. |
| Failure | Continue and report missing filenames | A single unavailable document should not block the task. User selected this behavior. |
| Size | 50 MB per file | Matches existing work item upload and local attachment limit. |
| Scope | Both task creation screens | Both can create tasks linked to work items. |

## Architecture

```text
Selected work items
  └─ AttachedFile relations ──► renderer download helper
                                  │
                                  ▼
                             typed IPC bridge
                                  │
                                  ▼
                         authenticated Azure stream
                                  │
                                  ▼
                     .jean-claude/tmp/<unique>-<name>
                                  │
                                  ▼
                       <attached_files> in task prompt
```

## Data flow and interface

`downloadWorkItemAttachment({ providerId, attachmentUrl, filename, projectPath })` returns `{ filePath, filename }`. The renderer collects successful files and failures per work item, then adds paths using `buildAttachedFilesXml`. The legacy screen refetches the selected work items before downloading so a reopened draft uses current relations.

## Failure and security

Reject URLs outside the HTTPS Azure work item attachment endpoint or the selected provider's organization before making a request. The existing proxy checks every authenticated redirect against that organization. Stream with a 50 MB cap and 60 second timeout, delete partial files on failure, and keep the token in the main process. Remove completed downloads when preparation fails before task creation starts. Retain them when task creation rejects because a task may already be saved. Surface failed names in a toast and in the persisted task prompt. Submission guards prevent duplicate tasks during downloads and creation.

## Verification and rollout

Unit tests cover authenticated file writing, rejected hosts and organizations, cleanup after setup failure, and partial download failure. Run repository tests, lint and TypeScript checks. No schema migration or feature flag is needed. Existing tasks retain their prompts.

## Review revision — 2026-10-21

The work item fetch used by task creation must preserve `AttachedFile` relations in its mapper. The task creation job begins before attachment downloads, so closing the overlay leaves visible progress and task creation continues in the background, as selected by the user. The job's retry input is updated with the completed prompt before submission. A rejected creation call may occur after a task is saved, so downloaded files are retained in that case. After a successful worktree task, project temp copies are removed only if the saved prompt no longer references them; a failed relocation retains the original file.
