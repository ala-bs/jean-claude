import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type Row = {
    id: string;
    providerId: string;
    workItemId: number;
    content: string;
    sourceHash: string;
    sourceChangedDate: string | null;
    sourceLatestCommentId: number | null;
    sourceCommentCount: number;
    generatedAt: string;
    updatedAt: string;
  };

  const rows: Row[] = [];
  let nextId = 1;
  let queriedWorkItemIds: number[] | null = null;
  const findProviderById = vi.fn();

  class SelectQuery {
    private providerId: string | null = null;
    private workItemId: number | null = null;
    private workItemIds: number[] | null = null;

    selectAll() {
      return this;
    }

    where(column: string, operator: string, value: string | number | number[]) {
      expect(operator === '=' || operator === 'in').toBe(true);
      if (column === 'providerId') this.providerId = value as string;
      if (column === 'workItemId' && operator === '=') this.workItemId = value as number;
      if (column === 'workItemId' && operator === 'in') {
        this.workItemIds = value as number[];
        queriedWorkItemIds = value as number[];
      }
      return this;
    }

    async executeTakeFirst() {
      return this.filtered()[0];
    }

    async execute() {
      return this.filtered();
    }

    private filtered() {
      return rows.filter((row) =>
        (this.providerId === null || row.providerId === this.providerId) &&
        (this.workItemId === null || row.workItemId === this.workItemId) &&
        (this.workItemIds === null || this.workItemIds.includes(row.workItemId)),
      );
    }
  }

  const dbMock = {
    selectFrom: vi.fn(() => new SelectQuery()),
    insertInto: vi.fn(() => ({
      values: (values: Omit<Row, 'id'>) => ({
        onConflict: (configure: (builder: {
          columns: (columns: string[]) => {
            doUpdateSet: (update: Partial<Row>) => unknown;
          };
        }) => unknown) => {
          let update: Partial<Row> = {};
          configure({
            columns: (columns) => {
              expect(columns).toEqual(['providerId', 'workItemId']);
              return {
                doUpdateSet: (nextUpdate) => {
                  update = nextUpdate;
                  return {};
                },
              };
            },
          });
          return {
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => {
                const existing = rows.find((row) =>
                  row.providerId === values.providerId && row.workItemId === values.workItemId,
                );
                if (existing) {
                  Object.assign(existing, update);
                  return existing;
                }
                const row = { ...values, id: `summary-${nextId++}` };
                rows.push(row);
                return row;
              },
            }),
          };
        },
      }),
    })),
  };

  return {
    dbMock,
    findProviderById,
    getQueriedWorkItemIds: () => queriedWorkItemIds,
    rows,
    reset: () => {
      rows.splice(0, rows.length);
      nextId = 1;
      queriedWorkItemIds = null;
      findProviderById.mockReset();
      findProviderById.mockResolvedValue({ id: 'provider-1' });
    },
  };
});

vi.mock('../index', () => ({ db: mocks.dbMock }));
vi.mock('./providers', () => ({
  ProviderRepository: { findById: mocks.findProviderById },
}));

import { WorkItemSummaryRepository } from './work-item-summaries';

const content = '# Summary\n\nProblem and expected outcome.';

const input = {
  providerId: 'provider-1',
  workItemId: 42,
  content,
  sourceHash: 'hash-1',
  sourceChangedDate: '2026-07-13T00:00:00.000Z',
  sourceLatestCommentId: 10,
  sourceCommentCount: 2,
  generatedAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

describe('WorkItemSummaryRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it('upserts and looks up raw Markdown', async () => {
    const inserted = await WorkItemSummaryRepository.upsert(input);

    expect(inserted).toEqual({ id: 'summary-1', ...input });
    expect(mocks.rows[0].content).toBe(content);
    await expect(WorkItemSummaryRepository.findByWorkItem({
      providerId: 'provider-1',
      workItemId: 42,
    })).resolves.toEqual(inserted);
    await expect(WorkItemSummaryRepository.findByWorkItem({
      providerId: 'provider-1',
      workItemId: 404,
    })).resolves.toBeNull();
  });

  it('rejects summaries for missing providers', async () => {
    mocks.findProviderById.mockResolvedValue(undefined);

    await expect(WorkItemSummaryRepository.upsert(input)).rejects.toThrow(
      'missing provider provider-1',
    );
    expect(mocks.dbMock.insertInto).not.toHaveBeenCalled();
  });

  it('updates mutable fields without changing identity or id', async () => {
    const inserted = await WorkItemSummaryRepository.upsert(input);
    const updatedContent = '## Updated\n\nNew summary.';
    const updated = await WorkItemSummaryRepository.upsert({
      ...input,
      content: updatedContent,
      sourceHash: 'hash-2',
      sourceChangedDate: null,
      sourceLatestCommentId: null,
      sourceCommentCount: 3,
      generatedAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:00:00.000Z',
    });

    expect(updated).toEqual({
      ...inserted,
      content: updatedContent,
      sourceHash: 'hash-2',
      sourceChangedDate: null,
      sourceLatestCommentId: null,
      sourceCommentCount: 3,
      generatedAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:00:00.000Z',
    });
    expect(updated.id).toBe(inserted.id);
    expect(updated.providerId).toBe(inserted.providerId);
    expect(updated.workItemId).toBe(inserted.workItemId);
  });

  it('fetches deduplicated work item IDs in one query and isolates providers', async () => {
    await WorkItemSummaryRepository.upsert(input);
    await WorkItemSummaryRepository.upsert({ ...input, workItemId: 43 });
    await WorkItemSummaryRepository.upsert({ ...input, providerId: 'provider-2' });
    vi.clearAllMocks();

    const summaries = await WorkItemSummaryRepository.findByWorkItems({
      providerId: 'provider-1',
      workItemIds: [42, 43, 42],
    });

    expect(summaries.map((summary) => summary.workItemId)).toEqual([42, 43]);
    expect(summaries.every((summary) => summary.providerId === 'provider-1')).toBe(true);
    expect(mocks.getQueriedWorkItemIds()).toEqual([42, 43]);
    expect(mocks.dbMock.selectFrom).toHaveBeenCalledTimes(1);
  });

  it('returns an empty batch without querying', async () => {
    await expect(WorkItemSummaryRepository.findByWorkItems({
      providerId: 'provider-1',
      workItemIds: [],
    })).resolves.toEqual([]);
    expect(mocks.dbMock.selectFrom).not.toHaveBeenCalled();
  });

  it('reads stored content directly without legacy JSON parsing', async () => {
    mocks.rows.push({
      id: 'raw-summary',
      ...input,
      content: '{not JSON; still Markdown}',
    });

    await expect(WorkItemSummaryRepository.findByWorkItem({
      providerId: 'provider-1',
      workItemId: 42,
    })).resolves.toMatchObject({ content: '{not JSON; still Markdown}' });
  });
});
