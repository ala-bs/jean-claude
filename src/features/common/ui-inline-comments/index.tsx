/* eslint-disable sort-imports */
import { ImagePlus, Pencil, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type React from 'react';
import type { ReactNode } from 'react';



import {
  EMPTY_MENTION_OPTIONS,
  MENTION_TEXTAREA_CLASS,
  type MentionOption,
  MentionTextarea,
} from '@/common/ui/mention-textarea';
import {
  isVideoFile,
  VideoGifConverter,
} from '@/features/common/ui-video-gif-converter';
import {
  getPromptImageMarkdownSize,
  markdownImagePlaceholderPattern,
  replaceMarkdownImageUrl,
} from '@/lib/markdown-image-size';
import { MAX_IMAGES, processImageFile } from '@/lib/image-utils';
import { formatBytes } from '@/lib/format-bytes';
import { formatLineRangeLabel } from '@/stores/utils-comment-store';
import { MarkdownContent } from '@/features/agent/ui-markdown-content';
import type { PromptImagePart } from '@shared/agent-backend-types';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useImagePreviewUrls } from '@/hooks/use-image-preview-urls';
import { useRegisterKeyboardBindings } from '@/common/context/keyboard-bindings';



// ---------------------------------------------------------------------------
// Shared styling constants for inline comment UI
// ---------------------------------------------------------------------------

export const COMMENT_ACCENT = {
  bg: 'color-mix(in oklch, oklch(0.78 0.18 295) 8%, transparent)',
  bgLight: 'color-mix(in oklch, oklch(0.78 0.18 295) 6%, transparent)',
  border: 'oklch(0.78 0.18 295 / 0.15)',
  borderStrong: 'oklch(0.78 0.18 295 / 0.2)',
  bar: 'oklch(0.78 0.18 295)',
  barSoft: 'oklch(0.78 0.18 295 / 0.5)',
  text: 'oklch(0.65 0.15 295)',
  chipBg: 'color-mix(in oklch, oklch(0.78 0.18 295) 18%, transparent)',
  chipText: 'oklch(0.78 0.18 295)',
};

type InlineComposerImage = PromptImagePart & {
  placeholderMarkdown?: string;
};

function markdownWithLocalImages(
  body: string,
  images: InlineComposerImage[],
  previewUrls: (string | undefined)[],
) {
  return images.reduce((current, image, index) => {
    if (!image.placeholderMarkdown) return current;
    const pattern = markdownImagePlaceholderPattern(image.placeholderMarkdown);
    if (!pattern) return current;
    const previewUrl = previewUrls[index];
    if (previewUrl) {
      return current.replace(pattern, (match) =>
        replaceMarkdownImageUrl(match, previewUrl),
      );
    }
    const mediaType = image.mimeType === 'image/gif' ? 'GIF' : 'image';
    return current.replace(pattern, `_[Attached ${mediaType}: ${image.filename ?? mediaType}]_`);
  }, body);
}

const ComposerMarkdownPreview = memo(function ComposerMarkdownPreview({
  markdown,
}: {
  markdown: string;
}) {
  if (!markdown.trim()) return null;

  return (
    <div className="border-glass-border/60 bg-bg-1/60 rounded border px-2.5 py-2">
      <div className="text-ink-4 mb-1 text-[10px] font-medium tracking-wide uppercase">
        Preview
      </div>
      <MarkdownContent
        content={markdown}
        imageClassName="max-h-64 object-contain"
        enableImageModal
        allowBlobImages
      />
    </div>
  );
});

