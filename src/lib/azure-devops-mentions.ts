export type MentionDisplayNames = Record<string, string>;

const AZURE_MENTION_PATTERN =
  /@<([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/g;
const AZURE_MENTION_ANCHOR_PATTERN =
  /<a\b[^>]*\bdata-vss-mention=(['"])[\s\S]*?\1[^>]*>([\s\S]*?)<\/a>/gi;
const AZURE_MENTION_DETECTION_PATTERN =
  /@(?:<|&lt;)([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:>|&gt;)|<a\b[^>]*\bdata-vss-mention=/i;
const MARKDOWN_SPECIAL_CHARS = /([\\`*_{}[\]()#+.!|>-])/g;

export function normalizeMentionId(id: string) {
  return id.toLowerCase();
}

export function containsAzureDevOpsMention(content: string) {
  return AZURE_MENTION_DETECTION_PATTERN.test(content);
}

export function replaceAzureDevOpsMentions(
  content: string,
  displayNames?: MentionDisplayNames,
  options: { escapeMarkdown?: boolean; renderMarkdownLinks?: boolean } = {},
) {
  const escapeMarkdown = options.escapeMarkdown ?? true;

  const withHtmlMentions = content.replace(
    AZURE_MENTION_ANCHOR_PATTERN,
    (_match, _quote: string, label: string) => {
      const mentionText = escapeMarkdown
        ? escapeMarkdownText(decodeHtmlText(label))
        : decodeHtmlText(label);
      if (!options.renderMarkdownLinks) return mentionText;

      return `[${mentionText}](azure-devops-mention:html)`;
    },
  );

  return withHtmlMentions.replace(AZURE_MENTION_PATTERN, (match, id: string) => {
    const displayName = displayNames?.[normalizeMentionId(id)];
    if (!displayName) return match;

    const mentionText = `@${escapeMarkdown ? escapeMarkdownText(displayName) : displayName}`;
    if (!options.renderMarkdownLinks) return mentionText;

    return `[${mentionText}](azure-devops-mention:${normalizeMentionId(id)})`;
  });
}

function decodeHtmlText(value: string) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function escapeMarkdownText(value: string) {
  return value.replace(MARKDOWN_SPECIAL_CHARS, '\\$1');
}
