import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { toDirectoryPermissionPattern } from '../../directory-access';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import {
  ClaudeCodeBackend,
  CLOSE_HOLD_RECHECK_MS,
  MAX_TOOL_HOLD_MS,
} from './claude-code-backend';

function makeBackend() {
  return new ClaudeCodeBackend({
    taskId: 'task-1',
    sessionStartIndex: 0,
    persistRaw: vi.fn(async () => 'raw-1'),
  });
}

function createQuery(run?: () => Promise<void>) {
  let complete = false;
  return {
    async next() {
      if (complete) return { done: true as const, value: undefined };
      complete = true;
      await run?.();
      return { done: true as const, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function createMessageQuery(messages: unknown[]) {
  let index = 0;
  return {
    async next() {
      if (index >= messages.length) return { done: true as const, value: undefined };
      return { done: false as const, value: messages[index++] };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function collectEvents(session: { events: AsyncIterable<unknown> }) {
  const events: unknown[] = [];
  for await (const event of session.events) events.push(event);
  return events;
}

describe('ClaudeCodeBackend background-task results', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  const notificationResult = {
    type: 'result',
    subtype: 'success',
    origin: { kind: 'task-notification' },
    num_turns: 0,
    result: '',
  };
  const assistantText = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] },
  };
  const realResult = { type: 'result', subtype: 'success', num_turns: 3, result: 'done' };

  async function runMessages(messages: unknown[]) {
    queryMock.mockImplementation(() => createMessageQuery(messages));
    const backend = makeBackend();
    try {
      const session = await backend.start(
        { type: 'claude-code', cwd: '/worktree', interactionMode: 'ask' },
        [{ type: 'text', text: 'go' }],
      );
      return (await collectEvents(session)) as { type: string }[];
    } finally {
      await backend.dispose();
    }
  }

  it('does not complete the turn on a background task-notification result', async () => {
    const events = await runMessages([notificationResult, assistantText, realResult]);
    // The no-op notification result must produce neither a UI result entry nor
    // a completion; only the real result completes the turn.
    expect(events.map((event) => event.type)).toEqual([
      'entry', // synthetic user prompt
      'entry', // assistant text
      'entry', // real result entry
      'complete',
    ]);
  });

  it('persists the raw message of a withheld result', async () => {
    const persistRaw = vi.fn(async () => 'raw-1');
    queryMock.mockImplementation(() => createMessageQuery([notificationResult, realResult]));
    const backend = new ClaudeCodeBackend({
      taskId: 'task-1',
      sessionStartIndex: 0,
      persistRaw,
    });
    try {
      const session = await backend.start(
        { type: 'claude-code', cwd: '/worktree', interactionMode: 'ask' },
        [{ type: 'text', text: 'go' }],
      );
      await collectEvents(session);
      expect(persistRaw).toHaveBeenCalledTimes(2);
    } finally {
      await backend.dispose();
    }
  });

  it('replays the withheld result when the run ends without any real result', async () => {
    const events = await runMessages([assistantText, notificationResult]);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
    // Replayed last, after the live activity.
    expect(events[events.length - 1]?.type).toBe('complete');
  });

  it('does not replay after a real result already completed the turn', async () => {
    const events = await runMessages([realResult, notificationResult]);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
  });

  it('does not replay a withheld result after a terminal error', async () => {
    queryMock.mockImplementation(() => ({
      async next() {
        return { done: false as const, value: notificationResult };
      },
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => {
            if (!sent) {
              sent = true;
              return { done: false as const, value: notificationResult };
            }
            throw new Error('SDK exploded');
          },
        };
      },
    }));

    const backend = makeBackend();
    try {
      const session = await backend.start(
        { type: 'claude-code', cwd: '/worktree', interactionMode: 'ask' },
        [{ type: 'text', text: 'go' }],
      );
      const events = (await collectEvents(session)) as { type: string }[];
      expect(events.filter((event) => event.type === 'complete')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps completing on a notification-triggered turn that did real work', async () => {
    const events = await runMessages([
      { ...realResult, origin: { kind: 'task-notification' } },
    ]);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
  });
});

// The SDK closes the CLI's stdin at the first `result` when the prompt is a
// bare string (`isSingleUserTurn`). stdin is also the control channel carrying
// `canUseTool` responses, so a background task's zero-turn result would kill
// every later permission prompt with "AbortError: Stream closed". These tests
// lock in the streaming-prompt lifetime that avoids it.
describe('ClaudeCodeBackend prompt stream lifetime', () => {
  beforeEach(() => {
    queryMock.mockReset();
    vi.useRealTimers();
  });

  const notificationResult = {
    type: 'result',
    subtype: 'success',
    origin: { kind: 'task-notification' },
    num_turns: 0,
    result: '',
  };
  const realResult = {
    type: 'result',
    subtype: 'success',
    num_turns: 3,
    result: 'done',
  };

  /**
   * Drives the SDK generator by hand so the test controls exactly when each
   * message is delivered, and exposes the prompt iterator the backend passed in.
   */
  function makeControllableQuery() {
    const pending: unknown[] = [];
    let deliver: (() => void) | null = null;
    let ended = false;
    let promptIterator: AsyncIterator<unknown> | null = null;

    queryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      promptIterator = (
        prompt as AsyncIterable<unknown>
      )[Symbol.asyncIterator]();
      return {
        async next() {
          for (;;) {
            const message = pending.shift();
            if (message) return { done: false as const, value: message };
            if (ended) return { done: true as const, value: undefined };
            await new Promise<void>((resolve) => {
              deliver = resolve;
            });
          }
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    });

    return {
      send(message: unknown) {
        pending.push(message);
        deliver?.();
        deliver = null;
      },
      end() {
        ended = true;
        deliver?.();
        deliver = null;
      },
      getPromptIterator: () => promptIterator,
    };
  }

  async function startBackend(
    controller: ReturnType<typeof makeControllableQuery>,
    configOverrides: { env?: Record<string, string> } = {},
  ) {
    const backend = makeBackend();
    const session = await backend.start(
      {
        type: 'claude-code',
        cwd: '/worktree',
        interactionMode: 'ask',
        ...configOverrides,
      },
      [{ type: 'text', text: 'go' }],
    );
    await vi.waitFor(() => expect(controller.getPromptIterator()).not.toBeNull());
    return { backend, session };
  }

  /**
   * Drain the event channel up to the next `permission-request` and return its
   * id. Bounded and `done`-aware on purpose: a closed `AsyncEventChannel`
   * returns an already-resolved `{done: true}` forever, so an unguarded
   * `for(;;)` would spin as an unbroken microtask chain, starve the event loop
   * and hang the whole suite rather than failing this one test.
   */
  async function readPermissionRequestId(
    events: AsyncIterator<unknown>,
    maxEvents = 50,
  ): Promise<string> {
    for (let i = 0; i < maxEvents; i++) {
      const next = await events.next();
      if (next.done) {
        throw new Error('event channel closed before a permission-request');
      }
      const event = next.value as {
        type: string;
        request?: { requestId: string };
      };
      if (event?.type === 'permission-request' && event.request) {
        return event.request.requestId;
      }
    }
    throw new Error(`no permission-request within ${maxEvents} events`);
  }

  /** Resolves to true only if `promise` settles within a real tick or two. */
  async function settlesSoon(promise: Promise<unknown>) {
    return Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
  }

  it('sends the prompt as a stream, not a bare string', async () => {
    const controller = makeControllableQuery();
    const { backend } = await startBackend(controller);
    try {
      // A string prompt is what puts the SDK into stdin-closing single-turn mode.
      expect(typeof queryMock.mock.calls[0][0].prompt).not.toBe('string');
      const first = await controller.getPromptIterator()!.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
      });
    } finally {
      controller.end();
      await backend.dispose();
    }
  });

  it('keeps the input stream open across a background-notification result', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next(); // the user message
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      controller.send(notificationResult);
      // Consume events so the backend actually processes the message.
      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt
      await vi.advanceTimersByTimeAsync(50);

      // Still suspended => stdin still open => permissions still answerable.
      expect(closed).toBe(false);

      // A real result no longer closes stdin immediately: it schedules the
      // close so that any further activity can cancel it.
      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // Real transcript, 2026-10-03: result at 17:31:06 (end of the user's turn,
  // a background subagent still live) -> `init` at 17:33:11 started a new turn
  // in which the agent worked for another HOUR. The previous turn's 30s close
  // kept being re-armed by every message, so the first model-generation gap
  // longer than the grace (103s composing a long subagent prompt, zero messages
  // emitted) closed stdin mid-run. The CLI survived, so the run continued with
  // a dead control channel and 17 later Bash calls died with
  // "Tool permission request failed: AbortError: Stream closed".
  //
  // Zero live background tasks is the deliberate configuration: it is what
  // selects POST_RESULT_CLOSE_GRACE_MS (30s) over the 10-minute background
  // grace, and so the setup in which the bug is observable at all.
  it('does not close stdin during a turn the CLI started after a result', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next(); // the user message
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      // End of the user's turn while background work is still live.
      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      // The CLI resumes the agent for a new turn.
      controller.send({ type: 'system', subtype: 'init' });
      await vi.advanceTimersByTimeAsync(50);

      // The agent now spends minutes composing one message and emits NOTHING.
      // Nothing holds stdin (no pending tool, no permission card) — before the
      // fix this is exactly where the 30s close fired.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(closed).toBe(false);

      // A permission request raised that late must still be answerable.
      const canUseTool = queryMock.mock.calls[0][0].options.canUseTool;
      const decision = canUseTool('Bash', { command: 'pnpm -v' }, {});
      const requestId = await readPermissionRequestId(events);
      await backend.respondToPermission(session.sessionId, requestId, {
        behavior: 'allow',
        updatedInput: { command: 'pnpm -v' },
      });
      await expect(decision).resolves.toMatchObject({ behavior: 'allow' });

      // The resumed turn's own result still ends the run on silence.
      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // The flip side of the test above: standing down the 30s close must not leave
  // the run with NO terminating timer. The real `result` already cleared both
  // conditions the idle watchdog arms on, so the stand-down has to arm it
  // itself — otherwise a live-but-silent CLI holds stdin, and the step's
  // `running` status, forever.
  it('still terminates a CLI-started turn that never reports a result', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      const events = session.events[Symbol.asyncIterator]();
      await events.next();

      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);
      controller.send({ type: 'system', subtype: 'init' });
      await vi.advanceTimersByTimeAsync(50);

      // Well past the 30s close, so the stand-down is working...
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(closed).toBe(false);

      // ...but total silence still ends the run rather than hanging forever.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // `task_notification` is a task SETTLEMENT record, and the SDK documents such
  // messages as able to follow the turn-complete `result`. One arriving after
  // the user's turn genuinely ended has no new turn behind it, so it must NOT
  // stand down the close — doing so would hold stdin open for a turn that never
  // comes.
  it('does not treat a background task settling as a new turn', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      const events = session.events[Symbol.asyncIterator]();
      await events.next();

      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);
      controller.send({
        type: 'system',
        subtype: 'task_notification',
        status: 'completed',
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      // The settlement re-armed the grace (any message does) but did not
      // disarm it, so the run still ends on the next silence.
      await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // Observed against the bundled CLI: `idle` lands in the same millisecond as
  // the turn's `result`. With no background work left it is the authoritative
  // end of the run, so the 30s grace invented for guessing is pure latency.
  it('closes stdin at once when the CLI reports idle with no background work', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      const events = session.events[Symbol.asyncIterator]();
      await events.next();

      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      controller.send({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        session_id: 'sess-idle-1',
      });
      // Not immediate — a short window stays open so a resumption can cancel.
      await vi.advanceTimersByTimeAsync(100);
      expect(closed).toBe(false);

      // ...but far below the 30s grace the turn-end used to wait out.
      await vi.advanceTimersByTimeAsync(2 * 1000 + 100);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // The trap the CLI probe exposed: `idle` fires when the TURN ends, not when
  // the RUN does. In a real background-task run it arrived with one task still
  // live, 24 seconds before that task resumed the agent for another turn.
  // Closing stdin on it would kill the control channel for the resumed turn —
  // the exact "AbortError: Stream closed" this machinery prevents.
  it('does not close on idle while background work is still live', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      const events = session.events[Symbol.asyncIterator]();
      await events.next();

      controller.send(backgroundTasksChanged(['bg-1']));
      controller.send(realResult);
      controller.send({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(closed).toBe(false);

      // Past the 30s grace too — the live task earns the long one.
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(closed).toBe(false);

      // The task settles and resumes the agent, and the permission channel it
      // needs is still alive.
      controller.send(backgroundTasksChanged([]));
      controller.send({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
      });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(closed).toBe(false);

      const canUseTool = queryMock.mock.calls[0][0].options.canUseTool;
      const decision = canUseTool('Bash', { command: 'pnpm -v' }, {});
      const requestId = await readPermissionRequestId(events);
      await backend.respondToPermission(session.sessionId, requestId, {
        behavior: 'allow',
        updatedInput: { command: 'pnpm -v' },
      });
      await expect(decision).resolves.toMatchObject({ behavior: 'allow' });

      // That turn ends and now the run really is over.
      controller.send(realResult);
      controller.send({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      });
      await vi.advanceTimersByTimeAsync(2 * 1000 + 100);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // An authoritative turn-over signal must still not outrank a human. stdin is
  // the channel the permission answer travels back on, so the immediate close
  // routes through the same hold machinery as the timed one.
  it('holds stdin open on idle while a permission card is unanswered', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      const events = session.events[Symbol.asyncIterator]();
      await events.next();

      const canUseTool = queryMock.mock.calls[0][0].options.canUseTool;
      const decision = canUseTool('Bash', { command: 'ls' }, {});
      const requestId = await readPermissionRequestId(events);

      controller.send(realResult);
      controller.send({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(closed).toBe(false);

      await backend.respondToPermission(session.sessionId, requestId, {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      });
      await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // `idle` is a TURN boundary and `backgroundTaskIds` is a weak proxy for "no
  // resumption coming" — this file's own transcript records a resumption with
  // zero tracked tasks. So the idle close must stay cancellable: a `running`
  // arriving inside the window has to keep the control channel alive.
  it('lets a resumption inside the idle window cancel the close', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      const events = session.events[Symbol.asyncIterator]();
      await events.next();

      controller.send(realResult);
      controller.send({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(closed).toBe(false);

      // A turn the background-task bookkeeping never saw coming.
      controller.send({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
      });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(closed).toBe(false);

      // And its tool calls can still get an answer.
      const canUseTool = queryMock.mock.calls[0][0].options.canUseTool;
      const decision = canUseTool('Bash', { command: 'ls' }, {});
      const requestId = await readPermissionRequestId(events);
      await backend.respondToPermission(session.sessionId, requestId, {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      });
      await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // A turn can end on a withheld background-notification result, whose replay
  // in `finally` is the ONLY thing that finalizes the step. `idle` must not
  // make a later turn-start edge discard it — the SDK re-emits `init` on
  // reconnect with no turn behind it, which would strand the step on `running`.
  it('keeps a withheld result through idle and a spurious turn start', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      // Collected from the start: the replay happens as the channel closes, and
      // a closed channel yields `{done: true}` forever, so draining afterwards
      // would see nothing.
      const seen: string[] = [];
      const collector = (async () => {
        for await (const event of session.events) {
          seen.push((event as { type: string }).type);
        }
      })();

      // The turn's only result is a zero-turn notification one: withheld, so
      // `sawRealResult` stays false and nothing has finalized the step yet.
      controller.send(notificationResult);
      controller.send({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
      });
      // A reconnect re-emits `init` with no real turn behind it.
      controller.send({ type: 'system', subtype: 'init' });
      await vi.advanceTimersByTimeAsync(500);

      // The run still terminates...
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(closed).toBe(true);

      // Closing stdin makes the real CLI exit, which ends the SDK stream and
      // runs the generator's `finally` — where the replay lives.
      controller.end();
      await collector;

      // ...and the withheld result survived to finalize the step.
      expect(seen).toContain('complete');
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // The single line that changes behaviour for every existing user: without the
  // env var the CLI emits no session-state messages at all and the whole
  // explicit-turn-boundary path above is dead.
  it('enables the CLI session-state events, and lets config env override them', async () => {
    const controller = makeControllableQuery();
    const { backend } = await startBackend(controller);
    try {
      expect(queryMock.mock.calls[0][0].options.env).toMatchObject({
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      });
    } finally {
      controller.end();
      await backend.dispose();
    }

    const second = makeControllableQuery();
    const { backend: backend2 } = await startBackend(second, {
      env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '' },
    });
    try {
      const lastCall = queryMock.mock.calls[queryMock.mock.calls.length - 1];
      expect(
        lastCall[0].options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS,
      ).toBe('');
    } finally {
      second.end();
      await backend2.dispose();
    }
  });

  // A `canUseTool` request arrives on the SDK's CONTROL channel, not the
  // message stream, so the generator loop never sees it and cannot cancel the
  // close armed by the preceding `result`. If the user takes longer than the
  // grace period to click the permission card, stdin — the channel their answer
  // travels back on — is gone, and the call dies with
  // "Tool permission request failed: AbortError: Stream closed".
  it('holds stdin open while a permission card waits on the user past the grace period', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next(); // the user message
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      // A result arms the 30s close.
      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      // The agent is resumed (background notification) and asks for permission.
      const canUseTool = queryMock.mock.calls[0][0].options.canUseTool;
      const decision = canUseTool('Bash', { command: 'ls' }, {});

      const requestId = await readPermissionRequestId(events);

      // The user deliberates for far longer than the grace period. stdin must
      // survive — it is what carries their answer back to the CLI.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(closed).toBe(false);

      // They finally allow it, and the answer lands on a live channel.
      await backend.respondToPermission(session.sessionId, requestId, {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      });
      await expect(decision).resolves.toMatchObject({ behavior: 'allow' });

      // The approved tool gets a fresh full grace period rather than being cut
      // off by whatever was left of the deferred one...
      await vi.advanceTimersByTimeAsync(CLOSE_HOLD_RECHECK_MS + 1_000);
      expect(closed).toBe(false);

      // ...but nothing blocks on a human any more, so the run does terminate.
      await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // The hold is deliberately unbounded: an answer the user walked away from
  // must never be thrown away by a timeout. `stop()` closes the stream
  // unconditionally and is the escape hatch for a run they no longer want.
  it('holds indefinitely for an unanswered card, and stop() still ends it', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);

      const canUseTool = queryMock.mock.calls[0][0].options.canUseTool;
      const decision = canUseTool('Bash', { command: 'ls' }, {});
      await readPermissionRequestId(events);

      // The user wanders off for the rest of the day. stdin stays open the
      // whole time — their answer is still worth something whenever it comes.
      await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
      expect(closed).toBe(false);
      await expect(settlesSoon(decision)).resolves.toBe(false);

      // Stop is the escape hatch, and it settles the card rather than leaving
      // it dangling for a click that would throw "No Claude session".
      await backend.stop(session.sessionId);
      await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // The CLI emits nothing between `tool_use` and `tool_result`, so a slow Bash
  // or a long build is indistinguishable from a finished run. Closing stdin
  // under it kills the tool's result and every later permission request.
  it('holds stdin open while an approved tool is still running', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      // The turn ends, arming the close. Then a background task resumes the
      // agent, which starts a slow tool and goes quiet while it runs.
      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);
      controller.send({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_slow',
              name: 'Bash',
              input: { command: 'sleep 600' },
            },
          ],
        },
      });
      await events.next(); // the tool-use entry
      await vi.advanceTimersByTimeAsync(50);

      // Ten minutes of silence that used to close stdin at the 30s mark.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(closed).toBe(false);

      // The tool finally reports back; now the run may wind down.
      controller.send({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_slow',
              content: 'done',
            },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      await vi.advanceTimersByTimeAsync(
        CLOSE_HOLD_RECHECK_MS + 30 * 1000 + 1_000,
      );
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // The close timer is not the only thing that can kill stdin under a live
  // card: a withheld background-notification result arms the 10-minute idle
  // watchdog, which used to close the stream regardless of what was pending.
  it('holds stdin open against the idle watchdog too, not just the close timer', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      // A withheld result arms the idle watchdog and nothing else.
      controller.send(notificationResult);
      await vi.advanceTimersByTimeAsync(50);

      const canUseTool = queryMock.mock.calls[0][0].options.canUseTool;
      const decision = canUseTool('Bash', { command: 'ls' }, {});
      const requestId = await readPermissionRequestId(events);

      // Well past the 10-minute idle timeout with the card still up.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(closed).toBe(false);

      await backend.respondToPermission(session.sessionId, requestId, {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      });
      await expect(decision).resolves.toMatchObject({ behavior: 'allow' });
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // A hold is normally ended by an incoming message, which cancels the recheck
  // timer outright — so no timer fire ever observes the release. If the hold
  // latch survived that teardown, the next close would read it as "a hold just
  // ended", grant a second full grace period, and drag every run out by an
  // extra 30s (or 10 minutes with background tasks live).
  it('does not grant a second grace period after a hold ended off-timer', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);

      const canUseTool = queryMock.mock.calls[0][0].options.canUseTool;
      const decision = canUseTool('Bash', { command: 'ls' }, {});
      const requestId = await readPermissionRequestId(events);

      // Let the close timer fire once and latch the hold.
      await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
      expect(closed).toBe(false);

      await backend.respondToPermission(session.sessionId, requestId, {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      });
      await expect(decision).resolves.toMatchObject({ behavior: 'allow' });

      // A message arrives, cancelling the recheck timer without any fire
      // observing that the card is gone, and re-arming a normal close.
      controller.send({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      });
      await events.next();
      await vi.advanceTimersByTimeAsync(50);

      // Exactly one grace period later the run is over — not two.
      await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // `pendingToolUses` is drained only by a matching `tool_result`. A turn that
  // ends as `error_max_turns` leaves an entry that will never be drained, so
  // treating it as a hold would wedge the run — and the idle watchdog that
  // exists to break exactly that wedge — forever.
  it('does not let a tool call abandoned by the turn hold the stream open', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      controller.send({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_abandoned',
              name: 'Bash',
              input: { command: 'sleep 600' },
            },
          ],
        },
      });
      await events.next(); // the tool-use entry

      // The turn dies without ever producing a `tool_result` for it.
      controller.send({
        type: 'result',
        subtype: 'error_max_turns',
        num_turns: 12,
        result: '',
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      // The abandoned tool must not keep the run alive.
      await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // A background notification result does NOT end the user's turn — that is
  // the whole reason it is withheld. Treating it as proof that in-flight tools
  // are finished would excuse a foreground build that is genuinely still
  // running and let the close timer kill stdin under it.
  it('does not let a background notification excuse a still-running tool', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);

      // A long foreground build starts after the turn's result.
      controller.send({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_build',
              name: 'Bash',
              input: { command: 'pnpm build' },
            },
          ],
        },
      });
      await events.next();

      // A background bash finishes mid-build and notifies the agent.
      controller.send(notificationResult);
      await vi.advanceTimersByTimeAsync(50);

      // The build is still running, so stdin must survive.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(closed).toBe(false);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  // A tool waits on a machine that can simply die (hung mount, crashed MCP
  // server). Unlike a permission card, that hold must be bounded or an
  // undrainable `pendingToolUses` entry disables every close path forever.
  it('gives up on a tool that never returns, instead of wedging the run', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      controller.send(realResult);
      await vi.advanceTimersByTimeAsync(50);

      // A tool starts after the result and never reports back.
      controller.send({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_wedged',
              name: 'Bash',
              input: { command: 'cat /mnt/hung/file' },
            },
          ],
        },
      });
      await events.next();
      await vi.advanceTimersByTimeAsync(50);

      // Well inside the budget it still holds — a real build must not be cut off.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(closed).toBe(false);

      // Past it, the run finalizes on its own rather than staying `running`.
      await vi.advanceTimersByTimeAsync(
        MAX_TOOL_HOLD_MS + CLOSE_HOLD_RECHECK_MS + 30 * 1000 + 1_000,
      );
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  describe('follow-up prompt injection', () => {
    it('hands an injected prompt to the SDK on the same run', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      try {
        const iterator = controller.getPromptIterator()!;
        await iterator.next(); // the initial user message

        // The generator is now suspended waiting for more input.
        const pulled = iterator.next();
        expect(await settlesSoon(pulled)).toBe(false);

        const accepted = await backend.sendUserMessage!(session.sessionId, [
          { type: 'text', text: 'follow up' },
        ]);
        expect(accepted).toBe(true);

        const delivered = await pulled;
        expect(delivered.done).toBe(false);
        expect(delivered.value).toMatchObject({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'follow up' }],
          },
        });
      } finally {
        controller.end();
        await backend.dispose();
      }
    });

    it('cancels the pending stdin close so the injected prompt is not killed', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const iterator = controller.getPromptIterator()!;
        await iterator.next();
        let closed = false;
        const pulled = iterator.next().then((r) => {
          if (r.done) closed = true;
          return r;
        });

        // A real result arms the 30s stdin close.
        controller.send(realResult);
        await vi.advanceTimersByTimeAsync(50);

        expect(
          await backend.sendUserMessage!(session.sessionId, [
            { type: 'text', text: 'follow up' },
          ]),
        ).toBe(true);

        // Well past the close grace armed by that result.
        await vi.advanceTimersByTimeAsync(60 * 1000);
        expect(closed).toBe(false);
        expect((await pulled).value).toMatchObject({
          message: { content: [{ type: 'text', text: 'follow up' }] },
        });

        // The prompt being delivered is not enough — the input stream must
        // still be OPEN afterwards. Without cancelScheduledClose the pending
        // close fires, stdin shuts, and the CLI can never answer the prompt it
        // was just handed.
        const afterInjection = iterator.next();
        await vi.advanceTimersByTimeAsync(60 * 1000);
        expect(await settlesSoon(afterInjection)).toBe(false);
      } finally {
        vi.useRealTimers();
        controller.end();
        await backend.dispose();
      }
    });

    it('terminates the run if the CLI never answers an injected prompt', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const iterator = controller.getPromptIterator()!;
        await iterator.next();
        void iterator.next();

        controller.send(realResult);
        await vi.advanceTimersByTimeAsync(50);
        await backend.sendUserMessage!(session.sessionId, [
          { type: 'text', text: 'follow up' },
        ]);
        await vi.advanceTimersByTimeAsync(50);

        // Injection clears deferredResultEvents and the close timer, so without
        // the awaiting-injected-response watchdog NOTHING would ever end this
        // run: stdin stays open and the step wedges on `running` forever.
        let closed = false;
        void iterator.next().then((r) => {
          if (r.done) closed = true;
        });
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1_000);
        expect(closed).toBe(true);
      } finally {
        vi.useRealTimers();
        controller.end();
        await backend.dispose();
      }
    });

    /**
     * The session is still alive and the SDK generator is still running — only
     * the *input stream* has closed (the post-result grace elapsed). Returning
     * false here is what makes agent-service fall back to a restart rather than
     * silently dropping the user's prompt into a stream nobody reads.
     */
    /**
     * Without this the follow-up never reaches the timeline: no prompt group
     * opens, the prompt is invisible in the stream and gone from history on
     * reload, and the live background jobs stay pinned under the previous
     * group instead of the new one.
     */
    it('emits a user-prompt timeline entry for the injected prompt', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      try {
        const events = session.events[Symbol.asyncIterator]();
        // The run's own initial prompt entry.
        const first = await events.next();
        expect(first.value).toMatchObject({
          type: 'entry',
          entry: { type: 'user-prompt', value: 'go' },
        });

        await backend.sendUserMessage!(session.sessionId, [
          { type: 'text', text: 'follow up' },
        ]);

        // Same shape as a run's initial prompt, so an injected prompt renders
        // exactly like the start of a run.
        expect((await events.next()).value).toMatchObject({
          type: 'entry',
          entry: {
            type: 'user-prompt',
            value: 'follow up',
            isSynthetic: true,
          },
        });
      } finally {
        controller.end();
        await backend.dispose();
      }
    });

    it('does not emit a timeline entry when the injection is refused', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const events = session.events[Symbol.asyncIterator]();
        await events.next(); // initial prompt entry

        const iterator = controller.getPromptIterator()!;
        await iterator.next();
        void iterator.next();
        controller.send(realResult);
        await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);

        expect(
          await backend.sendUserMessage!(session.sessionId, [
            { type: 'text', text: 'follow up' },
          ]),
        ).toBe(false);

        // A refused injection must not leave an orphan prompt in the timeline:
        // the next event is the result's, never a 'follow up' user-prompt.
        const next = await events.next();
        expect(next.value).not.toMatchObject({
          entry: { type: 'user-prompt', value: 'follow up' },
        });
      } finally {
        vi.useRealTimers();
        controller.end();
        await backend.dispose();
      }
    });

    /**
     * The watchdog must not punish a legitimate injected turn. Waiting for a
     * `result` to disarm it would kill any turn whose first action is a long
     * silent foreground tool call — closing stdin mid-turn, breaking the
     * permission channel and the background jobs this path exists to protect.
     */
    it('disarms the watchdog once the CLI starts answering the injected prompt', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const iterator = controller.getPromptIterator()!;
        await iterator.next();
        void iterator.next();

        controller.send(realResult);
        await vi.advanceTimersByTimeAsync(50);
        await backend.sendUserMessage!(session.sessionId, [
          { type: 'text', text: 'follow up' },
        ]);
        await vi.advanceTimersByTimeAsync(50);

        let closed = false;
        void iterator.next().then((r) => {
          if (r.done) closed = true;
        });

        // The agent starts the turn, then runs a long silent tool call.
        controller.send({
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
        });
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1_000);

        expect(closed).toBe(false);
      } finally {
        vi.useRealTimers();
        controller.end();
        await backend.dispose();
      }
    });

    /**
     * A background bash/Monitor completion resumes the MAIN agent, so its
     * messages are top-level (no `parent_tool_use_id`) — unlike subagent
     * output. Such a message can already be in flight when the user's prompt is
     * injected, and must not be mistaken for a response to a prompt the CLI has
     * not even been handed yet.
     */
    it('does not let a message in flight before the prompt reached stdin disarm the watchdog', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const iterator = controller.getPromptIterator()!;
        await iterator.next(); // initial prompt written

        controller.send(realResult);
        await vi.advanceTimersByTimeAsync(50);
        await backend.sendUserMessage!(session.sessionId, [
          { type: 'text', text: 'follow up' },
        ]);
        await vi.advanceTimersByTimeAsync(50);

        // Deliberately do NOT pull the prompt iterator: the injected prompt is
        // queued but has not been written to stdin yet. (Pulling it to observe
        // the close would itself deliver the prompt, so the stream's open/shut
        // state is read via a later injection attempt instead.)

        // A top-level assistant message from the previous turn lands now.
        controller.send({
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          parent_tool_use_id: null,
        });
        await vi.advanceTimersByTimeAsync(50);

        // The watchdog must still be armed, so total silence still ends the run.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1_000);

        // Stream closed => a further injection is refused.
        expect(
          await backend.sendUserMessage!(session.sessionId, [
            { type: 'text', text: 'later' },
          ]),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
        controller.end();
        await backend.dispose();
      }
    });

    /**
     * Background subagents are streaming precisely when injection happens, so
     * "any message" is NOT evidence the CLI answered the injected prompt. If
     * unrelated chatter could disarm the watchdog there would be nothing left
     * to end the run: injection resets `sawRealResult`, so no stdin close is
     * scheduled either, and the step wedges on `running` forever.
     */
    it('keeps the injected-prompt watchdog armed through unrelated background chatter', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const iterator = controller.getPromptIterator()!;
        await iterator.next();
        void iterator.next();

        controller.send(realResult);
        await vi.advanceTimersByTimeAsync(50);
        await backend.sendUserMessage!(session.sessionId, [
          { type: 'text', text: 'follow up' },
        ]);
        await vi.advanceTimersByTimeAsync(50);

        let closed = false;
        void iterator.next().then((r) => {
          if (r.done) closed = true;
        });

        // A background subagent keeps streaming, but never answers the prompt.
        controller.send(backgroundTasksChanged(['bg-1']));
        await vi.advanceTimersByTimeAsync(50);
        expect(closed).toBe(false);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1_000);
        expect(closed).toBe(true);
      } finally {
        vi.useRealTimers();
        controller.end();
        await backend.dispose();
      }
    });

    it('refuses injection once the input stream has closed under a live session', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const iterator = controller.getPromptIterator()!;
        await iterator.next();
        let closed = false;
        void iterator.next().then((r) => {
          if (r.done) closed = true;
        });

        controller.send(realResult);
        await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
        // Input stream closed, but the run/session still exists.
        expect(closed).toBe(true);

        expect(
          await backend.sendUserMessage!(session.sessionId, [
            { type: 'text', text: 'follow up' },
          ]),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
        controller.end();
        await backend.dispose();
      }
    });

    it('refuses injection after the run has ended', async () => {
      const controller = makeControllableQuery();
      const { backend, session } = await startBackend(controller);
      controller.end();
      await vi.waitFor(async () => {
        expect(
          await backend.sendUserMessage!(session.sessionId, [
            { type: 'text', text: 'follow up' },
          ]),
        ).toBe(false);
      });
      await backend.dispose();
    });
  });

  // Replays the sequence from a real transcript that broke permissions: the
  // agent launched 11 background subagents, then emitted a `result` with NO
  // `origin` field and `num_turns: 17`. Both the origin and zero-turn
  // heuristics classified that as a real end-of-turn, so stdin closed — and the
  // run went on for 25 more minutes and 245 tool calls with a dead `canUseTool`
  // channel, failing every permission request in that window.
  const backgroundTasksChanged = (ids: string[]) => ({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: ids.map((id) => ({ task_id: id, task_type: 'local_agent' })),
  });
  const originlessResult = {
    type: 'result',
    subtype: 'success',
    num_turns: 17,
    result: 'first turn done',
  };
  // Transcript idx 1164: a task-notification result that reports real work, so
  // `isBackgroundNotificationResult` (which withholds only zero-turn no-ops)
  // treats it as a genuine end of turn.
  const notificationRealWorkResult = {
    type: 'result',
    subtype: 'success',
    origin: { kind: 'task-notification' },
    num_turns: 1,
    result: 'notification turn done',
  };

  it('keeps stdin open through BOTH misclassified results in the real transcript', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next(); // the user message
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      // --- Window 1 (transcript idx 427): origin absent, num_turns 17, with
      // 11 background subagents live. Looked like a human end-of-turn.
      controller.send(backgroundTasksChanged(['task-a', 'task-b']));
      controller.send(originlessResult);
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      // The agent keeps working, which must cancel the pending close.
      controller.send({ type: 'assistant', message: { content: [] } });
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(closed).toBe(false);

      // --- Window 2 (transcript idx 1164): tasks have legitimately drained to
      // zero and the result carries origin `task-notification` with
      // num_turns 1. The background-task signal CANNOT catch this one — only
      // the silence grace can. The run continued for 20 more minutes here.
      controller.send(backgroundTasksChanged([]));
      controller.send(notificationRealWorkResult);
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      controller.send({ type: 'assistant', message: { content: [] } });
      await vi.advanceTimersByTimeAsync(20 * 1000);
      expect(closed).toBe(false);

      // Only sustained silence ends the run.
      await vi.advanceTimersByTimeAsync(30 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  it('emits a background-tasks event for every snapshot so the UI can show live jobs', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    try {
      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      controller.send({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          {
            task_id: 'task-a',
            task_type: 'local_agent',
            description: 'Review: behavior regressions',
          },
        ],
      });
      const live = await events.next();
      expect(live.value).toEqual({
        type: 'background-tasks',
        tasks: [
          {
            taskId: 'task-a',
            description: 'Review: behavior regressions',
            taskType: 'local_agent',
          },
        ],
      });

      // REPLACE semantics: an empty snapshot clears the indicator.
      controller.send(backgroundTasksChanged([]));
      const drained = await events.next();
      expect(drained.value).toEqual({ type: 'background-tasks', tasks: [] });
    } finally {
      controller.end();
      await backend.dispose();
    }
  });

  it('clears background tasks when the stream ends without a final snapshot', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    try {
      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      controller.send(backgroundTasksChanged(['never-reported-done']));
      await events.next(); // the live snapshot
      controller.end();

      const cleared = await events.next();
      expect(cleared.value).toEqual({ type: 'background-tasks', tasks: [] });
    } finally {
      await backend.dispose();
    }
  });

  it('still closes stdin when a background task never terminates', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });
      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt

      // A leftover `run_in_background` shell (or a Monitor) never completes, so
      // the task set never drains. The grace period must stay BOUNDED — gating
      // the close on an empty task set would hang the run forever.
      controller.send(backgroundTasksChanged(['never-ends']));
      controller.send(originlessResult);
      await vi.advanceTimersByTimeAsync(50);
      expect(closed).toBe(false);

      // A quiet stretch shorter than the grace must NOT close the channel —
      // a real transcript went 4m21s without a message mid-run.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(closed).toBe(false);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  it('closes the input stream when the run goes idle after a withheld result', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      let closed = false;
      void iterator.next().then(() => {
        closed = true;
      });

      controller.send(notificationResult);
      const events = session.events[Symbol.asyncIterator]();
      await events.next(); // synthetic user prompt
      await vi.advanceTimersByTimeAsync(50); // let the result be processed

      // A withheld result is outstanding and no real result will ever arrive.
      // Without the watchdog the CLI would idle forever holding stdin — and the
      // deferred-result replay that finalizes the step would never run.
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1_000);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      controller.end();
      await backend.dispose();
    }
  });

  it('closes the input stream when the session is stopped', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      const secondNext = iterator.next();

      await backend.stop(session.sessionId);
      expect(await settlesSoon(secondNext)).toBe(true);
    } finally {
      controller.end();
      await backend.dispose();
    }
  });

  it('closes the input stream when the SDK stream ends', async () => {
    const controller = makeControllableQuery();
    const { backend, session } = await startBackend(controller);
    try {
      const iterator = controller.getPromptIterator()!;
      await iterator.next();
      const secondNext = iterator.next();

      controller.end();
      await collectEvents(session);

      expect(await settlesSoon(secondNext)).toBe(true);
    } finally {
      await backend.dispose();
    }
  });

  it('denies a still-pending permission request when the stream ends', async () => {
    let permissionResult: PermissionResult | undefined;
    queryMock.mockImplementation(
      ({ options }: { options: Record<string, unknown> }) => {
        return createQuery(async () => {
          const canUseTool = options.canUseTool as (
            toolName: string,
            input: Record<string, unknown>,
            metadata: Record<string, unknown>,
          ) => Promise<PermissionResult>;
          // Never answered — the stream ends underneath it.
          void canUseTool('Bash', { command: 'rm -rf /' }, {}).then((result) => {
            permissionResult = result;
          });
        });
      },
    );

    const backend = makeBackend();
    try {
      const session = await backend.start(
        { type: 'claude-code', cwd: '/worktree', interactionMode: 'ask' },
        [{ type: 'text', text: 'go' }],
      );
      await collectEvents(session);
      await vi.waitFor(() => expect(permissionResult).toBeDefined());
      expect(permissionResult).toEqual({
        behavior: 'deny',
        message: 'Session ended',
      });
    } finally {
      await backend.dispose();
    }
  });
});