const ImageAttachments = memo(function ImageAttachments({
  images,
  previewUrls,
  onRemove,
  className,
}: {
  images: InlineComposerImage[];
  previewUrls: (string | undefined)[];
  onRemove?: (index: number) => void;
  className?: string;
}) {
  if (images.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-1.5${className ? ` ${className}` : ''}`}>
      {images.map((image, index) => (
        <div
          key={`${image.filename ?? 'img'}-${index}`}
          className="group relative"
        >
          {previewUrls[index] ? (
            <img
              src={previewUrls[index]}
              alt={image.filename || 'Attached image'}
              title={image.sizeBytes ? formatBytes(image.sizeBytes) : undefined}
              className="h-8 w-8 rounded border border-white/10 object-cover"
            />
          ) : (
            <div
              title={image.filename}
              className="text-ink-3 border-stroke-1 flex h-8 max-w-36 items-center rounded border px-1.5 text-[9px]"
            >
              <span className="truncate">
                {image.filename ?? image.mimeType}
              </span>
            </div>
          )}
          {image.sizeBytes && (
            <span className="absolute right-0 bottom-0 left-0 rounded-b bg-black/70 px-0.5 text-center font-mono text-[7px] leading-3 text-white">
              {formatBytes(image.sizeBytes)}
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${image.filename ?? 'attached image'}`}
              onClick={() => onRemove(index)}
              className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/60 text-white opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// InlineCommentComposer — shared comment input form
// ---------------------------------------------------------------------------

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
  allowImages = true,
  insertImagesInBody = false,
  isSubmitting = false,
  showCancel = true,
  mentionOptions = EMPTY_MENTION_OPTIONS,
  onSearchMentions,
  onBodyChange,
  onEmptyChange,
}: {
  lineStart: number;
  lineEnd?: number;
  onSubmit: (body: string, images: PromptImagePart[]) => void;
  onCancel: () => void;
  /** Rendered between the line label and the textarea (e.g. preset chips). */
  renderBeforeTextarea?: ReactNode;
  /** Rendered after the action buttons (e.g. hint text). */
  renderAfterActions?:
    | ReactNode
    | ((context: {
        body: string;
        images: PromptImagePart[];
        isSubmitting: boolean;
        isDisabled: boolean;
      }) => ReactNode);
  placeholder?: string;
  submitLabel?: string;
  /**
   * When true the submit button is enabled even if the body is empty.
   * Useful when the parent tracks additional state (e.g. selected presets)
   * that makes an empty body valid.
   */
  canSubmitEmpty?: boolean;
  /** Initial body text (for editing existing comments). */
  initialBody?: string;
  /** Initial image attachments (for editing existing comments). */
  initialImages?: PromptImagePart[];
  /** Whether users can attach images to the comment. */
  allowImages?: boolean;
  /** Insert image markdown at the cursor instead of appending attachments. */
  insertImagesInBody?: boolean;
  /** Whether submit is in progress. */
  isSubmitting?: boolean;
  /** Whether to show cancel action. */
  showCancel?: boolean;
  /** People available for @ mention insertion. */
  mentionOptions?: MentionOption[];
  onSearchMentions?: (query: string) => Promise<MentionOption[]>;
  /** Called when the draft body text changes (for external persistence). */
  onBodyChange?: (body: string) => void;
  /** Called when body + attachments become empty/non-empty. */
  onEmptyChange?: (isEmpty: boolean) => void;
}) {
  const [body, setBodyRaw] = useState(initialBody);

  const setBody = useCallback(
    (value: string | ((prev: string) => string)) => {
      setBodyRaw((prev) => {
        const next = typeof value === 'function' ? value(prev) : value;
        onBodyChange?.(next);
        return next;
      });
    },
    [onBodyChange],
  );
  const [images, setImages] = useState<InlineComposerImage[]>(initialImages);
  const imagePreviewUrls = useImagePreviewUrls(images);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<InlineComposerImage[]>(initialImages);
  const imageTokenCounterRef = useRef(0);
  const bindingId = useId();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const lineLabel = formatLineRangeLabel(lineStart, lineEnd);

  const insertTextAtCursor = useCallback(
    (text: string) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        setBody((current) => `${current}${current ? '\n\n' : ''}${text}`);
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      setBody(
        (current) => `${current.slice(0, start)}${text}${current.slice(end)}`,
      );
      requestAnimationFrame(() => {
        textarea.focus();
        const cursor = start + text.length;
        textarea.setSelectionRange(cursor, cursor);
      });
    },
    [setBody],
  );

  const handleImageAttach = useCallback(
    (image: PromptImagePart) => {
      if (!allowImages || isSubmitting) return;
      if (imagesRef.current.length >= MAX_IMAGES) return;

      let nextImage: InlineComposerImage = image;

      if (insertImagesInBody) {
        imageTokenCounterRef.current += 1;
        const token = imageTokenCounterRef.current;
        const extension = image.mimeType.split('/')[1] || 'png';
        const fileName = image.filename || `image-${token}.${extension}`;
        const safeAltText = fileName.replace(/[[\]()\\]/g, '_');
        const placeholderMarkdown = `![${safeAltText}](jc-image://${token}${getPromptImageMarkdownSize(image)})`;

        insertTextAtCursor(placeholderMarkdown);
        nextImage = { ...image, placeholderMarkdown };
      }

      const nextImages = [...imagesRef.current, nextImage];
      imagesRef.current = nextImages;
      setImages(nextImages);
    },
    [allowImages, insertImagesInBody, insertTextAtCursor, isSubmitting],
  );

  const handleImageRemove = useCallback(
    (index: number) => {
      if (isSubmitting) return;
      const image = imagesRef.current[index];
      if (image?.placeholderMarkdown) {
        const pattern = markdownImagePlaceholderPattern(image.placeholderMarkdown);
        setBody((current) =>
          pattern ? current.replace(pattern, '') : current,
        );
      }

      const nextImages = imagesRef.current.filter((_, i) => i !== index);
      imagesRef.current = nextImages;
      setImages(nextImages);
    },
    [isSubmitting, setBody],
  );

  const handleSubmit = useCallback(() => {
    if (isSubmitting) return;
    const trimmed = body.trim();
    if (!trimmed && images.length === 0 && !canSubmitEmpty) return;
    onSubmit(trimmed, images);
  }, [body, images, canSubmitEmpty, isSubmitting, onSubmit]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!allowImages || isSubmitting) return;
      const files = Array.from(e.clipboardData.files);
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      const nextVideoFile = files.find(isVideoFile);
      if (imageFiles.length === 0 && !nextVideoFile) return;
      e.preventDefault();
      const allowed = MAX_IMAGES - images.length;
      for (const file of imageFiles.slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
      if (nextVideoFile && allowed > imageFiles.length)
        setVideoFile(nextVideoFile);
    },
    [allowImages, images.length, handleImageAttach, isSubmitting],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!allowImages || isSubmitting) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      const nextVideoFile = files.find(isVideoFile);
      const allowed = MAX_IMAGES - images.length;
      for (const file of imageFiles.slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
      if (nextVideoFile && allowed > imageFiles.length)
        setVideoFile(nextVideoFile);
    },
    [allowImages, images.length, handleImageAttach, isSubmitting],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!allowImages) return;
      e.preventDefault();
    },
    [allowImages],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!allowImages || isSubmitting) return;
      const files = Array.from(e.target.files ?? []);
      const nextVideoFile = files.find(isVideoFile);
      const allowed = MAX_IMAGES - images.length;
      for (const file of files
        .filter((f) => f.type.startsWith('image/'))
        .slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
      if (nextVideoFile && allowed > 0) setVideoFile(nextVideoFile);
      e.target.value = '';
    },
    [allowImages, images.length, handleImageAttach, isSubmitting],
  );

  // Register cmd+enter and escape at the top of the keyboard binding stack.
  // Because the LIFO stack checks most-recently-registered first, these
  // bindings take priority over the overlay's cmd+enter while this component
  // is mounted. Each handler only fires when the composer textarea is focused.
  useRegisterKeyboardBindings(`inline-comment-composer-${bindingId}`, {
    'cmd+enter': () => {
      if (document.activeElement !== textareaRef.current) return false;
      handleSubmit();
      return true;
    },
    escape: () => {
      if (isSubmitting) return true;
      onCancel();
      return true;
    },
  });

  const isDisabled =
    isSubmitting || (!body.trim() && images.length === 0 && !canSubmitEmpty);
  useEffect(() => {
    onEmptyChange?.(!body.trim() && images.length === 0);
  }, [body, images.length, onEmptyChange]);

  const debouncedPreviewBody = useDebouncedValue(body, 300);
  const previewMarkdown = useMemo(
    () =>
      markdownWithLocalImages(
        debouncedPreviewBody,
        images,
        imagePreviewUrls,
      ),
    [debouncedPreviewBody, images, imagePreviewUrls],
  );

  return (
    <div className="flex flex-col gap-2">
      {lineStart > 0 && (
        <span
          className="font-mono text-[10px]"
          style={{ color: COMMENT_ACCENT.text }}
        >
          {lineLabel}
        </span>
      )}

      {renderBeforeTextarea}

      <MentionTextarea
        ref={textareaRef}
        className={MENTION_TEXTAREA_CLASS}
        value={body}
        onChange={setBody}
        mentionOptions={mentionOptions}
        onSearchMentions={onSearchMentions}
        placeholder={placeholder}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        disabled={isSubmitting}
        minHeight={60}
      />

      <ComposerMarkdownPreview markdown={previewMarkdown} />

      <ImageAttachments
        images={images}
        previewUrls={imagePreviewUrls}
        onRemove={isSubmitting ? undefined : handleImageRemove}
      />

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
        {allowImages && (
          <>
            <button
              type="button"
              className="text-ink-3 hover:text-ink-1 p-1"
              onClick={() => fileInputRef.current?.click()}
              disabled={images.length >= MAX_IMAGES || isSubmitting}
              title="Attach image"
            >
              <ImagePlus className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />
          </>
        )}
        {showCancel && (
          <button
            type="button"
            className="text-ink-3 hover:text-ink-1 rounded px-2 py-1 text-xs"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </button>
        )}
        {typeof renderAfterActions === 'function'
          ? renderAfterActions({
              body,
              images,
              isSubmitting,
              isDisabled,
            })
          : renderAfterActions}
      </div>
      <VideoGifConverter
        file={videoFile}
        onAttach={handleImageAttach}
        onClose={() => setVideoFile(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineCommentBubble — shared comment display
// ---------------------------------------------------------------------------

const EMPTY_IMAGES: PromptImagePart[] = [];

function InlineCommentEditComposer({
  body,
  initialImages,
  onSave,
  onCancel,
}: {
  body: string;
  initialImages: PromptImagePart[];
  onSave: (body: string, images: PromptImagePart[]) => void;
  onCancel: () => void;
}) {
  const [editBody, setEditBody] = useState(body);
  const [editImages, setEditImages] =
    useState<PromptImagePart[]>(initialImages);
  const editImagePreviewUrls = useImagePreviewUrls(editImages);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bindingId = useId();

  const handleImageAttach = useCallback((image: PromptImagePart) => {
    setEditImages((current) =>
      current.length < MAX_IMAGES ? [...current, image] : current,
    );
  }, []);

  const handleImageRemove = useCallback((index: number) => {
    setEditImages((current) =>
      current.filter((_, imageIndex) => imageIndex !== index),
    );
  }, []);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = Array.from(event.clipboardData.files);
      const imageFiles = files.filter((file) =>
        file.type.startsWith('image/'),
      );
      const nextVideoFile = files.find(isVideoFile);
      if (imageFiles.length === 0 && !nextVideoFile) return;
      event.preventDefault();
      const allowed = MAX_IMAGES - editImages.length;
      for (const file of imageFiles.slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
      if (nextVideoFile && allowed > imageFiles.length)
        setVideoFile(nextVideoFile);
    },
    [editImages.length, handleImageAttach],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      const imageFiles = files.filter((file) =>
        file.type.startsWith('image/'),
      );
      const nextVideoFile = files.find(isVideoFile);
      const allowed = MAX_IMAGES - editImages.length;
      for (const file of imageFiles.slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
      if (nextVideoFile && allowed > imageFiles.length)
        setVideoFile(nextVideoFile);
    },
    [editImages.length, handleImageAttach],
  );

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      const nextVideoFile = files.find(isVideoFile);
      const allowed = MAX_IMAGES - editImages.length;
      for (const file of files
        .filter((item) => item.type.startsWith('image/'))
        .slice(0, allowed)) {
        void processImageFile(file, handleImageAttach);
      }
      if (nextVideoFile && allowed > 0) setVideoFile(nextVideoFile);
      event.target.value = '';
    },
    [editImages.length, handleImageAttach],
  );

  const save = useCallback(() => {
    const trimmed = editBody.trim();
    const imagesChanged =
      editImages.length !== initialImages.length ||
      editImages.some((image, index) => image !== initialImages[index]);
    if (
      (!trimmed && editImages.length === 0) ||
      (!imagesChanged && trimmed === body)
    ) {
      onCancel();
      return;
    }
    onSave(trimmed, editImages);
  }, [body, editBody, editImages, initialImages, onCancel, onSave]);

  const debouncedPreviewBody = useDebouncedValue(editBody, 300);
  const previewMarkdown = useMemo(
    () =>
      markdownWithLocalImages(
        debouncedPreviewBody,
        editImages,
        editImagePreviewUrls,
      ),
    [debouncedPreviewBody, editImages, editImagePreviewUrls],
  );

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useRegisterKeyboardBindings(`inline-comment-edit-${bindingId}`, {
    'cmd+enter': () => {
      if (document.activeElement !== textareaRef.current) return false;
      save();
      return true;
    },
    escape: () => {
      onCancel();
      return true;
    },
  });

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={textareaRef}
        className="bg-bg-2 text-ink-1 border-stroke-1 min-h-[48px] w-full resize-y rounded border px-2 py-1.5 text-xs focus:outline-none"
        value={editBody}
        onChange={(event) => setEditBody(event.target.value)}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(event) => event.preventDefault()}
      />
      <ComposerMarkdownPreview markdown={previewMarkdown} />
      <ImageAttachments
        images={editImages}
        previewUrls={editImagePreviewUrls}
        onRemove={handleImageRemove}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="bg-acc text-acc-ink inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
          onClick={save}
          disabled={
            (!editBody.trim() && editImages.length === 0) ||
            (editBody.trim() === body &&
              editImages.length === initialImages.length &&
              editImages.every(
                (image, index) => image === initialImages[index],
              ))
          }
        >
          Save
          <kbd className="rounded bg-white/20 px-1 py-px font-mono text-[9px]">
            {'\u2318\u21B5'}
          </kbd>
        </button>
        <button
          type="button"
          className="text-ink-3 hover:text-ink-1 p-1"
          onClick={() => fileInputRef.current?.click()}
          disabled={editImages.length >= MAX_IMAGES}
          title="Attach image"
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
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
      </div>
      <VideoGifConverter
        file={videoFile}
        onAttach={handleImageAttach}
        onClose={() => setVideoFile(null)}
      />
    </div>
  );
}

