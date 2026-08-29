// electron/database/repositories/project-env-vars.ts
import type {
  NewProjectEnvVar,
  ProjectEnvVar,
  UpdateProjectEnvVar,
} from '@shared/types';

import { db } from '../index';
import { encryptionService } from '../../services/encryption-service';
import type { ProjectEnvVarRow } from '../schema';

/**
 * POSIX-ish environment variable name. Deliberately strict: a key with an `=`
 * or a space silently breaks the child environment rather than erroring.
 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * App-internal namespaces. `getChildProcessEnv` strips these from the inherited
 * environment, but overrides are applied afterwards, so without this check a
 * project variable could reintroduce one (e.g. ELECTRON_RUN_AS_NODE) and change
 * how the agent process itself boots.
 */
const RESERVED_ENV_PREFIXES = ['ELECTRON_', 'JC_'];

export function assertValidEnvKey(key: string): void {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid environment variable name "${key}". Use letters, digits and underscores, and don't start with a digit.`,
    );
  }

  const normalized = key.toUpperCase();
  const reserved = RESERVED_ENV_PREFIXES.find((prefix) =>
    normalized.startsWith(prefix),
  );
  if (reserved) {
    throw new Error(
      `"${key}" is reserved: names starting with ${reserved} are used internally by Jean-Claude and can't be set per project.`,
    );
  }
}

/**
 * Translate the (projectId, key) unique-index violation into something a user
 * can act on. The UI pre-checks duplicates when adding, but not when renaming,
 * so a raw `SQLITE_CONSTRAINT_UNIQUE` would otherwise land in a toast.
 */
async function withDuplicateKeyMessage<T>(
  key: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE') && message.includes('project_env_vars')) {
      throw new Error(
        `"${key ?? 'That name'}" is already set for this project. Rename or remove the existing variable first.`,
      );
    }
    throw error;
  }
}

function assertEncryptionAvailable(): void {
  if (!encryptionService.isEncryptionAvailable()) {
    throw new Error(
      'Secure storage is unavailable on this system, so secret environment variables cannot be saved. Store the value as a plain variable instead, or enable an OS keychain.',
    );
  }
}

/** Whether a stored secret still decrypts. The plaintext is discarded. */
function canDecryptSecret(row: ProjectEnvVarRow): boolean {
  if (!row.valueEncrypted) return false;
  try {
    encryptionService.decrypt(row.valueEncrypted);
    return true;
  } catch {
    return false;
  }
}

// Strips the encrypted value: secrets are write-only from the renderer's side.
// Only the *decryptability* of a secret is reported, never its contents.
function toProjectEnvVar(row: ProjectEnvVarRow): ProjectEnvVar {
  const isSecret = row.isSecret === 1;
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    value: isSecret ? null : (row.value ?? ''),
    isSecret,
    decryptionFailed: isSecret && !canDecryptSecret(row),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const ProjectEnvVarRepository = {
  findByProjectId: async (projectId: string): Promise<ProjectEnvVar[]> => {
    const rows = await db
      .selectFrom('project_env_vars')
      .selectAll()
      .where('projectId', '=', projectId)
      .orderBy('sortOrder', 'asc')
      .orderBy('key', 'asc')
      .execute();
    return rows.map(toProjectEnvVar);
  },

  /**
   * Internal: resolve every variable for a project to plain text for injection
   * into an agent process. Never exposed over IPC.
   *
   * A secret that fails to decrypt (keychain reset, machine migration) is
   * skipped rather than throwing, so one stale row can't block every task. Its
   * name is returned in `undecryptableKeys` so callers can warn the user
   * instead of failing silently.
   */
  getResolvedEnv: async (
    projectId: string,
  ): Promise<{ env: Record<string, string>; undecryptableKeys: string[] }> => {
    const rows = await db
      .selectFrom('project_env_vars')
      .selectAll()
      .where('projectId', '=', projectId)
      .orderBy('sortOrder', 'asc')
      .orderBy('key', 'asc')
      .execute();

    const env: Record<string, string> = {};
    const undecryptableKeys: string[] = [];

    for (const row of rows) {
      if (row.isSecret !== 1) {
        env[row.key] = row.value ?? '';
        continue;
      }
      if (!row.valueEncrypted) {
        undecryptableKeys.push(row.key);
        continue;
      }
      try {
        env[row.key] = encryptionService.decrypt(row.valueEncrypted);
      } catch {
        undecryptableKeys.push(row.key);
      }
    }

    return { env, undecryptableKeys };
  },

  create: async (data: NewProjectEnvVar): Promise<ProjectEnvVar> => {
    const key = data.key.trim();
    assertValidEnvKey(key);
    const isSecret = data.isSecret ?? false;
    if (isSecret) assertEncryptionAvailable();

    const now = new Date().toISOString();
    const row = await withDuplicateKeyMessage(key, () =>
      db
        .insertInto('project_env_vars')
        .values({
          id: crypto.randomUUID(),
          projectId: data.projectId,
          key,
          value: isSecret ? null : data.value,
          valueEncrypted: isSecret
            ? encryptionService.encrypt(data.value)
            : null,
          isSecret: isSecret ? 1 : 0,
          sortOrder: data.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return toProjectEnvVar(row);
  },

  update: async (
    id: string,
    data: UpdateProjectEnvVar,
  ): Promise<ProjectEnvVar> => {
    const existing = await db
      .selectFrom('project_env_vars')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    const isSecret = data.isSecret ?? existing.isSecret === 1;
    const wasSecret = existing.isSecret === 1;

    // Changing the secret flag moves the value between columns, so the caller
    // must resend it. Demotion in particular must NOT decrypt the stored value
    // into the plaintext column: that would hand a secret back to the renderer
    // through the returned row and defeat write-only storage.
    if (isSecret !== wasSecret && data.value === undefined) {
      throw new Error(
        isSecret
          ? 'A value is required when converting an environment variable into a secret.'
          : 'A value is required when converting a secret into a plain environment variable. Secrets cannot be read back.',
      );
    }
    // Only assert when we are about to encrypt. Renaming or reordering an
    // existing secret touches no ciphertext and must keep working even if the
    // keychain became unavailable.
    if (isSecret && data.value !== undefined) assertEncryptionAvailable();

    const updateData: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (data.key !== undefined) {
      const key = data.key.trim();
      assertValidEnvKey(key);
      updateData.key = key;
    }
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;

    if (data.value !== undefined) {
      updateData.value = isSecret ? null : data.value;
      updateData.valueEncrypted = isSecret
        ? encryptionService.encrypt(data.value)
        : null;
    }

    if (data.isSecret !== undefined) updateData.isSecret = isSecret ? 1 : 0;

    const row = await withDuplicateKeyMessage(data.key, () =>
      db
        .updateTable('project_env_vars')
        .set(updateData)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return toProjectEnvVar(row);
  },

  delete: async (id: string): Promise<void> => {
    await db.deleteFrom('project_env_vars').where('id', '=', id).execute();
  },
};
