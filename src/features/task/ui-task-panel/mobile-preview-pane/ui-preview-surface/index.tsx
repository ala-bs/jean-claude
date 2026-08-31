import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';
import {
  type CSSProperties,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type ScrcpyMediaStreamPacket,
  ScrcpyVideoCodecId,
} from '@yume-chan/scrcpy';
import { motion } from 'framer-motion';

import { containsH264Keyframe, createH264AccessUnitParser } from '../utils-h264';
import {
  GESTURE_FEEDBACK_FADE_MS,
  type GestureFeedbackStore,
} from '../gesture-feedback-store';
import {
  notifyH264FrameRendered,
  notifyImageFrameRendered,
  notifyRawRgbaFrameRendered,
} from '../utils-frame-readiness';
import { base64ToBytes } from '../utils-surface';
import { logMobilePreviewDebug } from '../utils-debug-log';
import type { MobilePreviewH264Chunk } from '@/hooks/use-mobile-preview';

export function buildGestureFeedbackPath(
  points: Array<{ x: number; y: number }>,
): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

export const GestureFeedbackOverlay = memo(function GestureFeedbackOverlay({
  store,
}: {
  store: GestureFeedbackStore;
}) {
  const feedback = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!feedback || feedback.points.length === 0) return null;

  const lastPoint = feedback.points.at(-1)!;
  const path = buildGestureFeedbackPath(feedback.points);

  return (
    <svg
      key={feedback.id}
      className="pointer-events-none absolute inset-0 z-20 size-full overflow-visible"
    >
      {feedback.points.length > 1 ? (
        <motion.path
          d={path}
          fill="none"
          stroke="var(--color-acc)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ opacity: 0.8 }}
          animate={{ opacity: feedback.released ? 0 : 0.8 }}
          transition={{ duration: GESTURE_FEEDBACK_FADE_MS / 1000 }}
          style={{ filter: 'drop-shadow(0 0 3px rgb(0 0 0 / 0.55))' }}
        />
      ) : null}
      <motion.circle
        cx={lastPoint.x}
        cy={lastPoint.y}
        r="7"
        fill="var(--color-acc)"
        stroke="rgb(255 255 255 / 0.9)"
        strokeWidth="2"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{
          opacity: feedback.released ? 0 : 0.95,
          scale: feedback.released ? 1.8 : 1,
        }}
        transition={{ duration: GESTURE_FEEDBACK_FADE_MS / 1000 }}
        style={{ transformOrigin: `${lastPoint.x}px ${lastPoint.y}px` }}
      />
    </svg>
  );
});

