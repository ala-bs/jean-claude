import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  appendAgentMemoryEventMock,
  browserWindowGetAllWindowsMock,
  debugAgentMock,
  settingsGetMock,
  warningSendMock,
} = vi.hoisted(() => ({
  appendAgentMemoryEventMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  debugAgentMock: vi.fn(),
  settingsGetMock: vi.fn(),
  warningSendMock: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: browserWindowGetAllWindowsMock },
}));

vi.mock('../database/repositories/settings', () => ({
  SettingsRepository: { get: settingsGetMock },
}));

vi.mock('./agent-memory-storage', () => ({
  appendAgentMemoryEvent: appendAgentMemoryEventMock,
}));

vi.mock('../lib/debug', () => ({
  dbg: { agent: debugAgentMock },
}));

import {
  AGENT_MEMORY_CAPTURE_WARNING_CHANNEL,
  captureAgentMemoryEvent,
  captureAgentMemoryEventSafe,
  captureAgentMemoryPromptSubmissionSafe,
  captureInitialTaskPromptSafe,
  latestAgentMemoryContextTail,
} from './agent-memory-capture-service';

const baseInput = {
  source: 'follow-up-prompt' as const,
  sourceId: 'follow-up-prompt:submission-1',
  projectId: 'project-1',
  taskId: 'task-1',
  stepId: 'step-1',
  text: 'Use token=secret-value and keep this',
  context: {
    previousAgentResult: 'Authorization: Bearer abc.def.ghi',
  },
  createdAt: '2026-07-18T12:00:00.000Z',
};

