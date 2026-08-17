import TurndownService from 'turndown';
import { useMemo } from 'react';


import {
  expandRelativeAzureAttachmentUrls,
  restoreEscapedMarkdownLinks,
} from '@/lib/azure-devops-markdown';
import {
  type MentionDisplayNames,
  replaceAzureDevOpsMentions,
} from '@/lib/azure-devops-mentions';
import { MarkdownContent } from '@/features/agent/ui-markdown-content';
import { rewriteAzureImageUrls } from '@/lib/azure-image-proxy';


// Shared Turndown instance for HTML to Markdown conversion
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

function escapeTableCell(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

function tableCellToMarkdown(cell: Element): string {
  const markdown = turndown.turndown(cell.innerHTML).trim();
  return escapeTableCell(markdown || cell.textContent || '');
}

function escapeMarkdownText(value: string) {
  return value.replace(/([\\`*_{}[\]()#+.!|>-])/g, '\\$1');
}

function getDirectTableRows(table: Element): Element[] {
  return Array.from(table.children).flatMap((child) => {
    if (child.tagName.toLowerCase() === 'tr') return [child];
    if (['thead', 'tbody', 'tfoot'].includes(child.tagName.toLowerCase())) {
      return Array.from(child.children).filter(
        (row) => row.tagName.toLowerCase() === 'tr',
      );
    }
    return [];
  });
}

function getDirectTableCells(row: Element): Element[] {
  return Array.from(row.children).filter((cell) =>
    ['th', 'td'].includes(cell.tagName.toLowerCase()),
  );
}

function tableRowToMarkdownCells(row: Element): string[] {
  return getDirectTableCells(row).flatMap((cell) => {
    const colspan = Number(cell.getAttribute('colspan') ?? 1);
    return [
      tableCellToMarkdown(cell),
      ...Array<string>(Math.max(0, colspan - 1)).fill(''),
    ];
  });
}

function htmlTableToMarkdown(table: Element): string {
  const tableRows = getDirectTableRows(table);
  const rows = tableRows
    .map((row) => tableRowToMarkdownCells(row))
    .filter((cells) => cells.length > 0);

  if (rows.length === 0) return '';

  const columnCount = Math.max(...rows.map((cells) => cells.length));
  const firstRowIsHeader = getDirectTableCells(tableRows[0]).some(
    (cell) => cell.tagName.toLowerCase() === 'th',
  );
  const normalizedRows = rows.map((cells) => [
    ...cells,
    ...Array<string>(columnCount - cells.length).fill(''),
  ]);
  const header = firstRowIsHeader
    ? normalizedRows[0]
    : Array<string>(columnCount).fill('');
  const separator = Array<string>(columnCount).fill('---');
  const body = firstRowIsHeader ? normalizedRows.slice(1) : normalizedRows;

  return [header, separator, ...body]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
}

turndown.addRule('tables', {
  filter: 'table',
  replacement: (_content, node) =>
    `\n\n${htmlTableToMarkdown(node as Element)}\n\n`,
});

turndown.addRule('azureMentions', {
  filter: (node) =>
    node.nodeName.toLowerCase() === 'a' &&
    (node as Element).hasAttribute('data-vss-mention'),
  replacement: (_content, node) => {
    const mentionText = escapeMarkdownText((node.textContent ?? '').trim());
    return mentionText ? `[${mentionText}](azure-devops-mention:html)` : '';
  },
});

/**
 * Renders Azure DevOps HTML content (e.g., work item descriptions)
 * with authenticated image proxy support.
 *
 * Converts HTML to Markdown and rewrites Azure DevOps image URLs to use
 * the azure-image-proxy:// protocol for authenticated fetching.
 */
export function AzureHtmlContent({
  html,
  providerId,
  attachmentBaseUrl,
  mentionDisplayNames,
  className,
  imageClassName,
  enableImageModal,
}: {
  /** The HTML content from Azure DevOps */
  html: string;
  /** The provider ID for authenticating image requests */
  providerId?: string;
  /** Base URL for expanding relative Azure work item attachment URLs */
  attachmentBaseUrl?: string;
  /** Azure DevOps identity IDs to display names for @<guid> mention tokens */
  mentionDisplayNames?: MentionDisplayNames;
  /** Optional className for the wrapper */
  className?: string;
  /** Optional className for rendered markdown images */
  imageClassName?: string;
  /** Whether rendered images should open in a modal when clicked */
  enableImageModal?: boolean;
}) {
  const markdown = useMemo(() => {
    if (!html) return '';

    // Azure DevOps TCM content uses uppercase tags (<DIV>, <P>, <STRONG>)
    // that Turndown cannot parse — lowercase them first
    const expanded = expandRelativeAzureAttachmentUrls({
      value: html,
      attachmentBaseUrl,
    });

    const lowered = expanded.replace(/<\/?[A-Z][A-Z0-9]*\b[^>]*>/g, (tag) =>
      tag.toLowerCase(),
    );

    // Rewrite Azure DevOps image URLs to use the proxy protocol
    const processedHtml = providerId
      ? rewriteAzureImageUrls(lowered, providerId)
      : lowered;

    const turndownMarkdown = turndown.turndown(processedHtml);
    const restoredMarkdown = restoreEscapedMarkdownLinks(turndownMarkdown);
    return replaceAzureDevOpsMentions(
      restoredMarkdown,
      mentionDisplayNames,
      { renderMarkdownLinks: true },
    );
  }, [html, providerId, attachmentBaseUrl, mentionDisplayNames]);

  if (!markdown.trim()) {
    return null;
  }

  return (
    <div className={className}>
      <MarkdownContent
        content={markdown}
        imageClassName={imageClassName}
        enableImageModal={enableImageModal}
      />
    </div>
  );
}

/**
 * Renders Azure DevOps Markdown content (e.g., PR descriptions)
 * with authenticated image proxy support.
 *
 * Rewrites Azure DevOps image URLs to use the azure-image-proxy:// protocol
 * for authenticated fetching.
 */
export function AzureMarkdownContent({
  markdown,
  providerId,
  attachmentBaseUrl,
  mentionDisplayNames,
  className,
  imageClassName,
  enableImageModal,
  allowBlobImages,
}: {
  /** The Markdown content from Azure DevOps */
  markdown: string;
  /** The provider ID for authenticating image requests */
  providerId?: string;
  /** Base URL for expanding relative Azure work item attachment URLs */
  attachmentBaseUrl?: string;
  /** Azure DevOps identity IDs to display names for @<guid> mention tokens */
  mentionDisplayNames?: MentionDisplayNames;
  /** Optional className for the wrapper */
  className?: string;
  /** Optional className for rendered markdown images */
  imageClassName?: string;
  /** Whether rendered images should open in a modal when clicked */
  enableImageModal?: boolean;
  /** Whether local Blob URLs may render as images */
  allowBlobImages?: boolean;
}) {
  const processedMarkdown = useMemo(() => {
    if (!markdown) return '';

    // Rewrite Azure DevOps image URLs to use the proxy protocol
    const expanded = expandRelativeAzureAttachmentUrls({
      value: markdown,
      attachmentBaseUrl,
    });

    const withImages = providerId
      ? rewriteAzureImageUrls(expanded, providerId)
      : expanded;

    return replaceAzureDevOpsMentions(withImages, mentionDisplayNames, {
      renderMarkdownLinks: true,
    });
  }, [markdown, providerId, attachmentBaseUrl, mentionDisplayNames]);

  if (!processedMarkdown.trim()) {
    return null;
  }

  return (
    <div className={className}>
      <MarkdownContent
        content={processedMarkdown}
        imageClassName={imageClassName}
        enableImageModal={enableImageModal}
        allowBlobImages={allowBlobImages}
      />
    </div>
  );
}
