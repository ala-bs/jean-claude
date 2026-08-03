import { MAX_IMAGE_ATTACHMENT_BYTES } from '@shared/media-limits';
import type { PromptImagePart } from '@shared/agent-backend-types';

import { compressImage, transcodeBase64Image } from './image-compression';

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

const ATTACHMENT_SAFE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * Pick the bytes to upload as a remote attachment (Azure DevOps).
 *
 * The storage variant is usually AVIF, which Azure DevOps fails to render in PR
 * descriptions. Prefer the storage bytes only when they are a broadly supported
 * format (e.g. an untouched GIF staged for animation), otherwise fall back to
 * the WebP agent variant.
 */
export function getAttachmentPayload(image: {
  data: string;
  mimeType: string;
  storageData?: string;
  storageMimeType?: string;
}): { dataBase64: string; mimeType: string } {
  if (
    image.storageData &&
    image.storageMimeType &&
    ATTACHMENT_SAFE_MIME_TYPES.has(image.storageMimeType)
  ) {
    return { dataBase64: image.storageData, mimeType: image.storageMimeType };
  }
  return { dataBase64: image.data, mimeType: image.mimeType };
}

/**
 * Azure DevOps rejects uploads whose extension is not in its allow list
 * (PNG, GIF, JPG, JPEG, ...). WebP/AVIF variants must be re-encoded to PNG
 * before upload.
 */
const AZURE_ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
]);

export async function getAzureAttachmentPayload(image: {
  data: string;
  mimeType: string;
  storageData?: string;
  storageMimeType?: string;
}): Promise<{ dataBase64: string; mimeType: string }> {
  // Only GIF storage bytes win: they are the untouched original kept for
  // animation, which a canvas re-encode would flatten to a single frame.
  if (image.storageData && image.storageMimeType === 'image/gif') {
    return { dataBase64: image.storageData, mimeType: image.storageMimeType };
  }
  const payload = { dataBase64: image.data, mimeType: image.mimeType };
  if (AZURE_ALLOWED_MIME_TYPES.has(payload.mimeType)) return payload;
  return transcodeBase64Image({
    dataBase64: payload.dataBase64,
    sourceMimeType: payload.mimeType,
    targetMimeType: 'image/png',
  });
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
