import type { MouseEvent, ReactNode } from 'react';
import clsx from 'clsx';

export function WorkItemBoardPrimaryHeading({
  selectionControl,
  trailingControl,
  metadata,
  title,
  onOpen,
}: {
  selectionControl?: ReactNode;
  trailingControl?: ReactNode;
  metadata: ReactNode;
  title: ReactNode;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="relative min-w-0">
      {selectionControl && (
        <div className="absolute top-0 left-0 z-10">{selectionControl}</div>
      )}
      {trailingControl && (
        <div className="absolute top-0 right-0 z-10">{trailingControl}</div>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-acc flex w-full flex-col gap-1.5 text-left outline-none focus-visible:ring-1"
      >
        <span
          className={clsx(
            'flex items-center gap-1.5',
            selectionControl && 'pl-5',
            trailingControl && 'pr-6',
          )}
        >
          {metadata}
        </span>
        {title}
      </button>
    </div>
  );
}
