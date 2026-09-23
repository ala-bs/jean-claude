import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TERMINAL_FLUSH_BYTES,
  TERMINAL_REPLAY_RESET,
  TERMINAL_SCROLLBACK_LIMIT,
} from '@shared/terminal-types';

type PtyHandler = (data: string) => void;
type ExitHandler = (event: { exitCode: number; signal?: number }) => void;

const spawned: {
  file: string;
  args: string[] | string;
  options: { cols: number; rows: number; cwd: string };
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData: PtyHandler;
  emitExit: ExitHandler;
}[] = [];

/** Overridable so a test can make `spawn` throw the way a bad cwd does. */
let spawnImpl: ((file: string, args: string[] | string) => void) | null = null;

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[] | string, options: never) => {
    spawnImpl?.(file, args);
    let dataHandler: PtyHandler = () => {};
    let exitHandler: ExitHandler = () => {};
    const record = {
      file,
      args,
      options: options as unknown as {
        cols: number;
        rows: number;
        cwd: string;
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData: (data: string) => dataHandler(data),
      emitExit: (event: { exitCode: number }) => exitHandler(event),
    };
    spawned.push(record);
    return {
      onData: (handler: PtyHandler) => {
        dataHandler = handler;
      },
      onExit: (handler: ExitHandler) => {
        exitHandler = handler;
      },
      write: record.write,
      resize: record.resize,
      kill: record.kill,
      pid: 1234,
    };
  },
}));

const { terminalService } = await import('./terminal-service');

function ensure(sessionId: string, cols = 80, rows = 24) {
  return terminalService.ensureSession({
    sessionId,
    cwd: '/tmp/project',
    cols,
    rows,
  });
}