export function H264PreviewCanvas({
  sessionId,
  width,
  height,
  subscribeH264Chunks,
  onFpsChange,
  onFrameRendered,
  surfaceStyle,
}: {
  sessionId: string;
  width: number | null;
  height: number | null;
  subscribeH264Chunks: (
    listener: (chunk: MobilePreviewH264Chunk) => void,
  ) => () => void;
  onFpsChange: (fps: number) => void;
  onFrameRendered: (
    sessionId: string,
    source: 'image' | 'raw-rgba' | 'h264',
  ) => void;
  surfaceStyle?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<WebCodecsVideoDecoder | null>(null);
  const writerRef =
    useRef<WritableStreamDefaultWriter<ScrcpyMediaStreamPacket> | null>(null);
  const parserRef = useRef<ReturnType<typeof createH264AccessUnitParser>>(
    createH264AccessUnitParser(),
  );
  const chunksReceivedRef = useRef(0);
  const dataPacketsReceivedRef = useRef(0);
  const accessUnitsRef = useRef(0);
  const queuedDecodesRef = useRef(0);
  const decoderGenerationRef = useRef(0);
  const hasDecodedKeyframeRef = useRef(false);
  const lastStatsSampleRef = useRef({
    at: 0,
    received: 0,
    queued: 0,
    rendered: 0,
    skipped: 0,
  });
  const [decodeError, setDecodeError] = useState<string | null>(null);
  // Keyed by session rather than a counter so it needs no reset on session
  // change: a deferred reset would land after the synchronous replay of
  // buffered chunks and strand the "waiting" overlay over a live canvas.
  const [decodedSessionId, setDecodedSessionId] = useState<string | null>(null);
  const hasDecodedFrame = decodedSessionId === sessionId;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    parserRef.current = createH264AccessUnitParser();
    chunksReceivedRef.current = 0;
    dataPacketsReceivedRef.current = 0;
    accessUnitsRef.current = 0;
    queuedDecodesRef.current = 0;
    decoderGenerationRef.current += 1;
    hasDecodedKeyframeRef.current = false;
    lastStatsSampleRef.current = {
      at: performance.now(),
      received: 0,
      queued: 0,
      rendered: 0,
      skipped: 0,
    };
    queueMicrotask(() => {
      setDecodeError(null);
      onFpsChange(0);
    });

    if (!WebCodecsVideoDecoder.isSupported) {
      queueMicrotask(() => {
        setDecodeError(
          'WebCodecs VideoDecoder is not available in this renderer',
        );
      });
      return undefined;
    }

    let renderedFrameRequest: number | null = null;
    try {
      const renderer = WebGLVideoFrameRenderer.isSupported
        ? new WebGLVideoFrameRenderer(canvas)
        : new BitmapVideoFrameRenderer(canvas);
      const decoder = new WebCodecsVideoDecoder({
        codec: ScrcpyVideoCodecId.H264,
        renderer,
      });
      decoder.sizeChanged(({ width, height }) => {
        canvas.width = width;
        canvas.height = height;
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer h264 size sessionId=%s size=%dx%d',
          sessionId,
          width,
          height,
        );
      });
      decoderRef.current = decoder;
      writerRef.current = decoder.writable.getWriter();
      const observeRenderedFrame = () => {
        if (decoder.framesRendered > 0) {
          notifyH264FrameRendered(onFrameRendered, sessionId);
          return;
        }
        renderedFrameRequest = requestAnimationFrame(observeRenderedFrame);
      };
      renderedFrameRequest = requestAnimationFrame(observeRenderedFrame);
    } catch (error) {
      queueMicrotask(() => {
        setDecodeError(error instanceof Error ? error.message : String(error));
      });
    }

    return () => {
      if (renderedFrameRequest !== null) {
        cancelAnimationFrame(renderedFrameRequest);
      }
      decoderGenerationRef.current += 1;
      void writerRef.current?.close().catch(() => undefined);
      writerRef.current = null;
      decoderRef.current?.dispose();
      decoderRef.current = null;
    };
  }, [onFpsChange, onFrameRendered, sessionId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const decoder = decoderRef.current;
      const now = performance.now();
      const previous = lastStatsSampleRef.current;
      const seconds = Math.max((now - previous.at) / 1000, 0.001);
      const rendered = decoder?.framesRendered ?? 0;
      const skipped = decoder?.framesSkipped ?? 0;
      const received = dataPacketsReceivedRef.current;
      const queued = queuedDecodesRef.current;

      const renderedFps = Math.round((rendered - previous.rendered) / seconds);
      onFpsChange(renderedFps);
      lastStatsSampleRef.current = {
        at: now,
        received,
        queued,
        rendered,
        skipped,
      };
    }, 1000);

    return () => window.clearInterval(timer);
  }, [onFpsChange, sessionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !height) return;
    canvas.width = width;
    canvas.height = height;
  }, [height, width]);

  const writeH264Packet = useCallback(
    (packet: ScrcpyMediaStreamPacket) => {
      const writer = writerRef.current;
      if (!decoderRef.current || !writer) return;
      const decoderGeneration = decoderGenerationRef.current;
      if (packet.type === 'data') dataPacketsReceivedRef.current += 1;

      if (packet.type === 'configuration') {
        hasDecodedKeyframeRef.current = false;
      } else if (!hasDecodedKeyframeRef.current) {
        if (packet.keyframe === false) {
          return;
        }
        hasDecodedKeyframeRef.current = true;
      }

      void writer.write(packet).catch((error: unknown) => {
        if (
          writerRef.current !== writer ||
          decoderGenerationRef.current !== decoderGeneration
        ) {
          return;
        }
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer h264 decode throw sessionId=%s queued=%d type=%s bytes=%d error=%s',
          sessionId,
          queuedDecodesRef.current,
          packet.type,
          packet.data.length,
          error instanceof Error ? error.message : String(error),
        );
        setDecodeError(error instanceof Error ? error.message : String(error));
      });
      queuedDecodesRef.current += 1;
      if (packet.type === 'data') {
        setDecodedSessionId((current) =>
          current === sessionId ? current : sessionId,
        );
      }
    },
    [sessionId],
  );

  const processH264Chunk = useCallback(
    (nextChunk: MobilePreviewH264Chunk) => {
      const writer = writerRef.current;
      if (!decoderRef.current || !writer) return;

      chunksReceivedRef.current += 1;
      if (
        chunksReceivedRef.current === 1 ||
        chunksReceivedRef.current % 30 === 0
      ) {
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer h264 process chunk sessionId=%s chunks=%d base64Length=%d packetType=%s',
          sessionId,
          chunksReceivedRef.current,
          nextChunk.frameBase64.length,
          nextChunk.h264PacketType ?? 'raw',
        );
      }

      if (nextChunk.h264PacketType) {
        const data = base64ToBytes(nextChunk.frameBase64);
        const keyframe =
          nextChunk.h264PacketType === 'data'
            ? nextChunk.keyframe || containsH264Keyframe(data) || undefined
            : undefined;
        writeH264Packet({
          type: nextChunk.h264PacketType,
          keyframe,
          data,
        } as ScrcpyMediaStreamPacket);
        return;
      }

      const accessUnits = parserRef.current(
        base64ToBytes(nextChunk.frameBase64),
      );
      accessUnitsRef.current += accessUnits.length;
      if (accessUnits.length > 0 || chunksReceivedRef.current % 30 === 0) {
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer h264 parser sessionId=%s chunks=%d emitted=%d totalAccessUnits=%d framesRendered=%d framesSkipped=%d',
          sessionId,
          chunksReceivedRef.current,
          accessUnits.length,
          accessUnitsRef.current,
          decoderRef.current.framesRendered,
          decoderRef.current.framesSkipped,
        );
      }

      for (const accessUnit of accessUnits) {
        if (accessUnit.configuration) {
          writeH264Packet({
            type: 'configuration',
            data: accessUnit.configuration,
          });
        }
        writeH264Packet({
          type: 'data',
          keyframe: accessUnit.isKey,
          data: accessUnit.data,
        });
        if (
          queuedDecodesRef.current === 1 ||
          queuedDecodesRef.current % 30 === 0
        ) {
          logMobilePreviewDebug(
            'jc:mobile-preview:renderer h264 decode queued sessionId=%s queued=%d key=%s bytes=%d',
            sessionId,
            queuedDecodesRef.current,
            accessUnit.isKey,
            accessUnit.data.length,
          );
        }
      }
    },
    [sessionId, writeH264Packet],
  );

  useEffect(
    () => subscribeH264Chunks(processH264Chunk),
    [processH264Chunk, subscribeH264Chunks],
  );

  return (
    <div className="relative flex h-full items-center justify-center bg-zinc-950 p-4">
      <canvas
        ref={canvasRef}
        className="max-h-full max-w-full rounded-xl shadow-2xl select-none"
        style={surfaceStyle}
      />
      {hasDecodedFrame ? null : (
        <div className="bg-bg-0/80 text-ink-2 border-border/70 absolute rounded-xl border px-3 py-2 text-xs shadow-xl backdrop-blur">
          {decodeError
            ? `H264 decode failed: ${decodeError}`
            : 'Waiting for H264 frame...'}
        </div>
      )}
    </div>
  );
}

