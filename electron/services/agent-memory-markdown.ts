import type { AgentMemoryItem } from '@shared/agent-memory-types';

const PROJECT_GROUPS = [
  { title: 'Decisions', kinds: ['project-decision'] },
  { title: 'Constraints', kinds: ['project-constraint'] },
  { title: 'Guidelines', kinds: ['project-guideline'] },
  { title: 'Recurring Priorities', kinds: ['project-priority'] },
  {
    title: 'Preferences',
    kinds: ['explicit-preference', 'inferred-preference'],
  },
] as const;

const GLOBAL_GROUPS = [
  ['communication', 'Communication'],
  ['engineering', 'Engineering'],
  ['product', 'Product'],
  ['quality', 'Quality'],
  ['design-ui-ux', 'Design, UI, and UX'],
  ['process-workflow', 'Process and Workflow'],
  ['decision', 'Decisions'],
  ['constraint', 'Constraints'],
  ['guideline', 'Guidelines'],
  ['recurring-priority', 'Recurring Priorities'],
] as const;

const MARKDOWN_CONTROL_CHARACTERS = new Set([
  '\\',
  '`',
  '*',
  '_',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  '#',
  '+',
  '|',
  '~',
]);

function escapeMarkdown(value: string): string {
  const normalized = value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...normalized]
    .map((character) =>
      MARKDOWN_CONTROL_CHARACTERS.has(character)
        ? `\\${character}`
        : character,
    )
    .join('');
}

function sorted(items: readonly AgentMemoryItem[]): AgentMemoryItem[] {
  return [...items].sort(
    (left, right) =>
      left.statement.localeCompare(right.statement) || left.id.localeCompare(right.id),
  );
}

function renderItem(item: AgentMemoryItem): string {
  return `- ${escapeMarkdown(item.statement)} _(${Math.round(item.confidence * 100)}% confidence; ${item.evidenceIds.length} evidence)_`;
}

function candidateBlocker(item: AgentMemoryItem): string {
  if (item.reviewBlocker === 'uncited-global-nomination') {
    return 'Not selected by global merge; awaiting matching project nomination';
  }
  if (item.scope === 'global') {
    const remaining = Math.max(0, 2 - item.projectCount);
    return remaining > 0
      ? `Needs evidence from ${remaining} more distinct project${remaining === 1 ? '' : 's'}`
      : 'Awaiting confirmation';
  }
  const remaining = Math.max(0, 2 - item.taskCount);
  return remaining > 0
    ? `Needs evidence from ${remaining} more distinct task${remaining === 1 ? '' : 's'}`
    : 'Awaiting confirmation';
}

function renderCandidates(items: readonly AgentMemoryItem[]): string[] {
  const candidates = sorted(items.filter((item) => item.status === 'candidate'));
  return [
    '## Candidates',
    '',
    ...(candidates.length
      ? candidates.map(
          (item) =>
            `${renderItem(item)} - ${escapeMarkdown(candidateBlocker(item))}`,
        )
      : ['_No candidates._']),
  ];
}

function renderSuperseded(items: readonly AgentMemoryItem[]): string[] {
  const superseded = sorted(items.filter((item) => item.status === 'superseded'));
  if (superseded.length === 0) return [];
  return [
    '',
    '## Superseded History',
    '',
    ...superseded.map(
      (item) => {
        const relationship =
          item.supersessionReason === 'promotion'
            ? 'promoted into'
            : 'superseded by';
        return `${renderItem(item)} - ${relationship} ${escapeMarkdown(item.supersededById ?? '')}`;
      },
    ),
  ];
}

export function renderProjectAgentMemoryMarkdown({
  projectName,
  items,
}: {
  projectName: string | null;
  items: readonly AgentMemoryItem[];
}): string {
  const title = projectName
    ? `# Project Memory: ${escapeMarkdown(projectName)}`
    : '# Project Memory';
  const confirmed = items.filter(
    (item) => item.status === 'confirmed' && item.scope === 'project',
  );
  const sections: string[] = [title, ''];
  for (const group of PROJECT_GROUPS) {
    const grouped = sorted(
      confirmed.filter((item) =>
        (group.kinds as readonly string[]).includes(item.kind),
      ),
    );
    if (grouped.length === 0) continue;
    sections.push(`## ${group.title}`, '', ...grouped.map(renderItem), '');
  }
  if (confirmed.length === 0) sections.push('_No active project memory._', '');
  sections.push(...renderCandidates(items), ...renderSuperseded(items));
  return `${sections.join('\n').trimEnd()}\n`;
}

export function renderGlobalAgentMemoryMarkdown({
  items,
}: {
  items: readonly AgentMemoryItem[];
}): string {
  const confirmed = items.filter(
    (item) => item.status === 'confirmed' && item.scope === 'global',
  );
  const sections: string[] = ['# Global Agent Memory', ''];
  for (const [category, title] of GLOBAL_GROUPS) {
    const grouped = sorted(confirmed.filter((item) => item.category === category));
    if (grouped.length === 0) continue;
    sections.push(`## ${title}`, '', ...grouped.map(renderItem), '');
  }
  if (confirmed.length === 0) {
    sections.push('_No confirmed global preferences._', '');
  }
  sections.push(...renderCandidates(items), ...renderSuperseded(items));
  return `${sections.join('\n').trimEnd()}\n`;
}
