import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 8;

type View = { scale: number; x: number; y: number };

const INITIAL_VIEW: View = { scale: MIN_SCALE, x: 0, y: 0 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Image viewer whose box is sized from the image's own aspect ratio, scaled to
 * fill the available viewport area (small images are upscaled) so there is no
 * dead space around it. Supports zooming via trackpad pinch, ctrl/cmd + wheel,
 * plain wheel and double click, plus drag panning while zoomed.
 */
export function ZoomableImage(props: {
  src: string;
  alt: string;
  maxWidthRatio?: number;
  maxHeightRatio?: number;
  className?: string;
}) {
  // Remount on src change so zoom/pan/natural-size state resets cleanly.
  return <ZoomableImageView key={props.src} {...props} />;
}

function ZoomableImageView({
  src,
  alt,
  maxWidthRatio = 0.9,
  maxHeightRatio = 0.86,
  className = '',
}: {
  src: string;
  alt: string;
  maxWidthRatio?: number;
  maxHeightRatio?: number;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1024 : window.innerWidth,
    h: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const maxW = viewport.w * maxWidthRatio;
  const maxH = viewport.h * maxHeightRatio;
  const fitRatio = natural ? Math.min(maxW / natural.w, maxH / natural.h) : 1;
  const boxWidth = natural ? Math.round(natural.w * fitRatio) : undefined;
  const boxHeight = natural ? Math.round(natural.h * fitRatio) : undefined;

  const clampOffset = useCallback(
    (next: { x: number; y: number }, scale: number, rect?: DOMRect) => {
      const width = rect?.width ?? containerRef.current?.clientWidth ?? 0;
      const height = rect?.height ?? containerRef.current?.clientHeight ?? 0;
      const maxX = (width * (scale - 1)) / 2;
      const maxY = (height * (scale - 1)) / 2;
      return { x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
    },
    [],
  );

  /**
   * Multiply the current scale by `factor`, keeping the point under the cursor
   * fixed. `rect` is read before the state update so the updater stays pure.
   */
  const zoomBy = useCallback(
    (
      factor: number,
      target?: { clientX: number; clientY: number; rect: DOMRect },
    ) => {
      setView((prev) => {
        const scale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
        if (scale === prev.scale) return prev;
        if (scale === MIN_SCALE) return INITIAL_VIEW;
        if (!target) {
          const ratio = scale / prev.scale;
          const next = clampOffset(
            { x: prev.x * ratio, y: prev.y * ratio },
            scale,
          );
          return { scale, ...next };
        }
        const { rect } = target;
        // Cursor position relative to the untransformed image center.
        const cx = target.clientX - (rect.left + rect.width / 2);
        const cy = target.clientY - (rect.top + rect.height / 2);
        const ratio = scale / prev.scale;
        const next = clampOffset(
          { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio },
          scale,
          rect,
        );
        return { scale, ...next };
      });
    },
    [clampOffset],
  );

  // Wheel must be a non-passive native listener so preventDefault works and the
  // trackpad pinch gesture (ctrlKey wheel) is not swallowed by the page.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const intensity = event.ctrlKey || event.metaKey ? 0.01 : 0.0035;
      zoomBy(Math.exp(-event.deltaY * intensity), {
        clientX: event.clientX,
        clientY: event.clientY,
        rect: el.getBoundingClientRect(),
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (view.scale <= MIN_SCALE || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setView((prev) => ({
      ...prev,
      ...clampOffset(
        { x: drag.originX + dx, y: drag.originY + dy },
        prev.scale,
      ),
    }));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const isZoomed = view.scale > MIN_SCALE;

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden rounded-lg ${
        isZoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
      } ${className}`}
      style={{
        width: boxWidth,
        height: boxHeight,
        // Before the image loads (or when it fails) keep a visible box so the
        // alt text / broken-image indicator is not collapsed to 0x0.
        minWidth: natural && !failed ? undefined : 200,
        minHeight: natural && !failed ? undefined : 120,
        maxWidth: `${Math.round(maxWidthRatio * 100)}vw`,
        maxHeight: `${Math.round(maxHeightRatio * 100)}vh`,
        touchAction: 'none',
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        zoomBy(isZoomed ? MIN_SCALE / view.scale : 2, {
          clientX: event.clientX,
          clientY: event.clientY,
          rect,
        });
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            setNatural({
              w: image.naturalWidth || image.width,
              h: image.naturalHeight || image.height,
            });
          }}
          onError={() => setFailed(true)}
          className="h-full w-full select-none object-contain"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 80ms linear',
          }}
        />
    </div>
  );
}
