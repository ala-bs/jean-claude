import { describe, expect, it } from 'vitest';

import {
  getDefaultInteractionMode,
  renormalizeDraftInteractionMode,
} from './default-interaction-mode';

describe('getDefaultInteractionMode', () => {
  it('returns auto when the project opts into auto-accept on task creation', () => {
    expect(
      getDefaultInteractionMode({
        project: { autoAcceptOnTaskCreation: true },
      }),
    ).toBe('auto');
  });

  it('returns ask when the project does not opt in', () => {
    expect(
      getDefaultInteractionMode({
        project: { autoAcceptOnTaskCreation: false },
      }),
    ).toBe('ask');
  });

  it('returns ask while the project is still loading', () => {
    expect(getDefaultInteractionMode({ project: undefined })).toBe('ask');
    expect(getDefaultInteractionMode({ project: null })).toBe('ask');
  });
});

describe('renormalizeDraftInteractionMode', () => {
  // The regression this guards: writing the *resolved* default back into the
  // draft on an unrelated change (backend switch, preset apply, rate-limit
  // swap) would pin it, and later flipping the project setting would then be
  // ignored for that draft forever.
  it('keeps the draft unset when the user has not picked a mode', () => {
    expect(
      renormalizeDraftInteractionMode({
        draftMode: undefined,
        backend: 'claude-code',
      }),
    ).toBeUndefined();

    expect(
      renormalizeDraftInteractionMode({
        draftMode: null,
        backend: 'claude-code',
      }),
    ).toBeUndefined();
  });

  it('preserves an explicit mode the backend supports', () => {
    expect(
      renormalizeDraftInteractionMode({
        draftMode: 'auto',
        backend: 'claude-code',
      }),
    ).toBe('auto');
  });

  it('passes an explicit mode through untouched when no backend is known', () => {
    expect(
      renormalizeDraftInteractionMode({ draftMode: 'plan', backend: null }),
    ).toBe('plan');
  });
});
