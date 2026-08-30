import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectEnvVarRow } from '../schema';

const mocks = vi.hoisted(() => {
  let rows: ProjectEnvVarRow[] = [];
  let encryptionAvailable = true;
  let lastUpdate: Record<string, unknown> | null = null;

  const selectChain = {
    selectAll: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    execute: async () => rows,
    executeTakeFirst: async () => rows[0],
    executeTakeFirstOrThrow: async () => rows[0],
  };

  // Applies the captured SET payload over the existing row so assertions can
  // inspect what would actually be persisted, not just what was requested.
  const updateChain = {
    set: (data: Record<string, unknown>) => {
      lastUpdate = data;
      return updateChain;
    },
    where: () => updateChain,
    returningAll: () => updateChain,
    executeTakeFirstOrThrow: async () => ({ ...rows[0], ...lastUpdate }),
  };

  return {
    db: {
      selectFrom: () => selectChain,
      updateTable: () => updateChain,
    },
    setRows: (next: ProjectEnvVarRow[]) => {
      rows = next;
    },
    setEncryptionAvailable: (value: boolean) => {
      encryptionAvailable = value;
    },
    isEncryptionAvailable: () => encryptionAvailable,
    getLastUpdate: () => lastUpdate,
    reset: () => {
      rows = [];
      encryptionAvailable = true;
      lastUpdate = null;
    },
  };
});

vi.mock('../index', () => ({ db: mocks.db }));
vi.mock('../../services/encryption-service', () => ({
  encryptionService: {
    isEncryptionAvailable: () => mocks.isEncryptionAvailable(),
    encrypt: (v: string) => `enc:${v}`,
    decrypt: (v: string) => {
      if (!v.startsWith('enc:')) throw new Error('cannot decrypt');
      return v.slice(4);
    },
  },
}));

import {
  ProjectEnvVarRepository,
  assertValidEnvKey,
} from './project-env-vars';

