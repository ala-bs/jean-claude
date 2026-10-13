# Image Preview Asset Size — Design
Date: 2026-09-21

## Problem

Opening an image in the shared preview modal does not show its asset size. The
image data model already supports `sizeBytes`, but the preview mapping omits it
and newly processed files do not populate it.

## Users & success criteria

Users can identify the displayed image and its size while viewing it in the
preview modal. Existing previews without known byte metadata continue to work
without showing an empty size label.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Shared preview modal accepts normalized image metadata | `src/common/ui/image-preview-modal/index.tsx` |
| Prompt images already define optional byte size | `shared/agent-backend-types.ts` |
| Thumbnails already use the shared byte formatter | `src/lib/format-bytes.ts`, prompt/PR thumbnail components |
| File processing has the source byte size but drops it | `src/lib/image-utils.ts` |

## Decisions

- Keep byte size optional because URL-only/remote image previews may not expose
  reliable source bytes at the point the modal opens.
- Display the filename and formatted size in a compact footer below the image
  when either piece of metadata is available.
- Use the original `File.size`, not the compressed preview payload size; this is
  the asset size users selected and matches existing thumbnail metadata.

## Architecture

```text
File.size -> processImageFile -> PromptImagePart.sizeBytes
                                      |
                                      v
                               ImagePreviewModal
                                      |
                                      v
                         metadata footer (filename, size)
```

`ImagePreviewModal` owns presentation. Callers map their existing image model
to `PreviewImage`; no IPC, database migration, or new state is required.

## Interfaces

```ts
type PreviewImage = {
  src?: string;
  alt?: string;
  fallbackLabel?: string;
  sizeBytes?: number;
};
```

## Data flow and failure handling

1. File selection passes `File.size` into `PromptImagePart.sizeBytes`.
2. Preview callers pass `filename`/`sizeBytes` through to `PreviewImage`.
3. The modal formats known bytes with `formatBytes` and renders metadata.
4. If size is absent or invalid, the image remains fully usable and the size
   label is omitted.

## Test strategy

- Unit-test `processImageFile` propagation of `File.size`.
- Verify the preview modal metadata manually for a known size and omission when
  it is unavailable; the repository test configuration does not include shared
  modal tests.
- Run the repository test, lint, and TypeScript checks.

## Rollout

No migration or flag. The change is backward-compatible for all existing
preview callers.
