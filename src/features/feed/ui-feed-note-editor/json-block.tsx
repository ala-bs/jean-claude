import { Braces, Maximize2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import type { MouseEvent } from 'react';

import {
  describeJson,
  formatJsonSize,
  JSON_BLOCK_TYPE,
  summarizeJsonText,
} from '@shared/json-snippet';
import { JsonViewerModal } from '@/common/ui/json-viewer';

export { JSON_BLOCK_TYPE };

function JsonSnippetCard({ json }: { json: string }) {
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const close = useCallback(() => setIsViewerOpen(false), []);

  // The card lives inside a contenteditable surface: keep clicks from moving
  // the editor selection or starting a drag on the block.
  const open = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsViewerOpen(true);
  }, []);

  const summary = useMemo(() => summarizeJsonText(json), [json]);

  return (
    <div
      className="w-full py-1"
      contentEditable={false}
      suppressContentEditableWarning
      data-testid="feed-note-json-block"
    >
      <button
        type="button"
        onClick={open}
        onMouseDown={(event) => event.stopPropagation()}
        className="bg-surface-container-low border-line-soft hover:border-acc-line hover:bg-surface-container flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors"
      >
        <Braces className="size-4 shrink-0 text-violet-300" />
        <div className="min-w-0 flex-1">
          <div className="text-ink-1 text-sm font-medium">
            {summary
              ? `${describeJson(summary)} · ${formatJsonSize(json.length)}`
              : 'JSON'}
          </div>
          {summary?.preview ? (
            <div className="text-ink-3 truncate font-mono text-xs">
              {summary.preview}
            </div>
          ) : null}
        </div>
        <span className="text-ink-3 flex shrink-0 items-center gap-1 text-xs">
          <Maximize2 className="size-3" />
          View
        </span>
      </button>

      {isViewerOpen ? (
        <JsonViewerModal isOpen onClose={close} json={json} title="JSON" />
      ) : null}
    </div>
  );
}

export const jsonBlockSpec = createReactBlockSpec(
  {
    type: JSON_BLOCK_TYPE,
    content: 'none',
    propSchema: {
      json: { default: '' },
    },
  },
  {
    render: ({ block }) => <JsonSnippetCard json={block.props.json} />,
  },
);