function row(overrides: Partial<ProjectEnvVarRow>): ProjectEnvVarRow {
  return {
    id: 'id-1',
    projectId: 'project-1',
    key: 'KEY',
    value: null,
    valueEncrypted: null,
    isSecret: 0,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('assertValidEnvKey', () => {
  it('accepts POSIX-style names', () => {
    expect(() => assertValidEnvKey('API_KEY_2')).not.toThrow();
    expect(() => assertValidEnvKey('_private')).not.toThrow();
  });

  it('rejects names that would corrupt the child environment', () => {
    expect(() => assertValidEnvKey('2FA')).toThrow();
    expect(() => assertValidEnvKey('HAS SPACE')).toThrow();
    expect(() => assertValidEnvKey('A=B')).toThrow();
    expect(() => assertValidEnvKey('')).toThrow();
  });

  it('rejects app-internal namespaces that overrides would reintroduce', () => {
    // getChildProcessEnv strips these from the inherited env but applies
    // overrides afterwards, so they must be blocked at the input instead.
    expect(() => assertValidEnvKey('ELECTRON_RUN_AS_NODE')).toThrow(/reserved/);
    expect(() => assertValidEnvKey('JC_SKIP_INSTANCE_LOCK')).toThrow(
      /reserved/,
    );
    expect(() => assertValidEnvKey('electron_run_as_node')).toThrow(/reserved/);
  });
});

describe('ProjectEnvVarRepository.findByProjectId', () => {
  beforeEach(() => mocks.reset());

  it('never returns secret values to the renderer', async () => {
    mocks.setRows([
      row({ id: 'a', key: 'PLAIN', value: 'visible', isSecret: 0 }),
      row({
        id: 'b',
        key: 'SECRET',
        valueEncrypted: 'enc:hunter2',
        isSecret: 1,
      }),
    ]);

    const result = await ProjectEnvVarRepository.findByProjectId('project-1');

    expect(result[0]).toMatchObject({ key: 'PLAIN', value: 'visible' });
    expect(result[1]).toMatchObject({
      key: 'SECRET',
      value: null,
      isSecret: true,
      decryptionFailed: false,
    });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('flags a secret the keychain can no longer decrypt', async () => {
    mocks.setRows([
      row({ id: 'a', key: 'BROKEN', valueEncrypted: 'garbage', isSecret: 1 }),
    ]);

    const result = await ProjectEnvVarRepository.findByProjectId('project-1');

    expect(result[0]).toMatchObject({
      key: 'BROKEN',
      value: null,
      decryptionFailed: true,
    });
  });
});

describe('ProjectEnvVarRepository.getResolvedEnv', () => {
  beforeEach(() => mocks.reset());

  it('decrypts secrets and passes plain values through', async () => {
    mocks.setRows([
      row({ id: 'a', key: 'PLAIN', value: 'visible', isSecret: 0 }),
      row({
        id: 'b',
        key: 'SECRET',
        valueEncrypted: 'enc:hunter2',
        isSecret: 1,
      }),
    ]);

    await expect(
      ProjectEnvVarRepository.getResolvedEnv('project-1'),
    ).resolves.toEqual({
      env: { PLAIN: 'visible', SECRET: 'hunter2' },
      undecryptableKeys: [],
    });
  });

  it('skips an undecryptable secret and reports it by name', async () => {
    mocks.setRows([
      row({ id: 'a', key: 'PLAIN', value: 'visible', isSecret: 0 }),
      row({ id: 'b', key: 'BROKEN', valueEncrypted: 'garbage', isSecret: 1 }),
    ]);

    await expect(
      ProjectEnvVarRepository.getResolvedEnv('project-1'),
    ).resolves.toEqual({
      env: { PLAIN: 'visible' },
      undecryptableKeys: ['BROKEN'],
    });
  });
});

describe('ProjectEnvVarRepository.update', () => {
  beforeEach(() => mocks.reset());

  it('refuses to demote a secret without a replacement value', async () => {
    // Regression: the demote path used to decrypt the stored secret into the
    // plaintext column, which handed it straight back to the renderer.
    mocks.setRows([
      row({ key: 'SECRET', valueEncrypted: 'enc:hunter2', isSecret: 1 }),
    ]);

    await expect(
      ProjectEnvVarRepository.update('id-1', { isSecret: false }),
    ).rejects.toThrow(/cannot be read back/i);
    expect(mocks.getLastUpdate()).toBeNull();
  });

  it('never returns a decrypted secret when demoting with a new value', async () => {
    mocks.setRows([
      row({ key: 'SECRET', valueEncrypted: 'enc:hunter2', isSecret: 1 }),
    ]);

    const result = await ProjectEnvVarRepository.update('id-1', {
      isSecret: false,
      value: 'now-plain',
    });

    expect(result.value).toBe('now-plain');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(mocks.getLastUpdate()).toMatchObject({
      value: 'now-plain',
      valueEncrypted: null,
      isSecret: 0,
    });
  });

  it('requires a value when promoting a plain var to a secret', async () => {
    mocks.setRows([row({ key: 'PLAIN', value: 'visible', isSecret: 0 })]);

    await expect(
      ProjectEnvVarRepository.update('id-1', { isSecret: true }),
    ).rejects.toThrow(/value is required/i);
  });

  it('encrypts the new value when promoting to a secret', async () => {
    mocks.setRows([row({ key: 'PLAIN', value: 'visible', isSecret: 0 })]);

    const result = await ProjectEnvVarRepository.update('id-1', {
      isSecret: true,
      value: 'hunter2',
    });

    expect(mocks.getLastUpdate()).toMatchObject({
      value: null,
      valueEncrypted: 'enc:hunter2',
      isSecret: 1,
    });
    expect(result.value).toBeNull();
  });

  it('allows renaming an existing secret when the keychain is unavailable', async () => {
    // Renaming touches no ciphertext, so it must not be blocked — otherwise a
    // broken keychain leaves the row uneditable and undeletable-by-replacement.
    mocks.setRows([
      row({ key: 'OLD_NAME', valueEncrypted: 'enc:hunter2', isSecret: 1 }),
    ]);
    mocks.setEncryptionAvailable(false);

    await expect(
      ProjectEnvVarRepository.update('id-1', { key: 'NEW_NAME' }),
    ).resolves.toMatchObject({ key: 'NEW_NAME' });
  });

  it('refuses to re-encrypt a secret when the keychain is unavailable', async () => {
    mocks.setRows([
      row({ key: 'SECRET', valueEncrypted: 'enc:hunter2', isSecret: 1 }),
    ]);
    mocks.setEncryptionAvailable(false);

    await expect(
      ProjectEnvVarRepository.update('id-1', { value: 'new-secret' }),
    ).rejects.toThrow(/Secure storage is unavailable/);
  });
});

describe('ProjectEnvVarRepository.create', () => {
  beforeEach(() => mocks.reset());

  it('refuses to store a secret when secure storage is unavailable', async () => {
    mocks.setEncryptionAvailable(false);

    await expect(
      ProjectEnvVarRepository.create({
        projectId: 'project-1',
        key: 'SECRET',
        value: 'hunter2',
        isSecret: true,
      }),
    ).rejects.toThrow(/Secure storage is unavailable/);
  });
});
