import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  type WheelEvent,
} from 'react';

import {
  canStartPointerInteraction,
  createWheelGestureFeedback,
  getNextGestureFeedbackId,
  getPasteInputs,
  getPointerDownInput,
  getPointerMoveInputs,
  getPointerUpInput,
  isPointWithinSurfaceBounds,
  matchesActivePointer,
  restartGestureFeedbackTimer,
} from './utils-input';
import { clamp, getSurfaceIntrinsicSize } from './utils-surface';
import {
  mapRotatedSurfacePoint,
  normalizeRotationDegrees,
} from './utils-rotation';
import type {
  MobilePlatform,
  MobilePreviewSession,
  MobileRotationDirection,
} from '@shared/mobile-simulator-types';
import { formatError } from './utils-preview-error';
import { GESTURE_FEEDBACK_FADE_MS } from './gesture-feedback-store';
import type { GestureFeedbackStore } from './gesture-feedback-store';
import type { MobilePreviewInputEvent } from '@shared/mobile-simulator-types';
import { resolveDeviceSize } from './utils-device-setup';

const SWIPE_THRESHOLD_PX = 8;
const LONG_PRESS_THRESHOLD_MS = 500;
const WHEEL_SWIPE_DURATION_MS = 180;
const WHEEL_INPUT_THROTTLE_MS = 120;
const WHEEL_SWIPE_MIN_DISTANCE_PX = 40;
const WHEEL_SWIPE_MAX_DISTANCE_PX = 320;
const TOUCH_MOVE_THROTTLE_MS = 16;
const POINTER_EDGE_SLOP_PX = 24;

/**
 * All pointer / wheel / keyboard input handling for the preview surface.
 * Extracted from the pane so the mapping + gesture logic lives in one place.
 */
