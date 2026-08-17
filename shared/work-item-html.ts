const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'i', 'em', 'u', 's',
  'code', 'p', 'pre', 'blockquote', 'a', 'span',
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  span: new Set(['style']),
};
const SEMANTIC_STYLE_PROPS = new Set([
  'color', 'background-color', 'font-weight', 'font-style',
  'text-decoration', 'text-decoration-line', 'text-align',
]);
const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&ndash;': '\u2013', '&mdash;': '\u2014',
  '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&ldquo;': '\u201C',
  '&rdquo;': '\u201D', '&bull;': '\u2022', '&hellip;': '\u2026',
  '&copy;': '\u00A9', '&reg;': '\u00AE', '&trade;': '\u2122',
};

function convertListsToMarkdown(html: string): string {
  const listRegex = /<(ul|ol)\b[^>]*>((?:(?!<\/?(?:ul|ol)\b)[\s\S])*?)<\/\1>/gi;
  let result = html;
  let previous: string | undefined;
  do {
    previous = result;
    result = result.replace(listRegex, (_match, type: string, content: string) => {
      let counter = 0;
      const items: string[] = [];
      const itemRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let itemMatch;
      while ((itemMatch = itemRegex.exec(content)) !== null) {
        items.push(`${type.toLowerCase() === 'ol' ? `${++counter}.` : '-'} ${itemMatch[1].trim()}`);
      }
      return `\n${items.join('\n')}\n`;
    });
  } while (result !== previous);
  return result;
}

function stripBareSpans(html: string): string {
  const stack: boolean[] = [];
  return html.replace(/<\/?span\b[^>]*>/gi, (match) => {
    if (match.startsWith('</')) return stack.pop() ? '' : match;
    const bare = /^<span\s*>$/i.test(match);
    stack.push(bare);
    return bare ? '' : match;
  });
}

function decodeHtmlEntities(text: string): string {
  let result = text.replace(/&[a-z]+;/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity);
  result = result.replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
    const codePoint = parseInt(hex, 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
  return result.replace(/&#(\d+);/g, (match, decimal: string) => {
    const codePoint = parseInt(decimal, 10);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
}

/** Preserve semantic HTML while removing Azure editor layout noise. */
export function simplifyWorkItemHtml(html: string): string {
  let result = convertListsToMarkdown(html);
  result = result.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  result = result.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)?\/?>/gi, (match, tag: string, attrsString: string | undefined) => {
    const lowerTag = tag.toLowerCase();
    if (lowerTag === 'img') return '';
    if (lowerTag === 'br') return '\n';
    if (!ALLOWED_TAGS.has(lowerTag)) return '';
    if (match.startsWith('</')) return `</${lowerTag}>`;
    const allowedAttrs = ALLOWED_ATTRS[lowerTag];
    if (!allowedAttrs || !attrsString?.trim()) return `<${lowerTag}>`;
    const attrs: string[] = [];
    const attrRegex = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrsString)) !== null) {
      const name = attrMatch[1].toLowerCase();
      const value = attrMatch[2] ?? attrMatch[3];
      if (!allowedAttrs.has(name)) continue;
      if (name === 'style') {
        const styles = value.split(';').filter((decl) => {
          const colon = decl.indexOf(':');
          return colon !== -1 && SEMANTIC_STYLE_PROPS.has(decl.slice(0, colon).trim().toLowerCase());
        }).map((decl) => decl.trim()).join('; ');
        if (styles) attrs.push(`style="${styles}"`);
      } else {
        attrs.push(`${name}="${value}"`);
      }
    }
    return `<${lowerTag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  });
  return decodeHtmlEntities(stripBareSpans(result)).trim();
}
