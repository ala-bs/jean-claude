export function sanitizeMarkdownUrl(
  url: string,
  { allowBlob = false }: { allowBlob?: boolean } = {},
): string {
  if (url.startsWith('azure-image-proxy://')) {
    return url;
  }

  if (url.startsWith('azure-devops-mention:')) {
    return url;
  }

  if (url.startsWith('data:image/')) {
    return url;
  }

  if (allowBlob && url.startsWith('blob:')) {
    return url;
  }

  const safeProtocols = ['http:', 'https:', 'mailto:', 'tel:'];

  try {
    const parsed = new URL(url);
    if (safeProtocols.includes(parsed.protocol)) {
      return url;
    }
  } catch {
    if (!url.includes(':')) {
      return url;
    }
  }

  return '';
}

export function decodeAzureProxyParts(
  src: string,
): { providerId: string; imageUrl: string } | null {
  if (!src.startsWith('azure-image-proxy://')) return null;
  try {
    const proxyUrl = new URL(src);
    const encodedUrl = proxyUrl.pathname.slice(1);
    if (!encodedUrl) return null;
    const padded = encodedUrl.padEnd(
      encodedUrl.length + ((4 - (encodedUrl.length % 4)) % 4),
      '=',
    );
    return {
      providerId: proxyUrl.hostname,
      imageUrl: atob(padded.replace(/-/g, '+').replace(/_/g, '/')),
    };
  } catch {
    return null;
  }
}
