import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const deleted: Array<{ table: string; column: string; value: string }> = [];
  const transaction = {
    execute: vi.fn(async (callback: (trx: unknown) => Promise<void>) => {
      const trx = {
        deleteFrom: (table: string) => ({
          where: (column: string, _operator: string, value: string) => ({
            execute: async () => {
              deleted.push({ table, column, value });
            },
          }),
        }),
      };
      await callback(trx);
    }),
  };

  const selects: Array<{ table: string; column: string; value: string }> = [];
  const selectResult: Array<Record<string, unknown>> = [];

  return {
    db: {
      transaction: () => transaction,
      selectFrom: (table: string) => ({
        selectAll: () => ({
          where: (column: string, _operator: string, value: string) => ({
            execute: async () => {
              selects.push({ table, column, value });
              return selectResult;
            },
          }),
        }),
      }),
    },
    selects,
    selectResult,
    deleted,
    reset: () => {
      deleted.splice(0, deleted.length);
      selects.splice(0, selects.length);
      selectResult.splice(0, selectResult.length);
      transaction.execute.mockClear();
    },
  };
});

vi.mock('../index', () => ({ db: mocks.db }));

import { ProviderRepository } from './providers';

describe('ProviderRepository', () => {
  beforeEach(() => mocks.reset());

  it('deletes summaries before deleting their provider', async () => {
    await ProviderRepository.delete('provider-1');

    expect(mocks.deleted).toEqual([
      {
        table: 'work_item_summaries',
        column: 'providerId',
        value: 'provider-1',
      },
      { table: 'providers', column: 'id', value: 'provider-1' },
    ]);
  });

  it('finds the providers referencing a token', async () => {
    mocks.selectResult.push({ id: 'provider-1', label: 'contoso' });

    const providers = await ProviderRepository.findByTokenId('token-1');

    expect(mocks.selects).toEqual([
      { table: 'providers', column: 'tokenId', value: 'token-1' },
    ]);
    expect(providers).toEqual([{ id: 'provider-1', label: 'contoso' }]);
  });
});
