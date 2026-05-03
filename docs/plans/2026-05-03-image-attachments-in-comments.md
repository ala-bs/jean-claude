# Image Attachments in Comments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to attach images to inline comments in both the diff review view and the new task file composer.

**Architecture:** Extract shared image processing utilities from `ui-prompt-textarea`, add `images?: PromptImagePart[]` to both comment types, wire image attach/preview into the shared `InlineCommentComposer`/`InlineCommentBubble` components, and update synthesis functions to return `PromptPart[]` so images flow through to the agent.

**Tech Stack:** React, Zustand, existing `compressImage()` utility, `PromptImagePart` type from `shared/agent-backend-types.ts`

---

### Task 1: Extract shared image processing utility

**Files:**
- Create: `src/lib/image-utils.ts`
- Modify: `src/features/common/ui-prompt-textarea/index.tsx`

**Step 1: Create `src/lib/image-utils.ts`**

Extract `processImageFile`, `MAX_IMAGES`, `MAX_FILE_SIZE`, and `ALLOWED_IMAGE_TYPES` from `ui-prompt-textarea/index.tsx` into a shared module.

```typescript
import { compressImage } from './image-compression';

import type { PromptImagePart } from '@shared/agent-backend-types';

export const MAX_IMAGES = 5;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
];

export async function processImageFile(
  file: File,
  onAttach: (image: PromptImagePart) => void,
  onError?: (message: string) => void,
): Promise<void> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    onError?.(`Unsupported image type: ${file.type}`);
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    onError?.(
      `Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)`,
    );
    return;
  }
  const { agent, storage } = await compressImage(file);
  onAttach({
    type: 'image',
    data: agent.data,
    mimeType: agent.mimeType,
    filename: file.name,
    storageData: storage.data,
    storageMimeType: storage.mimeType,
  });
}
```

**Step 2: Update `ui-prompt-textarea/index.tsx`**

Replace the local constants and `processImageFile` function with imports from the new module:

```typescript
import { processImageFile, MAX_IMAGES, MAX_FILE_SIZE, ALLOWED_IMAGE_TYPES } from '@/lib/image-utils';
```

Remove lines 102–136 (the local `MAX_IMAGES`, `MAX_FILE_SIZE`, `ALLOWED_IMAGE_TYPES`, and `processImageFile` definitions).

**Step 3: Verify**

Run: `pnpm ts-check`
Expected: No errors — behavior is unchanged, just relocated.

**Step 4: Commit**

```
feat: extract image processing utilities into shared module
```

---

### Task 2: Add `images` field to comment data types

**Files:**
- Modify: `src/stores/composer-file-comments.ts`
- Modify: `src/stores/review-comments.ts`

**Step 1: Update `ComposerFileComment`**

In `src/stores/composer-file-comments.ts`, add the import and field:

```typescript
import type { PromptImagePart } from '@shared/agent-backend-types';

export interface ComposerFileComment {
  id: string;
  anchor: FileCommentAnchor;
  body: string;
  images?: PromptImagePart[];
  createdAt: number;
}
```

**Step 2: Update `ReviewComment`**

In `src/stores/review-comments.ts`, add the import and field:

```typescript
import type { PromptImagePart } from '@shared/agent-backend-types';

export interface ReviewComment {
  id: string;
  anchor: FileCommentAnchor;
  body: string;
  images?: PromptImagePart[];
  presets: ReviewPresetId[];
  status: ReviewCommentStatus;
  agentNote?: string;
  resolved: boolean;
  createdAt: number;
}
```

**Step 3: Verify**

Run: `pnpm ts-check`
Expected: No errors — the field is optional so all existing code still compiles.

**Step 4: Commit**

```
feat: add optional images field to comment types
```

---

### Task 3: Update synthesis functions to return `PromptPart[]`

**Files:**
- Modify: `src/stores/composer-file-comments.ts` — `synthesizeFileCommentsPrompt()`
- Modify: `src/stores/review-comments.ts` — `synthesizeReviewPrompt()`
- Modify: `src/features/new-task/ui-new-task-overlay/index.tsx` — caller
- Modify: `src/features/new-task/ui-composer-comments-chip/index.tsx` — caller (preview only)
- Modify: `src/features/agent/ui-review-comments/review-submit-overlay.tsx` — caller
- Modify: `src/features/agent/ui-worktree-diff-view/index.tsx` — `onSubmitReview` signature
- Modify: `src/features/task/ui-task-panel/index.tsx` — `onSubmitReview` handler

