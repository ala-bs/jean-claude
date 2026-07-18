import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  AssistantMessage,
  Event,
  Message,
  Part,
} from '@opencode-ai/sdk/v2';
import { describe, expect, it } from 'vitest';

import {
  normalizeOpenCodeV2,
  type OpenCodeNormalizationContext,
} from './normalize-opencode-message-v2';
import { applyDeltaToMessageParts } from './opencode-message-delta';

function createContext(): OpenCodeNormalizationContext {
  return {
    emittedEntryIds: new Set(),
    rawMessages: new Map(),
    rawParts: new Map(),
    sessionStartTime: 0,
    totalCost: 0,
  };
}

function createAssistantMessage(id: string): AssistantMessage {
  return {
    id,
    role: 'assistant',
    providerID: 'openai',
    modelID: 'gpt-5.4',
    time: {
      created: 1_717_000_000_000,
      completed: 1_717_000_000_500,
    },
  } as AssistantMessage;
}

describe('normalizeOpenCodeV2', () => {
  it('preserves external-directory metadata and parent choices', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jc-opencode-normalizer-'),
    );
    const requestedDirectory = path.join(
      temporaryDirectory,
      'shared',
      'repo',
    );
    fs.mkdirSync(requestedDirectory, { recursive: true });
    const requestedPath = path.join(requestedDirectory, 'file.ts');
    fs.writeFileSync(requestedPath, 'test');

    try {
      const events = normalizeOpenCodeV2(
        {
          kind: 'event',
          event: {
            type: 'permission.asked',
            properties: {
              id: 'permission-1',
              sessionID: 'session-1',
              permission: 'external_directory',
              patterns: [`${requestedDirectory}/*`],
              always: [`${requestedDirectory}/*`],
              metadata: {
                filepath: requestedPath,
                parentDir: requestedDirectory,
              },
            },
          } as unknown as Event,
        },
        createContext(),
      );
      const canonicalDirectory = fs.realpathSync.native(requestedDirectory);
      const canonicalPath = fs.realpathSync.native(requestedPath);

      expect(events).toMatchObject([
        {
          type: 'permission-request',
          request: {
            requestId: 'permission-1',
            toolName: 'external_directory',
            input: {
              filepath: requestedPath,
              parentDir: requestedDirectory,
              permissionPatterns: [`${canonicalDirectory}/**`],
              alwaysPatterns: [`${requestedDirectory}/*`],
            },
            description: 'external_directory',
            directoryAccess: {
              requestedPath: canonicalPath,
              requestedDirectory: canonicalDirectory,
              parentDirectories: expect.arrayContaining([
                { path: path.dirname(canonicalDirectory) },
              ]),
            },
          },
        },
      ]);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('disables auto-evaluation when external-directory metadata is inconsistent', () => {
    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'permission.asked',
          properties: {
            id: 'permission-1',
            sessionID: 'session-1',
            permission: 'external_directory',
            patterns: ['/safe/repo/*'],
            always: ['/safe/repo/*'],
            metadata: {
              filepath: '/outside/file.ts',
              parentDir: '/safe/repo',
            },
          },
        } as unknown as Event,
      },
      createContext(),
    );

    expect(events).toMatchObject([
      {
        type: 'permission-request',
        request: {
          input: {
            externalDirectoryAutoEvaluate: false,
            permissionPatterns: ['/safe/repo/*'],
          },
          directoryAccess: undefined,
        },
      },
    ]);
  });

  it('emits both reasoning and text entries for prompt results', () => {
    const info = createAssistantMessage('msg-1');
    const ctx = createContext();
    const parts = [
      {
        id: 'reasoning-1',
        messageID: info.id,
        sessionID: 'session-1',
        type: 'reasoning',
        text: 'Thinking',
      },
      {
        id: 'text-1',
        messageID: info.id,
        sessionID: 'session-1',
        type: 'text',
        text: 'Final answer',
      },
    ] as Part[];

    const events = normalizeOpenCodeV2(
      { kind: 'prompt-result', info, parts },
      ctx,
    );

    expect(events).toHaveLength(2);
    expect(events).toMatchObject([
      {
        type: 'entry',
        entry: {
          id: 'msg-1:reasoning-1',
          type: 'thinking',
          value: 'Thinking',
        },
      },
      {
        type: 'entry',
        entry: {
          id: 'msg-1:text-1',
          type: 'assistant-message',
          value: 'Final answer',
        },
      },
    ]);
  });

  it('rebuilds accumulated text on message.part.delta events', () => {
    const info = createAssistantMessage('msg-2');
    const part = {
      id: 'text-2',
      messageID: info.id,
      sessionID: 'session-1',
      type: 'text',
      text: 'Hello',
    } as never;
    const ctx = createContext();
    ctx.rawMessages.set(info.id, info as Message);
    ctx.rawParts.set(info.id, [part]);
    ctx.emittedEntryIds.add('msg-2:text-2');

    applyDeltaToMessageParts(ctx.rawParts.get(info.id), {
      partID: 'text-2',
      field: 'text',
      delta: ' world',
    });

    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'session-1',
            messageID: info.id,
            partID: 'text-2',
            field: 'text',
            delta: ' world',
          },
        } as never,
      },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry-update',
      entry: {
        id: 'msg-2:text-2',
        type: 'assistant-message',
        value: 'Hello world',
      },
    });
  });

  it('maps session.compacted to compacting system status', () => {
    const ctx = createContext();

    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'session.compacted',
          properties: {},
        } as never,
      },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        type: 'system-status',
        status: 'compacting',
      },
    });
  });

  it('maps file.edited events to file-edited entries', () => {
    const ctx = createContext();

    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'file.edited',
          properties: {
            file: '/tmp/example.ts',
          },
        } as never,
      },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        type: 'file-edited',
        filePath: '/tmp/example.ts',
      },
    });
  });

  it('maps todo.updated events to todo-update entries', () => {
    const ctx = createContext();

    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          id: 'evt-todo-1',
          type: 'todo.updated',
          properties: {
            todos: [
              {
                content: 'First',
                description: 'First description',
                status: 'in_progress',
                priority: 'high',
              },
              { content: 'Second', status: 'pending', priority: 'medium' },
            ],
          },
        } as never,
      },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        id: 'evt-todo-1',
        type: 'todo-update',
        newTodos: [
          {
            content: 'First',
            description: 'First description',
            status: 'in_progress',
          },
          { content: 'Second', status: 'pending' },
        ],
      },
    });
  });

  it('links child session messages to parent sub-agent tool id', () => {
    const parentInfo = {
      ...createAssistantMessage('parent-msg'),
      sessionID: 'parent-session',
    } as AssistantMessage;
    const childInfo = {
      ...createAssistantMessage('child-msg'),
      sessionID: 'child-session',
    } as AssistantMessage;
    const ctx = createContext();
    const subtaskPart = {
      id: 'subtask-1',
      messageID: parentInfo.id,
      sessionID: 'child-session',
      type: 'subtask',
      prompt: 'Inspect code',
      description: 'Code inspector',
      agent: 'general',
    } as Part;
    const childTextPart = {
      id: 'child-text-1',
      messageID: childInfo.id,
      sessionID: 'child-session',
      type: 'text',
      text: 'Child answer',
    } as Part;

    normalizeOpenCodeV2(
      { kind: 'prompt-result', info: parentInfo, parts: [subtaskPart] },
      ctx,
    );
    const events = normalizeOpenCodeV2(
      { kind: 'prompt-result', info: childInfo, parts: [childTextPart] },
      ctx,
    );

    expect(events).toMatchObject([
      {
        type: 'entry',
        entry: {
          id: 'child-msg:child-text-1',
          parentToolId: 'subtask-1',
          type: 'assistant-message',
          value: 'Child answer',
        },
      },
    ]);
  });

  it('links fetched task child session messages from task tool metadata', () => {
    const parentInfo = {
      ...createAssistantMessage('parent-msg'),
      sessionID: 'parent-session',
    } as AssistantMessage;
    const childInfo = {
      ...createAssistantMessage('child-msg'),
      sessionID: 'child-session',
    } as AssistantMessage;
    const ctx = createContext();
    const taskPart = {
      id: 'task-part-1',
      messageID: parentInfo.id,
      sessionID: 'parent-session',
      type: 'tool',
      tool: 'task',
      callID: 'call-task-1',
      state: {
        status: 'completed',
        title: 'task',
        input: {
          description: 'Inspect code',
          subagent_type: 'explore',
          prompt: 'Inspect code',
        },
        output: '<task_result>Done</task_result>',
        time: { start: 1_717_000_000_000, end: 1_717_000_000_500 },
        metadata: { sessionId: 'child-session' },
      },
    } as Part;
    const childTextPart = {
      id: 'child-text-1',
      messageID: childInfo.id,
      sessionID: 'child-session',
      type: 'text',
      text: 'Child answer',
    } as Part;

    normalizeOpenCodeV2(
      { kind: 'prompt-result', info: parentInfo, parts: [taskPart] },
      ctx,
    );
    const events = normalizeOpenCodeV2(
      { kind: 'prompt-result', info: childInfo, parts: [childTextPart] },
      ctx,
    );

    expect(events).toMatchObject([
      {
        type: 'entry',
        entry: {
          id: 'child-msg:child-text-1',
          parentToolId: 'call-task-1',
          type: 'assistant-message',
          value: 'Child answer',
        },
      },
    ]);
  });

  it('links nested child subtask tools to the parent sub-agent tool id', () => {
    const parentInfo = {
      ...createAssistantMessage('parent-msg'),
      sessionID: 'parent-session',
    } as AssistantMessage;
    const childInfo = {
      ...createAssistantMessage('child-msg'),
      sessionID: 'child-session',
    } as AssistantMessage;
    const ctx = createContext();
    const parentSubtaskPart = {
      id: 'subtask-1',
      messageID: parentInfo.id,
      sessionID: 'child-session',
      type: 'subtask',
      prompt: 'Inspect code',
      description: 'Code inspector',
      agent: 'general',
    } as Part;
    const nestedSubtaskPart = {
      id: 'subtask-2',
      messageID: childInfo.id,
      sessionID: 'grandchild-session',
      type: 'subtask',
      prompt: 'Inspect nested code',
      description: 'Nested inspector',
      agent: 'general',
    } as Part;

    normalizeOpenCodeV2(
      { kind: 'prompt-result', info: parentInfo, parts: [parentSubtaskPart] },
      ctx,
    );
    const events = normalizeOpenCodeV2(
      { kind: 'prompt-result', info: childInfo, parts: [nestedSubtaskPart] },
      ctx,
    );

    expect(events).toMatchObject([
      {
        type: 'entry',
        entry: {
          id: 'child-msg:subtask-2',
          parentToolId: 'subtask-1',
          type: 'tool-use',
          toolId: 'subtask-2',
          name: 'sub-agent',
        },
      },
    ]);
  });

  it('uses unique fallback ids for repeated file.edited and todo.updated events', () => {
    const ctx = createContext();

    const fileEventsA = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'file.edited',
          properties: { file: '/tmp/example.ts' },
        } as never,
      },
      ctx,
    );
    if (fileEventsA[0]?.type === 'entry') {
      ctx.emittedEntryIds.add(fileEventsA[0].entry.id);
    }
    const fileEventsB = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'file.edited',
          properties: { file: '/tmp/example.ts' },
        } as never,
      },
      ctx,
    );

    expect((fileEventsA[0] as { entry: { id: string } }).entry.id).not.toBe(
      (fileEventsB[0] as { entry: { id: string } }).entry.id,
    );

    const todoEventsA = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'todo.updated',
          properties: { todos: [{ content: 'One', status: 'pending' }] },
        } as never,
      },
      ctx,
    );
    if (todoEventsA[0]?.type === 'entry') {
      ctx.emittedEntryIds.add(todoEventsA[0].entry.id);
    }
    const todoEventsB = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'todo.updated',
          properties: { todos: [{ content: 'Two', status: 'pending' }] },
        } as never,
      },
      ctx,
    );

    expect((todoEventsA[0] as { entry: { id: string } }).entry.id).not.toBe(
      (todoEventsB[0] as { entry: { id: string } }).entry.id,
    );
  });

  it('maps session.updated summary to session-summary entries', () => {
    const ctx = createContext();

    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'session.updated',
          properties: {
            info: {
              id: 'session-1',
              title: 'Session title',
              time: { created: 1_717_000_000_000, updated: 1_717_000_000_500 },
              summary: { additions: 3, deletions: 1, files: 2 },
            },
          },
        } as never,
      },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        type: 'session-summary',
        title: 'Session title',
        summary: {
          additions: 3,
          deletions: 1,
          files: 2,
        },
      },
    });
  });

  it('preserves all touched files for apply_patch tool entries', () => {
    const info = createAssistantMessage('msg-3');
    const ctx = createContext();

    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'message.updated',
          properties: {
            info,
          },
        } as never,
      },
      ctx,
    );
    expect(events).toEqual([]);

    ctx.rawMessages.set(info.id, info);
    ctx.rawParts.set(info.id, [
      {
        id: 'tool-1',
        messageID: info.id,
        sessionID: 'session-1',
        type: 'tool',
        tool: 'apply_patch',
        callID: 'call-1',
        state: {
          status: 'completed',
          input: {
            patchText: '*** Begin Patch\n*** End Patch',
          },
          output: 'ok',
          metadata: {
            files: [
              {
                filePath: '/tmp/a.ts',
                type: 'update',
                patch: '@@ -1 +1 @@\n-a\n+b',
                additions: 1,
                deletions: 1,
                before: 'a',
                after: 'b',
              },
              {
                filePath: '/tmp/b.ts',
                type: 'add',
                additions: 1,
                deletions: 0,
                after: 'c',
              },
            ],
          },
        },
      } as never,
    ]);

    const partEvents = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'message.part.updated',
          properties: {
            part: ctx.rawParts.get(info.id)?.[0],
          },
        } as never,
      },
      ctx,
    );

    expect(partEvents).toHaveLength(1);
    expect(partEvents[0]).toMatchObject({
      type: 'entry',
      entry: {
        type: 'tool-use',
        name: 'edit',
        input: {
          filePath: '/tmp/a.ts',
          files: [
            {
              filePath: '/tmp/a.ts',
              type: 'update',
              patch: '@@ -1 +1 @@\n-a\n+b',
              additions: 1,
              deletions: 1,
            },
            {
              filePath: '/tmp/b.ts',
              type: 'add',
              additions: 1,
              deletions: 0,
            },
          ],
        },
      },
    });
  });

  it('preserves system permission attribution across tool updates', () => {
    const info = createAssistantMessage('msg-permission-update');
    const ctx = createContext();
    const part = {
      id: 'tool-1',
      messageID: info.id,
      sessionID: 'session-1',
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: {
        status: 'running',
        input: { command: 'pnpm test' },
      },
    };
    ctx.rawMessages.set(info.id, info as Message);
    ctx.rawParts.set(info.id, [part as never]);
    ctx.pendingToolPermissionDecisions = [
      {
        allowedBy: 'system',
        tool: 'bash',
        matchValue: 'pnpm test',
        rule: { tool: 'bash', pattern: 'pnpm *' },
      },
    ];

    const runningEvents = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'message.part.updated',
          properties: { part: part as never },
        } as never,
      },
      ctx,
    );
    ctx.emittedEntryIds.add('msg-permission-update:tool-1');

    const completedPart = {
      ...part,
      state: {
        status: 'completed',
        input: { command: 'pnpm test' },
        output: 'ok',
      },
    };
    ctx.rawParts.set(info.id, [completedPart as never]);

    const completedEvents = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'message.part.updated',
          properties: { part: completedPart as never },
        } as never,
      },
      ctx,
    );

    expect(runningEvents[0]).toMatchObject({
      entry: {
        permission: {
          allowedBy: 'system',
          rule: { tool: 'bash', pattern: 'pnpm *' },
        },
      },
    });
    expect(completedEvents[0]).toMatchObject({
      type: 'entry-update',
      entry: {
        permission: {
          allowedBy: 'system',
          rule: { tool: 'bash', pattern: 'pnpm *' },
        },
      },
    });
  });

  it('marks OpenCode native auto-allows as system permissions', () => {
    const info = createAssistantMessage('msg-native-auto-allow');
    const ctx = createContext();
    ctx.permissionRules = [
      { tool: 'bash', pattern: 'pnpm *', action: 'allow' },
    ];
    const part = {
      id: 'tool-1',
      messageID: info.id,
      sessionID: 'session-1',
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: {
        status: 'running',
        input: { command: 'pnpm test' },
      },
    } as never;
    ctx.rawMessages.set(info.id, info as Message);
    ctx.rawParts.set(info.id, [part]);

    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'message.part.updated',
          properties: { part },
        } as never,
      },
      ctx,
    );

    expect(events[0]).toMatchObject({
      entry: {
        permission: {
          allowedBy: 'system',
          rule: { tool: 'bash', pattern: 'pnpm *' },
        },
      },
    });
  });

  it('emits synthetic skill content prompt when skill tool completes', () => {
    const info = createAssistantMessage('msg-skill');
    const ctx = createContext();
    ctx.rawMessages.set(info.id, info as Message);
    ctx.emittedEntryIds.add('msg-skill:tool-1');

    const part = {
      id: 'tool-1',
      messageID: info.id,
      sessionID: 'session-1',
      type: 'tool',
      tool: 'skill',
      callID: 'call-skill-1',
      state: {
        status: 'completed',
        input: { name: 'brainstorming' },
        output:
          '<skill_content name="brainstorming">\n# Skill\n</skill_content>',
        metadata: { name: 'brainstorming' },
        title: 'Loaded skill: brainstorming',
        time: {
          start: 1_717_000_000_000,
          end: 1_717_000_000_001,
        },
      },
    } as Part;
    ctx.rawParts.set(info.id, [part]);

    const events = normalizeOpenCodeV2(
      {
        kind: 'event',
        event: {
          type: 'message.part.updated',
          properties: { part },
        } as never,
      },
      ctx,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'entry-update',
      entry: {
        id: 'msg-skill:tool-1',
        type: 'tool-use',
        name: 'skill',
        skillName: 'brainstorming',
        result: {},
      },
    });
    expect(events[1]).toMatchObject({
      type: 'entry',
      entry: {
        id: 'msg-skill:tool-1:skill-content',
        type: 'user-prompt',
        value:
          '<skill_content name="brainstorming">\n# Skill\n</skill_content>',
        isSynthetic: true,
        parentToolId: 'call-skill-1',
      },
    });
  });
});
