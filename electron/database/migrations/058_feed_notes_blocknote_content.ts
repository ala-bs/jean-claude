import { Kysely, sql } from 'kysely';

const TASK_LINE_PATTERN = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)(.*)$/;

function markdownToBlockNoteJson(markdown: string): string {
  const blocks = markdown.split('\n').map((line) => {
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

function blockNoteJsonToMarkdown(content: string): string {
  try {
    const blocks = JSON.parse(content) as Array<{
      type?: string;
      props?: { checked?: boolean; level?: number };
      content?: unknown;
    }>;

    if (!Array.isArray(blocks)) return content;

    return blocks
      .map((block) => {
        const text = typeof block.content === 'string' ? block.content : '';
        if (block.type === 'checkListItem') {
          return `- [${block.props?.checked ? 'x' : ' '}] ${text}`;
        }
        if (block.type === 'heading') {
          return `${'#'.repeat(block.props?.level ?? 1)} ${text}`;
        }
        return text;
      })
      .join('\n')
      .trim();
  } catch {
    return content;
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const notes = await sql<{ id: string; content: string }>`
    SELECT id, content FROM feed_notes
  `.execute(db);

  for (const note of notes.rows) {
    await sql`
      UPDATE feed_notes
      SET content = ${markdownToBlockNoteJson(note.content)}
      WHERE id = ${note.id}
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const notes = await sql<{ id: string; content: string }>`
    SELECT id, content FROM feed_notes
  `.execute(db);

  for (const note of notes.rows) {
    await sql`
      UPDATE feed_notes
      SET content = ${blockNoteJsonToMarkdown(note.content)}
      WHERE id = ${note.id}
    `.execute(db);
  }
}
