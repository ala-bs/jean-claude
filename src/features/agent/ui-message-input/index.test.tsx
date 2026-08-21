// @vitest-environment happy-dom

import { act, useCallback } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { PromptFilePart, PromptPart } from '@shared/agent-backend-types';
import { useTaskPrompt, useTaskPromptsStore } from '@/stores/task-prompts';

import { MessageInput } from '.';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      settings: { get: async () => null, getAll: async () => ({}) },
      projects: { getFeatureMap: async () => null },
    },
  });
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

const TASK_ID = 'task-1';

beforeEach(() => {
  useTaskPromptsStore.setState({ drafts: {} });
});

/** Mirrors TaskInputFooter's wiring of MessageInput to the real draft store. */
function Footer({
  onSend,
  isRunning = false,
  disabled = false,
}: {
  onSend: (parts: PromptPart[]) => Promise<void>;
  isRunning?: boolean;
  disabled?: boolean;
}) {
  const {
    text: promptDraft,
    files: promptDraftFiles,
    setDraft: setPromptDraft,
    setFiles: setPromptDraftFiles,
    clearDraft: clearPromptDraft,
  } = useTaskPrompt(TASK_ID);

  const handlePromptFilesChange = useCallback(
    (update: (prev: PromptFilePart[]) => PromptFilePart[]) =>
      setPromptDraftFiles(update, '/repo'),
    [setPromptDraftFiles],
  );

  const handleSend = useCallback(
    async (parts: PromptPart[]) => {
      // Simulates submitPrompt: awaits the IPC round trip, then runs the
      // success side effects (clearPromptDraft) exactly like onSuccess does.
      await onSend(parts);
      clearPromptDraft();
    },
    [onSend, clearPromptDraft],
  );

  return (
    <MessageInput
      onSend={handleSend}
      onQueue={handleSend}
      onStop={() => {}}
      isRunning={isRunning}
      disabled={disabled}
      value={promptDraft}
      onValueChange={setPromptDraft}
      files={promptDraftFiles}
      onFilesChange={handlePromptFilesChange}
      projectRoot="/repo"
    />
  );
}

function draftState() {
  return useTaskPromptsStore.getState().drafts[TASK_ID];
}

async function runScenario({
  label,
  isRunning = false,
  attachFile = true,
  typeDuringFlight = false,
  typeViaDom = false,
  /** Resolve/reject the send manually, simulating the real IPC lifecycle. */
  manual = false,
}: {
  label: string;
  isRunning?: boolean;
  attachFile?: boolean;
  typeDuringFlight?: boolean;
  typeViaDom?: boolean;
  manual?: boolean;
}) {
  useTaskPromptsStore.setState({ drafts: {} });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const sent: PromptPart[][] = [];
  let settle: {
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null = null;
  const onSend = async (parts: PromptPart[]) => {
    sent.push(parts);
    await new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
      if (!manual && !typeDuringFlight) setTimeout(resolve, 0);
    });
  };

  await act(async () => {
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Footer onSend={onSend} isRunning={isRunning} />
      </QueryClientProvider>,
    );
  });

  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

  if (typeViaDom) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'hello world');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  } else {
    await act(async () => {
      useTaskPromptsStore.getState().setDraft(TASK_ID, 'hello world');
    });
  }

  if (attachFile) {
    await act(async () => {
      useTaskPromptsStore
        .getState()
        .setFiles(
          TASK_ID,
          [{ type: 'file', filePath: '/tmp/a.txt', filename: 'a.txt' }],
          '/repo',
        );
    });
  }

  const beforeText = draftState()?.text;

  const button = Array.from(container.querySelectorAll('button')).find((b) => {
    const l = b.getAttribute('aria-label');
    return l === 'Send message' || l === 'Queue this message';
  });

  await act(async () => {
    button?.click();
  });

  if (typeDuringFlight) {
    await act(async () => {
      useTaskPromptsStore.getState().setDraft(TASK_ID, 'typed while in flight');
    });
    await act(async () => {
      settle?.resolve();
      await new Promise((r) => setTimeout(r, 5));
    });
  }

  const snapshot = () => ({
    draftText: draftState()?.text ?? '',
    draftFiles: draftState()?.files ?? [],
    domValue:
      (container.querySelector('textarea') as HTMLTextAreaElement)?.value ?? '',
    textareaDisabled:
      (container.querySelector('textarea') as HTMLTextAreaElement)?.disabled ??
      false,
  });

  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  // Composer state after the send settled — except in `manual` scenarios,
  // where the send is still pending and this captures what the user stares at
  // while the prompt is in flight.
  const whilePending = snapshot();

  const finish = async (mode: 'resolve' | 'reject') => {
    await act(async () => {
      if (mode === 'resolve') settle?.resolve();
      else settle?.reject(new Error('Agent run aborted'));
      await new Promise((r) => setTimeout(r, 10));
    });
    return snapshot();
  };

  const result = { label, beforeText, sentCount: sent.length, whilePending };

  const cleanup = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };

  return { ...result, finish, cleanup, snapshot };
}

