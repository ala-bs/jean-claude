import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { toDirectoryPermissionPattern } from '../../directory-access';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeCodeBackend } from './claude-code-backend';

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

  async function startBackend(controller: ReturnType<typeof makeControllableQuery>) {
    const backend = makeBackend();
    const session = await backend.start(
      { type: 'claude-code', cwd: '/worktree', interactionMode: 'ask' },
      [{ type: 'text', text: 'go' }],
    );
    await vi.waitFor(() => expect(controller.getPromptIterator()).not.toBeNull());
    return { backend, session };
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
