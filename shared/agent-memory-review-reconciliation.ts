import type {
  AgentMemoryPromptCapture,
  AgentMemoryTaskReviewCapture,
} from './agent-memory-types';

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/&#(\d+);/g, (entity, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function readAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'),
  );
  return match ? decodeXmlEntities(match[2]) : undefined;
}

function readInstruction(commentXml: string): string | undefined {
  const instruction = readElement(commentXml, 'instruction');
  if (instruction === undefined) return undefined;
  const lines = instruction.split('\n');
  if (lines.at(-1)?.trim() === '[see attached image]') lines.pop();
  return lines.join('\n').trim();
}

function readElement(xml: string, tag: string): string | undefined {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  return match ? decodeXmlEntities(match[1]).trim() : undefined;
}

function readElementContent(xml: string, tag: string): string | undefined {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  if (!match) return undefined;
  return decodeXmlEntities(match[1])
    .replace(/^\r?\n/, '')
    .replace(/\r?\n\s*$/, '');
}

function parseLineRange(value: string | undefined): {
  lineStart: number;
  lineEnd: number;
} | null {
  if (!value) return null;
  const match = value.match(/^L(\d+)(?:-L?(\d+))?$/i);
  if (!match) return null;
  const lineStart = Number.parseInt(match[1], 10);
  const lineEnd = Number.parseInt(match[2] ?? match[1], 10);
  if (lineStart < 1 || lineEnd < lineStart) return null;
  return { lineStart, lineEnd };
}

type ParsedReviewComment = {
  commentId: string | undefined;
  body: string | undefined;
  type: string | undefined;
  filePath: string | undefined;
  lineRange: { lineStart: number; lineEnd: number } | null;
  hasLineRange: boolean;
  selectedText: string | undefined;
  presets: string[] | undefined;
};

function parseReviewComments(content: string): {
  hasReviewXml: boolean;
  comments: ParsedReviewComment[];
} {
  const reviewBlocks = [
    ...content.matchAll(
      /<user_review(?:\s[^>]*)?>([\s\S]*?)<\/user_review>/gi,
    ),
  ];
  const comments: ParsedReviewComment[] = [];
  for (const reviewBlock of reviewBlocks) {
    for (const comment of reviewBlock[1].matchAll(
      /<comment\b([^>]*)>([\s\S]*?)<\/comment>/gi,
    )) {
      const attributes = comment[1];
      const body = comment[2];
      const lineRangeValue = readAttribute(attributes, 'line_range');
      const selectedText =
        readElementContent(body, 'selected_lines') ??
        readElementContent(body, 'quoted_text');
      const tags = readElement(body, 'tags');
      comments.push({
        commentId: readAttribute(attributes, 'comment_id'),
        body: readInstruction(body),
        type: readAttribute(attributes, 'type'),
        filePath: readAttribute(attributes, 'file_path'),
        lineRange: parseLineRange(lineRangeValue),
        hasLineRange: lineRangeValue !== undefined,
        selectedText,
        presets: tags
          ? tags
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean)
          : undefined,
      });
    }
  }
  return { hasReviewXml: reviewBlocks.length > 0, comments };
}

function renderedReviewBody(review: AgentMemoryTaskReviewCapture): string {
  return (
    review.body ||
    (review.presets.length > 0
      ? `${review.presets.join(' and ')} this code`
      : '')
  );
}

function parsedReviewContext(
  comment: ParsedReviewComment,
): Pick<
  AgentMemoryTaskReviewCapture,
  'selectedText' | 'filePath' | 'lineStart' | 'lineEnd' | 'presets'
> {
  if (comment.type === 'message') {
    return {
      selectedText: comment.selectedText ?? null,
      filePath: null,
      lineStart: null,
      lineEnd: null,
      presets: [],
    };
  }
  if (comment.type !== 'file') {
    return {
      selectedText: null,
      filePath: null,
      lineStart: null,
      lineEnd: null,
      presets: [],
    };
  }
  return {
    selectedText: comment.selectedText ?? null,
    filePath: comment.filePath ?? null,
    lineStart: comment.lineRange?.lineStart ?? null,
    lineEnd: comment.lineRange?.lineEnd ?? null,
    presets: comment.presets ?? [],
  };
}

export function deriveAgentMemoryTaskReviewsFromSubmittedContent(
  content: string,
): AgentMemoryTaskReviewCapture[] {
  return parseReviewComments(content).comments.flatMap((comment) => {
    if (
      !comment.commentId ||
      comment.body === undefined ||
      (comment.type !== 'file' && comment.type !== 'message')
    ) {
      return [];
    }
    return [{
      commentId: comment.commentId,
      body: comment.body,
      ...parsedReviewContext(comment),
    }];
  });
}

export function reconcileAgentMemoryPromptCapture(
  capture: AgentMemoryPromptCapture,
  content: string,
): AgentMemoryPromptCapture {
  return reconcileAgentMemoryPromptCaptureWithDiagnostics(capture, content)
    .capture;
}

