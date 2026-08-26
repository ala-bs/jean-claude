import { randomUUID } from 'crypto';

import { BrowserWindow } from 'electron';

import { dbg } from '../lib/debug';

import type {
  GlobalPrompt,
  GlobalPromptResponse,
} from '@shared/global-prompt-types';

const pendingPrompts = new Map<
  string,
  (response: { accepted: boolean; inputValue?: string }) => void
>();

/**
 * Default ceiling for every prompt. A dialog nobody is waiting on any more is
 * worse than a missing one: it keeps an entry in `pendingPrompts` forever and
 * invites the user to type a secret that will be discarded.
 */
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

function dispatchPrompt(
  prompt: Omit<GlobalPrompt, 'id'>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ accepted: boolean; inputValue?: string }> {
  const id = randomUUID();
  const fullPrompt: GlobalPrompt = { ...prompt, id };

  return new Promise((resolve) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      // Nothing can answer this prompt. Resolving as rejected keeps callers
      // (e.g. a git push waiting on a passphrase) from hanging forever.
      resolve({ accepted: false });
      return;
    }

    if (options.signal?.aborted) {
      resolve({ accepted: false });
      return;
    }

    let timer: NodeJS.Timeout | undefined;

    /** Takes the dialog off screen and drops the entry, exactly once. */
    const withdraw = (reason: string) => {
      if (!pendingPrompts.has(id)) return;
      pendingPrompts.delete(id);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      dbg.ipc('globalPrompt %s withdrawn: %s', id, reason);
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('globalPrompt:dismiss', id);
      }
      resolve({ accepted: false });
    };

    function onAbort() {
      withdraw('caller aborted');
    }

    pendingPrompts.set(id, (response) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });

    timer = setTimeout(
      () => withdraw('timed out'),
      options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
    );
    timer.unref?.();

    // Lets a caller whose command already died pull its dialog back.
    options.signal?.addEventListener('abort', onAbort, { once: true });

    window.webContents.send('globalPrompt:show', fullPrompt);
  });
}

/** Shows a confirm/cancel prompt. Resolves to whether the user accepted. */
export async function sendGlobalPromptToWindow(
  prompt: Omit<GlobalPrompt, 'id' | 'inputType'>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const response = await dispatchPrompt(prompt, options);
  return response.accepted;
}

/**
 * Shows a prompt that collects a value, e.g. an SSH passphrase.
 *
 * Split from `sendGlobalPromptToWindow` rather than overloaded: an overload set
 * whose first signature also matches an input-carrying prompt makes the second
 * signature unreachable, so callers silently got `boolean` back and lost the
 * value they asked for.
 */
export function sendGlobalInputPrompt(
  prompt: Omit<GlobalPrompt, 'id' | 'inputType'> & {
    inputType: 'text' | 'password';
  },
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ accepted: boolean; inputValue?: string }> {
  return dispatchPrompt(prompt, options);
}

export function handlePromptResponse(response: GlobalPromptResponse): void {
  const resolve = pendingPrompts.get(response.id);
  if (resolve) {
    pendingPrompts.delete(response.id);
    resolve({ accepted: response.accepted, inputValue: response.inputValue });
  }
}