describe('MessageInput controlled submit', () => {
  it('fully clears the composer after a successful async send', async () => {
    const r = await runScenario({ label: 'baseline text+file' });
    expect(r.sentCount).toBe(1);
    expect(r.whilePending.draftText).toBe('');
    expect(r.whilePending.draftFiles).toHaveLength(0);
    expect(r.whilePending.domValue).toBe('');
    await r.cleanup();
  });

  it('variant: typed through the real textarea DOM', async () => {
    const r = await runScenario({ label: 'dom-typed', typeViaDom: true });
    expect(r.beforeText).toBe('hello world');
    expect(r.whilePending.draftText).toBe('');
    await r.cleanup();
  });

  it('variant: queue path while running', async () => {
    const r = await runScenario({
      label: 'queue while running',
      isRunning: true,
    });
    expect(r.sentCount).toBe(1);
    expect(r.whilePending.draftText).toBe('');
    await r.cleanup();
  });

  /**
   * Documents a known, accepted limitation rather than a desired outcome:
   * `TaskInputFooter`'s `onSuccess` calls `clearPromptDraft()` unconditionally,
   * so text typed between hitting send and the send resolving is discarded.
   * The window is now milliseconds (the IPC settles on acceptance, not on turn
   * completion), which is why this is tolerable. If in-flight typing ever needs
   * to survive, fix it in `submitPrompt` -- the composer can't do it alone.
   */
  it('variant: user types while the send is in flight', async () => {
    const r = await runScenario({
      label: 'type during flight',
      typeDuringFlight: true,
    });
    expect(r.whilePending.draftText).toBe('');
    await r.cleanup();
  });

  /**
   * The composer intentionally holds its content while `onSend` is unsettled,
   * so the prompt survives a rejected submission. That makes it essential that
   * `onSend` settles on ACCEPTANCE — see the `waitForCompletion` test in
   * electron/services/pr-review-task-service.test.ts, which is what keeps this
   * pending window short instead of lasting the whole agent turn.
   */
  it('keeps the composer intact while the send is still unsettled', async () => {
    const r = await runScenario({ label: 'pending send', manual: true });
    expect(r.sentCount).toBe(1);
    expect(r.whilePending.draftText).toBe('hello world');
    await r.finish('resolve');
    await r.cleanup();
  });

  /**
   * The reason `handleSubmit` awaits `onSend` at all (commit c95ea18d): a
   * prompt rejected at acceptance time must stay in the box so the user can
   * retry it, rather than being silently destroyed.
   */
  it('preserves text and attachments when the send is rejected', async () => {
    const r = await runScenario({
      label: 'rejected send',
      manual: true,
      attachFile: true,
    });
    const after = await r.finish('reject');

    expect(after.draftText).toBe('hello world');
    expect(after.draftFiles).toHaveLength(1);
    expect(after.domValue).toBe('hello world');
    // Re-enabled so the retry is actually possible.
    expect(after.textareaDisabled).toBe(false);
    await r.cleanup();
  });
});
