import TurndownService from 'turndown';

function lowercaseHtmlTags(html: string): string {
  return html.replace(/<\/?[A-Z][A-Z0-9]*\b[^>]*>/g, (tag) =>
    tag.toLowerCase(),
  );
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export function azureHtmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(lowercaseHtmlTags(html.trim())).trim();
}
