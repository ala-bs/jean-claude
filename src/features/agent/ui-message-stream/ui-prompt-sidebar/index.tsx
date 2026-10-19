import { Loader2, PackageOpen } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RefObject } from 'react';



import { TaskTodoDropdown } from '@/features/task/ui-task-todo-dropdown';

import type { PromptNavigationItem } from '../message-merger';
import { usePromptNavigation } from '../use-prompt-navigation';

function ChipTooltip({
  text,
  triggerRef,
}: {
  text: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.top + rect.height / 2,
      left: rect.right + 8,
    });
  }, [triggerRef]);

  if (!pos) return null;

  return createPortal(
    <div
      role="tooltip"
      className="border-glass-border bg-bg-1 text-ink-1 pointer-events-none fixed z-50 max-w-64 rounded-md border px-3 py-2 text-xs shadow-lg"
      style={{ top: pos.top, left: pos.left, transform: 'translateY(-50%)' }}
    >
      <div className="[display:-webkit-box] overflow-hidden leading-relaxed break-words [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
        {text}
      </div>
    </div>,
    document.body,
  );
}

const PromptChip = memo(function PromptChip({
  item,
  isCompleted,
  isCurrent,
  isFuture,
  onNavigate,
}: {
  item: PromptNavigationItem;
  isCompleted: boolean;
  isCurrent: boolean;
  isFuture: boolean;
  onNavigate: (index: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const isCompaction = item.kind === 'compaction';

  const className = isCompaction
    ? `flex cursor-pointer items-center justify-center rounded-md transition-all ${
        isCurrent
          ? 'h-5 w-5 border border-amber-400/60 bg-amber-500/25 text-amber-200 shadow-[0_0_10px_oklch(0.78_0.15_75_/_0.35)]'
          : isFuture
            ? 'h-5 w-5 border border-dashed border-amber-400/25 text-amber-300/40 hover:border-amber-400/45'
            : 'h-5 w-5 border border-amber-400/30 bg-amber-500/12 text-amber-300/80 hover:bg-amber-500/22'
      }`
    : `flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-xs font-medium transition-all ${
        isCompleted
          ? 'bg-acc/15 text-acc-ink border-acc/25 hover:bg-acc/25 border'
          : isCurrent
            ? 'bg-acc text-white shadow-[0_0_12px_oklch(0.7_0.18_295_/_0.4)]'
            : isFuture
              ? 'border border-dashed border-white/20 text-white/40 hover:border-white/35'
              : ''
      }`;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onNavigate(item.index)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={
          item.kind === 'compaction'
            ? item.text
            : `Prompt ${item.promptNumber}`
        }
        className={className}
      >
        {item.kind === 'compaction' ? (
          item.isComplete ? (
            <PackageOpen className="h-3 w-3" aria-hidden />
          ) : (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          )
        ) : (
          item.promptNumber
        )}
      </button>
      {hovered && <ChipTooltip text={item.text} triggerRef={buttonRef} />}
    </div>
  );
});

export const PromptSidebar = memo(function PromptSidebar({
  scrollContainerRef,
  prompts,
  taskId,
  bottomPadding = 0,
}: {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  prompts: PromptNavigationItem[];
  taskId?: string;
  bottomPadding?: number;
}) {
  // Navigation scans DOM anchors 0..totalPrompts-1. Indices are assigned in
  // document order across prompts AND compactions, and empty prompts consume an
  // index without producing a rail item, so the count must come from the last
  // index rather than the rail item count.
  const totalPrompts =
    prompts.length === 0 ? 0 : prompts[prompts.length - 1].index + 1;

  const { currentIndex, goToPrompt } = usePromptNavigation({
    scrollContainerRef,
    totalPrompts,
  });

  const handleNavigate = useCallback(
    (index: number) => goToPrompt(index, { behavior: 'instant' }),
    [goToPrompt],
  );

  // Auto-scroll the sidebar to keep the current prompt chip visible
  const chipRefs = useRef<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    const el = chipRefs.current.get(currentIndex);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentIndex]);

  if (totalPrompts === 0) return null;

  return (
    <div
      className="flex min-h-0 shrink-0 flex-col items-center py-4 pr-1.5 pl-1.5"
      style={
        bottomPadding > 0 ? { marginBottom: bottomPadding + 8 } : undefined
      }
    >
      {taskId && (
        <div className="bg-bg-0/90 z-20 mb-2 shrink-0 rounded-md backdrop-blur-sm">
          <TaskTodoDropdown taskId={taskId} />
        </div>
      )}
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center gap-0 overflow-y-auto">
        {prompts.map((item, position) => {
          const isCompleted = item.index < currentIndex;
          const isCurrent = item.index === currentIndex;
          const isFuture = item.index > currentIndex;
          const isCompaction = item.kind === 'compaction';

          return (
            <div
              key={item.index}
              className="flex flex-col items-center"
              ref={(node) => {
                if (node) {
                  chipRefs.current.set(item.index, node);
                } else {
                  chipRefs.current.delete(item.index);
                }
              }}
            >
              {/* Connector line above (except first) */}
              {position > 0 && (
                <div
                  className={`${isCompaction ? 'h-2.5' : 'h-5'} w-px ${
                    item.index <= currentIndex
                      ? isCompaction
                        ? 'bg-amber-400/40'
                        : 'bg-acc/40'
                      : 'border-l border-dashed border-white/15'
                  }`}
                />
              )}

              <PromptChip
                item={item}
                isCompleted={isCompleted}
                isCurrent={isCurrent}
                isFuture={isFuture}
                onNavigate={handleNavigate}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
