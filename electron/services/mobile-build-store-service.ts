import { app } from 'electron';
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import type {
  MobileBuildArtifact,
  MobileBuildStoreBuildParams,
  MobileBuildStoreDeleteParams,
  MobileBuildStoreInstallParams,
  MobileBuildStoreListParams,
  MobileBuildStoreRenameParams,
  MobileBuildStoreStoreParams,
} from '@shared/mobile-build-store';

import { MobileBuildArtifactRepository } from '../database/repositories/mobile-build-artifacts';
import { runCommandService } from './run-command-service';
import { installAndroidApk } from './mobile-preview-android-adapter';
import { fingerprintMobileBuildInputs } from './mobile-build-store-fingerprint';
import { discoverMobileBuildArtifact } from './mobile-build-store-discovery';
import { runCommand } from './mobile-preview-process';
import { dbg } from '../lib/debug';

const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const execFileAsync = promisify(execFile);

function assertListParams(params: MobileBuildStoreListParams) {
  if (!params || typeof params !== 'object') throw new Error('Invalid mobile build store request.');
  for (const field of ['projectPath'] as const) {
    if (typeof params[field] !== 'string' || !params[field].trim()) {
      throw new Error(`Mobile build store ${field} is required.`);
    }
  }
  if (params.platform !== 'android' && params.platform !== 'ios') {
    throw new Error('Mobile build store platform must be android or ios.');
  }
}

function assertBuildParams(params: MobileBuildStoreBuildParams | MobileBuildStoreStoreParams) {
  assertListParams(params);
  for (const field of ['packageId', 'appPath', 'command'] as const) {
    if (typeof params[field] !== 'string' || !params[field].trim()) {
      throw new Error(`Mobile build store ${field} is required.`);
    }
  }
}

function fingerprintParams(params: MobileBuildStoreBuildParams | MobileBuildStoreStoreParams) {
  return { ...params, command: params.fingerprintCommand ?? params.command };
}

function legacyStoreRoot() {
  return join(app.getPath('userData'), 'mobile-build-store');
}

function storeRoot(repositoryPath: string) {
  return join(repositoryPath, '.jean-claude', 'build-artifacts');
}

function safeArtifactName(taskName: string | undefined): string {
  const safeName = taskName
    ?.trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safeName || 'mobile-build';
}

async function resolveRepositoryPath(projectPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: projectPath, encoding: 'utf-8' },
    );
    const commonDir = stdout.trim();
    if (commonDir) {
      const repositoryPath = dirname(resolve(projectPath, commonDir));
      dbg.mobilePreview(
        'Build Store repository resolved: project=%s commonDir=%s repository=%s',
        projectPath,
        commonDir,
        repositoryPath,
      );
      return repositoryPath;
    }
  } catch (error) {
    dbg.mobilePreview(
      'Build Store repository resolution failed for %s: %s',
      projectPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  return resolve(projectPath);
}

function assertInsideStore(path: string, repositoryPath: string | null) {
  const root = resolve(repositoryPath ? storeRoot(repositoryPath) : legacyStoreRoot());
  const candidate = resolve(path);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error('Mobile build artifact path is outside the build store.');
  }
}

