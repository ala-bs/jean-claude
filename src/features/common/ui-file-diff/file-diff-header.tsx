import clsx from 'clsx';
import { MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';



import { Chip } from '@/common/ui/chip';
import { Separator } from '@/common/ui/separator';

import type { DiffFile } from './types';
import { DiffStatusBadge } from './status-badge';


export function FileDiffHeader({
  file,
  className,
  commentCount,
  hasAnnotations,
  actions,
}: {
  file: DiffFile;
  className?: string;
  commentCount?: number;
  hasAnnotations?: boolean;
  actions?: ReactNode;
}) {
  return (
    <>
      <div
        className={clsx(
          'bg-bg-1/50 flex items-center gap-2 overflow-hidden px-4 py-2',
          className,
        )}
      >
        <DiffStatusBadge status={file.status} />
        <div
          className="text-ink-1 min-w-0 shrink overflow-hidden text-left font-mono text-sm text-ellipsis whitespace-nowrap [direction:rtl] [unicode-bidi:plaintext]"
          title={file.path}
        >
          {file.path}
        </div>
        {file.status === 'renamed' && file.originalPath && (
          <span className="text-ink-3 text-xs">← {file.originalPath}</span>
        )}
        {hasAnnotations && (
          <span
            className="text-status-run/70 flex items-center gap-1"
            title="Has AI annotations"
          >
            <MessageCircle className="h-3.5 w-3.5" aria-hidden />
          </span>
        )}
        {commentCount !== undefined && commentCount > 0 && (
          <Chip size="xs" color="blue" pill>
            {commentCount} comment{commentCount !== 1 ? 's' : ''}
          </Chip>
        )}
        {actions && <div className="ml-auto shrink-0">{actions}</div>}
      </div>
      <Separator />
    </>
  );
}
