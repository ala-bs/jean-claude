import { AlertTriangle, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useState } from 'react';

import type {
  LogGroup,
  LogLine,
  LogNode,
  LogSeverity,
} from '../utils-ci-log-parser';


const severityText: Record<LogSeverity, string> = {
  error: 'text-red-400',
  warning: 'text-amber-300/90',
  success: 'text-emerald-400/90',
  info: 'text-neutral-400',
  plain: 'text-neutral-300',
};

function GroupRow({
  node,
  showTimestamps,
}: {
  node: LogGroup;
  showTimestamps: boolean;
}) {
  const [collapsed, setCollapsed] = useState(node.defaultCollapsed);
  const count = node.lineCount;

  return (
    <div>
      <button
        onClick={() => setCollapsed((p) => !p)}
        className="flex w-full items-center gap-1.5 py-[2px] pr-3 pl-2 text-left hover:bg-neutral-800/60"
      >
        {collapsed ? (
          <ChevronRight className="h-2.5 w-2.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronDown className="h-2.5 w-2.5 shrink-0 text-neutral-500" />
        )}
        <span
          className={clsx(
            'min-w-0 truncate',
            node.kind === 'section'
              ? 'font-semibold text-neutral-100'
              : node.kind === 'banner'
                ? 'text-neutral-500'
                : 'text-neutral-200',
          )}
        >
          {node.title}
        </span>
        {node.severity === 'error' && (
          <XCircle className="h-2.5 w-2.5 shrink-0 text-red-400" />
        )}
        {node.severity === 'warning' && (
          <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-amber-400" />
        )}
        {node.detail && (
          <span className="shrink-0 text-neutral-500">{node.detail}</span>
        )}
        {collapsed && count > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
            {count} lines
          </span>
        )}
      </button>
      {/* Indent comes from this wrapper only, so nesting does not compound. */}
      {!collapsed && (
        <div className="ml-3 border-l border-neutral-800">
          <LogNodes nodes={node.children} showTimestamps={showTimestamps} />
        </div>
      )}
    </div>
  );
}

function LineRow({
  node,
  showTimestamps,
}: {
  node: LogLine;
  showTimestamps: boolean;
}) {
  const isError = node.severity === 'error';
  const isWarning = node.severity === 'warning';

  return (
    <div
      className={clsx(
        'flex',
        isError && 'border-l-2 border-l-red-500 bg-red-500/10',
        isWarning && 'border-l-2 border-l-amber-500/70 bg-amber-500/[0.06]',
        !isError && !isWarning && 'border-l-2 border-l-transparent',
      )}
    >
      {showTimestamps && (
        <span className="w-[68px] shrink-0 pr-2 text-right text-neutral-600 select-none">
          {node.timestamp?.slice(11, 19)}
        </span>
      )}
      <span className="w-11 shrink-0 pr-2 text-right text-neutral-700 select-none">
        {node.lineNumber}
      </span>
      {node.code && (
        <span className="shrink-0 pr-2 text-neutral-600 select-none">
          {node.code}
        </span>
      )}
      <span
        className={clsx(
          'min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap',
          node.kind === 'command' && 'text-sky-300/90',
          node.kind !== 'command' && severityText[node.severity],
        )}
      >
        {node.kind === 'command' && (
          <span className="text-neutral-600 select-none">$ </span>
        )}
        {node.text}
      </span>
    </div>
  );
}

function LogNodes({
  nodes,
  showTimestamps,
}: {
  nodes: LogNode[];
  showTimestamps: boolean;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.type === 'group' ? (
          <GroupRow
            // Severity/default in the key: when a running build's log is
            // re-fetched and a step turns warning/error, remount so it expands.
            key={`g-${node.lineNumber}-${node.severity}-${node.defaultCollapsed}`}
            node={node}
            showTimestamps={showTimestamps}
          />
        ) : (
          <LineRow
            key={`l-${node.lineNumber}`}
            node={node}
            showTimestamps={showTimestamps}
          />
        ),
      )}
    </>
  );
}

export function CiLogView({
  nodes,
  showTimestamps,
}: {
  nodes: LogNode[];
  showTimestamps: boolean;
}) {
  return <LogNodes nodes={nodes} showTimestamps={showTimestamps} />;
}
