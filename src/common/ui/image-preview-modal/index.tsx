import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  KeyboardLayerProvider,
  useKeyboardLayer,
} from '@/common/context/keyboard-bindings';
import { Modal } from '@/common/ui/modal';
import { ZoomableImage } from '@/common/ui/zoomable-image';

export type PreviewImage = {
  src?: string;
  alt?: string;
  fallbackLabel?: string;
};

// Fit the panel to the image instead of the Modal size presets.
const PANEL_CLASS =
  'w-auto! max-w-none! max-h-none! bg-transparent! shadow-none!';

/**
 * Fullscreen image preview. The image box is fitted to the image's aspect
 * ratio and fills the available space (no empty gutters), so clicking anywhere
 * around it closes. Supports pinch/wheel zoom, drag pan and double-click zoom.
 */
export function ImagePreviewModal({
  isOpen = true,
  title,
  imageUrl,
  images,
  initialIndex = 0,
  onClose,
}: {
  isOpen?: boolean;
  title?: string;
  imageUrl?: string | null;
  images?: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
}) {
  const items: PreviewImage[] =
    images ?? (imageUrl ? [{ src: imageUrl, alt: title }] : []);
  const count = items.length;
  const [index, setIndex] = useState(initialIndex);
  const currentIndex = Math.min(Math.max(index, 0), Math.max(count - 1, 0));
  const layer = useKeyboardLayer('dialog', { exclusive: isOpen });

  useEffect(() => {
    if (!isOpen || count < 2) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === 'ArrowLeft' ? -1 : 1;
      setIndex((i) => Math.min(Math.max(i + delta, 0), count - 1));
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, count]);

  const current = items[currentIndex];
  if (!isOpen || !current) return null;

  const label = current.alt || title || 'Image preview';

  return (
    <KeyboardLayerProvider layer={layer}>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        ariaLabel={label}
        showHeader={false}
        panelClassName={PANEL_CLASS}
        contentClassName="p-0"
      >
        <button
          type="button"
          onClick={onClose}
          className="bg-bg-1/80 text-ink-1 hover:bg-glass-medium hover:text-ink-0 fixed top-4 right-4 z-10 rounded-full p-2"
          aria-label="Close preview"
        >
          <X className="h-5 w-5" />
        </button>

        {count > 1 && currentIndex > 0 && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setIndex(currentIndex - 1);
            }}
            className="bg-bg-1/80 text-ink-1 hover:bg-glass-medium hover:text-ink-0 fixed top-1/2 left-4 z-10 -translate-y-1/2 rounded-full p-2"
            aria-label="Previous image"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}

        {current.src ? (
          <ZoomableImage src={current.src} alt={label} className="shadow-2xl" />
        ) : (
          <div className="bg-bg-1 text-ink-2 border-glass-border max-w-[85vw] rounded-lg border px-6 py-5 text-sm">
            {current.fallbackLabel ?? label}
          </div>
        )}

        {count > 1 && currentIndex < count - 1 && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setIndex(currentIndex + 1);
            }}
            className="bg-bg-1/80 text-ink-1 hover:bg-glass-medium hover:text-ink-0 fixed top-1/2 right-4 z-10 -translate-y-1/2 rounded-full p-2"
            aria-label="Next image"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}

        {count > 1 && (
          <div className="text-ink-2 fixed bottom-4 left-1/2 -translate-x-1/2 text-sm">
            {currentIndex + 1} / {count}
          </div>
        )}
      </Modal>
    </KeyboardLayerProvider>
  );
}
