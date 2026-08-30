import { describe, expect, it, vi } from 'vitest';

import {
  canStartPointerInteraction,
  createWheelGestureFeedback,
  getPasteInputs,
  getPointerDownInput,
  getPointerMoveInputs,
  getPointerUpInput,
  isPointWithinSurfaceBounds,
  matchesActivePointer,
  MAX_PASTE_LENGTH,
  restartGestureFeedbackTimer,
  shouldUseHidTouchLifecycle,
} from './utils-input';
import { buildGestureFeedbackPath } from '.';

describe('iOS pointer lifecycle', () => {
  it('accepts only primary left-button pointers while no pointer is active', () => {
    expect(
      canStartPointerInteraction({
        isPrimary: true,
        button: 0,
        pointerType: 'mouse',
        activePointerId: null,
      }),
    ).toBe(true);
    expect(
      canStartPointerInteraction({
        isPrimary: false,
        button: 0,
        pointerType: 'touch',
        activePointerId: null,
      }),
    ).toBe(false);
    expect(
      canStartPointerInteraction({
        isPrimary: true,
        button: 2,
        pointerType: 'pen',
        activePointerId: null,
      }),
    ).toBe(false);
    expect(
      canStartPointerInteraction({
        isPrimary: true,
        button: 0,
        pointerType: 'touch',
        activePointerId: 1,
      }),
    ).toBe(false);
  });

  it('ignores mismatched end events so accepted pointer keeps its lifecycle', () => {
    expect(matchesActivePointer(1, 2)).toBe(false);
    expect(matchesActivePointer(1, 1)).toBe(true);
    expect(matchesActivePointer(null, 1)).toBe(false);
  });

  it('uses HID lifecycle for supported direct pointer types', () => {
    expect(shouldUseHidTouchLifecycle('touch')).toBe(true);
    expect(shouldUseHidTouchLifecycle('mouse')).toBe(true);
    expect(shouldUseHidTouchLifecycle('pen')).toBe(true);
    expect(shouldUseHidTouchLifecycle('')).toBe(false);
  });

  it('sends immediate down then up for stationary tap or hold', () => {
    const point = { x: 12, y: 34 };
    expect([
      getPointerDownInput({ platform: 'ios', pointerType: 'mouse', point }),
      getPointerUpInput({ didSendTouchDown: true, point }),
    ]).toEqual([
      { type: 'touchDown', x: 12, y: 34 },
      { type: 'touchUp', x: 12, y: 34 },
    ]);
  });

  it('does not duplicate down when an iOS hold becomes a drag', () => {
    const down = getPointerDownInput({
      platform: 'ios',
      pointerType: 'touch',
      point: { x: 12, y: 34 },
    });
    const moves = getPointerMoveInputs({
        platform: 'ios',
        pointerType: 'touch',
        startPoint: { x: 12, y: 34 },
        point: { x: 30, y: 50 },
        didSendTouchDown: true,
      });
    const up = getPointerUpInput({
      didSendTouchDown: true,
      point: { x: 30, y: 50 },
    });

    expect([down, ...moves, up]).toEqual([
      { type: 'touchDown', x: 12, y: 34 },
      { type: 'touchMove', x: 30, y: 50 },
      { type: 'touchUp', x: 30, y: 50 },
    ]);
  });

  it('promotes an Android drag to one down before moves', () => {
    expect(
      getPointerMoveInputs({
        platform: 'android',
        pointerType: 'mouse',
        startPoint: { x: 12, y: 34 },
        point: { x: 30, y: 50 },
        didSendTouchDown: false,
      }),
    ).toEqual([
      { type: 'touchDown', x: 12, y: 34 },
      { type: 'touchMove', x: 30, y: 50 },
    ]);
  });
});

describe('buildGestureFeedbackPath', () => {
  it('builds a continuous SVG path through gesture points', () => {
    expect(
      buildGestureFeedbackPath([
        { x: 12, y: 34 },
        { x: 20, y: 40 },
        { x: 25, y: 50 },
      ]),
    ).toBe('M 12 34 L 20 40 L 25 50');
  });
});

