import { Film, Loader2, Pause, Play, X } from 'lucide-react';
import {
  type PointerEvent,
  startTransition,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import FocusLock from 'react-focus-lock';

import { Button } from '@/common/ui/button';
import { createGifEncoderWorkerClient } from '@/features/common/ui-video-gif-converter/gif-encoder-worker-client';
import { formatBytes } from '@/lib/format-bytes';
import type { PromptImagePart } from '@shared/agent-backend-types';

export const MAX_VIDEO_SIZE = 80 * 1024 * 1024;
const DEFAULT_FPS = 24;
const DEFAULT_SCALE = 0.5;
const DEFAULT_QUALITY = 128;
const DEFAULT_SPEED = 1;
const SEEK_TIMEOUT_MS = 8_000;
const MAX_FRAME_COUNT = 360;
const MAX_OUTPUT_DIMENSION = 1280;
const MAX_PIXELS_PER_FRAME = 1_000_000;
const MAX_TOTAL_PROCESSED_PIXELS = 150_000_000;
const DEFAULT_FILMSTRIP_FRAME_COUNT = 12;
const FILMSTRIP_HEIGHT_PX = 64;
export const MAX_FILMSTRIP_FRAME_COUNT = 24;
export const MAX_FILMSTRIP_CANVAS_WIDTH = 512;
export const MAX_FILMSTRIP_CANVAS_HEIGHT = 128;
export const MAX_FILMSTRIP_CANVAS_PIXELS = 65_536;
const FPS_OPTIONS = [8, 12, 15, 24];
const SPEED_OPTIONS = [0.5, 1, 1.5, 2];
const SCALE_OPTIONS = [
  { label: '33%', value: 1 / 3 },
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: 'Full', value: 1 },
];
const fileInstanceIds = new WeakMap<File, number>();
let nextFileInstanceId = 1;

function getFileInstanceId(file: File) {
  const existingId = fileInstanceIds.get(file);
  if (existingId) return existingId;
  const id = nextFileInstanceId;
  nextFileInstanceId += 1;
  fileInstanceIds.set(file, id);
  return id;
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Conversion cancelled', 'AbortError');
}

function readFileAsDataUrl(file: File, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    const onAbort = () => {
      reader.abort();
      cleanup();
      reject(abortReason(signal));
    };
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      cleanup();
      reject(reader.error ?? new Error('Failed to read video'));
    };
    reader.onabort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.throwIfAborted();
    signal.addEventListener('abort', onAbort, { once: true });
    reader.readAsDataURL(file);
  });
}