export function InlineCommentBubble({
  lineStart,
  lineEnd,
  body,
  images,
  selectedText,
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
  /** Quoted text from the original content this comment was anchored to */
  selectedText?: string;
  onRemove?: () => void;
  /** Called with the new body text and images when the user saves an edit. */
  onEdit?: (newBody: string, newImages: PromptImagePart[]) => void;
  /** Extra elements in the header row (e.g. status pill, preset tags). */
  renderHeaderExtras?: ReactNode;
  /** Extra action buttons rendered alongside the default edit/remove buttons. */
  renderExtraActions?: ReactNode;
  /** Rendered below the body (e.g. agent response note). */
  renderFooter?: ReactNode;
}) {
  const currentImages = images ?? EMPTY_IMAGES;
  const lineLabel = formatLineRangeLabel(lineStart, lineEnd);
  const [isEditing, setIsEditing] = useState(false);
  const displayedImagePreviewUrls = useImagePreviewUrls(
    isEditing ? EMPTY_IMAGES : currentImages,
  );

  const startEditing = useCallback(() => {
    setIsEditing(true);
  }, []);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
  }, []);

  const saveEdit = useCallback((newBody: string, newImages: PromptImagePart[]) => {
    onEdit?.(newBody, newImages);
    setIsEditing(false);
  }, [onEdit]);

  return (
    <div className="group/bubble flex items-start gap-2 rounded px-3 py-1.5">
      {!selectedText && (
        <div
          className="mt-1 h-3 w-0.5 shrink-0 rounded-full"
          style={{ background: COMMENT_ACCENT.bar }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {lineStart > 0 && (
            <span
              className="mr-2 font-mono text-[10px]"
              style={{ color: COMMENT_ACCENT.text }}
            >
              {lineLabel}
            </span>
          )}
          {renderHeaderExtras}
          <div className="flex-1" />
          {!isEditing && (onEdit || onRemove || renderExtraActions) && (
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/bubble:opacity-100">
              {onEdit && (
                <button
                  type="button"
                  aria-label="Edit comment"
                  className="text-ink-4 hover:text-ink-1 mt-0.5 shrink-0"
                  onClick={startEditing}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  aria-label="Remove comment"
                  className="text-ink-4 hover:text-ink-1 mt-0.5 shrink-0"
                  onClick={onRemove}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {renderExtraActions}
            </div>
          )}
        </div>
        {isEditing ? (
          <InlineCommentEditComposer
            body={body}
            initialImages={currentImages}
            onSave={saveEdit}
            onCancel={cancelEditing}
          />
        ) : (
          <>
            {selectedText && (
              <div
                className="text-ink-3 mb-1 border-l-2 pl-2 font-mono text-[10px] italic"
                style={{ borderColor: COMMENT_ACCENT.barSoft }}
              >
                <span className="line-clamp-2">{selectedText}</span>
              </div>
            )}
            <div className="text-ink-0 text-xs whitespace-pre-wrap">{body}</div>
            <ImageAttachments
              images={currentImages}
              previewUrls={displayedImagePreviewUrls}
              className="mt-1.5"
            />
          </>
        )}
        {renderFooter}
      </div>
    </div>
  );
}
