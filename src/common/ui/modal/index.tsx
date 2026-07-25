import { type ReactNode, type RefObject, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import FocusLock from 'react-focus-lock';
import { RemoveScroll } from 'react-remove-scroll';
import { X } from 'lucide-react';



import { useModalArbitration } from '@/common/context/modal-arbitration';
import { useRegisterKeyboardBindings } from '@/common/context/keyboard-bindings';

const modalSizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-7xl',
} as const;

const openModalIds: string[] = [];

function isTopModal(id: string) {
  return openModalIds[openModalIds.length - 1] === id;
}

export function Modal({
  isOpen,
  onClose,
  title,
  size = 'md',
  closeOnClickOutside = true,
  closeOnEscape = true,
  closeDisabled = false,
  contentRef,
  showHeader = true,
  contentClassName = 'min-h-0 overflow-y-auto p-4',
  overlayClassName = 'z-50',
  panelClassName = '',
  ariaLabel,
  ariaDescribedBy,
  arbitrationPriority = 50,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  closeOnClickOutside?: boolean;
  closeOnEscape?: boolean;
  closeDisabled?: boolean;
  contentRef?: RefObject<HTMLDivElement | null>;
  showHeader?: boolean;
  contentClassName?: string;
  overlayClassName?: string;
  panelClassName?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  arbitrationPriority?: number;
  children: ReactNode;
}) {
  const id = useId();
  const ownsArbitration = useModalArbitration(isOpen, arbitrationPriority);
  const isActuallyOpen = isOpen && ownsArbitration;

  useEffect(() => {
    if (!isActuallyOpen) return;
    openModalIds.push(id);
    return () => {
      const index = openModalIds.lastIndexOf(id);
      if (index !== -1) {
        openModalIds.splice(index, 1);
      }
    };
  }, [id, isActuallyOpen]);

  useRegisterKeyboardBindings(
    `modal-${id}`,
    isActuallyOpen && closeOnEscape && !closeDisabled
      ? {
          escape: () => {
            if (!isTopModal(id)) return false;
            onClose();
            return true;
          },
        }
      : {},
  );

  useEffect(() => {
    if (!isActuallyOpen || !closeOnEscape || closeDisabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      if (!isTopModal(id)) return;

      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [id, isActuallyOpen, closeDisabled, closeOnEscape, onClose]);

  if (!isActuallyOpen) return null;

  const handleBackdropClick = () => {
    if (closeOnClickOutside && !closeDisabled) {
      onClose();
    }
  };

  return createPortal(
    <FocusLock returnFocus>
      <RemoveScroll>
        <div
          className={`bg-bg-0/50 fixed inset-0 flex items-center justify-center ${overlayClassName}`}
          onClick={handleBackdropClick}
        >
          <div
            ref={contentRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            className={`flex max-h-[85vh] w-full ${modalSizeClasses[size]} bg-bg-1 flex-col rounded-lg shadow-xl ${panelClassName}`}
            onClick={(e) => e.stopPropagation()}
          >
            {showHeader && (
              <div className="border-glass-border flex items-center justify-between border-b px-4 py-3">
                {title ? (
                  <h2 className="text-ink-0 text-lg font-semibold">{title}</h2>
                ) : (
                  <div />
                )}
                {!closeDisabled && (
                  <button
                    onClick={onClose}
                    aria-label="Close dialog"
                    className="text-ink-2 hover:bg-glass-medium hover:text-ink-1 rounded p-1"
                  >
                    <X className="h-5 w-5" aria-hidden />
                  </button>
                )}
              </div>
            )}
            <div className={contentClassName}>{children}</div>
          </div>
        </div>
      </RemoveScroll>
    </FocusLock>,
    document.body,
  );
}
