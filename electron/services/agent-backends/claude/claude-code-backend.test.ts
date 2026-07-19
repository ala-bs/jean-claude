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
