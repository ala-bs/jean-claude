import Anser from 'anser';
import { memo, useMemo, type MouseEvent } from 'react';

import { splitLogTextLinks } from './utils-log-links';

import { ansiClassToThemeColor } from '@/lib/ansi-theme';

/**
 * Strip all non-printable characters that the PTY may emit:
 * - ESC sequences: CSI (\x1b[…), OSC (\x1b]…\x07), and any other \x1b+char
 * - C0 control characters (0x00–0x1F) except tab (\x09)
 * - DEL (\x7F)
 */
function stripNonPrintable(text: string): string {
  return (
    text
      // ESC sequences: CSI (\x1b[…letter), OSC (\x1b]…BEL),
      // two-char charset switches (\x1b(B, \x1b(0, etc.), and other single-char ESC sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b(?:\[[0-9;?]*[a-zA-Z@]|\][^\x07]*\x07|\(.|.)/g, '')
      // Remaining C0 control chars (except \t) and DEL
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      // Symbols for Legacy Computing (U+1FB00–U+1FB9F): sextant block characters
      // used by CLIs for pixel-art logos. No common font includes these glyphs,
      // so they render as empty boxes. Strip them to keep output clean.
      .replace(/[\u{1FB00}-\u{1FB9F}]/gu, '')
  );
}

export const AnsiLine = memo(function AnsiLine({ line }: { line: string }) {
  const segments = useMemo(() => {
    if (!line) return null;
    const parsed = Anser.ansiToJson(line, { use_classes: true });
    return parsed
      .map((segment) => ({
        ...segment,
        content: stripNonPrintable(segment.content),
      }))
      .filter((segment) => segment.content.length > 0);
  }, [line]);

  if (!segments || segments.length === 0) return <> </>;

  const renderTextWithLinks = (content: string, keyPrefix: string) =>
    splitLogTextLinks(content).map((part, index) => {
      if (part.type === 'text') {
        return <span key={`${keyPrefix}-text-${index}`}>{part.text}</span>;
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();

        if (!event.metaKey && !event.ctrlKey) return;

        event.stopPropagation();
        window.open(part.url, '_blank', 'noopener,noreferrer');
      };

      return (
        <a
          key={`${keyPrefix}-link-${index}`}
          href={part.url}
          onClick={handleClick}
          className="underline decoration-current/45 underline-offset-2 hover:decoration-current"
          title="Cmd-click to open"
        >
          {part.text}
        </a>
      );
    });

  return (
    <>
      {segments.map((segment, i) => {
        const { content } = segment;
        if (!content) return null;

        const style: Record<string, string> = {};

        // Foreground color
        if (segment.fg) {
          if (segment.fg_truecolor) {
            style.color = `rgb(${segment.fg_truecolor})`;
          } else {
            const fg = ansiClassToThemeColor(segment.fg);
            if (fg) style.color = fg;
          }
        }

        // Background color
        if (segment.bg) {
          if (segment.bg_truecolor) {
            style.backgroundColor = `rgb(${segment.bg_truecolor})`;
          } else {
            const bg = ansiClassToThemeColor(segment.bg);
            if (bg) style.backgroundColor = bg;
          }
        }

        // Decorations (bold, italic, underline, dim, strikethrough)
        const decorations = segment.decorations || [];
        if (decorations.includes('bold')) {
          style.fontWeight = 'bold';
        }
        if (decorations.includes('italic')) {
          style.fontStyle = 'italic';
        }
        if (decorations.includes('dim')) {
          style.opacity = '0.6';
        }

        const textDecoration: string[] = [];
        if (decorations.includes('underline')) {
          textDecoration.push('underline');
        }
        if (decorations.includes('strikethrough')) {
          textDecoration.push('line-through');
        }
        if (textDecoration.length > 0) {
          style.textDecoration = textDecoration.join(' ');
        }

        // If no styling, render plain text (avoids extra DOM nodes)
        if (Object.keys(style).length === 0) {
          return <span key={i}>{renderTextWithLinks(content, String(i))}</span>;
        }

        return (
          <span key={i} style={style}>
            {renderTextWithLinks(content, String(i))}
          </span>
        );
      })}
    </>
  );
});