export function reconcileAgentMemoryPromptCaptureWithDiagnostics(
  capture: AgentMemoryPromptCapture,
  content: string,
): {
  capture: AgentMemoryPromptCapture;
  diagnostics: {
    hasReviewXml: boolean;
    rejectedCommentIds: string[];
    rejectedCommentsWithoutId: number;
  };
} {
  const existingReviews = capture.reviews ?? [];
  const remainingReviews = new Set(existingReviews);
  const reviews: AgentMemoryTaskReviewCapture[] = [];
  const parsed = parseReviewComments(content);
  const rejectedCommentIds: string[] = [];
  let rejectedCommentsWithoutId = 0;

  for (const comment of parsed.comments) {
    const instruction = comment.body;
    const commentId = comment.commentId;
    if (!commentId) {
      rejectedCommentsWithoutId += 1;
      continue;
    }
    const existing = existingReviews.find(
      (review) =>
        review.commentId === commentId && remainingReviews.has(review),
    );
    if (!existing) {
      rejectedCommentIds.push(commentId);
      continue;
    }

    remainingReviews.delete(existing);
    const context = parsedReviewContext(comment);
    const generatedBody = renderedReviewBody({
      ...existing,
      ...context,
      body: '',
    });
    reviews.push({
      commentId: existing.commentId,
      body:
        instruction === undefined
          ? ''
          : existing.body === '' && instruction === generatedBody
            ? ''
            : instruction,
      ...context,
    });
  }

  return {
    capture: { userText: content, reviews },
    diagnostics: {
      hasReviewXml: parsed.hasReviewXml,
      rejectedCommentIds,
      rejectedCommentsWithoutId,
    },
  };
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function deriveAgentMemoryPromptCaptureFromSubmittedContent(
  rendererCapture: AgentMemoryPromptCapture,
  content: string,
): {
  capture: AgentMemoryPromptCapture;
  diagnostics: {
    hasReviewXml: boolean;
    rejectedCommentIds: string[];
    rejectedCommentsWithoutId: number;
    metadataMismatchCommentIds: string[];
    unrepresentedRendererCommentIds: string[];
  };
} {
  const parsed = parseReviewComments(content);
  const rendererReviews = rendererCapture.reviews ?? [];
  const representedRendererIds = new Set<string>();
  const rejectedCommentIds: string[] = [];
  const metadataMismatchCommentIds: string[] = [];
  const reviews: AgentMemoryTaskReviewCapture[] = [];
  let rejectedCommentsWithoutId = 0;

  for (const comment of parsed.comments) {
    if (!comment.commentId) {
      rejectedCommentsWithoutId += 1;
      continue;
    }
    const rendererReview = rendererReviews.find(
      (review) => review.commentId === comment.commentId,
    );
    if (!rendererReview || representedRendererIds.has(comment.commentId)) {
      rejectedCommentIds.push(comment.commentId);
      continue;
    }
    representedRendererIds.add(comment.commentId);
    if (comment.body === undefined) {
      metadataMismatchCommentIds.push(comment.commentId);
      continue;
    }

    const isFileComment = comment.type === 'file';
    const isMessageComment = comment.type === 'message';
    const parsedPresets = comment.presets ?? [];
    const normalizedRendererSelectedText = rendererReview.selectedText?.trim()
      ? rendererReview.selectedText
      : null;
    const parsedSelectedText = comment.selectedText ?? null;
    const serializedContextMatches = isFileComment
      ? comment.filePath !== undefined &&
        rendererReview.filePath === comment.filePath &&
        normalizedRendererSelectedText === parsedSelectedText &&
        (comment.presets === undefined ||
          stringArraysEqual(rendererReview.presets, parsedPresets)) &&
        (!comment.hasLineRange ||
          (!!comment.lineRange &&
            rendererReview.lineStart === comment.lineRange.lineStart &&
            rendererReview.lineEnd === comment.lineRange.lineEnd))
      : isMessageComment &&
        rendererReview.filePath === null &&
        rendererReview.lineStart === null &&
        rendererReview.lineEnd === null &&
        normalizedRendererSelectedText === parsedSelectedText;
    if (!serializedContextMatches) {
      metadataMismatchCommentIds.push(comment.commentId);
      continue;
    }

    reviews.push({
      commentId: comment.commentId,
      body: comment.body,
      ...parsedReviewContext(comment),
    });
  }

  return {
    capture: { userText: content, reviews },
    diagnostics: {
      hasReviewXml: parsed.hasReviewXml,
      rejectedCommentIds,
      rejectedCommentsWithoutId,
      metadataMismatchCommentIds,
      unrepresentedRendererCommentIds: rendererReviews
        .filter((review) => !representedRendererIds.has(review.commentId))
        .map((review) => review.commentId),
    },
  };
}
