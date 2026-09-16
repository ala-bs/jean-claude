import '@xterm/xterm/css/xterm.css';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { X } from 'lucide-react';

import { api } from '@/lib/api';
import { getProjectTerminalSessionId } from '@shared/terminal-types';
import { IconButton } from '@/common/ui/icon-button';
import { readThemeFromCss } from './theme';
import { Separator } from '@/common/ui/separator';
import { sliceAfterReplay } from './replay';
import { TASK_PANEL_HEADER_HEIGHT_CLS } from '@/features/task/ui-task-panel/constants';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useProjectTerminalPaneWidth } from '@/stores/navigation';

/**
 * An interactive shell for the project checkout, living in the project panel's
 * right column.
 *
 * The pty is owned by the main process and keyed by project, so unmounting this
 * component (closing the pane, navigating away) detaches the view but leaves
 * the shell running — reopening replays the scrollback and reattaches.
 */
export function ProjectTerminal({
  projectId,
  cwd,
  onClose,
}: {
  projectId: string;
  cwd: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const sessionId = getProjectTerminalSessionId(projectId);

  const { width, setWidth, minWidth, maxWidth } = useProjectTerminalPaneWidth();
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: width,
    minWidth,
    maxWidth,
    maxWidthFraction: 0.7,
    direction: 'left',
    onWidthChange: setWidth,
    // Explicit, rather than relying on the handle's parent happening to be the
    // pane element.
    resizeTargetRef: paneRef,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    const terminal = new Terminal({
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      // The pty already retains its own replay buffer; this is xterm's local
      // scroll history for the attached view.
      scrollback: 10_000,
      cursorBlink: true,
      theme: readThemeFromCss(document.documentElement),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);
    fitAddon.fit();

    terminalRef.current = terminal;

    // Keystrokes go straight to the pty; the shell echoes them back. Rendering
    // locally would double every character.
    const dataSub = terminal.onData((data) => {
      void api.terminal.write({ sessionId, data });
    });

    // `ensure` is async, so live chunks can land before the snapshot does — and
    // a chunk emitted before the snapshot was taken is already inside its
    // backlog. Queue until the replay lands, then measure every chunk against
    // the boundary. Chunks *after* the replay go through the same check: the
    // snapshot arrives on the `invoke` reply path and output on a `send` push
    // channel, and nothing orders those two against each other.
    let replayedThrough: number | null = null;
    const queued: { data: string; offset: number }[] = [];

    const writeChunk = (chunk: { data: string; offset: number }) => {
      const text = sliceAfterReplay({
        ...chunk,
        replayedThrough: replayedThrough ?? 0,
      });
      if (text) terminal.write(text);
    };

    const offData = api.terminal.onData((event) => {
      if (event.sessionId !== sessionId) return;
      const chunk = { data: event.data, offset: event.offset };
      if (replayedThrough === null) {
        queued.push(chunk);
        return;
      }
      writeChunk(chunk);
    });

    const offExit = api.terminal.onExit((event) => {
      if (event.sessionId !== sessionId) return;
      // A restart's killed pty does not reach here: the service drops exits
      // from a pty whose session id has already been reused, so this can only
      // be the live shell.
      setExitCode(event.exitCode);
    });

    void api.terminal
      .ensure({
        sessionId,
        cwd,
        cols: terminal.cols,
        rows: terminal.rows,
      })
      .then((snapshot) => {
        if (disposed) return;
        if (snapshot.error) {
          setStartError(snapshot.error);
          return;
        }
        if (snapshot.backlog) terminal.write(snapshot.backlog);
        replayedThrough = snapshot.offset;
        queued.splice(0, queued.length).forEach(writeChunk);
        if (!snapshot.isRunning) setExitCode(snapshot.exitCode ?? 0);
        terminal.focus();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // The pane would otherwise sit blank forever with only an unhandled
        // rejection in the console.
        setStartError(error instanceof Error ? error.message : String(error));
      });

    // Resizing the pane (or the window) has to be pushed to the pty, otherwise
    // the shell keeps wrapping at the old column count and full-screen TUIs
    // draw into the wrong box.
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch {
        // `fit()` throws while the container is measured at zero (mid-layout).
        return;
      }
      void api.terminal.resize({
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      offData();
      offExit();
      dataSub.dispose();
      terminal.dispose();
      terminalRef.current = null;
      // Deliberately NOT calling `api.terminal.close` — the session outlives
      // this view. Only the explicit "kill" action ends the shell.
    };
  }, [cwd, sessionId]);

  /** Ends the shell for real and starts a fresh one in its place. */
  const restart = useCallback(async () => {
    const terminal = terminalRef.current;
    // Bail before killing anything: unmounting between render and click would
    // otherwise destroy the session with no replacement started.
    if (!terminal) return;
    try {
      await api.terminal.close(sessionId);
      setExitCode(null);
      setStartError(null);
      terminal.reset();
      const snapshot = await api.terminal.ensure({
        sessionId,
        cwd,
        cols: terminal.cols,
        rows: terminal.rows,
      });
      if (snapshot.error) {
        setStartError(snapshot.error);
        return;
      }
      terminal.focus();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  }, [cwd, sessionId]);

  return (
    <div
      ref={paneRef}
      style={{ width }}
      // Lets the project panel's panel-scope bindings decline while focus is in
      // the terminal, so ⌘F/⌘K reach the shell instead of the commit search.
      data-project-terminal
      className="panel-edge-shadow bg-bg-0 relative flex h-full flex-col"
    >
      <div
        onMouseDown={handleMouseDown}
        className={clsx(
          'hover:bg-acc/50 absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors',
          isDragging && 'bg-acc/50',
        )}
      />

      <div
        className={clsx(
          'flex shrink-0 items-center justify-between px-4 py-2',
          TASK_PANEL_HEADER_HEIGHT_CLS,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-ink-1 text-sm font-medium">Terminal</h3>
          <span className="text-ink-3 truncate text-xs" title={cwd}>
            {cwd}
          </span>
        </div>
        <IconButton onClick={onClose} size="sm" icon={<X />} tooltip="Close" />
      </div>
      <Separator />

      {(startError !== null || exitCode !== null) && (
        <div className="text-ink-3 flex shrink-0 items-center justify-between gap-3 px-4 py-1.5 text-xs">
          <span className="truncate" title={startError ?? undefined}>
            {startError !== null
              ? `Could not start shell: ${startError}`
              : `Shell exited (${exitCode})`}
          </span>
          <button
            type="button"
            onClick={() => void restart()}
            className="text-acc shrink-0 hover:underline"
          >
            Restart
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        // xterm measures its parent, so the container needs a definite size —
        // `min-h-0` stops the flex child from refusing to shrink.
        className="min-h-0 flex-1 overflow-hidden px-2 py-1"
      />
    </div>
  );
}