**Step 1: Update `synthesizeFileCommentsPrompt`**

Change return type from `string | null` to `PromptPart[] | null`. Collect images from all comments and append after the text part.

```typescript
import type { PromptImagePart, PromptPart } from '@shared/agent-backend-types';

export function synthesizeFileCommentsPrompt(
  comments: ComposerFileComment[],
): PromptPart[] | null {
  if (comments.length === 0) return null;

  // Group comments by file
  const byFile = new Map<string, ComposerFileComment[]>();
  for (const c of comments) {
    const existing = byFile.get(c.anchor.filePath);
    if (existing) {
      existing.push(c);
    } else {
      byFile.set(c.anchor.filePath, [c]);
    }
  }

  const textLines: string[] = [];

  for (const [filePath, fileComments] of byFile) {
    textLines.push(`### ${filePath}`);

    const sorted = [...fileComments].sort(
      (a, b) => a.anchor.lineStart - b.anchor.lineStart,
    );

    for (const c of sorted) {
      const lineLabel = c.anchor.lineEnd
        ? `L${c.anchor.lineStart}-${c.anchor.lineEnd}`
        : `L${c.anchor.lineStart}`;
      const hasImages = c.images && c.images.length > 0;
      const imageTag = hasImages ? ' [see attached image]' : '';
      textLines.push(`- ${lineLabel}: ${c.body}${imageTag}`);
    }

    textLines.push('');
  }

  const parts: PromptPart[] = [
    { type: 'text', text: textLines.join('\n').trimEnd() },
  ];

  // Append all images from comments
  for (const c of comments) {
    if (c.images) {
      for (const img of c.images) {
        parts.push(img);
      }
    }
  }

  return parts;
}
```

**Step 2: Update `synthesizeReviewPrompt`**

Change return type from `string | null` to `PromptPart[] | null`:

```typescript
import type { PromptImagePart, PromptPart } from '@shared/agent-backend-types';

export function synthesizeReviewPrompt(
  comments: ReviewComment[],
  globalIntent?: string,
): PromptPart[] | null {
  const openComments = comments.filter((c) => !c.resolved);
  if (openComments.length === 0) return null;

  const textLines: string[] = [];

  if (globalIntent?.trim()) {
    textLines.push(globalIntent.trim());
    textLines.push('');
  }

  textLines.push('Address the following inline comments from the diff review:');
  textLines.push('');

  openComments.forEach((c, i) => {
    const lineLabel = c.anchor.lineEnd
      ? `L${c.anchor.lineStart}-${c.anchor.lineEnd}`
      : `L${c.anchor.lineStart}`;
    const anchor = `${c.anchor.filePath}:${lineLabel}`;
    const tags = c.presets.length > 0 ? ` [${c.presets.join(', ')}]` : '';
    const hasImages = c.images && c.images.length > 0;
    const imageTag = hasImages ? ' [see attached image]' : '';
    textLines.push(`${i + 1}. ${anchor}${tags}`);
    const body =
      c.body ||
      (c.presets.length > 0 ? `${c.presets.join(' and ')} this code` : '');
    textLines.push(`   \u2192 ${body}${imageTag}`);
    textLines.push('');
  });

  textLines.push(
    "Keep changes scoped to the comments. Don't refactor unrelated code.",
  );

  const parts: PromptPart[] = [
    { type: 'text', text: textLines.join('\n') },
  ];

  for (const c of openComments) {
    if (c.images) {
      for (const img of c.images) {
        parts.push(img);
      }
    }
  }

  return parts;
}
```

**Step 3: Update `ui-new-task-overlay/index.tsx`**

Around line 618, change from string concatenation to parts array:

```typescript
// Before:
const fileContext = synthesizeFileCommentsPrompt(fileComments);
if (fileContext) {
  finalPrompt = finalPrompt.trim()
    ? `${finalPrompt}\n\n${fileContext}`
    : fileContext;
}