function dataUrlToBase64(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

function gifFileName(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  return `${withoutExtension || 'video'}.gif`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getFilmstripLayout({
  timelineWidth,
  sourceWidth,
  sourceHeight,
}: {
  timelineWidth: number;
  sourceWidth: number;
  sourceHeight: number;
}) {
  const aspectRatio =
    sourceWidth > 0 && sourceHeight > 0 && Number.isFinite(sourceWidth / sourceHeight)
      ? sourceWidth / sourceHeight
      : 16 / 9;
  const requestedFrameCount = timelineWidth
    ? Math.round(timelineWidth / Math.max(1, FILMSTRIP_HEIGHT_PX * aspectRatio))
    : DEFAULT_FILMSTRIP_FRAME_COUNT;
  const frameCount = clamp(requestedFrameCount, 3, MAX_FILMSTRIP_FRAME_COUNT);

  let canvasWidth = clamp(
    Math.round(MAX_FILMSTRIP_CANVAS_HEIGHT * aspectRatio),
    1,
    MAX_FILMSTRIP_CANVAS_WIDTH,
  );
  let canvasHeight = clamp(
    Math.round(canvasWidth / aspectRatio),
    1,
    MAX_FILMSTRIP_CANVAS_HEIGHT,
  );
  if (canvasWidth * canvasHeight > MAX_FILMSTRIP_CANVAS_PIXELS) {
    const scale = Math.sqrt(
      MAX_FILMSTRIP_CANVAS_PIXELS / (canvasWidth * canvasHeight),
    );
    canvasWidth = Math.max(1, Math.floor(canvasWidth * scale));
    canvasHeight = Math.max(1, Math.floor(canvasHeight * scale));
  }

  return { frameCount, canvasWidth, canvasHeight };
}

export function getVideoSizeError(file: File): string | null {
  return file.size > MAX_VIDEO_SIZE
    ? `Video is ${formatBytes(file.size)}. Choose a clip under 80 MB before creating a GIF.`
    : null;
}

function formatSeconds(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${tenths}`;
}

function estimateGifSizeBytes({
  width,
  height,
  frames,
  colors,
}: {
  width: number;
  height: number;
  frames: number;
  colors: number;
}) {
  const indexedPixels = width * height * frames;
  const paletteBytes = colors * 3 * frames;
  const compressionFactor = 0.2 + (colors / 256) * 0.45;
  return {
    low: indexedPixels * compressionFactor * 0.6 + paletteBytes,
    high: indexedPixels * compressionFactor * 1.4 + paletteBytes,
  };
}

export function getGifConversionLimitError({
  width,
  height,
  frames,
}: {
  width: number;
  height: number;
  frames: number;
}) {
  const pixelsPerFrame = width * height;
  if (frames > MAX_FRAME_COUNT) {
    return `Too many frames (${frames}). Trim the clip, lower FPS, or increase speed to stay at ${MAX_FRAME_COUNT} frames or fewer.`;
  }
  if (width > MAX_OUTPUT_DIMENSION || height > MAX_OUTPUT_DIMENSION) {
    return `Output dimensions are too large (${width}x${height}). Lower scale so each side is ${MAX_OUTPUT_DIMENSION}px or less.`;
  }
  if (pixelsPerFrame > MAX_PIXELS_PER_FRAME) {
    return `Each frame is too large (${pixelsPerFrame.toLocaleString()} pixels). Lower scale to stay at 1 million pixels per frame or fewer.`;
  }
  if (pixelsPerFrame * frames > MAX_TOTAL_PROCESSED_PIXELS) {
    return 'Conversion requires too much pixel processing. Trim the clip, lower FPS, or lower scale.';
  }
  return null;
}

function drawVideoFrameContain({
  context,
  video,
  width,
  height,
}: {
  context: CanvasRenderingContext2D;
  video: HTMLVideoElement;
  width: number;
  height: number;
}) {
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (width - drawWidth) / 2;
  const drawY = (height - drawHeight) / 2;
  context.fillStyle = '#05040a';
  context.fillRect(0, 0, width, height);
  context.drawImage(
    video,
    0,
    0,
    sourceWidth,
    sourceHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  );
}

async function yieldToRenderer(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 0);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForVideoMetadata(
  video: HTMLVideoElement,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (video.readyState >= 1) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onLoadedMetadata = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Failed to load video'));
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function seekVideo(
  video: HTMLVideoElement,
  time: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) {
    await yieldToRenderer(signal);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while seeking video'));
    }, SEEK_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Failed to seek video'));
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    video.currentTime = time;
  });
}

export async function convertVideoToGif({
  file,
  fps,
  outputWidth,
  outputHeight,
  colors,
  speed,
  startTime,
  endTime,
  onProgress,
  signal,
}: {
  file: File;
  fps: number;
  outputWidth: number;
  outputHeight: number;
  colors: number;
  speed: number;
  startTime: number;
  endTime: number;
  onProgress: (progress: number) => void;
  signal: AbortSignal;
}): Promise<PromptImagePart> {
  signal.throwIfAborted();
  if (file.size > MAX_VIDEO_SIZE) {
    throw new Error('Video too large. Use a clip under 80 MB.');
  }
  const plannedFrameCount = Math.max(
    1,
    Math.ceil((Math.max(0.1, endTime - startTime) * fps) / speed),
  );
  const plannedLimitError = getGifConversionLimitError({
    width: Math.max(1, Math.round(outputWidth)),
    height: Math.max(1, Math.round(outputHeight)),
    frames: plannedFrameCount,
  });
  if (plannedLimitError) throw new Error(plannedLimitError);

  const sourceUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = sourceUrl;

  try {
    await waitForVideoMetadata(video, signal);

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const safeStart = Math.max(0, Math.min(startTime, duration));
    const safeEnd = Math.max(safeStart + 0.1, Math.min(endTime, duration));
    const width = Math.max(1, Math.round(outputWidth));
    const height = Math.max(1, Math.round(outputHeight));
    const frameCount = Math.max(
      1,
      Math.ceil(((safeEnd - safeStart) * fps) / speed),
    );
    const limitError = getGifConversionLimitError({
      width,
      height,
      frames: frameCount,
    });
    if (limitError) throw new Error(limitError);
    const delay = Math.round(1000 / fps);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Failed to create canvas');

    const workerClient = createGifEncoderWorkerClient(signal);
    let gifBuffer: ArrayBuffer;
    try {
      await workerClient.initialize({
        width,
        height,
        colors,
        delay,
      });
      for (let index = 0; index < frameCount; index += 1) {
        const time = Math.min(safeEnd, safeStart + (index * speed) / fps);
        await seekVideo(video, time, signal);
        await yieldToRenderer(signal);
        context.drawImage(video, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        signal.throwIfAborted();
        const rgba =
          pixels.buffer instanceof ArrayBuffer &&
          pixels.byteOffset === 0 &&
          pixels.byteLength === pixels.buffer.byteLength
            ? pixels.buffer
            : pixels.slice().buffer;
        await workerClient.encodeFrame(index, rgba);
        onProgress((index + 1) / frameCount);
      }
      gifBuffer = (await workerClient.finish()).bytes;
    } finally {
      workerClient.terminate();
    }

    const blob = new Blob([gifBuffer], { type: 'image/gif' });
    const dataUrl = await readFileAsDataUrl(
      new File([blob], gifFileName(file.name), { type: 'image/gif' }),
      signal,
    );
    signal.throwIfAborted();
    const base64Data = dataUrlToBase64(dataUrl);
    return {
      type: 'image',
      data: base64Data,
      mimeType: 'image/gif',
      filename: gifFileName(file.name),
      sizeBytes: gifBuffer.byteLength,
      width,
      height,
      storageData: base64Data,
      storageMimeType: 'image/gif',
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(sourceUrl);
  }
}

export function isVideoFile(file: File) {
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name);
}

export function VideoGifConverter({
  file,
  onAttach,
  onClose,
}: {
  file: File | null;
  onAttach: (image: PromptImagePart) => void;
  onClose: () => void;
}) {
  if (!file) return null;
  const sizeError = getVideoSizeError(file);
  if (sizeError) {
    return <VideoSizeErrorDialog error={sizeError} onClose={onClose} />;
  }
  return (
    <VideoGifConverterDialog
      key={getFileInstanceId(file)}
      file={file}
      onAttach={onAttach}
      onClose={onClose}
    />
  );
}

function VideoSizeErrorDialog({
  error,
  onClose,
}: {
  error: string;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <FocusLock returnFocus>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="border-glass-border bg-bg-1 w-full max-w-md rounded-xl border p-5 shadow-2xl"
        >
          <h2 id={titleId} className="text-ink-0 text-sm font-semibold">
            Video cannot be converted
          </h2>
          <p className="mt-2 text-sm text-red-400" role="alert">
            {error}
          </p>
          <div className="mt-5 flex justify-end">
            <Button type="button" variant="primary" size="sm" onClick={onClose}>
              Choose another video
            </Button>
          </div>
        </div>
      </FocusLock>
    </div>
  );
}

function VideoGifConverterDialog({
  file,
  onAttach,
  onClose,
}: {
  file: File;
  onAttach: (image: PromptImagePart) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const currentFileRef = useRef<File | null>(file);
  const conversionRef = useRef<{
    controller: AbortController;
    file: File;
  } | null>(null);
  const filmstripGenerationRef = useRef<AbortController | null>(null);
  const isPreviewPlayingRef = useRef(false);
  const isScrubbingPlayheadRef = useRef(false);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(6);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [colors, setColors] = useState(DEFAULT_QUALITY);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [filmstripFrames, setFilmstripFrames] = useState<string[]>([]);
  const [timelineWidth, setTimelineWidth] = useState(0);
  const titleId = useId();

  useEffect(() => {
    const nextPreviewUrl = URL.createObjectURL(file);
    startTransition(() => setPreviewUrl(nextPreviewUrl));
    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [file]);

  useLayoutEffect(() => {
    currentFileRef.current = file;
    return () => {
      currentFileRef.current = null;
      conversionRef.current?.controller.abort();
      conversionRef.current = null;
      filmstripGenerationRef.current?.abort();
      filmstripGenerationRef.current = null;
    };
  }, [file]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      conversionRef.current?.controller.abort();
      conversionRef.current = null;
      filmstripGenerationRef.current?.abort();
      startTransition(() => setFilmstripFrames([]));
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;
    const updateWidth = () => setTimelineWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [previewUrl]);

  const filmstripLayout = getFilmstripLayout({
    timelineWidth,
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
  });
  const filmstripFrameCount = filmstripLayout.frameCount;

  useEffect(() => {
    if (!previewUrl || !duration) {
      startTransition(() => setFilmstripFrames([]));
      return;
    }

    const controller = new AbortController();
    filmstripGenerationRef.current?.abort();
    filmstripGenerationRef.current = controller;
    const { signal } = controller;
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    canvas.width = filmstripLayout.canvasWidth;
    canvas.height = filmstripLayout.canvasHeight;
    const context = canvas.getContext('2d');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = previewUrl;
    const releaseVideo = () => {
      video.removeAttribute('src');
      video.load();
    };
    signal.addEventListener('abort', releaseVideo, { once: true });

    const generateFrames = async () => {
      try {
        await waitForVideoMetadata(video, signal);
        if (!context || signal.aborted) return;
        const nextFrames: string[] = [];
        const lastFrameIndex = filmstripFrameCount - 1;
        for (let index = 0; index < filmstripFrameCount; index += 1) {
          const time = duration * (index / lastFrameIndex);
          await seekVideo(
            video,
            Math.min(time, Math.max(0, duration - 0.05)),
            signal,
          );
          drawVideoFrameContain({
            context,
            video,
            width: canvas.width,
            height: canvas.height,
          });
          nextFrames.push(canvas.toDataURL('image/jpeg', 0.55));
        }
        if (!signal.aborted) setFilmstripFrames(nextFrames);
      } catch {
        if (!signal.aborted) setFilmstripFrames([]);
      }
    };

    void generateFrames();
    return () => {
      controller.abort();
      if (filmstripGenerationRef.current === controller) {
        filmstripGenerationRef.current = null;
      }
      signal.removeEventListener('abort', releaseVideo);
      releaseVideo();
    };
  }, [
    duration,
    filmstripFrameCount,
    filmstripLayout.canvasHeight,
    filmstripLayout.canvasWidth,
    previewUrl,
  ]);

  if (!previewUrl) return null;

  const handleMetadata = () => {
    const video = videoRef.current;
    const rawDuration = video?.duration ?? 0;
    const nextDuration = Number.isFinite(rawDuration) ? rawDuration : 0;
    const nextSourceSize = {
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
    };
    setDuration(nextDuration);
    setEndTime(nextDuration || 0.1);
    setSourceSize(nextSourceSize);
  };

  const clipSeconds = Math.max(0.1, endTime - startTime);
  const estimatedFrames = Math.ceil((clipSeconds * fps) / speed);
  const outputWidth = Math.max(1, Math.round(sourceSize.width * scale));
  const outputHeight = Math.max(1, Math.round(sourceSize.height * scale));
  const estimatedSize = estimateGifSizeBytes({
    width: outputWidth,
    height: outputHeight,
    frames: estimatedFrames,
    colors,
  });
  const conversionLimitError = getGifConversionLimitError({
    width: outputWidth,
    height: outputHeight,
    frames: estimatedFrames,
  });
  const conversionBlockReason =
    duration > 0 && sourceSize.width > 0 && sourceSize.height > 0
      ? conversionLimitError
      : 'Loading video metadata...';
  const startPercent = duration ? (startTime / duration) * 100 : 0;
  const endPercent = duration ? (endTime / duration) * 100 : 100;
  const visualStartPercent = startTime <= 0.05 ? 0 : startPercent;
  const visualEndPercent =
    duration && duration - endTime <= 0.05 ? 100 : endPercent;
  const previewProgressPercent = duration
    ? (clamp(previewTime, 0, duration) / duration) * 100
    : startPercent;

  const setTimelineStart = (value: number) => {
    const nextStart = clamp(value, 0, endTime - 0.1);
    setStartTime(nextStart);
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = nextStart;
    setPreviewTime(nextStart);
  };

  const setTimelineEnd = (value: number) => {
    const nextEnd = clamp(value, startTime + 0.1, duration || 0.1);
    setEndTime(nextEnd);
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = nextEnd;
    setPreviewTime(nextEnd);
  };

  const setTimelineEndFromPointer = (event: PointerEvent<HTMLInputElement>) => {
    if (!duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX >= rect.right) setTimelineEnd(duration);
  };

  const handlePreviewPlay = () => {
    const video = videoRef.current;
    if (!video) return;
    isPreviewPlayingRef.current = true;
    setIsPreviewPlaying(true);
    if (video.currentTime < startTime || video.currentTime >= endTime) {
      video.currentTime = startTime;
    }
    setPreviewTime(video.currentTime);
  };

  const handlePreviewPause = () => {
    if (!videoRef.current?.ended) {
      isPreviewPlayingRef.current = false;
      setIsPreviewPlaying(false);
    }
  };

  const handlePreviewEnded = () => {
    const video = videoRef.current;
    if (!video || !isPreviewPlayingRef.current) return;
    video.currentTime = startTime;
    setPreviewTime(startTime);
    void video.play();
  };

  const handlePreviewTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !duration) return;
    setPreviewTime(video.currentTime);
    if (video.currentTime >= endTime) {
      const shouldResume = isPreviewPlayingRef.current;
      video.currentTime = startTime;
      setPreviewTime(startTime);
      if (shouldResume) void video.play();
    }
  };

  const togglePreviewPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPreviewPlayingRef.current) {
      video.pause();
      return;
    }
    if (video.currentTime < startTime || video.currentTime >= endTime) {
      video.currentTime = startTime;
    }
    void video.play();
  };

  const scrubPreviewToClientX = (clientX: number, element: HTMLDivElement) => {
    if (!duration) return;
    const rect = element.getBoundingClientRect();
    const nextTime = clamp(
      ((clientX - rect.left) / rect.width) * duration,
      0,
      duration,
    );
    setPreviewTime(nextTime);
    if (videoRef.current) videoRef.current.currentTime = nextTime;
  };

  const handleTimelinePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || !duration) return;
    isScrubbingPlayheadRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubPreviewToClientX(event.clientX, event.currentTarget);
  };

  const handleTimelinePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isScrubbingPlayheadRef.current) return;
    scrubPreviewToClientX(event.clientX, event.currentTarget);
  };

  const handleTimelinePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    isScrubbingPlayheadRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleConvert = async () => {
    if (conversionBlockReason) return;
    conversionRef.current?.controller.abort();
    const conversion = { controller: new AbortController(), file };
    conversionRef.current = conversion;
    setIsConverting(true);
    setError(null);
    setProgress(0);
    try {
      const image = await convertVideoToGif({
        file,
        fps,
        outputWidth,
        outputHeight,
        colors,
        speed,
        startTime,
        endTime,
        signal: conversion.controller.signal,
        onProgress: (nextProgress) => {
          if (conversionRef.current === conversion) setProgress(nextProgress);
        },
      });
      if (
        conversionRef.current !== conversion ||
        conversion.controller.signal.aborted ||
        currentFileRef.current !== conversion.file
      ) {
        return;
      }
      onAttach(image);
      onClose();
    } catch (convertError) {
      if (
        conversionRef.current !== conversion ||
        conversion.controller.signal.aborted ||
        currentFileRef.current !== conversion.file
      ) {
        return;
      }
      setError(
        convertError instanceof Error
          ? convertError.message
          : 'Failed to convert video',
      );
    } finally {
      if (conversionRef.current === conversion) {
        conversionRef.current = null;
        setIsConverting(false);
      }
    }
  };

  const handleClose = () => {
    conversionRef.current?.controller.abort();
    conversionRef.current = null;
    filmstripGenerationRef.current?.abort();
    filmstripGenerationRef.current = null;
    setFilmstripFrames([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-[radial-gradient(ellipse_at_18%_0%,rgba(143,92,255,0.22),transparent_34%),radial-gradient(ellipse_at_86%_100%,rgba(57,132,255,0.14),transparent_38%),rgba(7,6,12,0.92)] p-4">
      <FocusLock returnFocus>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="border-glass-border bg-bg-1 flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border shadow-[0_40px_100px_-30px_rgba(0,0,0,0.85)]"
        >
        <div className="border-glass-border bg-bg-0 flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <div className="bg-acc/15 text-acc flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-white/10">
            <Film className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="text-ink-0 text-sm font-semibold">
              New GIF from recording
            </h2>
            <div className="text-ink-3 truncate text-xs">{file.name}</div>
          </div>
          <button
            type="button"
            autoFocus
            className="text-ink-3 hover:text-ink-1 ml-auto rounded-md p-1.5 transition-colors hover:bg-white/5"
            onClick={handleClose}
            aria-label="Close GIF converter"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="bg-bg-0/80 flex min-h-[260px] flex-1 items-center justify-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[length:22px_22px] p-5">
              <div className="relative max-h-[42vh] max-w-full overflow-hidden rounded-xl shadow-[0_28px_70px_-24px_rgba(0,0,0,0.9)] ring-1 ring-white/10">
                <video
                  ref={videoRef}
                  src={previewUrl}
                  className="bg-bg-0 max-h-[42vh] max-w-full"
                  onLoadedMetadata={handleMetadata}
                  onEnded={handlePreviewEnded}
                  onPause={handlePreviewPause}
                  onPlay={handlePreviewPlay}
                  onTimeUpdate={handlePreviewTimeUpdate}
                />
                <div className="absolute top-3 left-3 rounded-full bg-black/65 px-2.5 py-1 font-mono text-[11px] text-white/90 ring-1 ring-white/15 backdrop-blur">
                  {formatSeconds(clipSeconds)} · {estimatedFrames}f
                </div>
              </div>
            </div>

            <div className="border-glass-border bg-bg-1 border-t p-4">
              <div className="mb-3 flex items-center gap-3">
                <button
                  type="button"
                  className="bg-acc text-acc-ink flex h-9 w-9 items-center justify-center rounded-full shadow-[0_0_24px_rgba(255,255,255,0.16)] disabled:opacity-50"
                  onClick={togglePreviewPlayback}
                  disabled={isConverting}
                  aria-label={
                    isPreviewPlaying ? 'Pause preview' : 'Play preview'
                  }
                >
                  {isPreviewPlaying ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="ml-0.5 h-4 w-4" />
                  )}
                </button>
                <span className="text-ink-1 font-mono text-xs">
                  {formatSeconds(startTime)}
                </span>
                <span className="text-ink-3 min-w-0 flex-1 truncate text-xs">
                  Drag violet handles to trim · {formatSeconds(duration)} total
                </span>
                <span className="text-acc hidden items-center gap-1.5 text-xs sm:inline-flex">
                  loop selected range
                </span>
              </div>

              <div>
                <div
                  ref={timelineRef}
                  className="relative h-16 cursor-crosshair overflow-hidden rounded-lg bg-black ring-1 ring-white/10 select-none"
                  onPointerCancel={handleTimelinePointerEnd}
                  onPointerDown={handleTimelinePointerDown}
                  onPointerMove={handleTimelinePointerMove}
                  onPointerUp={handleTimelinePointerEnd}
                >
                  <div className="flex h-full">
                    {Array.from({ length: filmstripFrameCount }).map(
                      (_, index) => {
                        const framePercent =
                          (index / Math.max(1, filmstripFrameCount - 1)) * 100;
                        const isInRange =
                          framePercent >= visualStartPercent &&
                          framePercent <= visualEndPercent;
                        const frame = filmstripFrames[index];
                        return (
                          <div
                            key={index}
                            className="h-full flex-1 overflow-hidden border-r border-black/60 last:border-r-0"
                          >
                            {frame ? (
                              <img
                                src={frame}
                                alt=""
                                draggable={false}
                                className={
                                  isInRange
                                    ? 'h-full w-full object-fill'
                                    : 'h-full w-full object-fill brightness-50 grayscale'
                                }
                              />
                            ) : (
                              <div
                                className={
                                  isInRange
                                    ? 'from-bg-2 to-bg-0 h-full bg-gradient-to-br'
                                    : 'from-bg-2 to-bg-0 h-full bg-gradient-to-br brightness-50 grayscale'
                                }
                              />
                            )}
                          </div>
                        );
                      },
                    )}
                  </div>
                  <div
                    className="absolute inset-y-0 left-0 bg-black/60"
                    style={{ width: `${visualStartPercent}%` }}
                  />
                  <div
                    className="absolute inset-y-0 right-0 bg-black/60"
                    style={{ width: `${100 - visualEndPercent}%` }}
                  />
                  <div
                    className="border-acc pointer-events-none absolute inset-y-0 rounded-md border-2 shadow-[0_0_18px_rgba(168,120,255,0.38)]"
                    style={{
                      left: `${visualStartPercent}%`,
                      right: `${100 - visualEndPercent}%`,
                    }}
                  />
                  <div
                    className="bg-acc absolute inset-y-0 flex w-6 items-center justify-center rounded-l-md shadow-[0_0_16px_rgba(168,120,255,0.45)]"
                    style={{
                      left:
                        visualStartPercent <= 1 ? 0 : `${visualStartPercent}%`,
                      transform:
                        visualStartPercent <= 1 ? 'none' : 'translateX(-50%)',
                    }}
                  >
                    <span className="bg-acc-ink/80 h-6 w-0.5 rounded" />
                  </div>
                  <div
                    className="bg-acc absolute inset-y-0 flex w-6 items-center justify-center rounded-r-md shadow-[0_0_16px_rgba(168,120,255,0.45)]"
                    style={{
                      right:
                        visualEndPercent >= 99
                          ? 0
                          : `${100 - visualEndPercent}%`,
                      transform:
                        visualEndPercent >= 99 ? 'none' : 'translateX(50%)',
                    }}
                  >
                    <span className="bg-acc-ink/80 h-6 w-0.5 rounded" />
                  </div>
                  <div
                    className="absolute -top-1 -bottom-1 w-0.5 bg-yellow-300 shadow-[0_0_10px_rgba(253,224,71,0.9)]"
                    style={{ left: `${previewProgressPercent}%` }}
                  />
                  <input
                    className="pointer-events-none absolute inset-x-0 top-0 h-16 w-full appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-16 [&::-webkit-slider-thumb]:w-8 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-transparent"
                    type="range"
                    min={0}
                    max={duration || 1}
                    step="any"
                    value={startTime}
                    onChange={(event) =>
                      setTimelineStart(Number(event.target.value))
                    }
                    disabled={isConverting}
                    aria-label="GIF start time"
                  />
                  <input
                    className="pointer-events-none absolute inset-x-0 top-0 h-16 w-full appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-16 [&::-webkit-slider-thumb]:w-8 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-transparent"
                    type="range"
                    min={0}
                    max={duration || 1}
                    step="any"
                    value={endTime}
                    onChange={(event) =>
                      setTimelineEnd(Number(event.target.value))
                    }
                    onPointerMove={setTimelineEndFromPointer}
                    onPointerUp={setTimelineEndFromPointer}
                    disabled={isConverting}
                    aria-label="GIF end time"
                  />
                </div>
                <div className="text-ink-3 mt-2 flex justify-between font-mono text-[11px]">
                  <span>0:00.0</span>
                  <span className="text-acc">
                    {formatSeconds(startTime)} - {formatSeconds(endTime)}
                  </span>
                  <span>{formatSeconds(duration)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="border-glass-border bg-bg-1 w-full shrink-0 border-t p-4 lg:w-80 lg:overflow-y-auto lg:border-t-0 lg:border-l">
            <div className="text-ink-3 mb-2 text-[11px] font-semibold tracking-wide uppercase">
              Export settings
            </div>

            <div className="border-glass-border border-b pt-4 pb-3">
              <div className="text-ink-1 mb-3 flex w-full items-center justify-between text-xs font-medium">
                Frame rate{' '}
                <span className="text-ink-3 font-mono">{fps} fps</span>
              </div>
              <div className="bg-bg-0 grid grid-cols-4 gap-1 rounded-lg p-1 ring-1 ring-white/10">
                {FPS_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={
                      fps === option
                        ? 'bg-bg-3 text-ink-0 rounded-md px-2 py-1.5 text-xs font-semibold shadow-sm'
                        : 'text-ink-3 hover:text-ink-1 rounded-md px-2 py-1.5 text-xs'
                    }
                    onClick={() => setFps(option)}
                    disabled={isConverting}
                    aria-pressed={fps === option}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-glass-border border-b pt-5 pb-4">
              <div className="text-ink-1 mb-3 flex w-full items-center justify-between text-xs font-medium">
                Size{' '}
                <span className="text-ink-3 font-mono">
                  {outputWidth}x{outputHeight}
                </span>
              </div>
              <div className="bg-bg-0 grid grid-cols-4 gap-1 rounded-lg p-1 ring-1 ring-white/10">
                {SCALE_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={
                      scale === option.value
                        ? 'bg-bg-3 text-ink-0 rounded-md px-2 py-1.5 text-xs font-semibold shadow-sm'
                        : 'text-ink-3 hover:text-ink-1 rounded-md px-2 py-1.5 text-xs'
                    }
                    onClick={() => setScale(option.value)}
                    disabled={isConverting}
                    aria-pressed={scale === option.value}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="text-ink-4 mt-1.5 text-[11px]">
                Original {sourceSize.width}x{sourceSize.height}
              </div>
            </div>

            <div className="border-glass-border border-b pt-5 pb-4">
              <div className="text-ink-1 mb-3 flex w-full items-center justify-between text-xs font-medium">
                Speed{' '}
                <span className="text-ink-3 font-mono">
                  {speed.toFixed(1)}x
                </span>
              </div>
              <div className="bg-bg-0 grid grid-cols-4 gap-1 rounded-lg p-1 ring-1 ring-white/10">
                {SPEED_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={
                      speed === option
                        ? 'bg-bg-3 text-ink-0 rounded-md px-2 py-1.5 text-xs font-semibold shadow-sm'
                        : 'text-ink-3 hover:text-ink-1 rounded-md px-2 py-1.5 text-xs'
                    }
                    onClick={() => setSpeed(option)}
                    disabled={isConverting}
                    aria-pressed={speed === option}
                  >
                    {option}x
                  </button>
                ))}
              </div>
            </div>

            <label className="border-glass-border block border-b pt-5 pb-4">
              <span className="text-ink-1 mb-3 flex items-center justify-between text-xs font-medium">
                Quality{' '}
                <span className="text-ink-3 font-mono">{colors} colors</span>
              </span>
              <input
                className="accent-acc w-full"
                type="range"
                min={32}
                max={256}
                step={32}
                value={colors}
                onChange={(event) => setColors(Number(event.target.value))}
                disabled={isConverting}
              />
              <span className="text-ink-3 mt-1.5 flex justify-between text-[11px]">
                <span>Smaller file</span>
                <span>Sharper</span>
              </span>
            </label>

            <div className="pt-4">
              <div className="mb-2 flex items-baseline gap-2">
                <span className="font-mono text-xl font-semibold text-emerald-400">
                  {formatBytes(estimatedSize.low)}-
                  {formatBytes(estimatedSize.high)}
                </span>
                <span className="text-ink-3 text-xs">estimated output</span>
              </div>
              <div className="text-ink-3 mt-3 grid grid-cols-3 gap-3 text-xs">
                <div>
                  <div className="text-ink-4 text-[10px] font-semibold tracking-wide uppercase">
                    Frames
                  </div>
                  <div className="text-ink-1 font-mono">{estimatedFrames}</div>
                </div>
                <div>
                  <div className="text-ink-4 text-[10px] font-semibold tracking-wide uppercase">
                    Length
                  </div>
                  <div className="text-ink-1 font-mono">
                    {formatSeconds(clipSeconds)}
                  </div>
                </div>
                <div>
                  <div className="text-ink-4 text-[10px] font-semibold tracking-wide uppercase">
                    Range
                  </div>
                  <div className="text-ink-1 font-mono">
                    {formatBytes(estimatedSize.low)}-
                    {formatBytes(estimatedSize.high)}
                  </div>
                </div>
              </div>
              {conversionLimitError && (
                <p className="mt-3 text-xs text-red-400" role="alert">
                  {conversionLimitError}
                </p>
              )}
            </div>
          </div>
        </div>

        {isConverting && (
          <div
            className="bg-bg-2 h-1.5 overflow-hidden"
            role="progressbar"
            aria-label="GIF conversion progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div
              className="bg-acc h-full"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
        {error && (
          <p
            className="px-4 pt-3 text-xs text-red-400"
            role="alert"
            aria-live="assertive"
          >
            {error}
          </p>
        )}

        <div className="border-glass-border bg-bg-0 flex shrink-0 flex-wrap items-center gap-3 border-t px-4 py-3">
          <div className="text-ink-3 min-w-0 flex-1 text-xs">
            Output {outputWidth}x{outputHeight} · loops selected range ·{' '}
            {estimatedFrames} frames
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void handleConvert()}
            disabled={isConverting || Boolean(conversionBlockReason)}
            title={conversionBlockReason ?? undefined}
            icon={
              isConverting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : undefined
            }
          >
            {isConverting ? 'Converting...' : 'Convert to GIF'}
          </Button>
        </div>
        </div>
      </FocusLock>
    </div>
  );
}