describe('wheel gesture feedback', () => {
  it('requires wheel origin inside strict visible surface bounds', () => {
    const surface = { left: 10, right: 110, top: 20, bottom: 220 };

    expect(
      isPointWithinSurfaceBounds({ x: 10, y: 20, surface, slop: 0 }),
    ).toBe(true);
    expect(
      isPointWithinSurfaceBounds({ x: 9, y: 100, surface, slop: 0 }),
    ).toBe(false);
    expect(
      isPointWithinSurfaceBounds({ x: 9, y: 100, surface, slop: 24 }),
    ).toBe(true);
  });

  it('replaces feedback state with a new render key and path', () => {
    const first = createWheelGestureFeedback({
      currentId: 0,
      startPoint: { x: 10, y: 20 },
      endPoint: { x: 10, y: 80 },
    });
    const second = createWheelGestureFeedback({
      currentId: first.id,
      startPoint: { x: 30, y: 40 },
      endPoint: { x: 30, y: 100 },
    });

    expect(first).toEqual({
      id: 1,
      points: [{ x: 10, y: 20 }, { x: 10, y: 80 }],
      released: true,
    });
    expect(second.id).toBe(2);
    expect(second.points).toEqual([{ x: 30, y: 40 }, { x: 30, y: 100 }]);
  });

  it('cancels the previous expiry timer when repeated feedback restarts', () => {
    vi.useFakeTimers();
    const firstExpired = vi.fn();
    const secondExpired = vi.fn();
    const firstTimer = restartGestureFeedbackTimer({
      currentTimer: null,
      delayMs: 300,
      onExpire: firstExpired,
    });
    restartGestureFeedbackTimer({
      currentTimer: firstTimer,
      delayMs: 300,
      onExpire: secondExpired,
    });

    vi.advanceTimersByTime(300);

    expect(firstExpired).not.toHaveBeenCalled();
    expect(secondExpired).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe('getPasteInputs', () => {
  it('sends a single-line paste as one text event', () => {
    expect(getPasteInputs({ text: 'hello world', platform: 'ios' })).toEqual({
      ok: true,
      inputs: [{ type: 'text', text: 'hello world' }],
    });
  });

  it('splits lines into text events separated by enter key events', () => {
    expect(getPasteInputs({ text: 'a\nb', platform: 'android' })).toEqual({
      ok: true,
      inputs: [
        { type: 'text', text: 'a' },
        { type: 'key', key: 'enter' },
        { type: 'text', text: 'b' },
      ],
    });
  });

  it('never lets a newline ride along inside a text event', () => {
    const result = getPasteInputs({
      text: 'hello\npm uninstall com.example.app',
      platform: 'android',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const input of result.inputs) {
      if (input.type === 'text') expect(input.text).not.toContain('\n');
    }
  });

  it('normalizes CRLF and lone CR to a single break', () => {
    expect(getPasteInputs({ text: 'a\r\nb\rc', platform: 'ios' })).toEqual({
      ok: true,
      inputs: [
        { type: 'text', text: 'a' },
        { type: 'key', key: 'enter' },
        { type: 'text', text: 'b' },
        { type: 'key', key: 'enter' },
        { type: 'text', text: 'c' },
      ],
    });
  });

  it('preserves blank lines as bare enter key events', () => {
    expect(getPasteInputs({ text: 'a\n\nb', platform: 'ios' })).toEqual({
      ok: true,
      inputs: [
        { type: 'text', text: 'a' },
        { type: 'key', key: 'enter' },
        { type: 'key', key: 'enter' },
        { type: 'text', text: 'b' },
      ],
    });
  });

  it('strips control characters that no backend can type', () => {
    expect(getPasteInputs({ text: 'a\tbc', platform: 'ios' })).toEqual({
      ok: true,
      inputs: [{ type: 'text', text: 'abc' }],
    });
  });

  it('returns no inputs for empty or fully stripped clipboard text', () => {
    expect(getPasteInputs({ text: '', platform: 'ios' })).toEqual({
      ok: true,
      inputs: [],
    });
    expect(getPasteInputs({ text: '\u0000\u0007', platform: 'ios' })).toEqual({
      ok: true,
      inputs: [],
    });
  });

  it('rejects text longer than the cap instead of truncating it', () => {
    const result = getPasteInputs({
      text: 'x'.repeat(MAX_PASTE_LENGTH + 1),
      platform: 'ios',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('too long');
  });

  it('accepts text exactly at the cap', () => {
    expect(
      getPasteInputs({ text: 'x'.repeat(MAX_PASTE_LENGTH), platform: 'ios' }).ok,
    ).toBe(true);
  });

  it('rejects percent only on android, where input text treats %s specially', () => {
    expect(getPasteInputs({ text: '100% done', platform: 'android' }).ok).toBe(
      false,
    );
    expect(getPasteInputs({ text: '100% done', platform: 'ios' }).ok).toBe(true);
  });
});