// After:
const fileContextParts = synthesizeFileCommentsPrompt(fileComments);
if (fileContextParts) {
  // Extract text part to append to prompt
  const textPart = fileContextParts.find((p) => p.type === 'text');
  if (textPart && textPart.type === 'text') {
    finalPrompt = finalPrompt.trim()
      ? `${finalPrompt}\n\n${textPart.text}`
      : textPart.text;
  }
  // Collect image parts to merge with draft images
  const commentImages = fileContextParts.filter(
    (p): p is PromptImagePart => p.type === 'image',
  );
  if (commentImages.length > 0) {
    const existingImages = draftImages ?? [];
    draftImages = [...existingImages, ...commentImages];
  }
}
```

Note: `draftImages` needs to change from `const` to `let` (line 626).

**Step 4: Update `ui-composer-comments-chip/index.tsx`**

The chip displays a text preview of the synthesized prompt. Extract just the text part:

```typescript
// Before:
const synthesizedPrompt = useMemo(
  () => synthesizeFileCommentsPrompt(comments),
  [comments],
);

// After:
const synthesizedParts = useMemo(
  () => synthesizeFileCommentsPrompt(comments),
  [comments],
);
const synthesizedPrompt = useMemo(() => {
  if (!synthesizedParts) return null;
  const textPart = synthesizedParts.find((p) => p.type === 'text');
  return textPart?.type === 'text' ? textPart.text : null;
}, [synthesizedParts]);
```

The rest of the component uses `synthesizedPrompt` as a string for display and null-checking, so it continues to work.

**Step 5: Update review submit overlay**

In `review-submit-overlay.tsx`, change `onSubmit` to accept `PromptPart[]`:

```typescript
// Props change:
onSubmit: (parts: PromptPart[], targetStepId: string | null) => void;

// synthesized is now PromptPart[] | null:
const synthesized = useMemo(
  () => synthesizeReviewPrompt(openComments, globalIntent),
  [openComments, globalIntent],
);

// For the text preview, extract the text part:
const synthesizedText = useMemo(() => {
  if (!synthesized) return null;
  const textPart = synthesized.find((p) => p.type === 'text');
  return textPart?.type === 'text' ? textPart.text : null;
}, [synthesized]);

// handleSubmit:
const handleSubmit = useCallback(() => {
  if (synthesized) {
    onSubmit(synthesized, selectedStepId);
  }
}, [synthesized, selectedStepId, onSubmit]);

// In char count display, use synthesizedText:
{`${synthesizedText?.length ?? 0} chars`}

// In preview display, use synthesizedText:
{showPromptPreview && synthesizedText && (
  <div className="px-4 pb-3.5">
    <div className="...">
      {synthesizedText}
    </div>
  </div>
)}
```

Also show image count in the comment cards. After the body text div:

```typescript
{c.images && c.images.length > 0 && (
  <div className="mt-1 flex gap-1">
    {c.images.map((img, imgIdx) => (
      <img
        key={imgIdx}
        src={`data:${img.storageMimeType ?? img.mimeType};base64,${img.storageData ?? img.data}`}
        alt={img.filename || 'Attached'}
        className="h-8 w-8 rounded border border-white/10 object-cover"
      />
    ))}
  </div>
)}
```

**Step 6: Update `ui-worktree-diff-view/index.tsx`**

Change the `onSubmitReview` prop type:

```typescript
// Before:
onSubmitReview?: (prompt: string, targetStepId: string | null) => void;

// After:
onSubmitReview?: (parts: PromptPart[], targetStepId: string | null) => void;
```

Update `handleSubmitReview`:

```typescript
const handleSubmitReview = useCallback(
  (parts: PromptPart[], targetStepId: string | null) => {
    setIsSubmitOverlayOpen(false);
    onSubmitReview?.(parts, targetStepId);
    // ... rest unchanged (resolve comments, etc.)
  },
  [onSubmitReview, reviewComments, resolveComment, clearResolvedComments, taskId],
);
```

**Step 7: Update `ui-task-panel/index.tsx`**

Change the `onSubmitReview` callback around line 1356:

```typescript
// Before:
onSubmitReview={(prompt, targetStepId) => {
  if (targetStepId) {
    if (targetStepId !== activeStepId) {
      setActiveStepId(targetStepId);
    }
    void api.agent.sendMessage(targetStepId, [
      { type: 'text', text: prompt },
    ]);
  } else {
    // ...
    void handleAddStep({
      promptTemplate: prompt,
      // ...
      images: [],
      start: true,
    });
  }
}}

