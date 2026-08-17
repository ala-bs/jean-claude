import { describe, expect, it } from 'vitest';
import type { AgentMemoryItem } from '@shared/agent-memory-types';

import {
  renderGlobalAgentMemoryMarkdown,
  renderProjectAgentMemoryMarkdown,
} from './agent-memory-markdown';

const timestamp = '2026-07-18T12:00:00.000Z';

function item(overrides: Partial<AgentMemoryItem> = {}): AgentMemoryItem {
  return {
    schemaVersion: 1,
    id: 'item-1',
    statement: 'Prefer focused tests.',
    category: 'quality',
    kind: 'project-guideline',
    scope: 'project',
    projectId: 'project-1',
    status: 'confirmed',
    confidence: 0.9,
    evidenceIds: ['event-1', 'event-2'],
    taskCount: 2,
    projectCount: 1,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  } as AgentMemoryItem;
}

describe('agent memory Markdown projections', () => {
  it('renders deterministic grouped project memory and candidate blockers', () => {
    const items = [
      item({ id: 'priority', kind: 'project-priority', statement: 'Ship docs.' }),
      item({ id: 'guideline', statement: 'Prefer focused tests.' }),
      item({
        id: 'candidate',
        kind: 'inferred-preference',
        scope: 'task',
        taskId: 'task-1',
        status: 'candidate',
        statement: 'Use snapshots.',
        evidenceIds: ['event-3'],
        taskCount: 1,
      }),
    ];

    const first = renderProjectAgentMemoryMarkdown({
      projectName: 'Jean-Claude',
      items,
    });
    const second = renderProjectAgentMemoryMarkdown({
      projectName: 'Jean-Claude',
      items: [...items].reverse(),
    });

    expect(first).toBe(second);
    expect(first).toContain('# Project Memory: Jean-Claude');
    expect(first.indexOf('## Guidelines')).toBeLessThan(
      first.indexOf('## Recurring Priorities'),
    );
    expect(first).toContain('## Candidates');
    expect(first).toContain('Needs evidence from 1 more distinct task');
  });

  it('groups global profile categories and excludes superseded items from active groups', () => {
    const markdown = renderGlobalAgentMemoryMarkdown({
      items: [
        item({
          id: 'quality',
          scope: 'global',
          projectId: undefined,
          kind: 'explicit-preference',
          statement: 'Run focused tests.',
          projectCount: 2,
        }),
        item({
          id: 'uncited',
          scope: 'global',
          projectId: undefined,
          kind: 'explicit-preference',
          status: 'candidate',
          reviewBlocker: 'uncited-global-nomination',
          projectCount: 1,
        }),
        item({
          id: 'old',
          scope: 'global',
          projectId: undefined,
          kind: 'explicit-preference',
          category: 'communication',
          statement: 'Write long explanations.',
          status: 'superseded',
          supersededById: 'quality',
          projectCount: 2,
        }),
      ],
    });

    expect(markdown).toContain('# Global Agent Memory');
    expect(markdown).toContain('## Quality');
    expect(markdown).not.toContain('## Communication');
    expect(markdown).toContain('## Superseded History');
    expect(markdown).toContain('Write long explanations.');
    expect(markdown).toContain(
      'Not selected by global merge; awaiting matching project nomination',
    );
  });

  it('escapes unsafe Markdown and collapses statement newlines', () => {
    const markdown = renderProjectAgentMemoryMarkdown({
      projectName: '# Team [one]',
      items: [item({ statement: '[link](javascript:alert(1))\n# injected' })],
    });

    expect(markdown).toContain('Project Memory: \\# Team \\[one\\]');
    expect(markdown).toContain(
      '\\[link\\]\\(javascript:alert\\(1\\)\\) \\# injected',
    );
    expect(markdown).not.toContain('\n# injected');
  });

  it('renders stable empty states', () => {
    expect(
      renderProjectAgentMemoryMarkdown({ projectName: null, items: [] }),
    ).toBe('# Project Memory\n\n_No active project memory._\n\n## Candidates\n\n_No candidates._\n');
    expect(renderGlobalAgentMemoryMarkdown({ items: [] })).toBe(
      '# Global Agent Memory\n\n_No confirmed global preferences._\n\n## Candidates\n\n_No candidates._\n',
    );
  });
});
