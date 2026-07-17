# Blob Media Previews Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preview converted GIFs and attached images through short-lived Blob URLs so markdown parsing and routine input renders never process multi-megabyte base64 strings.

**Architecture:** Keep `PromptImagePart` base64 unchanged for persistence and upload, but derive renderer-only Blob URLs through one shared hook. Editors keep `jc-image://` placeholders in draft text, substitute Blob URLs only in debounced preview markdown, and revoke every generated URL when media changes or component unmounts.

**Tech Stack:** React 19, TypeScript, Vitest, Happy DOM, `Blob`, `URL.createObjectURL`, existing `PromptImagePart` and markdown placeholder utilities.

---

## Data Flow

```text
VideoGifConverter
      |
      v
PromptImagePart(base64) ---------------------> upload/persistence
      |
      v
useImagePreviewUrls
      |
      v
blob:http://... -----> markdown preview + thumbnail
      |
      v
URL.revokeObjectURL on remove/change/unmount
```

Base64 remains transport data. It must not enter `MarkdownContent`, `AzureMarkdownContent`, or an `<img src>` during editing.

### Task 1: Shared Blob URL Hook

**Files:**
- Create: `src/hooks/use-image-preview-urls.ts`
- Create: `src/hooks/use-image-preview-urls.test.ts`

**Step 1: Write failing lifecycle tests**

Cover:

- Converts each `PromptImagePart` data payload into one Blob URL.
- Uses `storageData` and `storageMimeType` when available.
- Returns `undefined` while asynchronous conversion is pending.
- Revokes old URLs when image list changes.
- Revokes current URLs on unmount.
- Ignores stale async completion after cleanup.

Use mocked browser APIs:

```ts
const createObjectUrl = vi.fn(() => `blob:preview-${createObjectUrl.mock.calls.length}`);
const revokeObjectUrl = vi.fn();

vi.stubGlobal('URL', {
  ...URL,
  createObjectURL: createObjectUrl,
  revokeObjectURL: revokeObjectUrl,
});
```

Render a small harness with `createRoot`, capture returned URLs, then rerender and unmount.

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec vitest run src/hooks/use-image-preview-urls.test.ts
```

Expected: FAIL because `useImagePreviewUrls` does not exist.

**Step 3: Implement minimal hook**

Implement renderer-only conversion:

```ts
import { useEffect, useState } from 'react';
import type { PromptImagePart } from '@shared/agent-backend-types';

export function useImagePreviewUrls(images: PromptImagePart[]) {
  const [urls, setUrls] = useState<(string | undefined)[]>(() =>
    images.map(() => undefined),
  );

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    setUrls(images.map(() => undefined));

    void Promise.all(
      images.map(async (image) => {
        const mimeType = image.storageMimeType ?? image.mimeType;
        const data = image.storageData ?? image.data;
        const response = await fetch(`data:${mimeType};base64,${data}`);
        const url = URL.createObjectURL(await response.blob());
        createdUrls.push(url);
        return url;
      }),
    ).then((nextUrls) => {
      if (!cancelled) setUrls(nextUrls);
    });

    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [images]);

  return urls;
}
```

Handle conversion rejection by returning `undefined` for that item instead of creating an unhandled rejection. Do not fall back to a base64 data URL.

**Step 4: Run hook tests**

Run:

```bash
pnpm exec vitest run src/hooks/use-image-preview-urls.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/hooks/use-image-preview-urls.ts src/hooks/use-image-preview-urls.test.ts
git commit -m "perf(media): add blob preview URL lifecycle"
```

### Task 2: Inline Comment Blob Previews

**Files:**
- Modify: `src/features/common/ui-inline-comments/index.tsx:57-135`
- Modify: `src/features/common/ui-inline-comments/index.tsx:330-430`
- Modify: `src/features/common/ui-inline-comments/index.tsx:590-750`
- Modify: `src/features/common/ui-inline-comments/index.test.ts`

**Step 1: Update tests to require Blob URLs**

Extend existing composer tests so preview markdown:

- Contains `blob:preview-1` for attached GIF placeholder.
- Never contains `large-gif-data`.
- Does not rerender `MarkdownContent` on each keystroke before debounced text publishes.
- Uses Blob URL in new-comment and existing-comment edit paths.
- Revokes URL when attachment is removed.

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec vitest run src/features/common/ui-inline-comments/index.test.ts
```

