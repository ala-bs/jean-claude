import { beforeAll, describe, expect, it } from 'vitest';

import type { TaskStep } from '@shared/types';

let buildStepGraphLayout: typeof import('@/features/task/ui-step-flow-bar').buildStepGraphLayout;
let buildCollapsedSteps: typeof import('@/features/task/ui-step-flow-bar').buildCollapsedSteps;
let getStepChipAttention: typeof import('@/features/task/ui-step-flow-bar').getStepChipAttention;

beforeAll(async () => {
  globalThis.window = {} as Window & typeof globalThis;
  const mod = await import('@/features/task/ui-step-flow-bar');
  buildStepGraphLayout = mod.buildStepGraphLayout;
  buildCollapsedSteps = mod.buildCollapsedSteps;
  getStepChipAttention = mod.getStepChipAttention;
});

function makeStep({
  id,
  dependsOn = [],
  createdAt,
  sortOrder = Number(id.replace('step-', '')),
}: {
  id: string;
  dependsOn?: string[];
  createdAt: string;
  sortOrder?: number;
}): TaskStep {
  return {
    id,
    taskId: 'task-1',
    name: id,
    type: 'agent',
    dependsOn,
    promptTemplate: '',
    resolvedPrompt: null,
    status: 'completed',
    sessionId: null,
    interactionMode: null,
    modelPreference: null,
    thinkingEffort: null,
    agentBackend: null,
    output: null,
    images: null,
    meta: {},
    sessionRules: {},
    autoStart: false,
    sortOrder,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('buildStepGraphLayout', () => {
  it('keeps consecutive dependent steps on same lane', () => {
    const layout = buildStepGraphLayout([
      makeStep({ id: 'step-1', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeStep({
        id: 'step-2',
        dependsOn: ['step-1'],
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
      makeStep({
        id: 'step-3',
        dependsOn: ['step-2'],
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
    ]);

    expect(layout.positions.get('step-2')?.y).toBe(
      layout.positions.get('step-1')?.y,
    );
    expect(layout.positions.get('step-3')?.y).toBe(
      layout.positions.get('step-2')?.y,
    );
  });

  it('moves non-consecutive dependent steps onto branch lanes', () => {
    const layout = buildStepGraphLayout([
      makeStep({ id: 'step-1', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeStep({
        id: 'step-2',
        dependsOn: ['step-1'],
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
      makeStep({
        id: 'step-3',
        dependsOn: ['step-2'],
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
      makeStep({
        id: 'step-4',
        dependsOn: ['step-1'],
        createdAt: '2026-01-01T00:03:00.000Z',
      }),
    ]);

    expect(layout.positions.get('step-4')?.y).toBeGreaterThan(
      layout.positions.get('step-1')?.y ?? 0,
    );
  });

  it('reuses dependency lane when skipped lane is clear', () => {
    const layout = buildStepGraphLayout([
      makeStep({ id: 'step-1', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeStep({
        id: 'step-2',
        dependsOn: ['step-1'],
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
      makeStep({
        id: 'step-3',
        dependsOn: ['step-2'],
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
      makeStep({
        id: 'step-4',
        dependsOn: ['step-1'],
        createdAt: '2026-01-01T00:03:00.000Z',
      }),
      makeStep({
        id: 'step-5',
        dependsOn: ['step-3'],
        createdAt: '2026-01-01T00:04:00.000Z',
      }),
    ]);

    expect(layout.positions.get('step-5')?.y).toBe(
      layout.positions.get('step-3')?.y,
    );
  });

  it('moves late-added parallel steps below occupied main lane', () => {
    const layout = buildStepGraphLayout([
      makeStep({
        id: 'step-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      makeStep({
        id: 'step-2',
        dependsOn: ['step-1'],
        createdAt: '2026-01-01T00:03:00.000Z',
      }),
      makeStep({
        id: 'step-3',
        dependsOn: ['step-1'],
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
      makeStep({
        id: 'step-4',
        dependsOn: ['step-3'],
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
    ]);

    expect(layout.positions.get('step-2')?.y).toBeGreaterThan(
      layout.positions.get('step-3')?.y ?? 0,
    );
  });

  it('infers branch lane for old inserted steps without dependencies', () => {
    const layout = buildStepGraphLayout([
      makeStep({
        id: 'step-1',
        sortOrder: 0,
        createdAt: '2026-06-11 18:36:11',
      }),
      makeStep({
        id: 'step-2',
        sortOrder: 1,
        createdAt: '2026-06-12 21:37:15',
      }),
      makeStep({
        id: 'step-3',
        sortOrder: 2,
        createdAt: '2026-06-12 17:54:10',
      }),
      makeStep({
        id: 'step-4',
        sortOrder: 3,
        createdAt: '2026-06-12 21:00:58',
      }),
    ]);

    expect(layout.positions.get('step-2')?.y).toBeGreaterThan(
      layout.positions.get('step-3')?.y ?? 0,
    );
  });
});

describe('buildCollapsedSteps', () => {
  const archived = (id: string, createdAt: string) => ({
    ...makeStep({ id, createdAt }),
    archivedAt: createdAt,
  });

  it('collapses consecutive archived steps into one node', () => {
    const steps = [
      archived('step-1', '2026-01-01T00:00:00.000Z'),
      archived('step-2', '2026-01-01T00:01:00.000Z'),
      archived('step-3', '2026-01-01T00:02:00.000Z'),
      makeStep({
        id: 'step-4',
        dependsOn: ['step-3'],
        createdAt: '2026-01-01T00:03:00.000Z',
      }),
    ];

    const result = buildCollapsedSteps({
      steps,
      expandedGroupIds: new Set<string>(),
    });

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].id).toBe('archived-group:step-1');
    expect(result.steps[0].name).toBe('3 archived');
    expect(result.steps[1].dependsOn).toEqual(['archived-group:step-1']);
    expect(result.groups.get('archived-group:step-1')).toMatchObject({
      startIndex: 0,
      endIndex: 2,
    });
  });

  it('does not collapse a single archived step', () => {
    const steps = [
      archived('step-1', '2026-01-01T00:00:00.000Z'),
      makeStep({ id: 'step-2', createdAt: '2026-01-01T00:01:00.000Z' }),
    ];

    const result = buildCollapsedSteps({
      steps,
      expandedGroupIds: new Set<string>(),
    });

    expect(result.steps.map((step) => step.id)).toEqual(['step-1', 'step-2']);
  });

  it('expands a group when its id is expanded', () => {
    const steps = [
      archived('step-1', '2026-01-01T00:00:00.000Z'),
      archived('step-2', '2026-01-01T00:01:00.000Z'),
    ];

    const result = buildCollapsedSteps({
      steps,
      expandedGroupIds: new Set(['archived-group:step-1']),
    });

    expect(result.steps.map((step) => step.id)).toEqual(['step-1', 'step-2']);
    expect(result.expandedRunFirstIds.has('step-1')).toBe(true);
  });
});

describe('buildCollapsedSteps edge cases', () => {
  const archived = (id: string, createdAt: string, sortOrder?: number) => ({
    ...makeStep({ id, createdAt, sortOrder }),
    archivedAt: createdAt,
  });

  it('keeps the group expanded when it holds the active step', () => {
    const result = buildCollapsedSteps({
      steps: [
        archived('step-1', '2026-01-01T00:00:00.000Z'),
        archived('step-2', '2026-01-01T00:01:00.000Z'),
      ],
      expandedGroupIds: new Set<string>(),
      activeStepId: 'step-2',
    });

    expect(result.steps.map((step) => step.id)).toEqual(['step-1', 'step-2']);
  });

  it('does not collapse archived steps that are not contiguous by createdAt', () => {
    const result = buildCollapsedSteps({
      steps: [
        archived('step-1', '2026-01-01T00:00:00.000Z', 0),
        archived('step-2', '2026-01-01T00:03:00.000Z', 1),
        makeStep({
          id: 'step-3',
          sortOrder: 2,
          createdAt: '2026-01-01T00:01:00.000Z',
        }),
      ],
      expandedGroupIds: new Set<string>(),
    });

    expect(result.steps.map((step) => step.id)).toEqual([
      'step-1',
      'step-2',
      'step-3',
    ]);
  });
});

describe('getStepChipAttention', () => {
  it('surfaces the pending attention while the step is running', () => {
    expect(
      getStepChipAttention({
        step: { status: 'running', archivedAt: null },
        pendingAttention: 'permission',
      }),
    ).toBe('permission');
    expect(
      getStepChipAttention({
        step: { status: 'running', archivedAt: null },
        pendingAttention: 'question',
      }),
    ).toBe('question');
  });

  it('ignores a stale pending request on a non-running step', () => {
    expect(
      getStepChipAttention({
        step: { status: 'completed', archivedAt: null },
        pendingAttention: 'permission',
      }),
    ).toBeNull();
  });

  it('ignores archived steps and collapsed archived groups', () => {
    expect(
      getStepChipAttention({
        step: { status: 'running', archivedAt: '2026-01-01T00:00:00.000Z' },
        pendingAttention: 'question',
      }),
    ).toBeNull();
    expect(
      getStepChipAttention({
        step: { status: 'running', archivedAt: null },
        pendingAttention: 'question',
        isArchivedGroup: true,
      }),
    ).toBeNull();
  });
});