describe('agent memory capture service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsGetMock.mockResolvedValue({ enabled: true });
    appendAgentMemoryEventMock.mockResolvedValue({
      appended: true,
      filePath: '/memory/events.jsonl',
      fromOffset: 0,
      toOffset: 1,
    });
    browserWindowGetAllWindowsMock.mockReturnValue([]);
  });

  it('does not append when Agent Memory is disabled', async () => {
    settingsGetMock.mockResolvedValue({ enabled: false });

    await expect(captureAgentMemoryEvent(baseInput)).resolves.toEqual({
      appended: false,
      disabled: true,
    });

    expect(settingsGetMock).toHaveBeenCalledWith('agentMemory');
    expect(appendAgentMemoryEventMock).not.toHaveBeenCalled();
  });

  it('recursively redacts before append and derives a stable event id', async () => {
    await captureAgentMemoryEvent(baseInput);
    await captureAgentMemoryEvent(baseInput);

    expect(appendAgentMemoryEventMock).toHaveBeenCalledTimes(2);
    const firstEvent = appendAgentMemoryEventMock.mock.calls[0][0].event;
    const secondEvent = appendAgentMemoryEventMock.mock.calls[1][0].event;
    expect(firstEvent).toMatchObject({
      schemaVersion: 1,
      source: 'follow-up-prompt',
      sourceId: 'follow-up-prompt:submission-1',
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      text: 'Use token=[REDACTED:credential-assignment] and keep this',
      context: {
        previousAgentResult: 'Authorization: [REDACTED:bearer-token]',
      },
      createdAt: '2026-07-18T12:00:00.000Z',
    });
    expect(firstEvent.id).toBe(secondEvent.id);
    expect(firstEvent.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '$.text' }),
        expect.objectContaining({ path: '$.context.previousAgentResult' }),
      ]),
    );
  });

  it('returns storage duplicate suppression without changing source identity', async () => {
    appendAgentMemoryEventMock.mockResolvedValue({
      appended: false,
      filePath: '',
      fromOffset: 0,
      toOffset: 0,
    });

    await expect(captureAgentMemoryEvent(baseInput)).resolves.toEqual({
      appended: false,
      disabled: false,
    });
    expect(appendAgentMemoryEventMock.mock.calls[0][0].event.sourceId).toBe(
      baseInput.sourceId,
    );
  });

  it('keeps only latest 20,000 characters of context', () => {
    const value = `${'old'.repeat(4_000)}${'n'.repeat(20_000)}`;

    expect(latestAgentMemoryContextTail(value)).toBe('n'.repeat(20_000));
    expect(latestAgentMemoryContextTail(null)).toBeNull();
  });

  it.each([
    {
      name: 'Bearer token',
      value: `Bearer ${'bearer-secret-tail'.repeat(1_300)}`,
      marker: '[REDACTED:bearer-token]',
    },
    {
      name: 'credential assignment',
      value: `api_key=${'assignment-secret-tail'.repeat(1_100)}`,
      marker: 'api_key=[REDACTED:credential-assignment]',
    },
    {
      name: 'private key',
      value: `-----BEGIN PRIVATE KEY-----\n${'private-secret-tail'.repeat(1_200)}\n-----END PRIVATE KEY-----`,
      marker: '[REDACTED:private-key]',
    },
  ])(
    'redacts full previous-result $name before context tailing',
    async ({ value, marker }) => {
      await captureAgentMemoryPromptSubmissionSafe({
        source: 'follow-up-prompt',
        sourceId: `follow-up:${marker}`,
        projectId: 'project-1',
        taskId: 'task-1',
        stepId: 'step-1',
        userText: 'Continue',
        previousAgentResult: value,
      });

      const event = appendAgentMemoryEventMock.mock.calls[0][0].event;
      expect(event.context.previousAgentResult).toBe(marker);
      expect(JSON.stringify(event)).not.toContain('secret-tail');
    },
  );

  it.each(['previous-result', 'thread-context'] as const)(
    'defensively redacts a Bearer token exposed by the %s cutoff',
    async (contextKind) => {
      const cutoffExposedToken = `xBearer ${'s'.repeat(19_993)}`;
      if (contextKind === 'previous-result') {
        await captureAgentMemoryPromptSubmissionSafe({
          source: 'follow-up-prompt',
          sourceId: 'follow-up:cutoff-defense',
          projectId: 'project-1',
          taskId: 'task-1',
          stepId: 'step-1',
          userText: 'Continue',
          previousAgentResult: cutoffExposedToken,
        });
        expect(
          appendAgentMemoryEventMock.mock.calls[0][0].event.context
            .previousAgentResult,
        ).toBe('[REDACTED:bearer-token]');
      } else {
        await captureAgentMemoryEvent({
          source: 'pr-reply',
          sourceId: 'pr-reply:cutoff-defense',
          projectId: 'project-1',
          taskId: 'task-1',
          stepId: 'step-1',
          text: 'Reply',
          context: {
            pullRequestId: '42',
            filePath: null,
            lineStart: null,
            lineEnd: null,
            selectedLines: null,
            threadContext: cutoffExposedToken,
            threadId: 'thread-1',
          },
          createdAt: '2026-07-18T12:00:00.000Z',
        });
        expect(
          appendAgentMemoryEventMock.mock.calls[0][0].event.context
            .threadContext,
        ).toBe('[REDACTED:bearer-token]');
      }
      expect(
        JSON.stringify(appendAgentMemoryEventMock.mock.calls[0][0].event),
      ).not.toContain('ssssssss');
    },
  );

  it.each([
    {
      name: 'Bearer token',
      value: `Bearer ${'bearer-thread-secret'.repeat(1_300)}`,
      marker: '[REDACTED:bearer-token]',
    },
    {
      name: 'credential assignment',
      value: `secret=${'assignment-thread-secret'.repeat(1_100)}`,
      marker: 'secret=[REDACTED:credential-assignment]',
    },
    {
      name: 'private key',
      value: `-----BEGIN PRIVATE KEY-----\n${'private-thread-secret'.repeat(1_200)}\n-----END PRIVATE KEY-----`,
      marker: '[REDACTED:private-key]',
    },
  ])(
    'redacts full thread-context $name before context tailing',
    async ({ value, marker }) => {
      await captureAgentMemoryEvent({
        source: 'pr-comment',
        sourceId: `pr-comment:${marker}`,
        projectId: 'project-1',
        taskId: 'task-1',
        stepId: 'step-1',
        text: 'Review feedback',
        context: {
          pullRequestId: '42',
          filePath: null,
          lineStart: null,
          lineEnd: null,
          selectedLines: null,
          threadContext: value,
        },
        createdAt: '2026-07-18T12:00:00.000Z',
      });

      const event = appendAgentMemoryEventMock.mock.calls[0][0].event;
      expect(event.context.threadContext).toBe(marker);
      expect(JSON.stringify(event)).not.toContain('thread-secret');
    },
  );

  it('logs and emits a structured warning without rejecting', async () => {
    appendAgentMemoryEventMock.mockRejectedValue(new Error('disk full'));
    browserWindowGetAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: warningSendMock,
        },
      },
    ]);

    await expect(captureAgentMemoryEventSafe(baseInput)).resolves.toBeUndefined();

    expect(debugAgentMock).toHaveBeenCalledWith(
      expect.stringContaining('Agent Memory capture failed'),
      'follow-up-prompt',
      'project-1',
      'task-1',
      'step-1',
      expect.any(Error),
    );
    expect(warningSendMock).toHaveBeenCalledWith(
      AGENT_MEMORY_CAPTURE_WARNING_CHANNEL,
      {
        source: 'follow-up-prompt',
        projectId: 'project-1',
        taskId: 'task-1',
        stepId: 'step-1',
        message: 'disk full',
      },
    );
  });

  it('still resolves when renderer warning delivery fails', async () => {
    appendAgentMemoryEventMock.mockRejectedValue(new Error('disk full'));
    warningSendMock.mockImplementation(() => {
      throw new Error('window closed');
    });
    browserWindowGetAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: warningSendMock,
        },
      },
    ]);

    await expect(captureAgentMemoryEventSafe(baseInput)).resolves.toBeUndefined();
  });

  it('captures prompt and review evidence separately without generated artifacts', async () => {
    await captureAgentMemoryPromptSubmissionSafe({
      source: 'queued-prompt',
      sourceId: 'queued-prompt:queue-1',
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      userText:
        'Fix naming\n\n<attached_files>\n  <file name="secret.txt" path="/tmp/secret.txt" />\n</attached_files>\n\n<user_review><comment>generated</comment></user_review>',
      previousAgentResult: 'prior',
      reviews: [
        {
          commentId: 'rc-stable',
          body: 'Use a clearer name',
          selectedText: 'const x = 1',
          filePath: 'src/name.ts',
          lineStart: 4,
          lineEnd: 4,
          presets: ['rename'],
        },
      ],
      createdAt: '2026-07-18T12:00:00.000Z',
    });

    expect(appendAgentMemoryEventMock).toHaveBeenCalledTimes(2);
    expect(appendAgentMemoryEventMock.mock.calls[0][0].event).toMatchObject({
      source: 'queued-prompt',
      sourceId: 'queued-prompt:queue-1',
      text: 'Fix naming',
    });
    expect(appendAgentMemoryEventMock.mock.calls[1][0].event).toMatchObject({
      source: 'task-review',
      sourceId: 'task-review:rc-stable',
      text: 'Use a clearer name',
      context: {
        selectedText: 'const x = 1',
        filePath: 'src/name.ts',
        lineStart: 4,
        lineEnd: 4,
        presets: ['rename'],
      },
    });
  });

  it('turns preset-only reviews into meaningful user evidence', async () => {
    await captureAgentMemoryPromptSubmissionSafe({
      source: 'follow-up-prompt',
      sourceId: 'follow-up:preset-only',
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      userText: 'Apply review',
      previousAgentResult: null,
      reviews: [
        {
          commentId: 'preset-only',
          body: '',
          selectedText: 'const value = complicated();',
          filePath: 'src/value.ts',
          lineStart: 1,
          lineEnd: 1,
          presets: ['simplify', 'tests'],
        },
      ],
    });

    expect(appendAgentMemoryEventMock.mock.calls[1][0].event.text).toBe(
      'Simplify this code and add tests.',
    );
  });

  it('does not append task-review events when final queued metadata has no reviews', async () => {
    await captureAgentMemoryPromptSubmissionSafe({
      source: 'queued-prompt',
      sourceId: 'queued-prompt:edited-no-reviews',
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      userText: 'Final queued text',
      previousAgentResult: 'prior',
      reviews: [],
      createdAt: '2026-07-18T12:00:00.000Z',
    });

    const events = appendAgentMemoryEventMock.mock.calls.map(
      ([input]) => input.event,
    );
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('queued-prompt');
    expect(events.some((event) => event.source === 'task-review')).toBe(false);
  });

  it('uses stable initial-task source identity and strips attachment metadata', async () => {
    await captureInitialTaskPromptSafe({
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      userText:
        'Original request\n\n<attached_files>\n<file name="a" path="b" />\n</attached_files>',
      createdAt: '2026-07-18T12:00:00.000Z',
    });

    expect(appendAgentMemoryEventMock.mock.calls[0][0].event).toMatchObject({
      source: 'initial-task-prompt',
      sourceId: 'task:task-1:initial-prompt',
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      text: 'Original request',
      context: null,
    });
  });

  it('captures initial composer file comments separately with stable identities', async () => {
    await captureInitialTaskPromptSafe({
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      userText: 'Implement feature',
      reviews: [
        {
          commentId: 'cfc-stable',
          body: 'Preserve this branch',
          selectedText: 'if (ready) return;',
          filePath: 'src/app.ts',
          lineStart: 8,
          lineEnd: 8,
          presets: [],
        },
      ],
      createdAt: '2026-07-18T12:00:00.000Z',
    });

    const events = appendAgentMemoryEventMock.mock.calls.map(([input]) => input.event);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      source: 'task-review',
      sourceId: 'task-review:cfc-stable',
      text: 'Preserve this branch',
      context: {
        filePath: 'src/app.ts',
        lineStart: 8,
        lineEnd: 8,
      },
    });
  });
});