describe('ClaudeCodeBackend directory access', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns selected parent as an SDK session directory update', async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-claude-directory-'),
    );
    const requestedDirectory = path.join(temporaryDirectory, 'repo');
    const requestedPath = path.join(requestedDirectory, 'file.ts');
    fs.mkdirSync(requestedDirectory);
    fs.writeFileSync(requestedPath, 'test');
    const allowedDirectory = fs.realpathSync.native(temporaryDirectory);
    let permissionResult: PermissionResult | undefined;

    queryMock.mockImplementation(
      ({ options }: { options: Record<string, unknown> }) =>
        createQuery(async () => {
          const canUseTool = options.canUseTool as (
            toolName: string,
            input: Record<string, unknown>,
            metadata: Record<string, unknown>,
          ) => Promise<PermissionResult>;
          permissionResult = await canUseTool(
            'Read',
            { file_path: requestedPath },
            {
              blockedPath: requestedPath,
              suggestions: [
                {
                  type: 'addDirectories',
                  directories: [requestedDirectory],
                  destination: 'session',
                },
              ],
            },
          );
        }),
    );

    const backend = makeBackend();
    try {
      const session = await backend.start(
        {
          type: 'claude-code',
          cwd: '/worktree',
          interactionMode: 'ask',
          permissionRules: [
            { tool: 'read', pattern: '*', action: 'allow' },
          ],
        },
        [{ type: 'text', text: 'Read file' }],
      );
      const iterator = session.events[Symbol.asyncIterator]();
      await iterator.next(); // synthetic user prompt
      const permissionEvent = await iterator.next();
      expect(permissionEvent.value).toMatchObject({
        type: 'permission-request',
        request: {
          directoryAccess: {
            requestedPath: fs.realpathSync.native(requestedPath),
            requestedDirectory: fs.realpathSync.native(requestedDirectory),
          },
        },
      });
      if (permissionEvent.value?.type !== 'permission-request') {
        throw new Error('Expected permission request');
      }

      await backend.respondToPermission(
        session.sessionId,
        permissionEvent.value.request.requestId,
        { behavior: 'allow', allowedDirectory },
      );
      await iterator.next();

      expect(permissionResult).toEqual({
        behavior: 'allow',
        updatedInput: undefined,
        updatedPermissions: [
          {
            type: 'addDirectories',
            directories: [allowedDirectory],
            destination: 'session',
          },
        ],
      });
    } finally {
      await backend.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('does not hydrate a persisted directory whose symlink target changed', async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-claude-directory-'),
    );
    const allowedDirectory = path.join(temporaryDirectory, 'allowed');
    fs.mkdirSync(allowedDirectory);
    const canonicalAllowedDirectory = fs.realpathSync.native(allowedDirectory);
    const pattern = toDirectoryPermissionPattern(canonicalAllowedDirectory);
    fs.rmSync(allowedDirectory, { recursive: true });
    fs.symlinkSync(path.parse(temporaryDirectory).root, allowedDirectory);

    queryMock.mockImplementation(() => createQuery());
    const backend = makeBackend();
    try {
      await backend.start(
        {
          type: 'claude-code',
          cwd: '/worktree',
          interactionMode: 'ask',
          persistedSessionRules: {
            external_directory: { [pattern]: 'allow' },
          },
        },
        [{ type: 'text', text: 'Continue' }],
      );
      await vi.waitFor(() => expect(queryMock).toHaveBeenCalled());

      expect(queryMock.mock.calls[0][0].options.additionalDirectories).toBeUndefined();
    } finally {
      await backend.dispose();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

/**
 * The wire shape of the first user message. Anthropic content blocks are
 * ordered, so this is where a pasted image's position in the prompt either
 * survives or is lost. The empty-text-block rules matter too: an empty
 * `content` array is a shape the CLI may reject, and a bare-string prompt puts
 * the SDK into stdin-closing single-turn mode.
 */
describe('ClaudeCodeBackend user message content blocks', () => {
  beforeEach(() => {
    queryMock.mockReset();
    vi.useRealTimers();
  });

  const anchored = {
    type: 'image' as const,
    data: 'a-data',
    mimeType: 'image/png',
    filename: 'a.png',
    placeholderToken: 'aaa',
  };
  const loose = {
    type: 'image' as const,
    data: 'b-data',
    mimeType: 'image/png',
    filename: 'b.png',
  };
  const imgBlock = (data: string) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  });

  async function contentFor(parts: unknown[]) {
    let promptIterator: AsyncIterator<unknown> | null = null;
    queryMock.mockImplementation(({ prompt }: { prompt: unknown }) => {
      promptIterator = (prompt as AsyncIterable<unknown>)[
        Symbol.asyncIterator
      ]();
      return createQuery();
    });

    const backend = makeBackend();
    const session = await backend.start(
      { type: 'claude-code', cwd: '/worktree', interactionMode: 'ask' },
      parts as Parameters<typeof backend.start>[1],
    );
    await vi.waitFor(() => expect(promptIterator).not.toBeNull());
    try {
      const first = await promptIterator!.next();
      return (
        first.value as { message: { content: unknown[] } }
      ).message.content;
    } finally {
      void session;
      await backend.dispose();
    }
  }

  it('sends text only as a single text block', async () => {
    expect(await contentFor([{ type: 'text', text: 'go' }])).toEqual([
      { type: 'text', text: 'go' },
    ]);
  });

  it('appends untokened images after the text, as it always has', async () => {
    expect(
      await contentFor([{ type: 'text', text: 'go' }, loose]),
    ).toEqual([{ type: 'text', text: 'go' }, imgBlock('b-data')]);
  });

  it('omits the text block for an image-only prompt', async () => {
    expect(await contentFor([loose])).toEqual([imgBlock('b-data')]);
  });

  it('still emits an empty text block when there is nothing at all', async () => {
    expect(await contentFor([{ type: 'text', text: '' }])).toEqual([
      { type: 'text', text: '' },
    ]);
  });

  it('splits the text so an anchored image lands in its own slot', async () => {
    expect(
      await contentFor([
        { type: 'text', text: '1. header\n![a.png](jc-image://aaa)\n2. modal' },
        anchored,
      ]),
    ).toEqual([
      { type: 'text', text: '1. header\n' },
      imgBlock('a-data'),
      { type: 'text', text: '\n2. modal' },
    ]);
  });

  it('keeps an anchored image inline and an untokened one trailing', async () => {
    expect(
      await contentFor([
        { type: 'text', text: 'see ![a.png](jc-image://aaa)' },
        anchored,
        loose,
      ]),
    ).toEqual([
      { type: 'text', text: 'see ' },
      imgBlock('a-data'),
      imgBlock('b-data'),
    ]);
  });

  it('never drops an image whose placeholder the user deleted', async () => {
    expect(
      await contentFor([{ type: 'text', text: 'no marker' }, anchored]),
    ).toEqual([{ type: 'text', text: 'no marker' }, imgBlock('a-data')]);
  });
});
