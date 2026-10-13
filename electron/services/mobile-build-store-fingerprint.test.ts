import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { fingerprintMobileBuildInputs } from './mobile-build-store-fingerprint';

describe('fingerprintMobileBuildInputs', () => {
  it('is stable and excludes generated directories', async () => {
    const root = join(tmpdir(), `jc-build-fingerprint-${randomUUID()}`);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'build'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;');
    await writeFile(join(root, 'build', 'generated.bin'), 'one');
    const params = { projectPath: root, appPath: '.', platform: 'android' as const, packageId: 'com.example.app', command: 'npm run android' };
    const first = await fingerprintMobileBuildInputs(params);
    await writeFile(join(root, 'build', 'generated.bin'), 'two');
    expect(await fingerprintMobileBuildInputs(params)).toBe(first);
    await writeFile(join(root, 'src', 'index.ts'), 'export const value = 2;');
    expect(await fingerprintMobileBuildInputs(params)).not.toBe(first);
    await rm(root, { recursive: true, force: true });
  });
});