Expected: FAIL because current preview uses attachment labels rather than Blob URLs.

**Step 3: Restore visual markdown preview using short URLs**

Change preview transformation to accept URL list:

```ts
function markdownWithLocalImages(
  body: string,
  images: InlineComposerImage[],
  previewUrls: (string | undefined)[],
) {
  return images.reduce((current, image, index) => {
    if (!image.placeholderMarkdown) return current;
    const pattern = markdownImagePlaceholderPattern(image.placeholderMarkdown);
    const previewUrl = previewUrls[index];
    if (!pattern || !previewUrl) return current;
    return current.replace(pattern, (match) =>
      replaceMarkdownImageUrl(match, previewUrl),
    );
  }, body);
}
```

Call `useImagePreviewUrls(images)` and `useImagePreviewUrls(editImages)`. Include URL lists in preview `useMemo` dependencies.

Pass Blob URLs into `ComposerImageAttachments`; while a URL is pending, show compact filename/type placeholder instead of base64 `<img>` fallback.

Keep `ComposerMarkdownPreview` and `ComposerImageAttachments` memoized. Preserve original base64 `images` array for `onSubmit`.

**Step 4: Run inline-comment tests**

Run:

```bash
pnpm exec vitest run src/features/common/ui-inline-comments/index.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/features/common/ui-inline-comments/index.tsx src/features/common/ui-inline-comments/index.test.ts
git commit -m "perf(comments): preview media with blob URLs"
```

### Task 3: PR Description Blob Preview

**Files:**
- Modify: `src/features/pull-request/ui-pr-overview/index.tsx:74-95`
- Modify: `src/features/pull-request/ui-pr-overview/index.tsx:190-215`
- Modify: `src/features/pull-request/ui-pr-overview/index.tsx:720-790`
- Create: `src/features/pull-request/ui-pr-overview/media-preview.test.ts`

**Step 1: Write failing preview transformation tests**

Extract or export a small pure helper only if needed for direct testing. Verify:

- Description placeholder becomes corresponding Blob URL.
- Width suffix such as `=420x` remains unchanged.
- Preview markdown excludes base64 payload.
- Missing/pending URL leaves placeholder lightweight and does not inject data URI.

**Step 2: Run test and verify failure**

Run:

```bash
pnpm exec vitest run src/features/pull-request/ui-pr-overview/media-preview.test.ts
```

Expected: FAIL because description preview currently injects a full data URL.

**Step 3: Apply shared Blob URLs**

Call `useImagePreviewUrls(descriptionImages)` and update `descriptionPreviewMarkdown` to use URL by matching image index. Preserve `jc-image://` placeholders in `descriptionDraft`; only debounced preview receives Blob URLs.

Replace description attachment thumbnail base64 `src` with matching Blob URL. Show filename/GIF badge while URL is pending.

Keep save behavior unchanged: `saveDescription` still uploads base64 and replaces placeholders with Azure attachment URLs.

**Step 4: Run PR overview tests**

Run:

```bash
pnpm exec vitest run src/features/pull-request/ui-pr-overview/media-preview.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/features/pull-request/ui-pr-overview/index.tsx src/features/pull-request/ui-pr-overview/media-preview.test.ts
git commit -m "perf(pull-request): use blob description previews"
```

### Task 4: Remaining Converter Thumbnail Consumers

**Files:**
- Modify: `src/features/task/ui-task-pr-view/pr-creation-form.tsx:580-630`
- Modify: `src/features/new-task/ui-prompt-composer/index.tsx:1160-1210`
- Modify existing colocated tests where available

**Step 1: Add failing thumbnail tests**

