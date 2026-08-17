import { memo, type MouseEvent, useMemo } from 'react';
import Anser from 'anser';

import { isDefaultAppFile } from '@shared/default-app-extensions';

import { api } from '@/lib/api';
import { useToastStore } from '@/stores/toasts';

import { type LogTextSegment, splitLogTextLinks } from './utils-log-links';

const LINK_CLASS_NAME =
  'underline decoration-current/45 underline-offset-2 hover:decoration-current';

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

/** Resolves a log file path to an absolute path usable by the editor. */
function resolveLogPath(path: string, workingDir?: string): string | null {
  if (path.startsWith('/')) return path;
  if (path.startsWith('~/')) return path;
  if (!workingDir) return null;
  const base = workingDir.endsWith('/') ? workingDir.slice(0, -1) : workingDir;
  const relative = path.startsWith('./') ? path.slice(2) : path;
  return `${base}/${relative}`;
}

export const AnsiLine = memo(function AnsiLine({
  line,
  workingDir,
}: {
  line: string;
  /** Worktree/project dir used to resolve relative file paths. */
  workingDir?: string;
}) {
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

  const renderSegment = (part: LogTextSegment, key: string) => {
    if (part.type === 'text') return <span key={key}>{part.text}</span>;

    if (part.type === 'file') {
      const absolutePath = resolveLogPath(part.path, workingDir);
      if (!absolutePath) return <span key={key}>{part.text}</span>;

      // Images, PDFs, media and archives open with the OS default
      // application; everything else opens in the configured editor.
      const opensWithDefaultApp = isDefaultAppFile(absolutePath);

      const handleFileClick = (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        if (!event.metaKey && !event.ctrlKey) return;

        event.stopPropagation();
        const openPromise = opensWithDefaultApp
          ? api.shell.openPath(absolutePath)
          : api.shell.openInEditor(absolutePath, workingDir);
        openPromise
          .catch((error: unknown) => {
            useToastStore.getState().addToast({
              type: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : `Could not open ${absolutePath}`,
            });
          });
      };

      return (
        <button
          key={key}
          type="button"
          onClick={handleFileClick}
          className={`${LINK_CLASS_NAME} inline cursor-pointer bg-transparent p-0 font-[inherit] text-[inherit] whitespace-pre-wrap`}
          title={
            opensWithDefaultApp
              ? 'Cmd-click to open with default app'
              : 'Cmd-click to open in editor'
          }
        >
          {part.text}
        </button>
      );
    }

    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (!event.metaKey && !event.ctrlKey) return;

      event.stopPropagation();
      window.open(part.url, '_blank', 'noopener,noreferrer');
    };

    return (
      <a
        key={key}
        href={part.url}
        onClick={handleClick}
        className={LINK_CLASS_NAME}
        title="Cmd-click to open"
      >
        {part.text}
      </a>
    );
  };

  const renderTextWithLinks = (content: string, keyPrefix: string) =>
    splitLogTextLinks(content, { hasWorkingDir: !!workingDir }).map(
      (part, index) => renderSegment(part, `${keyPrefix}-${index}`),
    );

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
