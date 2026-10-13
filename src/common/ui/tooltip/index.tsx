import React, {
  isValidElement,
  type ReactElement,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';



import { useDropdownPosition } from '@/common/hooks/use-dropdown-position';

/**
 * Portal-based tooltip that renders on hover.
 * Positions itself relative to the trigger using the same positioning logic as Dropdown/Select.
 *
 * Usage:
 *   <Tooltip content={<div>Rich content</div>}>
 *     <button>Hover me</button>
 *   </Tooltip>
 */
export function Tooltip({
  children,
  content,
  side = 'bottom',
  align = 'left',
  className,
  delay = 200,
  closeDelay,
  interactive = false,
  minWidth,
}: {
  children: ReactElement;
  content: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'left' | 'right';
  className?: string;
  delay?: number;
  /** Grace period before hiding, letting the mouse travel into the tooltip. */
  closeDelay?: number;
  /** Allow hovering/selecting inside the tooltip content. */
  interactive?: boolean;
  minWidth?: number;
}) {
  const resolvedCloseDelay = closeDelay ?? (interactive ? 300 : 0);
  const [isOpen, setIsOpen] = useState(false);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [contentWidth, setContentWidth] = useState<number | undefined>(
    minWidth,
  );
  const [triggerElementNode, setTriggerElementNode] =
    useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const position = useDropdownPosition({
    isOpen,
    triggerElement: triggerElementNode,
    triggerRef,
    side,
    align,
    autoAlign: true,
    minHorizontalSpace: contentWidth ?? minWidth,
  });

  const updateContentWidth = useCallback((element: HTMLDivElement) => {
    setContentWidth(Math.ceil(element.getBoundingClientRect().width));
  }, []);

  const handleContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      setContentElement(node);
      if (node) updateContentWidth(node);
    },
    [updateContentWidth],
  );

  useEffect(() => {
    if (!isOpen) {
      startTransition(() => setContentElement(null));
      startTransition(() => setContentWidth(minWidth));
      return;
    }
    if (!contentElement) return;

    startTransition(() => updateContentWidth(contentElement));

    const observer = new ResizeObserver(() => {
      updateContentWidth(contentElement);
    });
    observer.observe(contentElement);

    return () => observer.disconnect();
  }, [contentElement, isOpen, minWidth, updateContentWidth]);

  // Clean up pending delay timeout on unmount
  useEffect(() => {
    return () => {
      if (delayRef.current) clearTimeout(delayRef.current);
    };
  }, []);

  const handleMouseEnter = () => {
    if (delayRef.current) clearTimeout(delayRef.current);
    delayRef.current = setTimeout(() => setIsOpen(true), delay);
  };

  const handleMouseLeave = () => {
    if (delayRef.current) clearTimeout(delayRef.current);
    if (resolvedCloseDelay <= 0) {
      delayRef.current = null;
      setIsOpen(false);
      return;
    }
    delayRef.current = setTimeout(() => setIsOpen(false), resolvedCloseDelay);
  };

  if (!isValidElement(children)) {
    throw new Error('Tooltip children must be a single ReactElement');
  }

  const triggerElement = (
    <span
      ref={setTriggerElementNode}
      className="inline-flex"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
    >
      {children}
    </span>
  );

  return (
    <>
      {triggerElement}
      {isOpen &&
        position &&
        createPortal(
          <div
            ref={handleContentRef}
            role="tooltip"
            onMouseEnter={
              interactive
                ? () => {
                    // Cancel the pending close so the tooltip stays while hovered
                    if (delayRef.current) clearTimeout(delayRef.current);
                    delayRef.current = null;
                  }
                : undefined
            }
            onMouseLeave={interactive ? handleMouseLeave : undefined}
            className={clsx(
              'border-glass-border bg-bg-1 text-ink-1 fixed z-[10020] rounded-md border px-3 py-2 text-xs shadow-lg',
              interactive
                ? 'pointer-events-auto select-text'
                : 'pointer-events-none',
              className,
            )}
            style={{
              top: position.actualSide === 'bottom' ? position.top : undefined,
              bottom:
                position.actualSide === 'top'
                  ? window.innerHeight - position.top
                  : undefined,
              left: position.actualAlign === 'left' ? position.left : undefined,
              right:
                position.actualAlign === 'right'
                  ? window.innerWidth - position.left
                  : undefined,
              minWidth,
              maxWidth: position.maxWidth,
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
