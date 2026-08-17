import { beforeEach, describe, expect, it } from 'vitest';

import type { NormalizedEntry } from '@shared/normalized-message-v2';

import {
  getQuestionDraftKey,
  useTaskMessagesStore,
} from './task-messages';

describe('task messages store', () => {
  beforeEach(() => {
    useTaskMessagesStore.setState({
      steps: {},
      runCommandLogs: {},
      runCommandLogGenerations: {},
      runCommandRunning: {},
      questionDrafts: {},
      questionResponsesInFlight: {},
    });
  });

  it('keeps question drafts until explicitly cleared', () => {
    const store = useTaskMessagesStore.getState();

    store.updateQuestionDraft('task-1:request-1', (draft) => ({
      ...draft,
      answers: { choice: 'First option' },
    }));

    expect(
      useTaskMessagesStore.getState().questionDrafts['task-1:request-1'],
    ).toEqual({
      answers: { choice: 'First option' },
      otherAnswers: {},
      notes: {},
    });

    store.clearQuestionDraft(
      'task-1:request-1',
      useTaskMessagesStore.getState().questionDrafts['task-1:request-1'],
    );
    expect(
      useTaskMessagesStore.getState().questionDrafts['task-1:request-1'],
    ).toBeUndefined();
  });

  it('keeps one question request draft per task', () => {
    const store = useTaskMessagesStore.getState();

    store.updateQuestionDraft('task-1:request-1', (draft) => draft);
    store.updateQuestionDraft('task-1:request-2', (draft) => ({
      ...draft,
      answers: { choice: 'Second option' },
    }));

    expect(useTaskMessagesStore.getState().questionDrafts).toEqual({
      'task-1:request-2': {
        answers: { choice: 'Second option' },
        otherAnswers: {},
        notes: {},
      },
    });
  });

  it('prunes request drafts safely when task IDs contain colons', () => {
    const store = useTaskMessagesStore.getState();
    const firstKey = getQuestionDraftKey('task:one', 'request:1');
    const secondKey = getQuestionDraftKey('task:one', 'request:2');

    store.updateQuestionDraft(firstKey, (draft) => draft);
    store.updateQuestionDraft(secondKey, (draft) => draft);

    expect(Object.keys(useTaskMessagesStore.getState().questionDrafts)).toEqual([
      secondKey,
    ]);
  });

  it('clears question drafts when task status is interrupted', () => {
    useTaskMessagesStore.setState({
      steps: {
        'step-1': {
          taskId: 'task-1',
          messages: [],
          status: 'running',
          error: null,
          pendingPermission: null,
          pendingQuestion: null,
          queuedPrompts: [],
          lastAccessedAt: 0,
        },
      },
    });
    const store = useTaskMessagesStore.getState();
    store.updateQuestionDraft('task-1:request-1', (draft) => draft);

    store.setStatus('step-1', 'interrupted');

    expect(useTaskMessagesStore.getState().questionDrafts).toEqual({});
  });

  it('clears drafts for interrupted unloaded steps', () => {
    const store = useTaskMessagesStore.getState();
    store.updateQuestionDraft(getQuestionDraftKey('task-1', 'request-1'), (draft) => draft);

    store.setStatus('step-1', 'interrupted', null, 'task-1');

    expect(useTaskMessagesStore.getState().questionDrafts).toEqual({});
  });

  it('keeps run-command output without newline as pending line', () => {
    const store = useTaskMessagesStore.getState();

    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'building', 0);

    const log =
      useTaskMessagesStore.getState().runCommandLogs['task-1']['cmd-1'];

    expect(log.chunks).toEqual([]);
    expect(log.totalLineCount).toBe(0);
    expect(log.pendingLines.stdout).toMatchObject({
      stream: 'stdout',
      line: 'building',
    });
  });

  it('moves pending run-command output into chunks after newline', () => {
    const store = useTaskMessagesStore.getState();

    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'building', 0);
    store.appendRunCommandLogBatch(
      'task-1',
      'cmd-1',
      'stdout',
      ' done\nnext',
      0,
    );

    const log =
      useTaskMessagesStore.getState().runCommandLogs['task-1']['cmd-1'];

    expect(log.totalLineCount).toBe(1);
    expect(log.chunks).toHaveLength(1);
    expect(log.chunks[0].lines).toHaveLength(1);
    expect(log.chunks[0].lines[0]).toMatchObject({
      stream: 'stdout',
      line: 'building done',
    });
    expect(log.pendingLines.stdout).toMatchObject({ line: 'next' });
  });

  it('keeps pending run-command output separate by stream', () => {
    const store = useTaskMessagesStore.getState();

    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'out', 0);
    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stderr', 'err\n', 0);

    const log =
      useTaskMessagesStore.getState().runCommandLogs['task-1']['cmd-1'];

    expect(log.chunks[0].lines).toHaveLength(1);
    expect(log.chunks[0].lines[0]).toMatchObject({
      stream: 'stderr',
      line: 'err',
    });
    expect(log.pendingLines.stdout).toMatchObject({ line: 'out' });
    expect(log.pendingLines.stderr).toBeNull();
  });

  it('drops stale run-command log batches after reset', () => {
    const store = useTaskMessagesStore.getState();

    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'old', 0);
    const generation = store.resetRunCommandLogs('task-1', 'cmd-1');
    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'stale', 0);
    store.appendRunCommandLogBatch(
      'task-1',
      'cmd-1',
      'stdout',
      'new',
      generation,
    );

    const log =
      useTaskMessagesStore.getState().runCommandLogs['task-1']['cmd-1'];

    expect(generation).toBeGreaterThan(0);
    expect(log.pendingLines.stdout).toMatchObject({ line: 'new' });
  });

  it('applies authoritative reset generation and clears queued logs', () => {
    const store = useTaskMessagesStore.getState();

    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'old', 10);
    store.applyRunCommandLogsReset('task-1', 'cmd-1', 11);
    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'stale', 10);
    store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'new', 11);

    const log =
      useTaskMessagesStore.getState().runCommandLogs['task-1']['cmd-1'];

    expect(log.pendingLines.stdout).toMatchObject({ line: 'new' });
  });

  it('does not let delayed batches shorten refetched text entries', () => {
    const store = useTaskMessagesStore.getState();
    const olderEntry: NormalizedEntry = {
      id: 'msg-1',
      date: '2026-01-01T00:00:00.000Z',
      type: 'assistant-message',
      value: 'hello',
    };
    const refetchedEntry: NormalizedEntry = {
      ...olderEntry,
      value: 'hello world',
    };

    store.loadStep('step-1', 'task-1', [refetchedEntry], 'running');
    store.applyEntryBatch([
      { stepId: 'step-1', entry: olderEntry, mode: 'upsert' },
    ]);

    expect(useTaskMessagesStore.getState().steps['step-1'].messages).toEqual([
      refetchedEntry,
    ]);
  });

  it('does not let delayed batches remove refetched tool results', () => {
    const store = useTaskMessagesStore.getState();
    const pendingTool: NormalizedEntry = {
      id: 'tool-entry-1',
      date: '2026-01-01T00:00:00.000Z',
      type: 'tool-use',
      toolId: 'tool-1',
      name: 'read',
      input: { filePath: 'README.md' },
    };
    const completedTool: NormalizedEntry = {
      ...pendingTool,
      result: 'contents',
    };

    store.loadStep('step-1', 'task-1', [completedTool], 'running');
    store.applyEntryBatch([
      { stepId: 'step-1', entry: pendingTool, mode: 'append' },
    ]);

    expect(useTaskMessagesStore.getState().steps['step-1'].messages).toEqual([
      completedTool,
    ]);
  });

  it('initializes a missing step when setting status with task id', () => {
    const store = useTaskMessagesStore.getState();

    store.setStatus('step-1', 'errored', 'Failed to fetch messages', 'task-1');

    expect(useTaskMessagesStore.getState().steps['step-1']).toMatchObject({
      taskId: 'task-1',
      messages: [],
      status: 'errored',
      error: 'Failed to fetch messages',
      pendingPermission: null,
      pendingQuestion: null,
      queuedPrompts: [],
    });
  });
});
