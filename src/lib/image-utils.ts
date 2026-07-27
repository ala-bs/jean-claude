import { MAX_IMAGE_ATTACHMENT_BYTES } from '@shared/media-limits';
import type { PromptImagePart } from '@shared/agent-backend-types';

import { compressImage } from './image-compression';

export const MAX_IMAGES = 5;
export const MAX_FILE_SIZE = MAX_IMAGE_ATTACHMENT_BYTES;
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
];

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/**
 * Attachment hosts (e.g. Azure DevOps) serve uploaded files with a content type
 * derived from the file extension, not from the upload request. Images are
 * re-encoded to AVIF/WebP during compression, so the original extension would
 * make the attachment render as broken. Align the extension with actual bytes.
 */
export function getAttachmentFileName(
  fileName: string,
  mimeType: string,
): string {
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) return fileName;
  const base = fileName.replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}.${extension}`;
}

export async function processImageFile(
  file: File,
  onAttach: (image: PromptImagePart) => void,
  onError?: (message: string) => void,
): Promise<void> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    onError?.(`Unsupported image type: ${file.type}`);
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    onError?.(
      `Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)`,
    );
    return;
  }
  const { agent, storage, width, height } = await compressImage(file);
  onAttach({
    type: 'image',
    data: agent.data,
    mimeType: agent.mimeType,
    filename: file.name,
    width,
    height,
    storageData: storage.data,
    storageMimeType: storage.mimeType,
  });
}
