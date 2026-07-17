const GIF_MIME_FRAGMENT = 'jc-mime=image%2Fgif';

export function tagBlobPreviewUrl(url: string, mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase() === 'image/gif'
    ? `${url}#${GIF_MIME_FRAGMENT}`
    : url;
}

export function isGifBlobPreviewUrl(url: string): boolean {
  if (!url.startsWith('blob:')) return false;

  try {
    return new URL(url).hash === `#${GIF_MIME_FRAGMENT}`;
  } catch {
    return false;
  }
}
