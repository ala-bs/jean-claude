// electron/database/repositories/tokens.ts
import type { NewToken, ProviderType, Token, UpdateToken } from '@shared/types';

import { db } from '../index';
import { encryptionService } from '../../services/encryption-service';
import type { TokenRow } from '../schema';


// Convert DB row to Token (without encrypted value)
function toToken(row: TokenRow): Token {
  return {
    id: row.id,
    label: row.label,
    providerType: row.providerType,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const TokenRepository = {
  findAll: async (): Promise<Token[]> => {
    const rows = await db.selectFrom('tokens').selectAll().execute();
    return rows.map(toToken);
  },

  findById: async (id: string): Promise<Token | undefined> => {
    const row = await db
      .selectFrom('tokens')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toToken(row) : undefined;
  },

  findByProviderType: async (providerType: string): Promise<Token[]> => {
    const rows = await db
      .selectFrom('tokens')
      .selectAll()
      .where('providerType', '=', providerType as ProviderType)
      .execute();
    return rows.map(toToken);
  },

  // Internal: get decrypted token for API calls (never exposed via IPC)
  getDecryptedToken: async (id: string): Promise<string | undefined> => {
    const row = await db
      .selectFrom('tokens')
      .select('tokenEncrypted')
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? encryptionService.decrypt(row.tokenEncrypted) : undefined;
  },

  create: async (data: NewToken): Promise<Token> => {
    const now = new Date().toISOString();
    const id = data.id ?? crypto.randomUUID();

    const row = await db
      .insertInto('tokens')
      .values({
        id,
        label: data.label,
        tokenEncrypted: encryptionService.encrypt(data.token),
        providerType: data.providerType,
        expiresAt: data.expiresAt ?? null,
        createdAt: data.createdAt ?? now,
        updatedAt: data.updatedAt ?? now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toToken(row);
  },

  update: async (id: string, data: UpdateToken): Promise<Token> => {
    const updateData: Record<string, unknown> = {
      updatedAt: data.updatedAt ?? new Date().toISOString(),
    };

    if (data.label !== undefined) updateData.label = data.label;
    if (data.expiresAt !== undefined) updateData.expiresAt = data.expiresAt;
    if (data.token !== undefined) {
      updateData.tokenEncrypted = encryptionService.encrypt(data.token);
    }

    const row = await db
      .updateTable('tokens')
      .set(updateData)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return toToken(row);
  },

  // Refuses to delete a token that any provider still references. The check
  // and the delete share a transaction so a concurrent provider update can't
  // slip a reference in between them.
  delete: async (id: string): Promise<void> => {
    await db.transaction().execute(async (trx) => {
      const usedBy = await trx
        .selectFrom('providers')
        .select('label')
        .where('tokenId', '=', id)
        .execute();

      if (usedBy.length > 0) {
        const labels = usedBy.map((provider) => provider.label).join(', ');
        const plural = usedBy.length > 1;
        throw new Error(
          `Cannot delete token: still used by ${usedBy.length} organization${
            plural ? 's' : ''
          } (${labels}). Assign another token to ${
            plural ? 'them' : 'it'
          } first.`,
        );
      }

      await trx.deleteFrom('tokens').where('id', '=', id).execute();
    });
  },
};
