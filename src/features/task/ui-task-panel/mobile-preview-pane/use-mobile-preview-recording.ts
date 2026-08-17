import { type RefObject, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';

import type { createGestureFeedbackStore } from './gesture-feedback-store';

/**
 * Screen recording for the mobile preview surface.
 *
 * Captures the live preview <canvas>/<img> into an offscreen canvas at 30fps,
 * optionally overlaying gesture feedback, and saves the result as WebM.
 *
 * Extracted from MobilePreviewPane verbatim. Two behaviours are load-bearing
 * and must not be "modernised":
 *  - `stopRecording` stays a plain function (not useCallback) and the unmount
 *    effect keeps an empty dep array. It works because `recordingRef` and
 *    `setIsRecording` are stable; adding deps risks leaking the setInterval.
 *  - the interval must be cleared before `recorder.stop()`, otherwise `draw`
 *    can run against a stopped stream.
 */
export function useMobilePreviewRecording({
  containerRef,
  gestureFeedbackStore,
  showGestures,
  hasImageFrame,
  recordingFolder,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  gestureFeedbackStore: ReturnType<typeof createGestureFeedbackStore>;
  showGestures: boolean;
  hasImageFrame: boolean;
  recordingFolder?: string | null;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const recordingRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    timer: number;
    chunks: Blob[];
  } | null>(null);

  const stopRecording = () => {
    const recording = recordingRef.current;
    if (!recording) return;
    window.clearInterval(recording.timer);
    recording.recorder.stop();
    recordingRef.current = null;
    setIsRecording(false);
  };

  /**
   * Save a single PNG of the current preview surface.
   *
   * Uses the same source lookup as `startRecording` and the same output folder
   * setting; gesture overlays are deliberately not drawn.
   */
  const captureScreenshot = async () => {
    if (!hasImageFrame) return;
    const source = containerRef.current?.querySelector('canvas, img') as
      | HTMLCanvasElement
      | HTMLImageElement
      | null;
    if (!source) return;
    const sourceWidth =
      source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
    const sourceHeight =
      source instanceof HTMLCanvasElement
        ? source.height
        : source.naturalHeight;
    if (!sourceWidth || !sourceHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) return;
    const folder =
      recordingFolder ?? (await api.settings.get('mobilePreviewRecordingFolder'));
    const defaultPath = folder
      ? `${folder}/mobile-preview-${new Date().toISOString().replaceAll(':', '-')}.png`
      : undefined;
    await api.dialog.saveFile({
      defaultPath,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
      content: new Uint8Array(await blob.arrayBuffer()),
    });
  };

  const startRecording = () => {
    if (!hasImageFrame || isRecording) return;
    const source = containerRef.current?.querySelector('canvas, img') as
      | HTMLCanvasElement
      | HTMLImageElement
      | null;
    if (!source) return;
    const sourceWidth =
      source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
    const sourceHeight =
      source instanceof HTMLCanvasElement
        ? source.height
        : source.naturalHeight;
    const mimeType = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!sourceWidth || !sourceHeight || !mimeType) return;
    const canvas = document.createElement('canvas');
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    const draw = () => {
      context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
      const feedback = gestureFeedbackStore.get();
      if (!showGestures || !feedback?.points.length) return;
      const containerRect = containerRef.current?.getBoundingClientRect();
      const surfaceRect = source.getBoundingClientRect();
      if (!containerRect || !surfaceRect) return;
      const scaleX = sourceWidth / surfaceRect.width;
      const scaleY = sourceHeight / surfaceRect.height;
      context.strokeStyle = '#7dd3fc';
      context.lineWidth = 3 * scaleX;
      context.lineCap = 'round';
      context.beginPath();
      feedback.points.forEach((point, index) => {
        const x = (point.x + containerRect.left - surfaceRect.left) * scaleX;
        const y = (point.y + containerRect.top - surfaceRect.top) * scaleY;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    };
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      try {
        const folder =
          recordingFolder ??
          (await api.settings.get('mobilePreviewRecordingFolder'));
        const defaultPath = folder
          ? `${folder}/mobile-preview-${new Date().toISOString().replaceAll(':', '-')}.webm`
          : undefined;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        await api.dialog.saveFile({
          defaultPath,
          filters: [{ name: 'WebM video', extensions: ['webm'] }],
          content: new Uint8Array(await blob.arrayBuffer()),
        });
      } finally {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
    draw();
    recorder.start();
    const timer = window.setInterval(draw, 1000 / 30);
    recordingRef.current = { recorder, stream, timer, chunks };
    setIsRecording(true);
  };

  useEffect(() => stopRecording, []);

  return { isRecording, startRecording, stopRecording, captureScreenshot };
}
