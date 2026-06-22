import type { RunCommandLogStream } from '@shared/run-command-types';

export interface ParsedRunCommandLogLine {
  stream: RunCommandLogStream;
  line: string;
  timestamp: number;
}

export function applyRunCommandLineOverwrites(line: string): string {
  let result = line;

  // eslint-disable-next-line no-control-regex
  const eraseMatch = /\x1b\[2?K/g;
  let lastEraseEnd = -1;
  let match;
  while ((match = eraseMatch.exec(result)) !== null) {
    lastEraseEnd = match.index + match[0].length;
  }
  if (lastEraseEnd > 0) result = result.substring(lastEraseEnd);

  const cursorHomeIdx = result.lastIndexOf('\x1b[1G');
  if (cursorHomeIdx !== -1) result = result.substring(cursorHomeIdx + 4);

  const crIdx = result.lastIndexOf('\r');
  if (crIdx !== -1) result = result.substring(crIdx + 1);

  return result;
}

function compactTrailingText(text: string): string {
  if (text.endsWith('\r')) {
    return `${applyRunCommandLineOverwrites(text.slice(0, -1))}\r`;
  }

  return applyRunCommandLineOverwrites(text);
}

export function parseRunCommandLogBatch({
  trailingText,
  stream,
  text,
  timestamp,
}: {
  trailingText: string;
  stream: RunCommandLogStream;
  text: string;
  timestamp: number;
}): {
  completedLines: ParsedRunCommandLogLine[];
  pendingLine: ParsedRunCommandLogLine | null;
  trailingText: string;
} {
  const combined = (trailingText + text).replace(/\r\n/g, '\n');
  const parts = combined.split('\n');
  const nextTrailingText = parts.pop() ?? '';
  const compactedTrailingText = compactTrailingText(nextTrailingText);
  const pendingText = compactedTrailingText.endsWith('\r')
    ? compactedTrailingText.slice(0, -1)
    : compactedTrailingText;

  return {
    completedLines: parts.map((line) => ({
      stream,
      line: applyRunCommandLineOverwrites(line),
      timestamp,
    })),
    pendingLine: nextTrailingText
      ? {
          stream,
          line: applyRunCommandLineOverwrites(pendingText),
          timestamp,
        }
      : null,
    trailingText: compactedTrailingText,
  };
}
