import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let row: Record<string, unknown>;

  const baseRow = () => ({
    id: 'step-1',
    taskId: 'task-1',
    name: 'Step',
    type: 'agent',
    dependsOn: '[]',
    promptTemplate: 'Prompt',
    resolvedPrompt: null,
    status: 'ready',
    sessionId: null,
    interactionMode: null,
    modelPreference: null,
    thinkingEffort: null,
    agentBackend: null,
    output: null,
    images: null,
    meta: null,
    sessionRules: null,
    autoStart: 0,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const dbMock = {
    selectFrom: vi.fn(() => {
      const builder = {
        select: vi.fn(() => builder),
        selectAll: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        execute: vi.fn(async () => (row ? [{ id: row.id }] : [])),
        executeTakeFirst: vi.fn(async () => row),
      };
      return builder;
    }),
    updateTable: vi.fn(() => {
      let values: Record<string, unknown> | undefined;
      const builder = {
        set: vi.fn((next: unknown) => {
          if (typeof next !== 'function') values = next as Record<string, unknown>;
          return builder;
        }),
        where: vi.fn(() => builder),
        returningAll: vi.fn(() => builder),
        execute: vi.fn(async () => []),
        executeTakeFirstOrThrow: vi.fn(async () => {
          row = { ...row, ...values };
          return row;
        }),
      };
      return builder;
    }),
    insertInto: vi.fn(() => {
      const builder = {
        values: vi.fn((values: Record<string, unknown>) => {
          row = { ...baseRow(), ...values };
          return builder;
        }),
        returningAll: vi.fn(() => builder),
        executeTakeFirstOrThrow: vi.fn(async () => row),
      };
      return builder;
    }),
    transaction: vi.fn(() => ({
      execute: (callback: (trx: typeof dbMock) => unknown) => callback(dbMock),
    })),
  };

  return {
    dbMock,
    getRow: () => row,
    reset: (overrides: Record<string, unknown> = {}) => {
      row = { ...baseRow(), ...overrides };
    },
  };
});

vi.mock('../index', () => ({ db: mocks.dbMock }));
vi.mock('../../lib/debug', () => ({ dbg: { db: vi.fn() } }));
vi.mock('nanoid', () => ({ nanoid: () => 'step-1' }));

import { TaskStepRepository } from './task-steps';

describe('TaskStepRepository session rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it('serializes and parses non-empty rules on create and update', async () => {
    const created = await TaskStepRepository.create({
      taskId: 'task-1',
      name: 'Step',
      promptTemplate: 'Prompt',
      sessionRules: { bash: { 'git status': 'allow' } },
    });

    expect(mocks.getRow().sessionRules).toBe(
      JSON.stringify({ bash: { 'git status': 'allow' } }),
    );
    expect(created.sessionRules).toEqual({
      bash: { 'git status': 'allow' },
    });
    await expect(TaskStepRepository.findById('step-1')).resolves.toMatchObject({
      sessionRules: { bash: { 'git status': 'allow' } },
    });

    const updated = await TaskStepRepository.update('step-1', {
      sessionRules: { read: 'allow', write: 'ask' },
    });

    expect(mocks.getRow().sessionRules).toBe(
      JSON.stringify({ read: 'allow', write: 'ask' }),
    );
    expect(updated.sessionRules).toEqual({ read: 'allow', write: 'ask' });
  });

  it('normalizes a null database value to an empty scope', async () => {
    mocks.reset({ sessionRules: null });

    await expect(TaskStepRepository.findById('step-1')).resolves.toMatchObject({
      sessionRules: {},
    });
  });
});
