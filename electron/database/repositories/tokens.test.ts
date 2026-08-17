import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const deleted: Array<{ table: string; value: string }> = [];
  let providersUsingToken: Array<{ label: string }> = [];

  const trx = {
    selectFrom: (table: string) => ({
      select: () => ({
        where: (_column: string, _operator: string, _value: string) => ({
          execute: async () => {
            if (table !== 'providers') return [];
            return providersUsingToken;
          },
        }),
      }),
    }),
    deleteFrom: (table: string) => ({
      where: (_column: string, _operator: string, value: string) => ({
        execute: async () => {
          deleted.push({ table, value });
        },
      }),
    }),
  };

  return {
    db: {
      transaction: () => ({
        execute: async (callback: (t: typeof trx) => Promise<void>) =>
          callback(trx),
      }),
    },
    deleted,
    setProvidersUsingToken: (providers: Array<{ label: string }>) => {
      providersUsingToken = providers;
    },
    reset: () => {
      deleted.splice(0, deleted.length);
      providersUsingToken = [];
    },
  };
});

vi.mock('../index', () => ({ db: mocks.db }));
vi.mock('../../services/encryption-service', () => ({
  encryptionService: { encrypt: (v: string) => v, decrypt: (v: string) => v },
}));

import { TokenRepository } from './tokens';

describe('TokenRepository.delete', () => {
  beforeEach(() => mocks.reset());

  it('deletes a token that no organization uses', async () => {
    await TokenRepository.delete('token-1');

    expect(mocks.deleted).toEqual([{ table: 'tokens', value: 'token-1' }]);
  });

  it('refuses to delete a token used by one organization', async () => {
    mocks.setProvidersUsingToken([{ label: 'contoso' }]);

    await expect(TokenRepository.delete('token-1')).rejects.toThrow(
      'Cannot delete token: still used by 1 organization (contoso). Assign another token to it first.',
    );
    expect(mocks.deleted).toEqual([]);
  });

  it('refuses to delete a token used by several organizations', async () => {
    mocks.setProvidersUsingToken([{ label: 'contoso' }, { label: 'fabrikam' }]);

    await expect(TokenRepository.delete('token-1')).rejects.toThrow(
      'Cannot delete token: still used by 2 organizations (contoso, fabrikam). Assign another token to them first.',
    );
    expect(mocks.deleted).toEqual([]);
  });
});
