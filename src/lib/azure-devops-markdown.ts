export function expandRelativeAzureAttachmentUrls({
  value,
  attachmentBaseUrl,
}: {
  value: string;
  attachmentBaseUrl?: string;
}) {
  if (!attachmentBaseUrl) return value;

  const relativeAttachmentUrlPattern = new RegExp(
    String.raw`(^|["'\s]|\(\s*)[\u0000-\u001f\u007f]*(\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:\?[^"')\s<]*)?)`,
    'g',
  );
  return value.replace(relativeAttachmentUrlPattern, (_match, prefix, path) =>
    `${prefix.startsWith('(') ? '(' : prefix}${attachmentBaseUrl}${path}`,
  );
}

export function restoreEscapedMarkdownLinks(value: string) {
  return value.replace(
    /!\\\[([^\]\n]+)\\\]\((azure-image-proxy:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => `![${label}](${url})`,
  );
}