export function RawRgbaPreviewCanvas({
  sessionId,
  width,
  height,
  subscribeH264Chunks,
  onFrameRendered,
  surfaceStyle,
}: {
  sessionId: string;
  width: number;
  height: number;
  subscribeH264Chunks: (
    listener: (chunk: MobilePreviewH264Chunk) => void,
  ) => () => void;
  onFrameRendered: (
    sessionId: string,
    source: 'image' | 'raw-rgba' | 'h264',
  ) => void;
  surfaceStyle?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef(0);
  const [paintedSessionId, setPaintedSessionId] = useState<string | null>(null);
  const hasPaintedFrame = paintedSessionId === sessionId;

  const processRawFrame = useCallback(
    (chunk: MobilePreviewH264Chunk) => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return;

      const bytes = base64ToBytes(chunk.frameBase64);
      const expectedBytes = width * height * 4;
      if (bytes.length !== expectedBytes) {
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer raw frame size mismatch sessionId=%s bytes=%d expected=%d width=%d height=%d',
          sessionId,
          bytes.length,
          expectedBytes,
          width,
          height,
        );
        return;
      }

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      context.putImageData(
        new ImageData(new Uint8ClampedArray(bytes), width, height),
        0,
        0,
      );
      if (framesRef.current === 0) {
        notifyRawRgbaFrameRendered(onFrameRendered, sessionId);
      }
      framesRef.current += 1;
      if (framesRef.current === 1 || framesRef.current % 30 === 0) {
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer raw output sessionId=%s frames=%d canvas=%dx%d',
          sessionId,
          framesRef.current,
          canvas.width,
          canvas.height,
        );
      }
      // Track WHICH session has painted rather than a counter, so the state
      // needs no reset on session change. A deferred reset would land after
      // `subscribeH264Chunks` synchronously replays buffered chunks and would
      // strand the "waiting" overlay over a live canvas. The updater runs per
      // frame but React bails out once it settles, so no re-render at stream
      // rate.
      setPaintedSessionId((current) =>
        current === sessionId ? current : sessionId,
      );
    },
    [height, onFrameRendered, sessionId, width],
  );

  useEffect(() => {
    framesRef.current = 0;
  }, [sessionId]);

  useEffect(
    () => subscribeH264Chunks(processRawFrame),
    [processRawFrame, subscribeH264Chunks],
  );

  return (
    <div className="relative flex h-full items-center justify-center bg-zinc-950 p-4">
      <canvas
        ref={canvasRef}
        className="max-h-full max-w-full rounded-xl shadow-2xl select-none"
        style={surfaceStyle}
      />
      {hasPaintedFrame ? null : (
        <div className="bg-bg-0/80 text-ink-2 border-border/70 absolute rounded-xl border px-3 py-2 text-xs shadow-xl backdrop-blur">
          Waiting for raw frame...
        </div>
      )}
    </div>
  );
}

