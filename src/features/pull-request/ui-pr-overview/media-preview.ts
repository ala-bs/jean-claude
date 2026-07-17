import type { PromptImagePart } from '@shared/agent-backend-types';

import {
  markdownImagePlaceholderPattern,
  replaceMarkdownImageUrl,
} from '@/lib/markdown-image-size';

type DescriptionImage = PromptImagePart & {
  placeholderMarkdown: string;
};

export function descriptionPreviewMarkdown(
  markdown: string,
  images: DescriptionImage[],
  previewUrls: (string | undefined)[],
) {
  return images.reduce((current, image, index) => {
    const pattern = markdownImagePlaceholderPattern(image.placeholderMarkdown);
    if (!pattern) return current;

    const previewUrl = previewUrls[index];
    if (previewUrl) {
      return current.replace(pattern, (match) =>
        replaceMarkdownImageUrl(match, previewUrl),
      );
    }

    const mediaType = image.mimeType === 'image/gif' ? 'GIF' : 'image';
    return current.replace(
      pattern,
      `_[Attached ${mediaType}: ${image.filename ?? mediaType}]_`,
    );
  }, markdown);
}