async function waitForBuild({ taskId, commandId }: { taskId: string; commandId: string }) {
  const started = Date.now();
  while (Date.now() - started < BUILD_TIMEOUT_MS) {
    const command = runCommandService.getRunStatus(taskId).commands.find((item) => item.id === commandId);
    if (command?.status === 'errored') throw new Error('Mobile native build failed. See the build log for details.');
    if (command?.status === 'stopped') return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  await runCommandService.stopCommand({ taskId, runCommandId: commandId });
  throw new Error('Mobile native build timed out after 30 minutes.');
}

async function installIosSimulator({ deviceId, appPath }: { deviceId: string; appPath: string }) {
  if (!deviceId.trim() || !appPath.trim()) throw new Error('iOS simulator and app paths are required.');
  await runCommand('xcrun', ['simctl', 'install', deviceId, appPath]);
}

function toArtifact(row: Awaited<ReturnType<typeof MobileBuildArtifactRepository.findById>>): MobileBuildArtifact {
  if (!row) throw new Error('Mobile build artifact not found.');
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as MobileBuildArtifact['platform'],
    packageId: row.packageId,
    appPath: row.appPath,
    fingerprint: row.fingerprint,
    buildCommand: row.buildCommand,
    artifactKind: row.artifactKind as MobileBuildArtifact['artifactKind'],
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export const mobileBuildStoreService = {
  async list(params: MobileBuildStoreListParams): Promise<MobileBuildArtifact[]> {
    assertListParams(params);
    const repositoryPath = await resolveRepositoryPath(params.projectPath);
    const rows = await MobileBuildArtifactRepository.list({ platform: params.platform, repositoryPath });
    const root = storeRoot(repositoryPath);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const allowedExtension = params.platform === 'android' ? '.apk' : '.app';
    const files = new Set(
      entries
        .filter((entry) => entry.name.endsWith(allowedExtension))
        .map((entry) => resolve(root, entry.name)),
    );
    dbg.mobilePreview('Build Store list: platform=%s repository=%s extension=%s diskEntries=%d rows=%d', params.platform, repositoryPath, allowedExtension, files.size, rows.length);
    const valid: MobileBuildArtifact[] = [];
    for (const row of rows) {
      try {
        assertInsideStore(row.artifactPath, row.repositoryPath);
        if (!files.has(resolve(row.artifactPath))) continue;
        await stat(row.artifactPath);
        valid.push(toArtifact(row));
      } catch (error) {
        dbg.mobilePreview('Ignoring missing mobile build artifact %s: %s', row.id, error instanceof Error ? error.message : String(error));
      }
    }
    return valid;
  },

  async build(params: MobileBuildStoreBuildParams): Promise<MobileBuildArtifact> {
    assertBuildParams(params);
    if (typeof params.taskId !== 'string' || !params.taskId.trim() || typeof params.projectId !== 'string' || !params.projectId.trim()) {
      throw new Error('Mobile build task and project are required.');
    }
    const commandId = `mobile-build:${params.platform}:${randomUUID()}`;
    const startedAt = Date.now();
    await runCommandService.startAdHocCommand({
      taskId: params.taskId,
      projectId: params.projectId,
      workingDir: resolve(params.projectPath, params.appPath || '.'),
      runCommandId: commandId,
      name: `${params.platform === 'ios' ? 'iOS' : 'Android'} native build`,
      command: params.command,
      ports: [],
    });
    await waitForBuild({ taskId: params.taskId, commandId });
    return this.store({ ...params, startedAt });
  },

  async store(params: MobileBuildStoreStoreParams): Promise<MobileBuildArtifact> {
    assertBuildParams(params);
    if (!Number.isFinite(params.startedAt) || params.startedAt <= 0) {
      throw new Error('Mobile build start time is required.');
    }
    const fingerprint = await fingerprintMobileBuildInputs(fingerprintParams(params));
    const discovered = await discoverMobileBuildArtifact({ ...params, startedAt: params.startedAt });
    const repositoryPath = await resolveRepositoryPath(params.projectPath);
    const id = randomUUID();
    const extension = discovered.kind === 'apk' ? '.apk' : '.app';
    const artifactName = safeArtifactName(params.taskName);
    const artifactPath = join(storeRoot(repositoryPath), `${artifactName}-${Date.now()}-${id}${extension}`);
    const temporary = `${artifactPath}.tmp`;
    await mkdir(dirname(artifactPath), { recursive: true });
    await rm(temporary, { recursive: true, force: true });
    await cp(discovered.path, temporary, { recursive: true });
    await rename(temporary, artifactPath);
    const metadata = await stat(artifactPath);
    let row;
    try {
      row = await MobileBuildArtifactRepository.insert({
        id, platform: params.platform, packageId: params.packageId, appPath: params.appPath,
        name: params.taskName?.trim() || null,
        repositoryPath,
        fingerprint, buildCommand: params.command, artifactKind: discovered.kind,
        artifactPath, sizeBytes: discovered.sizeBytes || metadata.size, createdAt: new Date().toISOString(), lastUsedAt: null,
      });
    } catch (error) {
      await rm(artifactPath, { recursive: true, force: true });
      throw error;
    }
    return toArtifact(row);
  },

  async install({ artifactId, device }: MobileBuildStoreInstallParams): Promise<void> {
    const row = await MobileBuildArtifactRepository.findById(artifactId);
    if (!row) throw new Error('Mobile build artifact not found.');
    assertInsideStore(row.artifactPath, row.repositoryPath);
    await stat(row.artifactPath);
    if (device.platform !== row.platform) throw new Error(`This build is for ${row.platform}, but the selected device is ${device.platform}.`);
    if (row.platform === 'ios' && device.kind === 'physical') {
      throw new Error('The Build Store currently supports iOS simulators, not physical devices.');
    }
    if (device.platform === 'android') await installAndroidApk({ deviceId: device.id, apkPath: row.artifactPath });
    else await installIosSimulator({ deviceId: device.id, appPath: row.artifactPath });
    await MobileBuildArtifactRepository.markUsed(artifactId, new Date().toISOString());
  },

  async delete({ artifactId }: MobileBuildStoreDeleteParams): Promise<void> {
    const row = await MobileBuildArtifactRepository.findById(artifactId);
    if (!row) return;
    assertInsideStore(row.artifactPath, row.repositoryPath);
    await rm(row.artifactPath, { recursive: true, force: true });
    await MobileBuildArtifactRepository.delete(artifactId);
  },

  async rename({ artifactId, name }: MobileBuildStoreRenameParams): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) {
      throw new Error('Build name must be between 1 and 120 characters.');
    }
    const row = await MobileBuildArtifactRepository.findById(artifactId);
    if (!row) throw new Error('Mobile build artifact not found.');
    await MobileBuildArtifactRepository.rename(artifactId, trimmed);
  },
};
