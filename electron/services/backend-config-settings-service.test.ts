import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn(() => '/tmp/jc-backend-config-bootstrap'),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: homedirMock,
  };
});

import {
  readBackendUserConfig,
  writeBackendUserConfig,
} from './backend-config-settings-service';

describe('backend-config-settings-service', () => {
  let homeDirectory: string;

  beforeEach(async (context) => {
    homeDirectory = path.join(
      os.tmpdir(),
      `jc-backend-config-${context.task.id}`,
    );
    homedirMock.mockReturnValue(homeDirectory);
    await fs.mkdir(homeDirectory, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(homeDirectory, { recursive: true, force: true });
  });

  it('returns default Codex config when file is missing', async () => {
    const result = await readBackendUserConfig('codex');

    expect(result.exists).toBe(false);
    expect(result.content).toBe('');
    expect(result.path).toBe(path.join(homeDirectory, '.codex', 'config.toml'));
  });

  it('rejects invalid Codex TOML on write', async () => {
    await expect(
      writeBackendUserConfig({
        backend: 'codex',
        content: 'model = "gpt-5.5',
      }),
    ).rejects.toThrow('Invalid config:');
  });

  it('writes valid Codex TOML config', async () => {
    const result = await writeBackendUserConfig({
      backend: 'codex',
      content: 'model = "gpt-5.5"\napproval_policy = "on-request"',
    });

    expect(result.exists).toBe(true);
    await expect(fs.readFile(result.path, 'utf8')).resolves.toBe(
      'model = "gpt-5.5"\napproval_policy = "on-request"\n',
    );
  });
});