// Image (png/jpeg) streaming surface. Frames arrive through a ref-based
// subscription and are applied imperatively to `img.src`, so a new frame never
// re-renders React.
export const ImagePreviewSurface = memo(function ImagePreviewSurface({
  imgRef,
  sessionId,
  subscribeImageFrames,
  onFrameRendered,
  surfaceStyle,
}: {
  imgRef: RefObject<HTMLImageElement | null>;
  sessionId: string | null;
  subscribeImageFrames: (
    listener: (nextFrameUrl: string | null) => void,
  ) => () => void;
  onFrameRendered: (
    sessionId: string,
    source: 'image' | 'raw-rgba' | 'h264',
  ) => void;
  surfaceStyle?: CSSProperties;
}) {
  useEffect(
    () =>
      subscribeImageFrames((nextFrameUrl) => {
        const image = imgRef.current;
        if (!image) return;
        if (nextFrameUrl) {
          image.src = nextFrameUrl;
        } else {
          image.removeAttribute('src');
        }
      }),
    [imgRef, subscribeImageFrames],
  );

  const handleLoad = useCallback(() => {
    if (!sessionId) return;
    notifyImageFrameRendered(onFrameRendered, sessionId);
  }, [onFrameRendered, sessionId]);

  return (
    <img
      ref={imgRef}
      alt="Mobile preview"
      onLoad={handleLoad}
      draggable={false}
      className="max-h-full max-w-full rounded-xl shadow-2xl select-none"
      style={surfaceStyle}
    />
  );
});
