import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AgentMemoryDashboard } from '@shared/agent-memory-types';

import {
  AgentMemoryDashboardInitialError,
  AgentMemoryDashboardView,
  getNextAgentMemoryDashboardView,
} from './index';

const dashboard: AgentMemoryDashboard = {
  enabled: false,
  globalProfile: [
    {
      category: 'engineering',
      items: [
        {
          schemaVersion: 1,
          id: 'global-1',
          statement: 'Prefer focused verification',
          category: 'engineering',
          kind: 'inferred-preference',
          scope: 'global',
          status: 'confirmed',
          confidence: 0.82,
          evidenceIds: ['event-global-1', 'event-global-2'],
          taskCount: 4,
          projectCount: 2,
          firstSeenAt: '2026-06-01T08:00:00.000Z',
          lastSeenAt: '2026-07-02T09:30:00.000Z',
          updatedAt: '2026-07-02T09:30:00.000Z',
        },
      ],
    },
  ],
  projectMemory: [
    {
      category: 'constraint',
      items: [
        {
          schemaVersion: 1,
          id: 'project-1',
          statement: 'Keep migrations reversible',
          category: 'constraint',
          kind: 'project-constraint',
          scope: 'project',
          projectId: 'project-1',
          status: 'confirmed',
          confidence: 0.91,
          evidenceIds: ['event-project-1'],
          taskCount: 2,
          projectCount: 1,
          firstSeenAt: '2026-06-05T10:00:00.000Z',
          lastSeenAt: '2026-07-03T11:15:00.000Z',
          updatedAt: '2026-07-03T11:15:00.000Z',
        },
      ],
    },
  ],
  candidates: [
    {
      item: {
        schemaVersion: 1,
        id: 'candidate-1',
        statement: 'Prefer accessible controls',
        category: 'quality',
        kind: 'inferred-preference',
        scope: 'task',
        projectId: 'project-1',
        taskId: 'task-1',
        status: 'candidate',
        confidence: 0.7,
        evidenceIds: ['event-1', 'event-2', 'event-3'],
        taskCount: 1,
        projectCount: 1,
        firstSeenAt: '2026-07-01T00:00:00.000Z',
        lastSeenAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      },
      blockers: [
        { kind: 'task-count', current: 1, required: 2 },
        { kind: 'project-count', current: 1, required: 2 },
      ],
    },
  ],
  evidence: {
    page: 0,
    pageSize: 20,
    total: 1,
    items: [
      {
        schemaVersion: 1,
        id: 'event-1',
        sourceId: 'source-1',
        source: 'follow-up-prompt',
        projectId: 'project-1',
        text: 'Please keep keyboard navigation.',
        context: { previousAgentResult: 'Implemented mouse-only controls.' },
        createdAt: '2026-07-01T00:00:00.000Z',
        redactions: [],
      },
    ],
  },
  extractionRuns: {
    page: 0,
    pageSize: 20,
    total: 1,
    items: [
      {
        schemaVersion: 1,
        id: 'run-1',
        scope: 'project',
        projectId: 'project-1',
        trigger: 'manual',
        backend: 'claude-code',
        model: 'haiku',
        status: 'failed',
        eventRanges: [
          {
            fileName: '2026-07-01.jsonl',
            fromOffset: 0,
            toOffset: 100,
            eventCount: 1,
          },
        ],
        proposedItemCount: 2,
        acceptedItemCount: 0,
        startedAt: '2026-07-01T00:00:00.000Z',
        completedAt: '2026-07-01T00:00:02.000Z',
        durationMs: 2_000,
        error: { message: 'Backend unavailable' },
      },
    ],
  },
  extractionState: null,
};

const callbacks = {
  onViewChange: vi.fn(),
  onProjectChange: vi.fn(),
  onRefresh: vi.fn(),
  onExtract: vi.fn(),
  onRetry: vi.fn(),
  onPreviousPage: vi.fn(),
  onNextPage: vi.fn(),
};

function render(view: 'global' | 'project' | 'candidates' | 'evidence' | 'runs') {
  return renderToStaticMarkup(
    <AgentMemoryDashboardView
      dashboard={dashboard}
      view={view}
      projects={[{ id: 'project-1', name: 'Project One' }]}
      selectedProjectId="project-1"
      isExtracting={false}
      retryingRunId={null}
      error={null}
      {...callbacks}
    />,
  );
}

