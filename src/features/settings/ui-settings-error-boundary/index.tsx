import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render/commit errors thrown by a settings section.
 *
 * Without a boundary here an uncaught error unmounts the whole React root, so
 * the settings panel just goes blank with no clue about what failed. This
 * keeps the app alive and shows the actual error + component stack.
 */
export class SettingsErrorBoundary extends Component<
  { children: ReactNode; sectionLabel?: string },
  { error: Error | null; componentStack: string | null }
> {
  state: { error: Error | null; componentStack: string | null } = {
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: Error) {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(
      `[settings] section "${this.props.sectionLabel ?? 'unknown'}" crashed:`,
      error,
      errorInfo.componentStack,
    );
    this.setState({ componentStack: errorInfo.componentStack ?? null });
  }

  handleRetry = () => {
    this.setState({ error: null, componentStack: null });
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4">
        <div className="text-sm font-semibold text-red-300">
          This settings section crashed
        </div>
        <pre className="text-ink-2 mt-2 max-h-40 overflow-auto rounded bg-black/30 p-3 font-mono text-xs whitespace-pre-wrap">
          {error.message}
        </pre>
        {componentStack && (
          <details className="mt-2">
            <summary className="text-ink-3 cursor-pointer text-xs">
              Component stack
            </summary>
            <pre className="text-ink-3 mt-1 max-h-40 overflow-auto rounded bg-black/30 p-3 font-mono text-[10px] whitespace-pre-wrap">
              {componentStack}
            </pre>
          </details>
        )}
        <button
          type="button"
          onClick={this.handleRetry}
          className="text-ink-1 mt-3 rounded border border-white/20 px-3 py-1 text-xs hover:bg-white/10"
        >
          Try again
        </button>
      </div>
    );
  }
}
