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
