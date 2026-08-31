import type {
  MobilePlatform,
  MobilePreviewInputEvent,
} from '@shared/mobile-simulator-types';

type Point = { x: number; y: number };

export function isPointWithinSurfaceBounds({
  x,
  y,
  surface,
  slop,
}: {
  x: number;
  y: number;
  surface: { left: number; right: number; top: number; bottom: number };
  slop: number;
}): boolean {
  return (
    x >= surface.left - slop &&
    x <= surface.right + slop &&
    y >= surface.top - slop &&
    y <= surface.bottom + slop
  );
}

export function createWheelGestureFeedback({
  currentId,
  startPoint,
  endPoint,
}: {
  currentId: number;
  startPoint: Point;
  endPoint: Point;
}) {
  return {
    id: currentId + 1,
    points: [startPoint, endPoint],
    released: true,
  };
}

export function restartGestureFeedbackTimer({
  currentTimer,
  delayMs,
  onExpire,
}: {
  currentTimer: ReturnType<typeof setTimeout> | null;
  delayMs: number;
  onExpire: () => void;
}): ReturnType<typeof setTimeout> {
  if (currentTimer !== null) clearTimeout(currentTimer);
  return setTimeout(onExpire, delayMs);
}

export function canStartPointerInteraction({
  isPrimary,
  button,
  pointerType,
  activePointerId,
}: {
  isPrimary: boolean;
  button: number;
  pointerType: string;
  activePointerId: number | null;
}): boolean {
  return (
    isPrimary &&
    activePointerId === null &&
    button === 0 &&
    shouldUseHidTouchLifecycle(pointerType)
  );
}

export function matchesActivePointer(
  activePointerId: number | null,
  pointerId: number,
): boolean {
  return activePointerId !== null && activePointerId === pointerId;
}

export function shouldUseHidTouchLifecycle(pointerType: string): boolean {
  return (
    pointerType === 'mouse' || pointerType === 'pen' || pointerType === 'touch'
  );
}

export function getPointerDownInput({
  platform,
  pointerType,
  point,
}: {
  platform: MobilePlatform;
  pointerType: string;
  point: Point;
}): MobilePreviewInputEvent | null {
  if (platform !== 'ios' || !shouldUseHidTouchLifecycle(pointerType)) return null;
  return { type: 'touchDown', ...point };
}

export function getPointerMoveInputs({
  pointerType,
  startPoint,
  point,
  didSendTouchDown,
}: {
  platform: MobilePlatform;
  pointerType: string;
  startPoint: Point;
  point: Point;
  didSendTouchDown: boolean;
}): MobilePreviewInputEvent[] {
  if (!shouldUseHidTouchLifecycle(pointerType)) return [];
  return [
    ...(didSendTouchDown
      ? []
      : [{ type: 'touchDown' as const, ...startPoint }]),
    { type: 'touchMove', ...point },
  ];
}

export function getPointerUpInput({
  didSendTouchDown,
  point,
}: {
  didSendTouchDown: boolean;
  point: Point;
}): MobilePreviewInputEvent | null {
  return didSendTouchDown ? { type: 'touchUp', ...point } : null;
}

export function getNextGestureFeedbackId(currentId: number): number {
  return currentId + 1;
}

export const MAX_PASTE_LENGTH = 1000;

/**
 * Turns clipboard text into device input events.
 *
 * Newlines cannot ride along inside a `text` event: on Android `adb shell`
 * re-parses the payload as a shell command, and on iOS `\n` maps to Return
 * anyway. So lines are sent as separate `text` events with an explicit `enter`
 * key event between them. Other control characters are stripped because no
 * backend can type them.
 */
export function getPasteInputs({
  text: rawText,
  platform,
}: {
  text: string;
  platform: MobilePlatform | undefined;
}):
  | { ok: true; inputs: MobilePreviewInputEvent[] }
  | { ok: false; reason: string } {
  const normalized = rawText
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');

  if (normalized.length === 0) return { ok: true, inputs: [] };
  if (normalized.length > MAX_PASTE_LENGTH) {
    return {
      ok: false,
      reason: `Pasted text is too long (${normalized.length} characters, max ${MAX_PASTE_LENGTH}).`,
    };
  }
  if (platform === 'android' && normalized.includes('%')) {
    return {
      ok: false,
      reason:
        'Pasted text contains "%", which Android cannot type. Remove it and try again.',
    };
  }

  const inputs: MobilePreviewInputEvent[] = [];
  normalized.split('\n').forEach((line, index) => {
    if (index > 0) inputs.push({ type: 'key', key: 'enter' });
    if (line.length > 0) inputs.push({ type: 'text', text: line });
  });
  return { ok: true, inputs };
}
