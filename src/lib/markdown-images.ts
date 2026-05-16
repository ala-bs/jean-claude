import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

export type ExtractedMarkdownImage = {
  src: string;
  alt: string;
};

export type ExtractedMarkdownContent = {
  contentWithoutImages: string;
  images: ExtractedMarkdownImage[];
};

type MarkdownNode = {
  type: string;
  alt?: string | null;
  children?: MarkdownNode[];
  identifier?: string;
  label?: string | null;
  url?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

function getNodeRange(
  node: MarkdownNode,
): { start: number; end: number } | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;

  if (start === undefined || end === undefined) {
    return null;
  }

  return { start, end };
}

function isImageOnlyLink(node: MarkdownNode): boolean {
  if (
    (node.type !== 'link' && node.type !== 'linkReference') ||
    !node.children ||
    node.children.length === 0
  ) {
    return false;
  }

  return node.children.every(
    (child) => child.type === 'image' || child.type === 'imageReference',
  );
}

function mergeRemovals(removals: Array<{ start: number; end: number }>): Array<{
  start: number;
  end: number;
}> {
  if (removals.length === 0) {
    return removals;
  }

  const merged = [{ ...removals[0] }];

  for (const removal of removals.slice(1)) {
    const previous = merged[merged.length - 1];

    if (removal.start <= previous.end) {
      previous.end = Math.max(previous.end, removal.end);
      continue;
    }

    merged.push({ ...removal });
  }

  return merged;
}

export function extractImagesFromMarkdown(
  content: string,
): ExtractedMarkdownContent {
  const images: ExtractedMarkdownImage[] = [];
  const removals: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  const definitions = new Map<string, string>();
  const imageReferenceUsageCounts = new Map<string, number>();
  const linkReferenceUsageCounts = new Map<string, number>();
  const removedLinkReferenceUsageCounts = new Map<string, number>();

  const incrementUsage = (counts: Map<string, number>, identifier: string) => {
    counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
  };

  const addImage = ({ src, alt }: ExtractedMarkdownImage) => {
    const normalizedSrc = src.trim();
    if (!normalizedSrc) return;

    const key = `${normalizedSrc}::${alt}`;
    if (seen.has(key)) return;

    seen.add(key);
    images.push({ src: normalizedSrc, alt });
  };

  const tree = unified().use(remarkParse).parse(content);

  visit(tree as never, (node) => {
    const markdownNode = node as MarkdownNode;

    if (
      markdownNode.type === 'definition' &&
      markdownNode.identifier &&
      markdownNode.url
    ) {
      definitions.set(markdownNode.identifier, markdownNode.url);
      return;
    }

    if (!markdownNode.identifier) {
      return;
    }

    if (markdownNode.type === 'imageReference') {
      incrementUsage(imageReferenceUsageCounts, markdownNode.identifier);
      return;
    }

    if (markdownNode.type === 'linkReference') {
      incrementUsage(linkReferenceUsageCounts, markdownNode.identifier);
    }
  });

  visit(tree as never, (node) => {
    const markdownNode = node as MarkdownNode;

    if (isImageOnlyLink(markdownNode)) {
      const linkRange = getNodeRange(markdownNode);
      if (!linkRange) {
        return;
      }

      for (const child of markdownNode.children ?? []) {
        if (child.type === 'image' && child.url) {
          addImage({ src: child.url, alt: (child.alt ?? '').trim() });
          continue;
        }

        if (child.type === 'imageReference' && child.identifier) {
          const definitionUrl = definitions.get(child.identifier);
          if (definitionUrl) {
            addImage({
              src: definitionUrl,
              alt: (child.alt ?? child.label ?? '').trim(),
            });
          }
        }
      }

      if (markdownNode.type === 'linkReference' && markdownNode.identifier) {
        incrementUsage(
          removedLinkReferenceUsageCounts,
          markdownNode.identifier,
        );
      }

      removals.push(linkRange);
      return;
    }

    if (markdownNode.type === 'image') {
      const range = getNodeRange(markdownNode);

      if (markdownNode.url && range) {
        addImage({
          src: markdownNode.url,
          alt: (markdownNode.alt ?? '').trim(),
        });
        removals.push(range);
      }

      return;
    }

    if (markdownNode.type === 'imageReference') {
      const range = getNodeRange(markdownNode);
      const definitionUrl = markdownNode.identifier
        ? definitions.get(markdownNode.identifier)
        : undefined;

      if (definitionUrl && range) {
        addImage({
          src: definitionUrl,
          alt: (markdownNode.alt ?? markdownNode.label ?? '').trim(),
        });
        removals.push(range);
      }

      return;
    }

    if (markdownNode.type !== 'definition' || !markdownNode.identifier) {
      return;
    }

    const imageReferenceCount =
      imageReferenceUsageCounts.get(markdownNode.identifier) ?? 0;
    const linkReferenceCount =
      linkReferenceUsageCounts.get(markdownNode.identifier) ?? 0;
    const removedLinkReferenceCount =
      removedLinkReferenceUsageCounts.get(markdownNode.identifier) ?? 0;

    if (
      (imageReferenceCount > 0 || removedLinkReferenceCount > 0) &&
      removedLinkReferenceCount === linkReferenceCount
    ) {
      const range = getNodeRange(markdownNode);
      if (range) {
        removals.push(range);
      }
    }
  });

  const mergedRemovals = mergeRemovals(
    removals.sort((left, right) => left.start - right.start),
  );

  const contentWithoutImages = mergedRemovals.reduce(
    (result, removal, index) => {
      const nextStart =
        index + 1 < mergedRemovals.length
          ? mergedRemovals[index + 1].start
          : content.length;

      return result + content.slice(removal.end, nextStart);
    },
    content.slice(0, mergedRemovals[0]?.start ?? content.length),
  );

  return {
    contentWithoutImages,
    images,
  };
}
