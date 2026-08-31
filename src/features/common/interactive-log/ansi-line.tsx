import { memo, type MouseEvent, type ReactNode, useMemo } from 'react';
import Anser from 'anser';

import { isDefaultAppFile } from '@shared/default-app-extensions';

import { api } from '@/lib/api';
import { useToastStore } from '@/stores/toasts';

import {
  type LogTextSegment,
  splitLogTextLinkSpans,
} from './utils-log-links';

const LINK_CLASS_NAME =
  'underline decoration-current/45 underline-offset-2 hover:decoration-current';

import { ansiClassToThemeColor } from '@/lib/ansi-theme';

/**
 * Cursor-forward (`\x1b[<n>C`) is column padding: many CLIs emit it instead of
 * spaces. Both Anser and `stripNonPrintable` drop it, which runs adjacent
 * columns together visually and for link detection (`built` + `dist/a.js` ->
 * `builtdist/a.js`). Expand it to spaces before parsing so columns stay apart.
 */
function expandCursorForward(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[(\d*)C/g, (_, count: string) =>
    ' '.repeat(Math.min(Number(count) || 1, 256)),
  );
}

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

/** Maps one Anser segment's ANSI attributes to inline CSS. */
function ansiStyle(segment: Anser.AnserJsonEntry): Record<string, string> {
  const style: Record<string, string> = {};

  if (segment.fg) {
    if (segment.fg_truecolor) {
      style.color = `rgb(${segment.fg_truecolor})`;
    } else {
      const fg = ansiClassToThemeColor(segment.fg);
      if (fg) style.color = fg;
    }
  }

  if (segment.bg) {
    if (segment.bg_truecolor) {
      style.backgroundColor = `rgb(${segment.bg_truecolor})`;
    } else {
      const bg = ansiClassToThemeColor(segment.bg);
      if (bg) style.backgroundColor = bg;
    }
  }

  const decorations = segment.decorations || [];
  if (decorations.includes('bold')) style.fontWeight = 'bold';
  if (decorations.includes('italic')) style.fontStyle = 'italic';
  if (decorations.includes('dim')) style.opacity = '0.6';

  const textDecoration: string[] = [];
  if (decorations.includes('underline')) textDecoration.push('underline');
  if (decorations.includes('strikethrough')) textDecoration.push('line-through');
  if (textDecoration.length > 0) {
    style.textDecoration = textDecoration.join(' ');
  }

  return style;
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
    const parsed = Anser.ansiToJson(expandCursorForward(line), {
      use_classes: true,
    });
    let offset = 0;
    return parsed
      .map((segment) => ({
        ...segment,
        content: stripNonPrintable(segment.content),
      }))
      .filter((segment) => segment.content.length > 0)
      .map((segment) => {
        // Character range of this segment within the de-ANSI-ed line, used to
        // map whole-line link detection back onto individual styled segments.
        const start = offset;
        offset += segment.content.length;
        return { ...segment, start, end: offset };
      });
  }, [line]);

  // Links are detected on the full de-ANSI-ed line, not per segment: emitters
  // like Vite style parts of a URL differently (`http://localhost:` + bold
  // `5800` + `/`), which would otherwise hide the URL from the detector.
  const linkSpans = useMemo(() => {
    if (!segments) return [];
    const plainText = segments.map((segment) => segment.content).join('');
    return splitLogTextLinkSpans(plainText, { hasWorkingDir: !!workingDir });
  }, [segments, workingDir]);

  if (!segments || segments.length === 0) return <> </>;

  const renderSegment = (
    part: LogTextSegment,
    key: string,
    children: ReactNode,
  ) => {
    if (part.type === 'text') return <span key={key}>{children}</span>;

    if (part.type === 'file') {
      const absolutePath = resolveLogPath(part.path, workingDir);
      if (!absolutePath) return <span key={key}>{children}</span>;

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
          {children}
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
        {children}
      </a>
    );
  };

  /**
   * Styled pieces of one link/text span. The span is the OUTER element and the
   * ANSI styling is nested inside, so a URL split across styles is a single
   * `<a>` — one hover target, one tab stop, one continuous underline.
   */
  const renderStyledChildren = (span: { start: number; end: number }) =>
    segments
      .filter((segment) => segment.end > span.start && segment.start < span.end)
      .map((segment, index) => {
        const text = segment.content.slice(
          Math.max(segment.start, span.start) - segment.start,
          Math.min(segment.end, span.end) - segment.start,
        );
        const style = ansiStyle(segment);

        // No styling: skip the extra DOM node.
        if (Object.keys(style).length === 0) return text;

        return (
          <span key={index} style={style}>
            {text}
          </span>
        );
      });

  return (
    <>
      {linkSpans.map((span, i) =>
        renderSegment(span, String(i), renderStyledChildren(span)),
      )}
    </>
  );
});