describe('AgentMemoryDashboardView', () => {
  it('exposes five accessible read-only views and disables extraction with paused-state copy', () => {
    const markup = render('global');

    expect(markup.match(/role="tab"/g)).toHaveLength(5);
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('Extract Now</button>');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('capture and extraction are paused');
    expect(markup).toContain('Stored memory remains readable');
    expect(markup).toContain('id="agent-memory-tab-global"');
    expect(markup).toContain('aria-controls="agent-memory-panel-global"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('id="agent-memory-tab-project"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('id="agent-memory-panel-global"');
    expect(markup).toContain('aria-labelledby="agent-memory-tab-global"');
  });

  it('supports wrapping arrow and home/end tab navigation', () => {
    expect(
      getNextAgentMemoryDashboardView({ view: 'global', key: 'ArrowLeft' }),
    ).toBe('runs');
    expect(
      getNextAgentMemoryDashboardView({ view: 'runs', key: 'ArrowRight' }),
    ).toBe('global');
    expect(
      getNextAgentMemoryDashboardView({ view: 'evidence', key: 'Home' }),
    ).toBe('global');
    expect(
      getNextAgentMemoryDashboardView({ view: 'project', key: 'End' }),
    ).toBe('runs');
    expect(
      getNextAgentMemoryDashboardView({ view: 'project', key: 'Enter' }),
    ).toBeNull();
  });

  it('renders an actionable initial load error instead of loading forever', () => {
    const markup = renderToStaticMarkup(
      <AgentMemoryDashboardInitialError
        error={new Error('Memory index unavailable')}
        retrying={false}
        onRetry={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Agent Memory failed to load');
    expect(markup).toContain('Memory index unavailable');
    expect(markup).toContain('>Retry</button>');
    expect(markup).not.toContain('Loading Agent Memory');
  });

  it('shows labeled scope, confidence, evidence, and observation dates on global and project items', () => {
    const globalMarkup = render('global');
    const projectMarkup = render('project');

    expect(globalMarkup).toContain('Prefer focused verification');
    expect(globalMarkup).toContain('Scope');
    expect(globalMarkup).toContain('Global');
    expect(globalMarkup).toContain('Confidence');
    expect(globalMarkup).toContain('82%');
    expect(globalMarkup).toContain('Evidence');
    expect(globalMarkup).toContain('>2</dd>');
    expect(globalMarkup).toContain('First seen');
    expect(globalMarkup).toContain('2026-06-01T08:00:00.000Z');
    expect(globalMarkup).toContain('Last seen');
    expect(globalMarkup).toContain('2026-07-02T09:30:00.000Z');

    expect(projectMarkup).toContain('Keep migrations reversible');
    expect(projectMarkup).toContain('Scope');
    expect(projectMarkup).toContain('Project');
    expect(projectMarkup).toContain('Confidence');
    expect(projectMarkup).toContain('91%');
    expect(projectMarkup).toContain('Evidence');
    expect(projectMarkup).toContain('>1</dd>');
    expect(projectMarkup).toContain('First seen');
    expect(projectMarkup).toContain('2026-06-05T10:00:00.000Z');
    expect(projectMarkup).toContain('Last seen');
    expect(projectMarkup).toContain('2026-07-03T11:15:00.000Z');
  });

  it('shows candidate metadata and labels task and project promotion blockers explicitly', () => {
    const markup = render('candidates');

    expect(markup).toContain('Prefer accessible controls');
    expect(markup).toContain('Scope');
    expect(markup).toContain('Task');
    expect(markup).toContain('Confidence');
    expect(markup).toContain('70%');
    expect(markup).toContain('Evidence');
    expect(markup).toContain('>3</dd>');
    expect(markup).toContain('First seen');
    expect(markup).toContain('2026-07-01T00:00:00.000Z');
    expect(markup).toContain('Last seen');
    expect(markup).toContain('2026-07-04T00:00:00.000Z');
    expect(markup).toContain('1 of 2 distinct tasks');
    expect(markup).toContain('1 of 2 distinct projects');
  });

  it('renders evidence body and context as separately expandable labeled regions', () => {
    const markup = render('evidence');

    expect(markup).toContain('<summary>Evidence body</summary>');
    expect(markup).toContain('<summary>Context: previous agent result</summary>');
    expect(markup).toContain('Please keep keyboard navigation.');
    expect(markup).toContain('Implemented mouse-only controls.');
  });

  it('shows run backend, model, ranges, counts, duration, error, and labeled retry action', () => {
    const markup = render('runs');

    expect(markup).toContain('claude-code / haiku');
    expect(markup).toContain('2026-07-01.jsonl');
    expect(markup).toContain('2 proposed');
    expect(markup).toContain('0 accepted');
    expect(markup).toContain('2.0s');
    expect(markup).toContain('Backend unavailable');
    expect(markup).toContain('aria-label="Retry failed extraction run run-1"');
  });
});
