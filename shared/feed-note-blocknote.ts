const TASK_LINE_PATTERN = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)(.*)$/;

export type FeedNoteLine = {
  lineIndex: number;
  text: string;
  raw: string;
  task?: {
    checked: boolean;
  };
};

type BlockNoteBlock = {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: BlockNoteBlock[];
};

function getBlockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      return '';
    })
    .join('');
}

function parseBlocks(content: string): BlockNoteBlock[] | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as BlockNoteBlock[]) : null;
  } catch {
    return null;
  }
}

export function markdownToBlockNoteJson(markdown: string): string {
  const blocks = markdown.split('\n').map((line): BlockNoteBlock => {
    const taskMatch = line.match(TASK_LINE_PATTERN);
    if (taskMatch) {
      return {
        type: 'checkListItem',
        props: { checked: taskMatch[2].toLowerCase() === 'x' },
        content: taskMatch[4].trim(),
      };
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      return {
        type: 'heading',
        props: { level: headingMatch[1].length },
        content: headingMatch[2],
      };
    }

    const bulletMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bulletMatch) {
      return { type: 'bulletListItem', content: bulletMatch[1] };
    }

    const numberedMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numberedMatch) {
      return { type: 'numberedListItem', content: numberedMatch[1] };
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      return { type: 'quote', content: quoteMatch[1] };
    }

    return { type: 'paragraph', content: line };
  });

  return JSON.stringify(blocks.length > 0 ? blocks : [{ type: 'paragraph' }]);
}

export function blockNoteJsonToMarkdown(content: string): string {
  const blocks = parseBlocks(content);
  if (!blocks) return content;

  const lines: string[] = [];
  const visit = (items: BlockNoteBlock[], depth = 0) => {
    for (const block of items) {
      const text = getBlockText(block.content);
      const indent = '  '.repeat(depth);

      switch (block.type) {
        case 'checkListItem':
          lines.push(
            `${indent}- [${block.props?.checked ? 'x' : ' '}] ${text}`,
          );
          break;
        case 'bulletListItem':
          lines.push(`${indent}- ${text}`);
          break;
        case 'numberedListItem':
          lines.push(`${indent}1. ${text}`);
          break;
        case 'heading': {
          const level = Number(block.props?.level ?? 1);
          lines.push(`${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${text}`);
          break;
        }
        case 'quote':
          lines.push(`> ${text}`);
          break;
        default:
          lines.push(text);
      }

      if (Array.isArray(block.children) && block.children.length > 0) {
        visit(block.children, depth + 1);
      }
    }
  };

  visit(blocks);
  return lines.join('\n').trim();
}

export function parseFeedNoteLine(
  line: string,
  lineIndex: number,
): FeedNoteLine {
  const taskMatch = line.match(TASK_LINE_PATTERN);
  if (!taskMatch) {
    return { lineIndex, raw: line, text: line.trim() };
  }

  return {
    lineIndex,
    raw: line,
    text: taskMatch[4].trim(),
    task: { checked: taskMatch[2].toLowerCase() === 'x' },
  };
}

export function parseFeedNoteLines(content: string): FeedNoteLine[] {
  return content
    .split('\n')
    .map((line, lineIndex): FeedNoteLine | null => {
      if (!line.trim()) return null;
      return parseFeedNoteLine(line, lineIndex);
    })
    .filter((line): line is FeedNoteLine => line !== null);
}

export function getFeedNoteTaskIndex({
  content,
  lineIndex,
}: {
  content: string;
  lineIndex: number;
}): number | null {
  let taskIndex = -1;

  for (const line of parseFeedNoteLines(content)) {
    if (line.task) taskIndex += 1;
    if (line.lineIndex === lineIndex) return line.task ? taskIndex : null;
  }

  return null;
}

export function toggleFeedNoteContentCheckbox({
  content,
  taskIndex,
  checked,
}: {
  content: string;
  taskIndex: number | null;
  checked: boolean;
}): string {
  const blocks = parseBlocks(content);
  if (!blocks || taskIndex === null) return content;

  let currentTaskIndex = -1;
  let didUpdate = false;

  const updateBlocks = (items: BlockNoteBlock[]): BlockNoteBlock[] =>
    items.map((block) => {
      const nextBlock: BlockNoteBlock = { ...block };

      if (nextBlock.type === 'checkListItem') {
        currentTaskIndex += 1;
        if (currentTaskIndex === taskIndex) {
          nextBlock.props = { ...(nextBlock.props ?? {}), checked };
          didUpdate = true;
        }
      }

      if (Array.isArray(nextBlock.children)) {
        nextBlock.children = updateBlocks(nextBlock.children);
      }

      return nextBlock;
    });

  const updatedBlocks = updateBlocks(blocks);
  return didUpdate ? JSON.stringify(updatedBlocks) : content;
}
