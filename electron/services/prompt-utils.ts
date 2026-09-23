import {
  hasPromptImagePlaceholder,
  renderPromptImagePlaceholders,
  splitPromptTextByImages,
} from '@shared/prompt-image-placeholders';
import type { PromptImagePart, PromptPart } from '@shared/agent-backend-types';

/** Wrap a plain text string as a single-element PromptPart array. */
export function textPrompt(text: string): PromptPart[] {
  return [{ type: 'text', text }];
}

/** Extract concatenated text from a PromptPart array. */
export function getPromptText(parts: PromptPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Extract image parts from a PromptPart array. */
export function getPromptImages(parts: PromptPart[]): PromptImagePart[] {
  return parts.filter((p): p is PromptImagePart => p.type === 'image');
}

/**
 * Reorder parts so each image sits where its `jc-image://` placeholder appeared
 * in the text, replacing the placeholder. Images with no placeholder stay at
 * the end, exactly where they were before this existed.
 *
 * Backends whose wire format is an ordered list of content blocks should run
 * their prompt through this and then map the result as usual, rather than
 * re-implementing the interleave.
 */
export function interleavePromptParts(parts: PromptPart[]): PromptPart[] {
  const images = getPromptImages(parts);
  // Text carrying markers still needs a pass even with no anchored images —
  // a prompt copied from an earlier task brings its markers along, and they
  // must be reduced to labels rather than shipped as dead links.
  if (
    !images.some((image) => image.placeholderToken) &&
    !parts.some(
      (part) => part.type === 'text' && hasPromptImagePlaceholder(part.text),
    )
  ) {
    return parts;
  }

  const placed = new Set<PromptImagePart>();
  const expanded: PromptPart[] = [];

  for (const part of parts) {
    if (part.type !== 'text') continue;
    const { blocks, trailing } = splitPromptTextByImages({
      text: part.text,
      images: images.filter((image) => !placed.has(image)),
    });
    const stillMissing = new Set(trailing);
    for (const image of images) {
      if (!stillMissing.has(image)) placed.add(image);
    }
    for (const block of blocks) {
      expanded.push(
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : block.image,
      );
    }
  }

  // Non-text parts keep their original relative order after the text; images
  // already positioned inline must not appear twice.
  for (const part of parts) {
    if (part.type === 'text') continue;
    if (part.type === 'image' && placed.has(part)) continue;
    expanded.push(part);
  }

  return expanded;
}

function decodeXmlAttr(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attachedFilesPlaceholder(content: string): string {
  const placeholders = [...content.matchAll(/<file\b[^>]*>/g)].map(([tag]) => {
    const filename = tag.match(/\bname="([^"]*)"/)?.[1];
    return filename ? `[file: ${decodeXmlAttr(filename)}]` : '[file]';
  });

  return placeholders.length > 0 ? placeholders.join('\n') : '[file]';
}

export function sanitizeAttachedFilesXml(text: string): string {
  return text
    .replace(
      /<attached_files>\s*([\s\S]*?)\s*<\/attached_files>/g,
      (_, content: string) => attachedFilesPlaceholder(content),
    )
    .replace(/<attached_files>\s*([\s\S]*)$/g, (_, content: string) =>
      attachedFilesPlaceholder(content),
    );
}

const imageLabel = (image: PromptImagePart) =>
  image.filename ? `[image: ${image.filename}]` : '[image]';

/**
 * Prompt text with image placeholders replaced by readable labels. Use for any
 * plain-text surface (queued prompt chips, memory capture) that would otherwise
 * show a raw `jc-image://` link.
 */
export function getPromptDisplayText(parts: PromptPart[]): string {
  return renderPromptImagePlaceholders({
    text: getPromptText(parts),
    images: getPromptImages(parts),
    render: imageLabel,
  }).text;
}

export function buildPromptActivityText(parts: PromptPart[]): string {
  const images = getPromptImages(parts);
  // Placeholders become inline labels in the text, so the images they resolve
  // to must not also be listed at the end. Only images whose placeholder was
  // actually found stay out of the trailing list.
  const stillTrailing = new Set(
    renderPromptImagePlaceholders({
      text: getPromptText(parts),
      images,
      render: imageLabel,
    }).trailing,
  );

  return parts
    .map((part) => {
      if (part.type === 'text') {
        return renderPromptImagePlaceholders({
          text: sanitizeAttachedFilesXml(part.text),
          images,
          render: imageLabel,
        }).text;
      }

      if (part.type === 'image') {
        return stillTrailing.has(part) ? imageLabel(part) : '';
      }

      return part.filename ? `[file: ${part.filename}]` : '[file]';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function buildTaskCreationActivityText({
  prompt,
  images,
}: {
  prompt: string;
  images?: PromptImagePart[] | null;
}): string {
  return buildPromptActivityText([
    { type: 'text', text: prompt },
    ...(images ?? []),
  ]);
}

/**
 * Build a markdown string with images inlined as base64 data URIs.
 * Uses storageData/storageMimeType (AVIF) when available, otherwise falls back
 * to the agent-facing data/mimeType.
 */
function inlineImageMarkdown(
  img: PromptImagePart,
  { useStorageVariant }: { useStorageVariant: boolean },
): string {
  const data = useStorageVariant ? (img.storageData ?? img.data) : img.data;
  const mime = useStorageVariant
    ? (img.storageMimeType ?? img.mimeType)
    : img.mimeType;
  // Sanitize filename to prevent markdown injection via crafted filenames
  const filename = (img.filename || 'image').replace(/[[\]()\\]/g, '_');
  return `![${filename}](data:${mime};base64,${data})`;
}

/**
 * Images the user pasted at a specific point in the prompt are rendered in that
 * slot (their `jc-image://` placeholder is swapped for the data URI); anything
 * without a placeholder falls back to being appended after the text.
 */
function buildMarkdown(
  parts: PromptPart[],
  { useStorageVariant }: { useStorageVariant: boolean },
): string {
  const render = (img: PromptImagePart) =>
    inlineImageMarkdown(img, { useStorageVariant });

  const { text, trailing } = renderPromptImagePlaceholders({
    text: getPromptText(parts),
    images: getPromptImages(parts),
    render,
  });

  const sections: string[] = [];
  if (text) sections.push(text);
  for (const img of trailing) sections.push(render(img));

  return sections.join('\n\n');
}

export function buildPromptMarkdown(parts: PromptPart[]): string {
  return buildMarkdown(parts, { useStorageVariant: true });
}

/** Build markdown from the exact prompt data sent to agent backends. */
export function buildAgentPromptMarkdown(parts: PromptPart[]): string {
  return buildMarkdown(parts, { useStorageVariant: false });
}