describe('terminalService', () => {
  beforeEach(() => {
    terminalService.closeAll();
    spawned.length = 0;
    spawnImpl = null;
    vi.useRealTimers();
  });

  it('spawns one shell per session and reattaches on re-ensure', () => {
    const first = ensure('a');
    expect(spawned).toHaveLength(1);
    expect(first.isRunning).toBe(true);

    const second = ensure('a');
    // Reattaching must not spawn a second shell, or the user silently loses the
    // one holding their history and working directory.
    expect(spawned).toHaveLength(1);
    expect(second.isRunning).toBe(true);

    ensure('b');
    expect(spawned).toHaveLength(2);
  });

  it('replays buffered output to a session that reattaches', async () => {
    ensure('a');
    spawned[0].emitData('hello ');
    spawned[0].emitData('world');

    expect(ensure('a').backlog).toBe('hello world');
  });

  it('honours the requested size on spawn and forwards later resizes', () => {
    ensure('a', 100, 40);
    expect(spawned[0].options.cols).toBe(100);
    expect(spawned[0].options.rows).toBe(40);

    terminalService.resize({ sessionId: 'a', cols: 120, rows: 50 });
    expect(spawned[0].resize).toHaveBeenCalledWith(120, 50);

    // Re-sending the same size would make interactive programs redraw for no
    // reason on every mouse-move during a pane drag.
    spawned[0].resize.mockClear();
    terminalService.resize({ sessionId: 'a', cols: 120, rows: 50 });
    expect(spawned[0].resize).not.toHaveBeenCalled();
  });

  it('ignores non-positive sizes, which node-pty rejects', () => {
    ensure('a');
    terminalService.resize({ sessionId: 'a', cols: 0, rows: 0 });
    expect(spawned[0].resize).not.toHaveBeenCalled();
  });

  it('caps the replay buffer and resumes on a line boundary', () => {
    ensure('a');
    const line = `${'x'.repeat(999)}\n`;
    const overflow = Math.ceil((TERMINAL_SCROLLBACK_LIMIT * 1.5) / 1000);
    for (let i = 0; i < overflow; i++) spawned[0].emitData(line);

    const { backlog } = ensure('a');
    expect(backlog.length).toBeLessThanOrEqual(TERMINAL_SCROLLBACK_LIMIT);
    // Every replay opens from a known-clean terminal state, then resumes at a
    // line boundary so the first line is whole rather than a fragment.
    expect(backlog.startsWith(TERMINAL_REPLAY_RESET)).toBe(true);
    expect(backlog.split('\n')[0]).toHaveLength(999 + TERMINAL_REPLAY_RESET.length);
  });

  it('emits coalesced output to listeners', async () => {
    const received: string[] = [];
    const off = terminalService.onData((event) => received.push(event.data));

    ensure('a');
    spawned[0].emitData('one');
    spawned[0].emitData('two');
    await vi.waitFor(() => expect(received.join('')).toBe('onetwo'));

    off();
  });

  it('stamps chunks with their offset in the stream so replays can dedupe', async () => {
    const events: { data: string; offset: number }[] = [];
    const off = terminalService.onData((event) =>
      events.push({ data: event.data, offset: event.offset }),
    );

    ensure('a');
    spawned[0].emitData('abc');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ data: 'abc', offset: 0 });

    // The snapshot offset marks the end of the backlog, so a client that
    // replays it knows chunk 0 is already covered and chunk 1 is not.
    expect(ensure('a').offset).toBe(3);

    spawned[0].emitData('de');
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toEqual({ data: 'de', offset: 3 });

    off();
  });

  it('keeps offsets counting the whole stream after the backlog is trimmed', async () => {
    ensure('a');
    const line = `${'x'.repeat(999)}\n`;
    const chunks = Math.ceil((TERMINAL_SCROLLBACK_LIMIT * 1.5) / 1000);
    for (let i = 0; i < chunks; i++) spawned[0].emitData(line);

    const snapshot = ensure('a');
    // Offsets index the full stream, not the retained window — otherwise they
    // would collide with earlier chunks once trimming starts.
    expect(snapshot.offset).toBe(chunks * 1000);
    expect(snapshot.backlog.length).toBeLessThan(snapshot.offset);
  });

  it('reports exit and stops accepting input, but keeps the backlog', async () => {
    const exits: number[] = [];
    const off = terminalService.onExit((event) => exits.push(event.exitCode));

    ensure('a');
    spawned[0].emitData('before exit\n');
    spawned[0].emitExit({ exitCode: 3 });

    expect(exits).toEqual([3]);
    terminalService.write({ sessionId: 'a', data: 'ignored' });
    expect(spawned[0].write).not.toHaveBeenCalled();
    // The pane still needs to show what the shell printed before it died.
    expect(ensure('a').backlog).toBe('before exit\n');

    off();
  });

  it('ignores a killed pty that exits after its session id was reused', async () => {
    const exits: number[] = [];
    const received: string[] = [];
    const offExit = terminalService.onExit((event) => exits.push(event.exitCode));
    const offData = terminalService.onData((event) => received.push(event.data));

    ensure('a');
    // The pane's Restart button does exactly this: close, then immediately
    // re-ensure under the same id.
    terminalService.close('a');
    ensure('a');
    expect(spawned).toHaveLength(2);

    // `kill()` is asynchronous, so the dead pty's handlers fire *after* the
    // replacement is registered. Nothing it emits may reach the live session.
    spawned[0].emitData('garbage from the dead shell');
    spawned[0].emitExit({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 32));

    expect(received).toEqual([]);
    expect(exits).toEqual([]);

    offExit();
    offData();
  });

  it('reports the exit code to a session that reattaches after the shell died', () => {
    ensure('a');
    spawned[0].emitExit({ exitCode: 137 });

    const snapshot = ensure('a');
    expect(snapshot.isRunning).toBe(false);
    // A shell killed by OOM must not be reported as a clean exit.
    expect(snapshot.exitCode).toBe(137);
  });

  it('surfaces a spawn failure instead of rejecting', () => {
    spawnImpl = () => {
      throw new Error('chdir failed: no such file or directory');
    };
    const snapshot = ensure('a');

    expect(snapshot.isRunning).toBe(false);
    expect(snapshot.error).toMatch(/chdir failed/);
    // A failed spawn must not leave a half-registered session behind.
    expect(ensure('a').error).toMatch(/chdir failed/);
  });

  it('trims a backlog that contains no newline at all', () => {
    ensure('a');
    // A full-screen TUI repaints with \r and cursor moves — it can emit far
    // more than the limit without ever writing a newline.
    const chunk = 'y'.repeat(1000);
    const chunks = Math.ceil((TERMINAL_SCROLLBACK_LIMIT * 1.5) / 1000);
    for (let i = 0; i < chunks; i++) spawned[0].emitData(chunk);

    const { backlog } = ensure('a');
    expect(backlog.length).toBeLessThanOrEqual(TERMINAL_SCROLLBACK_LIMIT);
    // Replay resumes mid-stream, so it must re-open with a state reset rather
    // than inheriting whatever attributes were set before the cut.
    expect(backlog.startsWith(TERMINAL_REPLAY_RESET)).toBe(true);
  });

  it('flushes immediately once the byte threshold is crossed', () => {
    const received: string[] = [];
    const off = terminalService.onData((event) => received.push(event.data));

    ensure('a');
    // No timers advanced: crossing the threshold must not wait for the tick.
    spawned[0].emitData('z'.repeat(TERMINAL_FLUSH_BYTES + 1));
    expect(received).toHaveLength(1);

    off();
  });

  it('kills every shell on closeAll', () => {
    ensure('a');
    ensure('b');
    terminalService.closeAll();

    expect(spawned[0].kill).toHaveBeenCalled();
    expect(spawned[1].kill).toHaveBeenCalled();
    // Both ids are free again, so re-ensuring spawns fresh shells.
    ensure('a');
    expect(spawned).toHaveLength(3);
  });

  it('kills the shell only on an explicit close', () => {
    ensure('a');
    expect(spawned[0].kill).not.toHaveBeenCalled();

    terminalService.close('a');
    expect(spawned[0].kill).toHaveBeenCalled();

    // Closing forgets the session, so the next ensure starts a fresh shell.
    ensure('a');
    expect(spawned).toHaveLength(2);
  });
});
