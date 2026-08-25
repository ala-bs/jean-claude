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

/** Matches any unresolved local image placeholder, regardless of token. */
const UNRESOLVED_PLACEHOLDER_RE = /!\[[^\]]*\]\(jc-image:\/\/[^)]*\)/g;

/**
 * Remove image placeholders that were never swapped for a real attachment URL.
 *
 * Posting a `jc-image://` link to a remote host renders as a broken image, so
 * callers strip these before publishing and report how many were dropped.
 */
export function stripUnresolvedImagePlaceholders(markdown: string): {
  text: string;
  removed: number;
} {
  const removed = markdown.match(UNRESOLVED_PLACEHOLDER_RE)?.length ?? 0;
  if (removed === 0) return { text: markdown, removed: 0 };

  const text = markdown
    .replace(UNRESOLVED_PLACEHOLDER_RE, '')
    // Removing a placeholder that sat on its own line leaves a run of blank
    // lines behind; collapse it back to a single paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, removed };
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
