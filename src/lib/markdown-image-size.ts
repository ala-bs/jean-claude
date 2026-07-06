import type { PromptImagePart } from '@shared/agent-backend-types';


export function getImageDisplayWidth(width: number, height: number): number {
  const aspectRatio = width / Math.max(height, 1);
  if (aspectRatio < 0.75) return Math.min(width, 280);
  if (aspectRatio > 1.6) return Math.min(width, 640);
  return Math.min(width, 420);
}

export function getPromptImageMarkdownSize(image: PromptImagePart): string {
  if (!image.width || !image.height) return '';

  return ` =${getImageDisplayWidth(image.width, image.height)}x`;
}

export function getMarkdownImageSizeSuffix(markdownImage: string): string {
  const target = markdownImage.match(/\(([^)]*)\)$/)?.[1] ?? '';
  return target.match(/\s+=\d+x\d*\s*$/)?.[0].trimEnd() ?? '';
}

export function replaceMarkdownImageUrl(
  markdownImage: string,
  url: string,
): string {
  return markdownImage.replace(
    /\([^)]*\)$/,
    `(${url}${getMarkdownImageSizeSuffix(markdownImage)})`,
  );
}

export function markdownImagePlaceholderPattern(placeholderMarkdown: string) {
  const token = placeholderMarkdown.match(/jc-image:\/\/([^\s)]+)/)?.[1];
  return token
    ? new RegExp(
        `!\\[[^\\]]*\\]\\(jc-image:\\/\\/${token}(?:\\s+=\\d+x\\d*)?\\)`,
        'g',
      )
    : null;
}
