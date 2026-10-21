import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchAuthenticatedImageStream, findProviderById } = vi.hoisted(() => ({
  fetchAuthenticatedImageStream: vi.fn(),
  findProviderById: vi.fn(),
}));
vi.mock('./azure-image-proxy-service', () => ({ fetchAuthenticatedImageStream }));
vi.mock('../database/repositories', () => ({
  ProviderRepository: { findById: findProviderById },
}));

import { downloadWorkItemAttachment } from './work-item-attachment-download-service';

const tempDirs: string[] = [];
afterEach(async () => {
  fetchAuthenticatedImageStream.mockReset();
  findProviderById.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('downloadWorkItemAttachment', () => {
  it('saves authenticated bytes to the managed prompt directory', async () => {
    await mkdir(tmpdir(), { recursive: true });
    const projectPath = await mkdtemp(path.join(tmpdir(), 'jc-work-item-'));
    tempDirs.push(projectPath);
    findProviderById.mockResolvedValue({ baseUrl: 'https://dev.azure.com/org' });
    fetchAuthenticatedImageStream.mockResolvedValue(new Response('document bytes'));

    const result = await downloadWorkItemAttachment({
      providerId: 'provider',
      attachmentUrl: 'https://dev.azure.com/org/_apis/wit/attachments/abc',
      filename: 'design.pdf',
      projectPath,
    });

    expect(result.filePath).toContain(path.join(projectPath, '.jean-claude', 'tmp'));
    expect(await readFile(result.filePath, 'utf8')).toBe('document bytes');
    expect(fetchAuthenticatedImageStream).toHaveBeenCalledWith({
      providerId: 'provider',
      imageUrl: expect.stringContaining('api-version=7.0'),
      organization: 'org',
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects a non-Azure URL before sending provider credentials', async () => {
    await expect(downloadWorkItemAttachment({
      providerId: 'provider',
      attachmentUrl: 'https://example.com/_apis/wit/attachments/abc',
      filename: 'secret.pdf',
      projectPath: '/tmp',
    })).rejects.toThrow('Invalid Azure work item attachment URL');
    expect(fetchAuthenticatedImageStream).not.toHaveBeenCalled();
  });

  it('rejects an attachment from another organization', async () => {
    findProviderById.mockResolvedValue({ baseUrl: 'https://dev.azure.com/org' });
    await expect(downloadWorkItemAttachment({
      providerId: 'provider',
      attachmentUrl: 'https://dev.azure.com/other/_apis/wit/attachments/abc',
      filename: 'secret.pdf',
      projectPath: '/tmp',
    })).rejects.toThrow('different Azure DevOps organization');
    expect(fetchAuthenticatedImageStream).not.toHaveBeenCalled();
  });

  it('cancels the response when the project directory cannot be created', async () => {
    await mkdir(tmpdir(), { recursive: true });
    const directory = await mkdtemp(path.join(tmpdir(), 'jc-work-item-'));
    tempDirs.push(directory);
    const projectPath = path.join(directory, 'not-a-directory');
    await writeFile(projectPath, 'file');
    findProviderById.mockResolvedValue({ baseUrl: 'https://dev.azure.com/org' });
    const response = new Response('document bytes');
    const cancel = vi.spyOn(response.body!, 'cancel');
    fetchAuthenticatedImageStream.mockResolvedValue(response);

    await expect(downloadWorkItemAttachment({
      providerId: 'provider',
      attachmentUrl: 'https://dev.azure.com/org/_apis/wit/attachments/abc',
      filename: 'design.pdf',
      projectPath,
    })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
