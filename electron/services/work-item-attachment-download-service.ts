import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

import { ProviderRepository } from '../database/repositories';

import { fetchAuthenticatedImageStream } from './azure-image-proxy-service';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Save an Azure work item attachment where prompt file references can read it. */
export async function downloadWorkItemAttachment(params: {
  providerId: string;
  attachmentUrl: string;
  filename: string;
  projectPath: string;
}): Promise<{ filePath: string; filename: string }> {
  const url = new URL(params.attachmentUrl);
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'dev.azure.com' &&
      !url.hostname.endsWith('.visualstudio.com')) ||
    !/\/_apis\/wit\/attachments\/[^/]+/i.test(url.pathname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error('Invalid Azure work item attachment URL');
  }
  url.searchParams.set('api-version', '7.0');
  url.searchParams.set('download', 'true');

  const provider = await ProviderRepository.findById(params.providerId);
  if (!provider) throw new Error('Azure DevOps provider not found');
  const providerUrl = new URL(provider.baseUrl);
  const organization = providerUrl.hostname.endsWith('.visualstudio.com')
    ? providerUrl.hostname.split('.')[0]
    : providerUrl.pathname.split('/').filter(Boolean)[0];
  if (!organization) throw new Error('Azure DevOps organization not found');
  const attachmentOrganization =
    url.hostname === 'dev.azure.com'
      ? url.pathname.split('/')[1]
      : url.hostname.split('.')[0];
  if (attachmentOrganization.toLowerCase() !== organization.toLowerCase()) {
    throw new Error('Attachment belongs to a different Azure DevOps organization');
  }

  const response = await fetchAuthenticatedImageStream({
    providerId: params.providerId,
    imageUrl: url.href,
    organization,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Attachment download failed (${response.status})`);
  }

  const filename =
    path.basename(params.filename).replace(/[^a-zA-Z0-9._-]/g, '_') ||
    'attachment';
  const tmpDir = path.join(params.projectPath, '.jean-claude', 'tmp');
  const filePath = path.join(tmpDir, `${randomUUID().slice(0, 8)}-${filename}`);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  let totalBytes = 0;
  try {
    await mkdir(tmpDir, { recursive: true });
    reader = response.body.getReader();
    file = await open(filePath, 'wx');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_ATTACHMENT_BYTES) {
        throw new Error('Attachment exceeds 50 MB limit');
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten === 0) throw new Error('Attachment write stalled');
        offset += bytesWritten;
      }
    }
    await file.close();
    file = undefined;
    complete = true;
    return { filePath, filename: params.filename };
  } finally {
    if (!complete) {
      if (reader) await reader.cancel().catch(() => undefined);
      else await response.body.cancel().catch(() => undefined);
    }
    reader?.releaseLock();
    await file?.close().catch(() => undefined);
    if (!complete) await unlink(filePath).catch(() => undefined);
  }
}
