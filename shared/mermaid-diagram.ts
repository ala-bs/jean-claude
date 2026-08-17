const SUPPORTED_DECLARATION =
  /^\s*(?:flowchart|graph|stateDiagram(?:-v2)?|sequenceDiagram)(?:\s|$)/;

const UNSAFE_MERMAID_SOURCE =
  /(?:^|[\n;])\s*(?:click\b|href\b|[a-z0-9_-]+\s+href\b)|%%\{|<\/?[a-z][^>]*>/i;

export function isSafeMermaidSource(source: string): boolean {
  return (
    SUPPORTED_DECLARATION.test(source) && !UNSAFE_MERMAID_SOURCE.test(source)
  );
}
