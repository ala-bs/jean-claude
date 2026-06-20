import * as fs from 'fs/promises';

import { getImageMimeType } from '@shared/image-types';

export const LOCAL_IMAGE_PROTOCOL = 'jc-local-image';

export function encodeLocalImageUrl(filePath: string): string | null {
  if (!getImageMimeType(filePath)) return null;

  const encodedPath = Buffer.from(filePath, 'utf8').toString('base64url');
  return `${LOCAL_IMAGE_PROTOCOL}://image/${encodedPath}`;
}

export function decodeLocalImageUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${LOCAL_IMAGE_PROTOCOL}:`) return null;
    const encodedPath = parsed.pathname.slice(1);
    if (!encodedPath) return null;

    return Buffer.from(encodedPath, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export async function fetchLocalImage(url: string): Promise<Response> {
  const filePath = decodeLocalImageUrl(url);
  if (!filePath) return new Response('Invalid image URL', { status: 400 });

  const mimeType = getImageMimeType(filePath);
  if (!mimeType) return new Response('Unsupported image type', { status: 415 });

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return new Response('Image not found', { status: 404 });

    const buffer = await fs.readFile(filePath);
    return new Response(new Uint8Array(buffer), {
      headers: { 'Content-Type': mimeType },
    });
  } catch {
    return new Response('Image not found', { status: 404 });
  }
}