export function useMobilePreviewInput({
  containerRef,
  imgRef,
  gestureFeedbackStore,
  isRunning,
  session,
  platform,
  previewRotationDeg,
  showGestures,
  sendInput,
  rotate,
  setInputNotice,
  setPreviewRotationDeg,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  imgRef: RefObject<HTMLImageElement | null>;
  gestureFeedbackStore: GestureFeedbackStore;
  isRunning: boolean;
  session: MobilePreviewSession | null;
  platform: MobilePlatform;
  previewRotationDeg: number;
  showGestures: boolean;
  sendInput: (event: MobilePreviewInputEvent) => Promise<unknown>;
  rotate: (direction: MobileRotationDirection) => Promise<unknown>;
  setInputNotice: (notice: string | null) => void;
  setPreviewRotationDeg: (
    update: number | ((current: number) => number),
  ) => void;
}) {
  const pointerStartRef = useRef<{
    pointerId: number;
    pointerType: string;
    clientX: number;
    clientY: number;
    imageX: number;
    imageY: number;
    currentImageX: number;
    currentImageY: number;
    lastMoveSentAt: number;
    startedAt: number;
    didSendTouchDown: boolean;
  } | null>(null);
  const lastWheelInputAtRef = useRef(0);
  const gestureFeedbackIdRef = useRef(0);
  const gestureFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const mapClientPointToImage = useCallback(
    (
      clientX: number,
      clientY: number,
      options: {
        clampToBounds?: boolean;
        allowOutsideBounds?: boolean;
        edgeSlopPx?: number;
      } = {},
    ) => {
      const image = imgRef.current;
      const canvas = containerRef.current?.querySelector('canvas') ?? null;
      const surface = image ?? canvas;
      if (!surface) return null;

      const rect = surface.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const slop = options.clampToBounds
        ? (options.edgeSlopPx ?? POINTER_EDGE_SLOP_PX)
        : 0;
      if (
        !options.allowOutsideBounds &&
        !isPointWithinSurfaceBounds({
          x: clientX,
          y: clientY,
          surface: rect,
          slop,
        })
      ) {
        return null;
      }

      const { width: naturalWidth, height: naturalHeight } = resolveDeviceSize({
        surface: getSurfaceIntrinsicSize(surface),
        sessionWidth: session?.width ?? null,
        sessionHeight: session?.height ?? null,
        fallback: { width: rect.width, height: rect.height },
      });

      const x = options.clampToBounds
        ? clamp(clientX, rect.left, rect.right)
        : clientX;
      const y = options.clampToBounds
        ? clamp(clientY, rect.top, rect.bottom)
        : clientY;
      const rotation = normalizeRotationDegrees(previewRotationDeg);
      const displayWidth =
        rotation === 90 || rotation === 270 ? naturalHeight : naturalWidth;
      const displayHeight =
        rotation === 90 || rotation === 270 ? naturalWidth : naturalHeight;
      const rawPoint = {
        x: (x - rect.left) * (displayWidth / rect.width),
        y: (y - rect.top) * (displayHeight / rect.height),
      };
      const point = mapRotatedSurfacePoint({
        ...rawPoint,
        width: naturalWidth,
        height: naturalHeight,
        rotationDegrees: previewRotationDeg,
      });

      return {
        x: clamp(Math.round(point.x), 0, naturalWidth - 1),
        y: clamp(Math.round(point.y), 0, naturalHeight - 1),
      };
    },
    [containerRef, imgRef, previewRotationDeg, session?.height, session?.width],
  );

  const sendInputSafe = useCallback(
    (event: Parameters<typeof sendInput>[0]) => {
      void sendInput(event)
        .then(() => setInputNotice(null))
        .catch((sendError) => {
          setInputNotice(formatError(sendError) ?? 'Input failed');
        });
    },
    [sendInput, setInputNotice],
  );

  const getGestureFeedbackPoint = useCallback((clientX: number, clientY: number) => {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const image = imgRef.current;
    const canvas = containerRef.current?.querySelector('canvas') ?? null;
    const surfaceRect = (image ?? canvas)?.getBoundingClientRect();
    if (!containerRect || !surfaceRect) return null;
    return {
      x:
        clamp(clientX, surfaceRect.left, surfaceRect.right) -
        containerRect.left,
      y:
        clamp(clientY, surfaceRect.top, surfaceRect.bottom) -
        containerRect.top,
    };
  }, [containerRef, imgRef]);

  const clearGestureFeedbackTimer = useCallback(() => {
    if (!gestureFeedbackTimerRef.current) return;
    clearTimeout(gestureFeedbackTimerRef.current);
    gestureFeedbackTimerRef.current = null;
  }, []);

  const beginGestureFeedback = useCallback(
    (clientX: number, clientY: number) => {
      if (!showGestures) return;
      const point = getGestureFeedbackPoint(clientX, clientY);
      if (!point) return;
      clearGestureFeedbackTimer();
      gestureFeedbackIdRef.current = getNextGestureFeedbackId(
        gestureFeedbackIdRef.current,
      );
      gestureFeedbackStore.set({
        id: gestureFeedbackIdRef.current,
        points: [point],
        released: false,
      });
    },
    [
      clearGestureFeedbackTimer,
      gestureFeedbackStore,
      getGestureFeedbackPoint,
      showGestures,
    ],
  );

  const extendGestureFeedback = useCallback(
    (clientX: number, clientY: number) => {
      if (!showGestures) return;
      const point = getGestureFeedbackPoint(clientX, clientY);
      if (!point) return;
      gestureFeedbackStore.set((current) => {
        if (!current || current.released) return current;
        const previous = current.points.at(-1);
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 2) {
          return current;
        }
        return { ...current, points: [...current.points.slice(-59), point] };
      });
    },
    [gestureFeedbackStore, getGestureFeedbackPoint, showGestures],
  );

  const releaseGestureFeedback = useCallback(() => {
    if (!showGestures) return;
    clearGestureFeedbackTimer();
    gestureFeedbackStore.set((current) =>
      current ? { ...current, released: true } : current,
    );
    gestureFeedbackTimerRef.current = setTimeout(() => {
      gestureFeedbackTimerRef.current = null;
      gestureFeedbackStore.set(null);
    }, GESTURE_FEEDBACK_FADE_MS);
  }, [clearGestureFeedbackTimer, gestureFeedbackStore, showGestures]);

  const showWheelGestureFeedback = useCallback(
    (startPoint: { x: number; y: number }, endPoint: { x: number; y: number }) => {
      if (!showGestures) return;
      const feedback = createWheelGestureFeedback({
        currentId: gestureFeedbackIdRef.current,
        startPoint,
        endPoint,
      });
      gestureFeedbackIdRef.current = feedback.id;
      gestureFeedbackStore.set(feedback);
      gestureFeedbackTimerRef.current = restartGestureFeedbackTimer({
        currentTimer: gestureFeedbackTimerRef.current,
        delayMs: GESTURE_FEEDBACK_FADE_MS,
        onExpire: () => {
          gestureFeedbackTimerRef.current = null;
          gestureFeedbackStore.set(null);
        },
      });
    },
    [gestureFeedbackStore, showGestures],
  );

  useEffect(() => {
    if (!showGestures) {
      clearGestureFeedbackTimer();
      queueMicrotask(() => gestureFeedbackStore.set(null));
    }
    return clearGestureFeedbackTimer;
  }, [clearGestureFeedbackTimer, gestureFeedbackStore, showGestures]);
  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        !canStartPointerInteraction({
          isPrimary: event.isPrimary,
          button: event.button,
          pointerType: event.pointerType,
          activePointerId: pointerStartRef.current?.pointerId ?? null,
        })
      ) {
        return;
      }
      containerRef.current?.focus();
      const point = mapClientPointToImage(event.clientX, event.clientY, {
        clampToBounds: session?.platform === 'ios',
      });
      if (!point) return;

      beginGestureFeedback(event.clientX, event.clientY);
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerStartRef.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        clientX: event.clientX,
        clientY: event.clientY,
        imageX: point.x,
        imageY: point.y,
        currentImageX: point.x,
        currentImageY: point.y,
        lastMoveSentAt: 0,
        startedAt: Date.now(),
        didSendTouchDown: false,
      };
      const downInput = getPointerDownInput({
        platform: session?.platform ?? platform,
        pointerType: event.pointerType,
        point,
      });
      if (downInput) {
        pointerStartRef.current.didSendTouchDown = true;
        sendInputSafe(downInput);
      }
    },
    [
      beginGestureFeedback,
      containerRef,
      mapClientPointToImage,
      platform,
      sendInputSafe,
      session?.platform,
    ],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const startPoint = pointerStartRef.current;
      if (!startPoint || startPoint.pointerId !== event.pointerId) {
        return;
      }

      const point = mapClientPointToImage(event.clientX, event.clientY, {
        clampToBounds: session?.platform === 'ios',
      });
      if (!point) return;

      extendGestureFeedback(event.clientX, event.clientY);
      startPoint.currentImageX = point.x;
      startPoint.currentImageY = point.y;

      if (
        (session?.platform !== 'ios' && session?.platform !== 'android') ||
        !startPoint.pointerType
      ) {
        return;
      }

      const distance = Math.hypot(
        event.clientX - startPoint.clientX,
        event.clientY - startPoint.clientY,
      );
      if (distance <= SWIPE_THRESHOLD_PX) return;

      const now = Date.now();
      if (now - startPoint.lastMoveSentAt < TOUCH_MOVE_THROTTLE_MS) return;

      startPoint.lastMoveSentAt = now;
      const inputs = getPointerMoveInputs({
        platform: session.platform,
        pointerType: startPoint.pointerType,
        startPoint: { x: startPoint.imageX, y: startPoint.imageY },
        point,
        didSendTouchDown: startPoint.didSendTouchDown,
      });
      if (inputs.some((input) => input.type === 'touchDown')) {
        startPoint.didSendTouchDown = true;
      }
      inputs.forEach(sendInputSafe);
    },
    [extendGestureFeedback, mapClientPointToImage, sendInputSafe, session],
  );

  const finishPointerInteraction = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const startPoint = pointerStartRef.current;
      if (!startPoint || startPoint.pointerId !== pointerId) return;
      pointerStartRef.current = null;
      extendGestureFeedback(clientX, clientY);
      releaseGestureFeedback();

      const endPoint = mapClientPointToImage(clientX, clientY, {
        clampToBounds: session?.platform === 'ios',
      });

      if (startPoint.didSendTouchDown) {
        const upInput = getPointerUpInput({
          didSendTouchDown: true,
          point: {
            x: endPoint?.x ?? startPoint.currentImageX,
            y: endPoint?.y ?? startPoint.currentImageY,
          },
        });
        if (upInput) sendInputSafe(upInput);
        return;
      }

      if (session?.platform === 'ios') {
        const distance = Math.hypot(
          clientX - startPoint.clientX,
          clientY - startPoint.clientY,
        );
        const pressDurationMs = Date.now() - startPoint.startedAt;

        if (distance > SWIPE_THRESHOLD_PX && endPoint) {
          sendInputSafe({
            type: 'swipe',
            x1: startPoint.imageX,
            y1: startPoint.imageY,
            x2: endPoint.x,
            y2: endPoint.y,
            durationMs: Math.max(1, pressDurationMs),
          });
          return;
        }

        if (pressDurationMs >= LONG_PRESS_THRESHOLD_MS) {
          sendInputSafe({
            type: 'longPress',
            x: startPoint.imageX,
            y: startPoint.imageY,
            durationMs: pressDurationMs,
          });
          return;
        }

        sendInputSafe({ type: 'tap', x: startPoint.imageX, y: startPoint.imageY });
        return;
      }

      if (!endPoint) return;

      const distance = Math.hypot(
        clientX - startPoint.clientX,
        clientY - startPoint.clientY,
      );

      if (distance > SWIPE_THRESHOLD_PX) {
        sendInputSafe({
          type: 'swipe',
          x1: startPoint.imageX,
          y1: startPoint.imageY,
          x2: endPoint.x,
          y2: endPoint.y,
          durationMs: Math.max(1, Date.now() - startPoint.startedAt),
        });
        return;
      }

      const pressDurationMs = Date.now() - startPoint.startedAt;
      if (pressDurationMs >= LONG_PRESS_THRESHOLD_MS) {
        sendInputSafe({
          type: 'longPress',
          x: endPoint.x,
          y: endPoint.y,
          durationMs: pressDurationMs,
        });
        return;
      }

      sendInputSafe({ type: 'tap', x: endPoint.x, y: endPoint.y });
    },
    [
      extendGestureFeedback,
      mapClientPointToImage,
      releaseGestureFeedback,
      sendInputSafe,
      session?.platform,
    ],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      finishPointerInteraction(event.pointerId, event.clientX, event.clientY);
    },
    [finishPointerInteraction],
  );

  const handlePointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const startPoint = pointerStartRef.current;
    if (!matchesActivePointer(startPoint?.pointerId ?? null, event.pointerId)) {
      return;
    }
    pointerStartRef.current = null;
    releaseGestureFeedback();
    if (!startPoint || !startPoint.didSendTouchDown) {
      return;
    }

    sendInputSafe({
      type: 'touchUp',
      x: startPoint.currentImageX,
      y: startPoint.currentImageY,
    });
  }, [releaseGestureFeedback, sendInputSafe]);

  useEffect(() => {
    const handleDocumentPointerUp = (event: globalThis.PointerEvent) => {
      finishPointerInteraction(event.pointerId, event.clientX, event.clientY);
    };
    const handleDocumentPointerCancel = (event: globalThis.PointerEvent) => {
      const startPoint = pointerStartRef.current;
      if (
        !startPoint ||
        !matchesActivePointer(startPoint.pointerId, event.pointerId)
      ) {
        return;
      }
      pointerStartRef.current = null;
      releaseGestureFeedback();
      if (!startPoint.didSendTouchDown) return;

      sendInputSafe({
        type: 'touchUp',
        x: startPoint.currentImageX,
        y: startPoint.currentImageY,
      });
    };

    document.addEventListener('pointerup', handleDocumentPointerUp);
    document.addEventListener('pointercancel', handleDocumentPointerCancel);
    return () => {
      document.removeEventListener('pointerup', handleDocumentPointerUp);
      document.removeEventListener(
        'pointercancel',
        handleDocumentPointerCancel,
      );
    };
  }, [finishPointerInteraction, releaseGestureFeedback, sendInputSafe]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!isRunning) return;

      const now = Date.now();
      if (now - lastWheelInputAtRef.current < WHEEL_INPUT_THROTTLE_MS) return;

      const point = mapClientPointToImage(event.clientX, event.clientY, {
        clampToBounds: true,
        edgeSlopPx: 0,
      });
      if (!point) return;

      event.preventDefault();
      lastWheelInputAtRef.current = now;
      containerRef.current?.focus();

      const clientDistance = clamp(
        Math.abs(event.deltaY),
        WHEEL_SWIPE_MIN_DISTANCE_PX,
        WHEEL_SWIPE_MAX_DISTANCE_PX,
      );
      const direction = event.deltaY >= 0 ? -1 : 1;
      const endPoint = mapClientPointToImage(
        event.clientX,
        event.clientY + direction * clientDistance,
        { clampToBounds: true, allowOutsideBounds: true },
      );
      if (!endPoint) return;

      const feedbackStartPoint = getGestureFeedbackPoint(
        event.clientX,
        event.clientY,
      );
      const feedbackEndPoint = getGestureFeedbackPoint(
        event.clientX,
        event.clientY + direction * clientDistance,
      );
      if (feedbackStartPoint && feedbackEndPoint) {
        showWheelGestureFeedback(feedbackStartPoint, feedbackEndPoint);
      }

      sendInputSafe({
        type: 'swipe',
        x1: point.x,
        y1: point.y,
        x2: endPoint.x,
        y2: endPoint.y,
        durationMs: WHEEL_SWIPE_DURATION_MS,
      });
    },
    [
      containerRef,
      getGestureFeedbackPoint,
      isRunning,
      mapClientPointToImage,
      sendInputSafe,
      showWheelGestureFeedback,
    ],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!isRunning) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        sendInputSafe({
          type: 'key',
          key: session?.platform === 'ios' ? 'home' : 'back',
        });
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        sendInputSafe({ type: 'key', key: 'backspace' });
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        sendInputSafe({ type: 'key', key: 'enter' });
        return;
      }

      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        sendInputSafe({ type: 'text', text: event.key });
      }
    },
    [isRunning, sendInputSafe, session?.platform],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (!isRunning) return;
      event.preventDefault();

      const result = getPasteInputs({
        text: event.clipboardData.getData('text/plain'),
        platform: session?.platform,
      });
      if (!result.ok) {
        setInputNotice(result.reason);
        return;
      }
      // Sent sequentially rather than via sendInputSafe: that helper is
      // fire-and-forget, and pasted characters must reach the device in order.
      const { inputs } = result;
      void (async () => {
        try {
          for (const input of inputs) {
            await sendInput(input);
          }
          setInputNotice(null);
        } catch (pasteError) {
          setInputNotice(formatError(pasteError) ?? 'Paste failed');
        }
      })();
    },
    [isRunning, sendInput, session?.platform, setInputNotice],
  );

  const handleHomeButton = useCallback(() => {
    if (!isRunning) return;
    sendInputSafe({ type: 'key', key: 'home' });
  }, [isRunning, sendInputSafe]);

  const handleBackButton = useCallback(() => {
    if (!isRunning) return;

    if (session?.platform !== 'ios') {
      sendInputSafe({ type: 'key', key: 'back' });
      return;
    }

    const surfaceElement =
      imgRef.current ?? containerRef.current?.querySelector('canvas') ?? null;
    const surface = getSurfaceIntrinsicSize(surfaceElement);
    const { width, height } = resolveDeviceSize({
      surface,
      sessionWidth: session.width ?? null,
      sessionHeight: session.height ?? null,
      fallback: surface ?? { width: 0, height: 0 },
    });
    if (width <= 0 || height <= 0) return;

    const y = Math.round(height / 2);
    sendInputSafe({
      type: 'swipe',
      x1: 1,
      y1: y,
      x2: Math.round(width * 0.45),
      y2: y,
      durationMs: 220,
    });
  }, [containerRef, imgRef, isRunning, sendInputSafe, session]);

  const handleShowKeyboardButton = useCallback(() => {
    if (!isRunning) return;
    void sendInput({ type: 'showKeyboard' })
      .then(() => {
        setInputNotice(
          session?.platform === 'android'
            ? 'Android keyboard request sent. If it stays hidden, type directly in the preview.'
            : null,
        );
      })
      .catch((error) => {
        setInputNotice(formatError(error) ?? 'Keyboard request failed');
      });
  }, [isRunning, sendInput, session?.platform, setInputNotice]);

  const handleRotateButton = useCallback(
    (direction: MobileRotationDirection) => {
      if (!isRunning) return;
      void rotate(direction)
        .then(() => {
          setPreviewRotationDeg((current) =>
            normalizeRotationDegrees(
              current + (direction === 'right' ? 90 : -90),
            ),
          );
          setInputNotice(null);
        })
        .catch((error) => {
          setInputNotice(formatError(error) ?? 'Rotation failed');
        });
    },
    [isRunning, rotate, setInputNotice, setPreviewRotationDeg],
  );

  return {
    handleBackButton,
    handleHomeButton,
    handleKeyDown,
    handlePaste,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleRotateButton,
    handleShowKeyboardButton,
    handleWheel,
  };
}
