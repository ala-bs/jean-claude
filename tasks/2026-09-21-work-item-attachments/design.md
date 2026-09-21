# Work-item document attachments — Design
Date: 2026-09-21

## Problem

Users can attach images while writing work-item comments, but the work-item
details modal has no way to upload a document as a work-item attachment. The
existing Azure upload service is also restricted to image MIME types.

## Users & success criteria

- From the work-item details modal or pane, a user can choose one or more local
  documents.
- Each selected file is uploaded to the configured Azure DevOps project and
  associated with the current work item.
- Existing Azure attachments are visible as named links in a dedicated
  Attachments tab in the details surface.
- A failed file does not hide successful uploads and produces an actionable
  error in the pane.
- The work-item description is not modified.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Details surface and refresh ownership | `src/features/feed/ui-work-item-details/index.tsx` |
| Renderer/preload/IPC API pattern | `src/lib/api.ts`, `electron/preload.ts`, `electron/ipc/handlers.ts` |
| Existing Azure attachment endpoint | `electron/services/azure-devops-service.ts` |
| Azure relation normalization | `electron/services/azure-devops-service.ts` (`WorkItemRelation`, `getWorkItemById`) |
| Existing image-only comment attachment UX | `src/features/work-item/ui-work-item-comments/index.tsx` |

## Decisions

- V1 supports arbitrary files accepted by the native file input, with a 50 MB
  per-file limit matching Azure’s existing upload guard.
- Multiple files can be selected in one action.
- Files are uploaded as Azure DevOps work-item attachments and are not appended
  to the description or comments.
- Attachment metadata is read from Azure’s `AttachedFile` work-item relations;
  no local database table or migration is needed.
- The renderer uses a browser file input and base64 transfer through the typed
  preload bridge. This follows the existing attachment path and avoids exposing
  filesystem APIs to the renderer.

## Architecture

```text
Details pane ──► api.azureDevOps.uploadWorkItemAttachment
     │                    │
     │                    ├─ preload IPC bridge
     │                    ├─ IPC handler
     │                    └─ Azure DevOps attachment endpoint
     │
     └─► getWorkItemById($expand=relations)
                 │
                 └─ AttachedFile relations ──► attachment list links
```

Responsibilities:

- `azure-devops-service`: validate file metadata/content, upload arbitrary
  files, and normalize `AttachedFile` relations.
- `electron/ipc/handlers.ts`, `electron/preload.ts`, `src/lib/api.ts`: expose
  the typed upload contract.
- `ui-work-item-details`: select files, track per-file state, refresh the item,
  and render the Attachments tab and its links.

## Interfaces

```ts
type AzureDevOpsWorkItemAttachment = {
  name: string;
  url: string;
};

interface AzureDevOpsWorkItem {
  attachments?: AzureDevOpsWorkItemAttachment[];
}

uploadWorkItemAttachment(params: {
  providerId: string;
  projectName: string;
  workItemId?: number;
  filename: string;
  mimeType: string;
  base64: string;
}): Promise<{ url: string }>;
```

When `workItemId` is supplied, the service uploads the blob and then adds an
`AttachedFile` relation to that work item. The optional field keeps the
existing comment image flow compatible; validation changes from image-only to
arbitrary non-empty content.

## Data flow and failures

1. User clicks “Attach document” and selects one or more files.
2. Renderer rejects empty files or files over 50 MB before invoking IPC.
3. Each file is converted to base64 and uploaded independently.
4. Successful uploads are accumulated; failed uploads retain their filename and
   error message.
5. After all uploads settle, the work item is refetched so Azure relations are
   authoritative.

Failure handling:

- No provider/project: disable the action.
- Empty/oversized file: show a per-file validation error; do not upload it.
- Invalid base64, filename, or content: reject in the main process and log the
  upload context without logging file contents.
- Azure failure: show the returned error for that file; keep other successes.
- Missing attachment relation name: use the final filename from the URL when
  possible, otherwise “Untitled attachment”.

## Security

- Provider authentication remains server-side in `getProviderAuth`.
- The main process validates base64 shape, decoded size, and filename before
  sending bytes to Azure.
- Do not log file content or base64 payloads.
- Links are rendered as external links with `noopener noreferrer`.

## Test strategy

- Service tests: arbitrary MIME acceptance, invalid base64, empty payload,
  50 MB limit, filename encoding, and `AttachedFile` relation normalization.
- UI tests: picker upload success, multi-file partial failure, disabled state,
  and attachment link rendering.
- Required repository checks: `pnpm install`, `pnpm test`, `pnpm lint --fix`,
  `pnpm ts-check`, and `pnpm lint`.

## Rollout

No feature flag or migration. Existing image comment uploads continue to use the
same IPC method. If Azure rejects a file type or size, the pane reports the
failure and existing work-item data remains unchanged.
