import { Send } from 'lucide-react';
import type { ChangeEvent, FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/common/ui/button';
import { Textarea } from '@/common/ui/textarea';
import {
  COMMENT_ACCENT,
  InlineCommentComposer,
} from '@/features/common/ui-inline-comments';
import type { PromptImagePart } from '@shared/agent-backend-types';

function imageFileName(image: PromptImagePart, index: number) {
  if (image.filename) return image.filename;

  const extension = image.mimeType.split('/')[1] || 'png';
  return `image-${index + 1}.${extension}`;
}

function escapeMarkdownAltText(value: string) {
  return value.replace(/[[\]()\\]/g, '_');
}

export function PrCommentForm({
  onSubmit,
  onCancel,
  lineStart,
  lineEnd,
  isSubmitting,
  placeholder = 'Add a comment...',
  uploadImage,
}: {
  onSubmit: (content: string) => void;
  onCancel?: () => void;
  lineStart?: number;
  lineEnd?: number;
  isSubmitting?: boolean;
  placeholder?: string;
  uploadImage?: (image: PromptImagePart, fileName: string) => Promise<string>;
}) {
  const [content, setContent] = useState('');
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const submitTokenRef = useRef(0);

  useEffect(() => {
    return () => {
      submitTokenRef.current += 1;
    };
  }, []);

  const isBusy = isSubmitting || isUploadingImages;

  const submitWithImages = async (body: string, images: PromptImagePart[]) => {
    const submitToken = submitTokenRef.current;
    setError(null);

    if (images.length === 0 || !uploadImage) {
      onSubmit(body);
      setComposerKey((current) => current + 1);
      return;
    }

    setIsUploadingImages(true);
    try {
      const markdownImages = await Promise.all(
        images.map(async (image, index) => {
          const fileName = imageFileName(image, index);
          const url = await uploadImage(image, fileName);
          return `![${escapeMarkdownAltText(fileName)}](${url})`;
        }),
      );
      if (submitToken !== submitTokenRef.current) return;

      const separator = body.trim() ? '\n\n' : '';
      onSubmit(`${body.trimEnd()}${separator}${markdownImages.join('\n\n')}`);
      setComposerKey((current) => current + 1);
    } catch (submitError) {
      if (submitToken !== submitTokenRef.current) return;
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Failed to upload image',
      );
    } finally {
      if (submitToken === submitTokenRef.current) {
        setIsUploadingImages(false);
      }
    }
  };

  const handleCancel = () => {
    submitTokenRef.current += 1;
    setIsUploadingImages(false);
    setError(null);
    onCancel?.();
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (content.trim() && !isBusy) {
      onSubmit(content.trim());
      setContent('');
    }
  };

  if (!uploadImage && (lineStart === undefined || !onCancel)) {
    return (
      <form onSubmit={handleSubmit} className="flex gap-2">
        <Textarea
          value={content}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
            setContent(e.target.value)
          }
          placeholder={placeholder}
          className="flex-1"
          rows={2}
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
          {isBusy ? 'Sending...' : 'Send'}
        </Button>
      </form>
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
          onSubmit={(body, images) => void submitWithImages(body, images)}
          onCancel={handleCancel}
          placeholder={placeholder}
          submitLabel={isBusy ? 'Sending...' : 'Add comment'}
          allowImages={!!uploadImage}
          isSubmitting={isBusy}
          showCancel={!!onCancel}
        />
        {error && <p className="text-status-fail mt-2 text-xs">{error}</p>}
      </div>
    </div>
  );
}
