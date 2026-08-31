import { beforeEach, describe, expect, it } from 'vitest';

import type { NormalizedEntry } from '@shared/normalized-message-v2';
import type { RunStatus } from '@shared/run-command-types';

import {
  clearStepScrollPosition,
  DEFAULT_CACHE_LIMIT,
  getQuestionDraftKey,
  getStepScrollPosition,
  setStepScrollPosition,
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
      areRunCommandStatusesHydrated: false,
      backgroundTasksByStepId: {},
      backgroundTasksVersions: {},
    });
  });

  describe('setBackgroundTasks', () => {
    it('tracks live background jobs outside the step cache', () => {
      // No loadStep call: the indicator must work before messages load.
      useTaskMessagesStore
        .getState()
        .setBackgroundTasks('step-1', [
          { taskId: 'bg-1', description: 'Review: regressions' },
        ]);

      expect(
        useTaskMessagesStore.getState().backgroundTasksByStepId['step-1'],
      ).toEqual([{ taskId: 'bg-1', description: 'Review: regressions' }]);
    });

    it('drops the key on an empty snapshot', () => {
      const store = useTaskMessagesStore.getState();
      store.setBackgroundTasks('step-1', [{ taskId: 'bg-1' }]);
      store.setBackgroundTasks('step-1', []);

      expect(
        useTaskMessagesStore.getState().backgroundTasksByStepId,
      ).not.toHaveProperty('step-1');
    });

    it('keeps the array reference stable for an identical snapshot', () => {
      const store = useTaskMessagesStore.getState();
      store.setBackgroundTasks('step-1', [
        { taskId: 'bg-1', description: 'same' },
      ]);
      const first =
        useTaskMessagesStore.getState().backgroundTasksByStepId['step-1'];

      store.setBackgroundTasks('step-1', [
        { taskId: 'bg-1', description: 'same' },
      ]);

      expect(
        useTaskMessagesStore.getState().backgroundTasksByStepId['step-1'],
      ).toBe(first);
    });

    it('bumps the version even for a no-op snapshot so an in-flight fetch can detect it', () => {
      const store = useTaskMessagesStore.getState();
      // set-then-clear: the key round-trips back to `undefined`, so only the
      // version tells a racing hydration fetch that it lost.
      store.setBackgroundTasks('step-1', [{ taskId: 'bg-1' }]);
      const afterSet =
        useTaskMessagesStore.getState().backgroundTasksVersions['step-1'];
      store.setBackgroundTasks('step-1', []);
      const afterClear =
        useTaskMessagesStore.getState().backgroundTasksVersions['step-1'];
      // Identical repeat snapshot: still a newer event than any older fetch.
      store.setBackgroundTasks('step-1', []);

      expect(afterClear).toBeGreaterThan(afterSet ?? 0);
      expect(
        useTaskMessagesStore.getState().backgroundTasksVersions['step-1'],
      ).toBeGreaterThan(afterClear ?? 0);
    });

    it('applies a description that arrives after the task id is known', () => {
      const store = useTaskMessagesStore.getState();
      store.setBackgroundTasks('step-1', [{ taskId: 'bg-1' }]);
      store.setBackgroundTasks('step-1', [
        { taskId: 'bg-1', description: 'Review: regressions' },
      ]);

      expect(
        useTaskMessagesStore.getState().backgroundTasksByStepId['step-1'],
      ).toEqual([{ taskId: 'bg-1', description: 'Review: regressions' }]);
    });
  });

  it('keeps the scroll position across an unload/reload refetch', () => {
    const store = useTaskMessagesStore.getState();
    store.loadStep('step-1', 'task-1', [], 'completed');
    setStepScrollPosition('step-1', 320);

    store.unloadStep('step-1');
    store.loadStep('step-1', 'task-1', [], 'completed');

    expect(getStepScrollPosition('step-1')).toBe(320);

    clearStepScrollPosition('step-1');
    expect(getStepScrollPosition('step-1')).toBeUndefined();
  });

  it('drops scroll positions for steps evicted by the cache limit', () => {
    useTaskMessagesStore.setState({ cacheLimit: 2 });
    try {
      const store = useTaskMessagesStore.getState();

      store.loadStep('step-a', 'task-1', [], 'completed');
      setStepScrollPosition('step-a', 100);
      store.loadStep('step-b', 'task-1', [], 'completed');
      setStepScrollPosition('step-b', 200);
      store.loadStep('step-c', 'task-1', [], 'completed');
      setStepScrollPosition('step-c', 300);

      expect(useTaskMessagesStore.getState().steps['step-a']).toBeUndefined();
      expect(getStepScrollPosition('step-a')).toBeUndefined();
      expect(getStepScrollPosition('step-c')).toBe(300);
    } finally {
      clearStepScrollPosition('step-b');
      clearStepScrollPosition('step-c');
      useTaskMessagesStore.setState({ cacheLimit: DEFAULT_CACHE_LIMIT });
    }
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

  // Two steps of one task, step-a waiting on a question the user is answering.
  const seedTwoStepTask = () => {
    useTaskMessagesStore.setState({
      steps: {
        'step-a': {
          taskId: 'task-1',
          messages: [],
          status: 'waiting',
          error: null,
          pendingPermission: null,
          pendingQuestion: {
            taskId: 'task-1',
            requestId: 'request-a',
            questions: [],
          },
          queuedPrompts: [],
          lastAccessedAt: 0,
        },
        'step-b': {
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
    const siblingKey = getQuestionDraftKey('task-1', 'request-a');
    const store = useTaskMessagesStore.getState();
    store.updateQuestionDraft(siblingKey, (draft) => ({
      ...draft,
      answers: { choice: 'half-typed' },
    }));
    return { store, siblingKey };
  };

  const siblingAnswers = (key: string) =>
    useTaskMessagesStore.getState().questionDrafts[key]?.answers;

  it('keeps a sibling pending question draft when another step finishes', () => {
    const { store, siblingKey } = seedTwoStepTask();

    // A different step of the same task completes.
    store.setStatus('step-b', 'completed');

    expect(siblingAnswers(siblingKey)).toEqual({ choice: 'half-typed' });
    expect(
      useTaskMessagesStore.getState().steps['step-a']?.pendingQuestion,
    ).not.toBeNull();
  });

  it('keeps a sibling draft when a question arrives on another step', () => {
    const { store, siblingKey } = seedTwoStepTask();

    store.setQuestion('step-b', {
      taskId: 'task-1',
      requestId: 'request-b',
      questions: [],
    });

    expect(siblingAnswers(siblingKey)).toEqual({ choice: 'half-typed' });
  });

  it('keeps a sibling draft while typing into another step\'s banner', () => {
    const { store, siblingKey } = seedTwoStepTask();
    store.setQuestion('step-b', {
      taskId: 'task-1',
      requestId: 'request-b',
      questions: [],
    });
    const ownKey = getQuestionDraftKey('task-1', 'request-b');

    // Every keystroke in step-b's banner goes through updateQuestionDraft.
    store.updateQuestionDraft(ownKey, (draft) => ({
      ...draft,
      answers: { choice: 'typing here' },
    }));

    expect(siblingAnswers(siblingKey)).toEqual({ choice: 'half-typed' });
    expect(siblingAnswers(ownKey)).toEqual({ choice: 'typing here' });
  });

  it('still prunes stale drafts with no pending question on any step', () => {
    const { store, siblingKey } = seedTwoStepTask();
    const staleKey = getQuestionDraftKey('task-1', 'request-stale');
    store.updateQuestionDraft(staleKey, (draft) => ({
      ...draft,
      answers: { choice: 'abandoned' },
    }));

    store.setStatus('step-b', 'completed');

    expect(siblingAnswers(siblingKey)).toEqual({ choice: 'half-typed' });
    expect(useTaskMessagesStore.getState().questionDrafts[staleKey]).toBeUndefined();
  });

  it('keeps a sibling in-flight response lock when another step finishes', () => {
    const { store, siblingKey } = seedTwoStepTask();
    expect(store.tryStartQuestionResponse(siblingKey)).toBe(true);

    store.setStatus('step-b', 'completed');

    // The lock must survive, or step-a can double-submit mid-request.
    expect(
      useTaskMessagesStore.getState().questionResponsesInFlight[siblingKey],
    ).toBe(true);
  });

  it('lets sibling steps submit answers concurrently', () => {
    const { store, siblingKey } = seedTwoStepTask();
    const otherKey = getQuestionDraftKey('task-1', 'request-b');

    expect(store.tryStartQuestionResponse(siblingKey)).toBe(true);
    // Per-request lock: a sibling step is not blocked by step-a's submit.
    expect(store.tryStartQuestionResponse(otherKey)).toBe(true);
    // Same request twice is still blocked.
    expect(store.tryStartQuestionResponse(siblingKey)).toBe(false);
  });

  it('keeps a held in-flight lock when a new question replaces the request', () => {
    const { store, siblingKey } = seedTwoStepTask();
    expect(store.tryStartQuestionResponse(siblingKey)).toBe(true);

    // The response is still in flight when the next question arrives.
    store.setQuestion('step-a', {
      taskId: 'task-1',
      requestId: 'request-next',
      questions: [],
    });

    expect(
      useTaskMessagesStore.getState().questionResponsesInFlight[siblingKey],
    ).toBe(true);
  });

  it('hands the task pending-request slot to a sibling step still waiting', () => {
    seedTwoStepTask();
    const store = useTaskMessagesStore.getState();
    store.setPendingRequestForTask({
      taskId: 'task-1',
      stepId: 'step-a',
      request: {
        type: 'question',
        question: { taskId: 'task-1', requestId: 'request-a', questions: [] },
      },
    });

    // step-b going 'running' clears the task slot on every turn boundary.
    store.clearPendingRequestForTask({ taskId: 'task-1', stepId: 'step-b' });

    // step-a is still waiting on the user, so the task keeps its attention.
    expect(
      useTaskMessagesStore.getState().pendingRequestsByTaskId['task-1'],
    ).toMatchObject({
      type: 'question',
      question: { requestId: 'request-a' },
    });
  });

  it('drops the task pending-request slot when no step is waiting', () => {
    useTaskMessagesStore.setState({ steps: {} });
    const store = useTaskMessagesStore.getState();
    store.setPendingRequestForTask({
      taskId: 'task-1',
      request: {
        type: 'question',
        question: { taskId: 'task-1', requestId: 'request-a', questions: [] },
      },
    });

    store.clearPendingRequestForTask({ taskId: 'task-1' });

    expect(
      useTaskMessagesStore.getState().pendingRequestsByTaskId['task-1'],
    ).toBeUndefined();
  });

  it('bumps the owning step version even when that step is unloaded', () => {
    seedTwoStepTask();
    const before =
      useTaskMessagesStore.getState().pendingRequestVersions['step-a'] ?? 0;
    // Mid-refetch: step-a is briefly absent from `steps`.
    useTaskMessagesStore.getState().unloadStep('step-a');

    useTaskMessagesStore
      .getState()
      .clearPendingRequestForTask({ taskId: 'task-1', stepId: 'step-a' });

    // Must still invalidate, or a stale in-flight fetch resurrects a dead banner.
    expect(
      useTaskMessagesStore.getState().pendingRequestVersions['step-a'] ?? 0,
    ).toBeGreaterThan(before);
  });

  it('does not bump a sibling version when a task slot is cleared', () => {
    seedTwoStepTask();
    const before =
      useTaskMessagesStore.getState().pendingRequestVersions['step-a'] ?? 0;

    // Fires on EVERY sibling turn boundary via clearsTaskPendingRequest.
    useTaskMessagesStore
      .getState()
      .clearPendingRequestForTask({ taskId: 'task-1', stepId: 'step-b' });

    expect(
      useTaskMessagesStore.getState().pendingRequestVersions['step-a'] ?? 0,
    ).toBe(before);
  });

  it('scopes pending-request versions per step', () => {
    seedTwoStepTask();
    const before =
      useTaskMessagesStore.getState().pendingRequestVersions['step-a'] ?? 0;

    useTaskMessagesStore.getState().setStatus('step-b', 'completed');

    // A sibling status tick must not invalidate step-a's in-flight fetch.
    expect(
      useTaskMessagesStore.getState().pendingRequestVersions['step-a'] ?? 0,
    ).toBe(before);
    expect(
      useTaskMessagesStore.getState().pendingRequestVersions['step-b'] ?? 0,
    ).toBeGreaterThan(0);
  });

  it('clears drafts for interrupted unloaded steps', () => {
    const store = useTaskMessagesStore.getState();
    store.updateQuestionDraft(getQuestionDraftKey('task-1', 'request-1'), (draft) => draft);

    store.setStatus('step-1', 'interrupted', null, 'task-1');

    expect(useTaskMessagesStore.getState().questionDrafts).toEqual({});
  });

  it('tracks run-command status hydration explicitly', () => {
    expect(
      useTaskMessagesStore.getState().areRunCommandStatusesHydrated,
    ).toBe(false);

    useTaskMessagesStore.getState().setRunCommandStatusesHydrated(true);

    expect(
      useTaskMessagesStore.getState().areRunCommandStatusesHydrated,
    ).toBe(true);
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

  it('propagates run-command status updates when only effective ports change', () => {
    const store = useTaskMessagesStore.getState();
    const status = {
      isRunning: true,
      commands: [
        {
          id: 'mobile-dev-server:app',
          name: 'Metro',
          command: 'pnpm start',
          ports: [8081],
          status: 'running',
        },
      ],
    } satisfies RunStatus;

    store.setRunCommandRunning('task-1', status);
    store.setRunCommandRunning('task-1', {
      ...status,
      commands: [{ ...status.commands[0], ports: [8082] }],
    });

    expect(
      useTaskMessagesStore.getState().runCommandRunning['task-1'].commands[0]
        .ports,
    ).toEqual([8082]);
  });

  it('safely updates a legacy run-command status with missing ports', () => {
    const store = useTaskMessagesStore.getState();
    const command = {
      id: 'mobile-dev-server:legacy',
      name: 'Metro',
      command: 'pnpm start',
      status: 'running',
    } as RunStatus['commands'][number];

    store.setRunCommandRunning('task-1', {
      isRunning: true,
      commands: [command],
    });
    store.setRunCommandRunning('task-1', {
      isRunning: true,
      commands: [{ ...command, ports: [8082] }],
    });

    expect(
      useTaskMessagesStore.getState().runCommandRunning['task-1'].commands[0]
        .ports,
    ).toEqual([8082]);
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