For each converter consumer, verify attached GIF thumbnail uses `blob:` URL and rendered markup excludes base64 payload. If full component setup is too broad, extract one small shared `MediaAttachmentThumbnail` component under `src/features/common/ui-media-attachment-thumbnail/index.tsx` and test it directly.

Do not broaden scope to generic `PromptTextarea`; it does not use `VideoGifConverter` and currently converts direct GIF inputs to static compressed image formats.

**Step 2: Run focused tests and verify failure**

Run exact test files added or changed with `pnpm exec vitest run <paths>`.

Expected: FAIL because current thumbnails use data URLs.

**Step 3: Replace thumbnail data URLs**

Use `useImagePreviewUrls` in both consumers, or use shared `MediaAttachmentThumbnail` if extraction reduces duplication. Keep full-size lightbox optional; opening it may use same Blob URL, never reconstruct base64.

Memoize attachment list only where parent input state causes rerender on each keystroke. Do not add unrelated component refactors.

**Step 4: Run focused tests**

Expected: PASS with no base64 rendered into DOM.

**Step 5: Commit**

```bash
git add src/features/task/ui-task-pr-view/pr-creation-form.tsx src/features/new-task/ui-prompt-composer/index.tsx src/features/common/ui-media-attachment-thumbnail
git commit -m "perf(media): use blob URLs for GIF thumbnails"
```

### Task 5: Converter Memory Cleanup

**Files:**
- Modify: `src/features/common/ui-video-gif-converter/index.tsx:226-243`
- Add or modify converter unit tests if converter result helpers are extracted

**Step 1: Write failing result-construction test**

Verify GIF bytes are converted to base64 once and reused for `data` and `storageData`.

**Step 2: Run test and verify failure**

Expected: FAIL because `dataUrlToBase64(dataUrl)` is currently called twice.

**Step 3: Reuse one base64 value**

```ts
const data = dataUrlToBase64(dataUrl);
return {
  type: 'image',
  data,
  mimeType: 'image/gif',
  filename: gifFileName(file.name),
  sizeBytes: gifBytes.byteLength,
  width,
  height,
  storageData: data,
  storageMimeType: 'image/gif',
};
```

Do not migrate upload contracts from base64 in this task. That would require IPC and persisted-data changes with little preview benefit.

**Step 4: Run converter tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add src/features/common/ui-video-gif-converter/index.tsx
git commit -m "perf(media): reuse converted GIF payload"
```

### Task 6: Full Verification

**Files:**
- Review all changed files

**Step 1: Install dependencies**

Run:

```bash
pnpm install
```

Expected: lockfile unchanged; install succeeds. Use repository-required Node 22 to avoid engine warnings.

**Step 2: Run complete tests**

Run:

```bash
pnpm test
```

Expected: all tests pass.

**Step 3: Apply lint fixes**

Run:

```bash
pnpm lint --fix
```

Expected: command succeeds.

**Step 4: Run type checking**

Run:

```bash
pnpm ts-check
```

Expected: renderer and main-process checks pass.

**Step 5: Run final lint**

Run:

```bash
pnpm lint
```

Expected: no findings.

**Step 6: Manually verify performance**

Use a converted GIF near 10 MB and test:

1. New PR comment.
2. PR thread reply.
3. Existing PR comment edit.
4. PR description edit.
5. Task PR creation.
6. New-task work-item composer.

For each input, type continuously for at least 10 seconds. Expected:

- No multi-second stalls.
- GIF preview remains visible where markdown preview exists.
- Thumbnail appears after Blob URL creation.
- Removing media removes preview.
- Saving/submitting uploads valid media markdown.

Use Chrome Performance panel if any stall exceeds 100 ms. Confirm no markdown parse receives a `data:image/gif;base64,...` string.

**Step 7: Review final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: only intended media-preview files changed; no whitespace errors.

**Step 8: Commit verification fixes if needed**

```bash
git add <intended-files>
git commit -m "test(media): cover blob preview performance"
```