// After:
onSubmitReview={(parts, targetStepId) => {
  if (targetStepId) {
    if (targetStepId !== activeStepId) {
      setActiveStepId(targetStepId);
    }
    void api.agent.sendMessage(targetStepId, parts);
  } else {
    const textPart = parts.find((p) => p.type === 'text');
    const imageParts = parts.filter(
      (p): p is PromptImagePart => p.type === 'image',
    );
    // ...
    void handleAddStep({
      promptTemplate: textPart?.type === 'text' ? textPart.text : '',
      // ...
      images: imageParts,
      start: true,
    });
  }
}}
```

**Step 8: Verify and lint**

Run: `pnpm ts-check && pnpm lint --fix`

**Step 9: Commit**

```
feat: update comment synthesis to return PromptPart[] with images
```

---

### Task 4: Add image support to `InlineCommentComposer`

**Files:**
- Modify: `src/features/common/ui-inline-comments/index.tsx`

**Step 1: Update `InlineCommentComposer` component**

Add image state, paste/drop/file-picker handlers, thumbnail strip, and update the `onSubmit` signature.

```typescript
import { ImagePlus, X } from 'lucide-react';
import type { PromptImagePart } from '@shared/agent-backend-types';
import { processImageFile, MAX_IMAGES } from '@/lib/image-utils';

