import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { discoverMobileBuildArtifact } from './mobile-build-store-discovery';

describe('discoverMobileBuildArtifact', () => {
  it('finds an iOS simulator app bundle directory', async () => {
    const root = join(tmpdir(), `jc-build-discovery-${randomUUID()}`);
    const app = join(root, 'ios', 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'Demo.app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'Info.plist'), 'plist');
    const result = await discoverMobileBuildArtifact({ projectPath: root, appPath: '.', platform: 'ios', startedAt: Date.now() - 1000 });
    expect(result).toMatchObject({ path: app, kind: 'ios-simulator-app' });
    await rm(root, { recursive: true, force: true });
  });

  it('rejects ambiguous Android outputs', async () => {
    const root = join(tmpdir(), `jc-build-discovery-${randomUUID()}`);
    const output = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'one.apk'), 'one');
    await writeFile(join(output, 'two.apk'), 'two');
    await expect(discoverMobileBuildArtifact({ projectPath: root, appPath: '.', platform: 'android', startedAt: Date.now() - 1000 })).rejects.toThrow('Could not uniquely discover');
    await rm(root, { recursive: true, force: true });
  });

  it('does not accept an iOS device app as a simulator artifact', async () => {
    const root = join(tmpdir(), `jc-build-discovery-${randomUUID()}`);
    const app = join(root, 'ios', 'build', 'Build', 'Products', 'Debug-iphoneos', 'Demo.app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'Info.plist'), 'plist');
    await expect(discoverMobileBuildArtifact({ projectPath: root, appPath: '.', platform: 'ios', startedAt: Date.now() - 1000 })).rejects.toThrow('found: none');
    await rm(root, { recursive: true, force: true });
  });
});
