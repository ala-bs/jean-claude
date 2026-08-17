import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const MAX_EXCERPT_LENGTH = 180;
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'dr.',
  'e.g.',
  'i.e.',
  'mr.',
  'mrs.',
  'ms.',
  'prof.',
  'vs.',
]);

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

function nodeSource(node: MarkdownNode, markdown: string): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start === undefined || end === undefined
    ? ''
    : markdown.slice(start, end);
}

function inlineText(node: MarkdownNode, markdown: string): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value ?? '';
  }
  if (node.type === 'break') return ' ';
  if (
    node.type === 'html' ||
    node.type === 'image' ||
    node.type === 'imageReference'
  ) {
    return '';
  }

  if (node.type === 'link') {
    const source = nodeSource(node, markdown);
    const label = (node.children ?? [])
      .map((child) => inlineText(child, markdown))
      .join('')
      .trim();
    const normalizedUrl = node.url?.replace(/^mailto:/i, '') ?? '';
    const isAutolink =
      (source.startsWith('<') && source.endsWith('>')) ||
      (!source.startsWith('[') &&
        (label === normalizedUrl || /^www\./i.test(source)));
    return isAutolink ? '' : label;
  }

  return (node.children ?? [])
    .map((child) => inlineText(child, markdown))
    .join('');
}

function findFirstProse(node: MarkdownNode, markdown: string): string | null {
  if (node.type === 'paragraph') {
    const text = inlineText(node, markdown).replace(/\s+/g, ' ').trim();
    return text || null;
  }

  if (
    node.type !== 'root' &&
    node.type !== 'list' &&
    node.type !== 'listItem' &&
    node.type !== 'blockquote'
  ) {
    return null;
  }

  for (const child of node.children ?? []) {
    const text = findFirstProse(child, markdown);
    if (text) return text;
  }
  return null;
}

function capExcerpt(value: string): string {
  if (value.length <= MAX_EXCERPT_LENGTH) return value;

  const available = value.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd();
  const lastSpace = available.lastIndexOf(' ');
  const cleanCut =
    lastSpace > MAX_EXCERPT_LENGTH / 2
      ? available.slice(0, lastSpace)
      : available;
  return `${cleanCut}\u2026`;
}

function firstSentence(value: string): string {
  for (const match of value.matchAll(/[.!?](?=\s|$)/g)) {
    const end = (match.index ?? 0) + 1;
    const token = value.slice(0, end).match(/[\p{L}.]+$/u)?.[0].toLowerCase();
    const nextLetter = value.slice(end).match(/^\s+(\p{L})/u)?.[1];
    const isAmbiguousMidSentenceAbbreviation =
      token !== undefined &&
      nextLetter !== undefined &&
      nextLetter === nextLetter.toLowerCase() &&
      (token === 'etc.' || /^(?:\p{L}\.){2,}$/u.test(token));
    if (
      match[0] === '.' &&
      token &&
      (NON_TERMINAL_ABBREVIATIONS.has(token) ||
        isAmbiguousMidSentenceAbbreviation)
    ) {
      continue;
    }
    return value.slice(0, end);
  }
  return value;
}

export function getWorkItemSummaryExcerpt(markdown: string): string | null {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const text = findFirstProse(tree as MarkdownNode, markdown);
  if (!text) return null;

  return capExcerpt(firstSentence(text));
}