export function InlineCommentComposer({
  lineStart,
  lineEnd,
  onSubmit,
  onCancel,
  renderBeforeTextarea,
  renderAfterActions,
  placeholder = 'Add a comment...',
  submitLabel = 'Add comment',
  canSubmitEmpty = false,
  initialBody = '',
  initialImages = [],
}: {
  lineStart: number;
  lineEnd?: number;
  onSubmit: (body: string, images: PromptImagePart[]) => void;
  onCancel: () => void;
  renderBeforeTextarea?: ReactNode;
  renderAfterActions?: ReactNode;
  placeholder?: string;
  submitLabel?: string;
  canSubmitEmpty?: boolean;
  initialBody?: string;
  initialImages?: PromptImagePart[];
}) {
  const [body, setBody] = useState(initialBody);
  const [images, setImages] = useState<PromptImagePart[]>(initialImages);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bindingId = useId();

  // ... focus effect unchanged ...

  const lineLabel = formatLineRangeLabel(lineStart, lineEnd);

  const handleImageAttach = useCallback((image: PromptImagePart) => {
    setImages((prev) => (prev.length < MAX_IMAGES ? [...prev, image] : prev));
  }, []);

  const handleImageRemove = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = body.trim();
    if (!trimmed && images.length === 0 && !canSubmitEmpty) return;
    onSubmit(trimmed, images);
  }, [body, images, canSubmitEmpty, onSubmit]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files);
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;
      e.preventDefault();
      const allowed = MAX_IMAGES - images.length;
      for (const file of imageFiles.slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
    },
    [images.length, handleImageAttach],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      const allowed = MAX_IMAGES - images.length;
      for (const file of imageFiles.slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
    },
    [images.length, handleImageAttach],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      const allowed = MAX_IMAGES - images.length;
      for (const file of files.slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
      e.target.value = '';
    },
    [images.length, handleImageAttach],
  );

  // keyboard bindings unchanged...

  const isDisabled = !body.trim() && images.length === 0 && !canSubmitEmpty;

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px]" style={{ color: COMMENT_ACCENT.text }}>
        {lineLabel}
      </span>

      {renderBeforeTextarea}

      <textarea
        ref={textareaRef}
        className="bg-bg-2 text-ink-1 border-stroke-1 min-h-[60px] w-full resize-y rounded border px-2 py-1.5 text-xs focus:outline-none"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      />

      {/* Image thumbnails */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((img, index) => (
            <div key={`${img.filename ?? 'img'}-${index}`} className="group relative">
              <img
                src={`data:${img.storageMimeType ?? img.mimeType};base64,${img.storageData ?? img.data}`}
                alt={img.filename || 'Attached image'}
                className="h-8 w-8 rounded border border-white/10 object-cover"
              />
              <button
                type="button"
                onClick={() => handleImageRemove(index)}
                className="bg-black/60 text-white absolute -top-1 -right-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full group-hover:flex"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="bg-acc text-acc-ink inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
          onClick={handleSubmit}
          disabled={isDisabled}
        >
          {submitLabel}
          <kbd className="rounded bg-white/20 px-1 py-px font-mono text-[9px]">
            {'\u2318\u21B5'}
          </kbd>
        </button>
        {/* Image attach button */}
        <button
          type="button"
          className="text-ink-3 hover:text-ink-1 p-1"
          onClick={() => fileInputRef.current?.click()}
          disabled={images.length >= MAX_IMAGES}
          title="Attach image"
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
        <button
          type="button"
          className="text-ink-3 hover:text-ink-1 rounded px-2 py-1 text-xs"
          onClick={onCancel}
        >
          Cancel
        </button>
        {renderAfterActions}
      </div>
    </div>
  );
}
```

**Step 2: Verify**

Run: `pnpm ts-check`
Expected: Type errors in consumers of `onSubmit` that now receive `(body, images)` instead of just `(body)`. These are fixed in Task 6.

**Step 3: Commit**

```
feat: add image attachment support to InlineCommentComposer
```

---

### Task 5: Add image display to `InlineCommentBubble`

**Files:**
- Modify: `src/features/common/ui-inline-comments/index.tsx`

**Step 1: Update `InlineCommentBubble` props and rendering**

Add `images` prop for display, update `onEdit` to pass images, and render thumbnails below the body.

```typescript
export function InlineCommentBubble({
  lineStart,
  lineEnd,
  body,
  images,
  onRemove,
  onEdit,
  renderHeaderExtras,
  renderExtraActions,
  renderFooter,
}: {
  lineStart: number;
  lineEnd?: number;
  body: string;
  images?: PromptImagePart[];
  onRemove?: () => void;
  onEdit?: (newBody: string, newImages: PromptImagePart[]) => void;
  renderHeaderExtras?: ReactNode;
  renderExtraActions?: ReactNode;
  renderFooter?: ReactNode;
}) {
```

In the editing state, add image state management:

```typescript
const [editImages, setEditImages] = useState<PromptImagePart[]>(images ?? []);
```

Reset `editImages` in `startEditing`:

```typescript
const startEditing = useCallback(() => {
  setEditBody(body);
  setEditImages(images ?? []);
  setIsEditing(true);
}, [body, images]);
```

Update `saveEdit`:

```typescript
const saveEdit = useCallback(() => {
  const trimmed = editBody.trim();
  const imagesChanged =
    editImages.length !== (images ?? []).length ||
    editImages.some((img, i) => img !== (images ?? [])[i]);
  if ((!trimmed && editImages.length === 0) || (!imagesChanged && trimmed === body)) {
    cancelEditing();
    return;
  }
  onEdit?.(trimmed, editImages);
  setIsEditing(false);
}, [editBody, editImages, body, images, onEdit, cancelEditing]);
```

Render thumbnails in display mode (below the body text):

```typescript
{!isEditing && images && images.length > 0 && (
  <div className="mt-1.5 flex flex-wrap gap-1.5">
    {images.map((img, index) => (
      <img
        key={`${img.filename ?? 'img'}-${index}`}
        src={`data:${img.storageMimeType ?? img.mimeType};base64,${img.storageData ?? img.data}`}
        alt={img.filename || 'Attached image'}
        className="h-8 w-8 rounded border border-white/10 object-cover"
      />
    ))}
  </div>
)}
```

In edit mode, show editable thumbnails with remove and an add button (reuse same pattern from Composer):

```typescript
{isEditing && (
  <>
    {editImages.length > 0 && (
      <div className="mt-1 flex flex-wrap gap-1.5">
        {editImages.map((img, index) => (
          <div key={`${img.filename ?? 'img'}-${index}`} className="group relative">
            <img
              src={`data:${img.storageMimeType ?? img.mimeType};base64,${img.storageData ?? img.data}`}
              alt={img.filename || 'Attached image'}
              className="h-8 w-8 rounded border border-white/10 object-cover"
            />
            <button
              type="button"
              onClick={() => setEditImages((prev) => prev.filter((_, i) => i !== index))}
              className="bg-black/60 text-white absolute -top-1 -right-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full group-hover:flex"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        ))}
      </div>
    )}
  </>
)}
```

**Step 2: Verify**

Run: `pnpm ts-check`
Expected: Type errors in consumers that pass `onEdit` with old signature `(newBody: string)`. Fixed in Task 6.

**Step 3: Commit**

```
feat: add image display and edit support to InlineCommentBubble
```

---

### Task 6: Wire images through all consumer components

**Files:**
- Modify: `src/features/agent/ui-review-comments/review-comment-composer.tsx`
- Modify: `src/features/agent/ui-review-comments/review-comment-thread.tsx`
- Modify: `src/features/new-task/ui-composer-file-explorer/commentable-file-viewer.tsx`

**Step 1: Update `ReviewCommentComposer`**

```typescript
import type { PromptImagePart } from '@shared/agent-backend-types';

export function ReviewCommentComposer({
  lineStart,
  lineEnd,
  onSubmit,
  onCancel,
}: {
  lineStart: number;
  lineEnd?: number;
  onSubmit: (body: string, presets: ReviewPresetId[], images: PromptImagePart[]) => void;
  onCancel: () => void;
}) {
  // ...
  const handleSubmit = useCallback(
    (body: string, images: PromptImagePart[]) => {
      onSubmit(body, selectedPresets, images);
    },
    [onSubmit, selectedPresets],
  );
  // ... rest unchanged, InlineCommentComposer onSubmit={handleSubmit} already works
}
```

**Step 2: Update `ReviewCommentThread`**

```typescript
import type { PromptImagePart } from '@shared/agent-backend-types';

export function ReviewCommentThread({
  comment,
  showStatus,
  onResolve,
  onDelete,
  onEdit,
}: {
  comment: ReviewComment;
  showStatus: boolean;
  onResolve?: (commentId: string) => void;
  onDelete?: (commentId: string) => void;
  onEdit?: (commentId: string, newBody: string, newImages: PromptImagePart[]) => void;
}) {
  return (
    // ...
    <InlineCommentBubble
      lineStart={comment.anchor.lineStart}
      lineEnd={comment.anchor.lineEnd}
      body={comment.body}
      images={comment.images}
      onRemove={onDelete ? () => onDelete(comment.id) : undefined}
      onEdit={onEdit ? (newBody, newImages) => onEdit(comment.id, newBody, newImages) : undefined}
      // ... rest unchanged
    />
    // ...
  );
}
```

**Step 3: Update `commentable-file-viewer.tsx`**

Update `handleComposerSubmit` to pass images:

```typescript
const handleComposerSubmit = useCallback(
  (body: string, images: PromptImagePart[]) => {
    if (!composerLineRange) return;
    addComment({
      anchor: {
        filePath,
        lineStart: composerLineRange.start,
        lineEnd:
          composerLineRange.start !== composerLineRange.end
            ? composerLineRange.end
            : undefined,
      },
      body,
      images: images.length > 0 ? images : undefined,
    });
    setComposerLineRange(null);
  },
  [composerLineRange, addComment, filePath],
);
```

Update `FileLineRow` props for `onComposerSubmit` and `onEditComment`:

```typescript
onComposerSubmit: (body: string, images: PromptImagePart[]) => void;
onEditComment: (commentId: string, newBody: string, newImages: PromptImagePart[]) => void;
```

Update the `inlineComments` type in `FileLineRow` to include images:

```typescript
inlineComments:
  | Array<{
      id: string;
      anchor: { lineStart: number; lineEnd?: number };
      body: string;
      images?: PromptImagePart[];
    }>
  | undefined;
```

Pass `images` to `InlineCommentBubble`:

```typescript
<InlineCommentBubble
  key={comment.id}
  lineStart={comment.anchor.lineStart}
  lineEnd={comment.anchor.lineEnd}
  body={comment.body}
  images={comment.images}
  onRemove={() => onRemoveComment(comment.id)}
  onEdit={(newBody, newImages) => onEditComment(comment.id, newBody, newImages)}
/>
```

Update the caller in `CommentableFileViewer` for `onEditComment`:

```typescript
onEditComment={(commentId, newBody, newImages) =>
  updateComment(commentId, {
    body: newBody,
    images: newImages.length > 0 ? newImages : undefined,
  })
}
```

**Step 4: Update diff view callers**

Find where `onEditReviewComment` and `onAddReviewComment` are used in `ui-worktree-diff-view/index.tsx` and update their signatures to pass images through. The handlers should include `images` in `addComment()` and `updateComment()` calls.

**Step 5: Verify and lint**

Run: `pnpm ts-check && pnpm lint --fix && pnpm lint`

**Step 6: Commit**

```
feat: wire image attachments through all comment consumers
```

---

### Task 7: Final verification and cleanup

**Step 1: Run full checks**

```bash
pnpm install
pnpm lint --fix
pnpm ts-check
pnpm lint
```

**Step 2: Fix any remaining issues**

Address any lint warnings or type errors.

**Step 3: Commit any fixes**

```
chore: fix lint and type errors from image attachment feature
```
