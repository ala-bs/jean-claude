import { describe, expect, it } from 'vitest';
import { vol } from 'memfs';

import {
  isProjectModelPolicy,
  MODEL_POLICY_FILE_RELATIVE_PATH,
  readPolicyFile,
} from './model-policy-file';

const REPO = '/repo';

/** Creates the in-memory repo, optionally with a policy file. */
function makeRepo(contents?: string): string {
  vol.fromJSON(
    contents === undefined
      ? { [`${REPO}/README.md`]: '' }
      : { [`${REPO}/${MODEL_POLICY_FILE_RELATIVE_PATH}`]: contents },
  );
  return REPO;
}

describe('isProjectModelPolicy', () => {
  it('accepts a minimal policy', () => {
    expect(isProjectModelPolicy({ mode: 'enforce' })).toBe(true);
  });

  it('accepts a full policy', () => {
    expect(
      isProjectModelPolicy({
        mode: 'prefer',
        allowedBackends: ['claude-code'],
        allowedProfileIds: ['preset-1'],
        pinnedProfileId: 'profile-1',
      }),
    ).toBe(true);
  });

  it('rejects non-objects and bad fields', () => {
    expect(isProjectModelPolicy(null)).toBe(false);
    expect(isProjectModelPolicy('enforce')).toBe(false);
    expect(isProjectModelPolicy({})).toBe(false);
    expect(isProjectModelPolicy({ mode: 'nope' })).toBe(false);
    expect(isProjectModelPolicy({ mode: 'inherit', allowedBackends: 'x' })).toBe(
      false,
    );
    expect(
      isProjectModelPolicy({ mode: 'inherit', allowedBackends: ['nope'] }),
    ).toBe(false);
    expect(
      isProjectModelPolicy({ mode: 'inherit', allowedProfileIds: [1] }),
    ).toBe(false);
    expect(
      isProjectModelPolicy({ mode: 'inherit', pinnedProfileId: 2 }),
    ).toBe(false);
  });
});

describe('readPolicyFile', () => {
  it('returns null when the file is absent', async () => {
    const cwd = makeRepo();
    await expect(readPolicyFile(cwd)).resolves.toBeNull();
  });

  it('parses a valid policy file', async () => {
    const cwd = makeRepo(
      JSON.stringify({
        mode: 'enforce',
        allowedBackends: ['claude-code', 'codex'],
        allowedProfileIds: ['preset-1'],
        pinnedProfileId: 'profile-1',
      }),
    );
    await expect(readPolicyFile(cwd)).resolves.toEqual({
      mode: 'enforce',
      allowedBackends: ['claude-code', 'codex'],
      allowedProfileIds: ['preset-1'],
      pinnedProfileId: 'profile-1',
    });
  });

  it('returns null on malformed JSON without throwing', async () => {
    const cwd = makeRepo('{ not json');
    await expect(readPolicyFile(cwd)).resolves.toBeNull();
  });

  it('returns null when the payload fails validation', async () => {
    const cwd = makeRepo(JSON.stringify({ mode: 'whatever' }));
    await expect(readPolicyFile(cwd)).resolves.toBeNull();
  });

  it('drops backends the user has not enabled', async () => {
    const cwd = makeRepo(
      JSON.stringify({
        mode: 'enforce',
        allowedBackends: ['claude-code', 'codex'],
      }),
    );
    await expect(
      readPolicyFile(cwd, { enabledBackends: ['claude-code', 'opencode'] }),
    ).resolves.toEqual({ mode: 'enforce', allowedBackends: ['claude-code'] });
  });

  it('keeps an empty allowedBackends when nothing intersects', async () => {
    const cwd = makeRepo(
      JSON.stringify({ mode: 'enforce', allowedBackends: ['codex'] }),
    );
    await expect(
      readPolicyFile(cwd, { enabledBackends: ['claude-code'] }),
    ).resolves.toEqual({ mode: 'enforce', allowedBackends: [] });
  });

  it('leaves allowedBackends untouched when no enabledBackends are given', async () => {
    const cwd = makeRepo(
      JSON.stringify({ mode: 'prefer', allowedBackends: ['codex'] }),
    );
    await expect(readPolicyFile(cwd)).resolves.toEqual({
      mode: 'prefer',
      allowedBackends: ['codex'],
    });
  });

  it('uses an injected reader when provided', async () => {
    const seen: string[] = [];
    const policy = await readPolicyFile('/repo', {
      readFile: async (path) => {
        seen.push(path);
        return JSON.stringify({ mode: 'inherit' });
      },
    });
    expect(policy).toEqual({ mode: 'inherit' });
    expect(seen).toEqual([`/repo/${MODEL_POLICY_FILE_RELATIVE_PATH}`]);
  });

  it('returns null when the injected reader rejects', async () => {
    await expect(
      readPolicyFile('/repo', {
        readFile: async () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toBeNull();
  });
});
