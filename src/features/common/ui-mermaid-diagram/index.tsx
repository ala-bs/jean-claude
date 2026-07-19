import { useEffect, useId, useState } from 'react';

import { isSafeMermaidSource } from '@shared/mermaid-diagram';

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; source: string; svg: string }
  | { status: 'error'; source: string };

export function MermaidDiagram({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const reactId = useId();
  const [state, setState] = useState<RenderState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        if (!isSafeMermaidSource(source)) {
          throw new Error('Unsupported Mermaid directive');
        }
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          flowchart: { htmlLabels: false },
        });
        const id = `work-item-summary-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) setState({ status: 'ready', source, svg });
      } catch {
        if (!cancelled) setState({ status: 'error', source });
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [reactId, source]);

  if (state.status === 'ready' && state.source === source) {
    return (
      <div
        className={className}
        data-testid="mermaid-diagram"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }

  if (state.status === 'error' && state.source === source) {
    return (
      <pre className={className} data-testid="mermaid-fallback">
        {source}
      </pre>
    );
  }

  return (
    <div className={className} data-testid="mermaid-loading">
      Rendering diagram…
    </div>
  );
}
