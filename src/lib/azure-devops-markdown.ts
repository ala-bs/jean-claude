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

/**
 * Turndown escapes the `[`/`]` of markdown image syntax that survives inside
 * Azure DevOps HTML, producing `!\[image.png\](azure-image-proxy://...)`.
 * Unescape it so the image renders.
 *
 * The URL may carry Azure's image-size extension (` =WIDTH x HEIGHT`, e.g.
 * `=640x` or `=640x480`). It is preserved verbatim — MarkdownContent
 * understands it and applies the requested display width.
 */
export function restoreEscapedMarkdownLinks(value: string) {
  return value.replace(
    /!\\\[([^\]\n]+)\\\]\((azure-image-proxy:\/\/[^)\s]+(?:[ \t]+=\d+x\d*)?)\)/g,
    (_match, label: string, url: string) => `![${label}](${url})`,
  );
}
