/* eslint-disable sort-imports */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Send } from 'lucide-react';



import {
  COMMENT_ACCENT,
  InlineCommentComposer,
} from '@/features/common/ui-inline-comments';
import {
  EMPTY_MENTION_OPTIONS,
  encodeMentionDisplayNames,
  MENTION_TEXTAREA_MD_CLASS,
  type MentionOption,
  MentionTextarea,
} from '@/common/ui/mention-textarea';
import {
  getPromptImageMarkdownSize,
  markdownImagePlaceholderPattern,
  replaceMarkdownImageUrl,
} from '@/lib/markdown-image-size';
import { Button } from '@/common/ui/button';
import {
  createPromptImageUploadCache,
  type PromptImageUploadCache,
} from '@/lib/prompt-image-upload-cache';
import type { PromptImagePart } from '@shared/agent-backend-types';



function imageFileName(image: PromptImagePart, index: number) {
  if (image.filename) return image.filename;

  const extension = image.mimeType.split('/')[1] || 'png';
  return `image-${index + 1}.${extension}`;
}

function escapeMarkdownAltText(value: string) {
  return value.replace(/[[\]()\\]/g, '_');
}

function getPlaceholderMarkdown(image: PromptImagePart) {
  return 'placeholderMarkdown' in image &&
    typeof image.placeholderMarkdown === 'string'
    ? image.placeholderMarkdown
    : null;
}

export async function uploadImagesIntoMarkdown({
  body,
  images,
  uploadImage,
  uploadCache,
  mentionOptions,
}: {
  body: string;
  images: PromptImagePart[];
  uploadImage?: (image: PromptImagePart, fileName: string) => Promise<string>;
  uploadCache?: PromptImageUploadCache;
  mentionOptions?: MentionOption[];
}) {
  const encodedBody = encodeMentionDisplayNames(body, mentionOptions ?? []);

  if (images.length === 0 || !uploadImage) return encodedBody;

  let contentWithImages = encodedBody.trimEnd();
  const attachedMarkdownImages: string[] = [];

  const uploadedImages = await Promise.all(
    images.map(async (image, index) => {
      const placeholderMarkdown = getPlaceholderMarkdown(image);
      const pattern = placeholderMarkdown
        ? markdownImagePlaceholderPattern(placeholderMarkdown)
        : null;
      if (pattern && !encodedBody.match(pattern)) {
        return;
      }

      const fileName = imageFileName(image, index);
      const url = uploadCache
        ? await uploadCache.resolve({
            image,
            fileName,
            upload: () => uploadImage(image, fileName),
          })
        : await uploadImage(image, fileName);
      const markdownImage = `![${escapeMarkdownAltText(fileName)}](${url}${getPromptImageMarkdownSize(image)})`;
      return { markdownImage, pattern, url };
    }),
  );

  for (const uploadedImage of uploadedImages) {
    if (!uploadedImage) continue;
    if (uploadedImage.pattern) {
      contentWithImages = contentWithImages.replace(
        uploadedImage.pattern,
        (match) => replaceMarkdownImageUrl(match, uploadedImage.url),
      );
      continue;
    }

    attachedMarkdownImages.push(uploadedImage.markdownImage);
  }

  const separator =
    contentWithImages.trim() && attachedMarkdownImages.length ? '\n\n' : '';
  return `${contentWithImages}${separator}${attachedMarkdownImages.join('\n\n')}`;
}

export function PrCommentForm({
  onSubmit,
  onCancel,
  lineStart,
  lineEnd,
  isSubmitting,
  placeholder = 'Add a comment...',
  uploadImage,
  mentionOptions = EMPTY_MENTION_OPTIONS,
  onSearchMentions,
  initialBody,
  onBodyChange,
  submitLabel,
  onAskAgent,
}: {
  onSubmit: (content: string) => Promise<void> | void;
  onCancel?: () => void;
  lineStart?: number;
  lineEnd?: number;
  isSubmitting?: boolean;
  placeholder?: string;
  uploadImage?: (image: PromptImagePart, fileName: string) => Promise<string>;
  mentionOptions?: MentionOption[];
  onSearchMentions?: (query: string) => Promise<MentionOption[]>;
  /** Initial body text for draft persistence. */
  initialBody?: string;
  /** Called when body text changes for draft persistence. */
  onBodyChange?: (body: string) => void;
  submitLabel?: string;
  onAskAgent?: (question: string) => Promise<void> | void;
}) {
  const [content, setContent] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [isAskingAgent, setIsAskingAgent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const submitTokenRef = useRef(0);
  const submitInFlightRef = useRef(false);
  const uploadedImageUrlsRef = useRef(createPromptImageUploadCache());

  useEffect(() => {
    const uploadCache = uploadedImageUrlsRef.current;
    return () => {
      submitTokenRef.current += 1;
      uploadCache.clear();
    };
  }, []);

  const isBusy = isSubmitting || isSubmittingComment || isAskingAgent;

  const handleAskAgent = async (body: string) => {
    if (!onAskAgent || isBusy) return;
    const question = body.trim();
    if (!question) return;

    const submitToken = submitTokenRef.current;
    setError(null);
    setIsAskingAgent(true);
    try {
      await onAskAgent(question);
      if (submitToken !== submitTokenRef.current) return;
      uploadedImageUrlsRef.current.clear();
      setComposerKey((current) => current + 1);
    } catch (askError) {
      if (submitToken !== submitTokenRef.current) return;
      setError(
        askError instanceof Error ? askError.message : 'Failed to ask agent',
      );
    } finally {
      if (submitToken === submitTokenRef.current) {
        setIsAskingAgent(false);
      }
    }
  };

  const submitWithImages = async (body: string, images: PromptImagePart[]) => {
    if (isBusy || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    const submitToken = submitTokenRef.current;
    setError(null);
    setIsSubmittingComment(true);
    try {
      let finalContent = encodeMentionDisplayNames(body, mentionOptions);
      if (images.length > 0 && uploadImage) {
        finalContent = await uploadImagesIntoMarkdown({
          body,
          images,
          uploadImage,
          uploadCache: uploadedImageUrlsRef.current,
          mentionOptions,
        });
      }
      if (submitToken !== submitTokenRef.current) return;
      if (!finalContent.trim()) {
        setError('Add a comment or insert an image.');
        return;
      }

      if (finalContent.includes('jc-image://')) {
        setError('Remove incomplete image placeholders before sending.');
        return;
      }

      const submission = onSubmit(finalContent);
      if (submission) await submission;
      if (submitToken !== submitTokenRef.current) return;
      uploadedImageUrlsRef.current.clear();
      setComposerKey((current) => current + 1);
    } catch (submitError) {
      if (submitToken !== submitTokenRef.current) return;
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Failed to submit comment',
      );
    } finally {
      if (submitToken === submitTokenRef.current) {
        submitInFlightRef.current = false;
        setIsSubmittingComment(false);
      }
    }
  };

  const handleCancel = () => {
    submitTokenRef.current += 1;
    submitInFlightRef.current = false;
    uploadedImageUrlsRef.current.clear();
    setIsSubmittingComment(false);
    setError(null);
    onCancel?.();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!content.trim() || isBusy || submitInFlightRef.current) return;

    submitInFlightRef.current = true;
    const submitToken = submitTokenRef.current;
    setError(null);
    setIsSubmittingComment(true);
    try {
      const submission = onSubmit(
        encodeMentionDisplayNames(content.trim(), mentionOptions),
      );
      if (submission) await submission;
      if (submitToken !== submitTokenRef.current) return;
      uploadedImageUrlsRef.current.clear();
      setContent('');
    } catch (submitError) {
      if (submitToken !== submitTokenRef.current) return;
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Failed to submit comment',
      );
    } finally {
      if (submitToken === submitTokenRef.current) {
        submitInFlightRef.current = false;
        setIsSubmittingComment(false);
      }
    }
  };

  if (!uploadImage && (lineStart === undefined || !onCancel)) {
    return (
      <div>
        <form onSubmit={(event) => void handleSubmit(event)} className="flex gap-2">
          <MentionTextarea
            value={content}
            onChange={setContent}
            mentionOptions={mentionOptions}
            onSearchMentions={onSearchMentions}
            placeholder={placeholder}
            className={MENTION_TEXTAREA_MD_CLASS}
            minHeight={58}
            disabled={isBusy}
          />
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!content.trim() || isBusy}
            icon={<Send />}
            className="self-end"
          >
            {isBusy ? 'Sending...' : (submitLabel ?? 'Send')}
          </Button>
        </form>
        {error && <p className="text-status-fail mt-2 text-xs">{error}</p>}
      </div>
    );
  }

  return (
    <div
      style={{
        background: COMMENT_ACCENT.bgLight,
        borderTop: `1px solid ${COMMENT_ACCENT.borderStrong}`,
        borderBottom: `1px solid ${COMMENT_ACCENT.borderStrong}`,
      }}
    >
      <div className="px-3 py-2.5">
        <InlineCommentComposer
          key={composerKey}
          lineStart={lineStart ?? 0}
          lineEnd={lineEnd}
          initialBody={initialBody}
          onSubmit={(body, images) => void submitWithImages(body, images)}
          onCancel={handleCancel}
          placeholder={placeholder}
          submitLabel={isBusy ? 'Sending...' : (submitLabel ?? 'Add comment')}
          allowImages={!!uploadImage}
          insertImagesInBody={!!uploadImage}
          isSubmitting={isBusy}
          showCancel={!!onCancel}
          mentionOptions={mentionOptions}
          onSearchMentions={onSearchMentions}
          onBodyChange={onBodyChange}
          renderAfterActions={
            onAskAgent
              ? ({ body, isDisabled }) => (
                  <button
                    type="button"
                    className="border-glass-border/70 text-ink-2 hover:text-ink-0 rounded border px-2 py-1 text-xs disabled:opacity-50"
                    onClick={() => void handleAskAgent(body)}
                    disabled={isDisabled || isAskingAgent || !body.trim()}
                  >
                    {isAskingAgent ? 'Asking...' : 'Ask Agent'}
                  </button>
                )
              : undefined
          }
        />
        {error && <p className="text-status-fail mt-2 text-xs">{error}</p>}
      </div>
    </div>
  );
}
