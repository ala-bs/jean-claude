/**
 * CI log parser (Azure Pipelines / Yarn aware).
 *
 * Turns raw log text into a tree of nodes so the UI can render collapsible
 * sections instead of a wall of timestamped text.
 *
 *   raw line                                     -> node
 *   ------------------------------------------------------------------
 *   2026-..Z ##[section]Starting: Setup yarn      -> group (section)
 *   2026-..Z ##[error]something broke             -> line (error)
 *   2026-..Z [command]/usr/bin/bash ...           -> line (command)
 *   2026-..Z ➤ YN0000: ┌ Resolution step          -> group (yarn)
 *   2026-..Z ➤ YN0060: │ ...peer dep...           -> line (warning, code YN0060)
 *   2026-..Z ==========================           -> dropped / banner
 */

export type LogSeverity = 'error' | 'warning' | 'success' | 'info' | 'plain';

export type LogLineKind =
  | 'text'
  | 'command'
  | 'error'
  | 'warning'
  | 'debug'
  | 'banner'
  | 'separator';

export type LogLine = {
  type: 'line';
  /** 1-based index in the raw log, for line numbers + copy fidelity. */
  lineNumber: number;
  timestamp?: string;
  text: string;
  kind: LogLineKind;
  severity: LogSeverity;
  /** e.g. `YN0060` for yarn lines. */
  code?: string;
};

export type LogGroup = {
  type: 'group';
  kind: 'section' | 'group' | 'yarn' | 'banner';
  title: string;
  /** trailing info, e.g. `Completed in 26s 609ms` */
  detail?: string;
  severity: LogSeverity;
  children: LogNode[];
  lineNumber: number;
  defaultCollapsed: boolean;
  /** Leaf lines contained in this group (recursive), precomputed for rendering. */
  lineCount: number;
};

export type LogNode = LogLine | LogGroup;

export type ParsedLog = {
  nodes: LogNode[];
  /** Raw line count of the source log. */
  totalLines: number;
  /** Lines actually rendered (blank lines / rulers dropped). */
  visibleLines: number;
  errorCount: number;
  warningCount: number;
};

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;
const SEPARATOR_RE = /^([=\-_*#~]|\s)+$/;
const BANNER_FIELD_RE = /^(Task|Description|Version|Author|Help)\s*:/;
const YARN_RE = /^➤\s+(YN\d{4}):\s?([┌└│├])?\s?(.*)$/;
const AZDO_RE = /^##\[([a-z]+)\](.*)$/;
// Glyphs must not use `\b` (it never matches after a non-word char).
const ERROR_HINT_RE =
  /^\s*(?:(?:error|fatal|fail(?:ed|ure|s)?)\b|[✖✗×]|\d+ problems? \()/i;
const WARNING_HINT_RE = /^\s*(?:warn(?:ing)?s?\b|⚠)/i;
const YARN_WARNING_CODES = new Set([
  'YN0002',
  'YN0007',
  'YN0060',
  'YN0086',
  'YN0059',
  'YN0061',
  'YN0062',
  'YN0068',
  'YN0074',
]);
const YARN_ERROR_CODES = new Set([
  'YN0001', // exception
  'YN0009', // build failed
  'YN0010', // invalid lockfile
  'YN0011', // network error
  'YN0028', // frozen lockfile changed
  'YN0035', // network error
  'YN0046', // automerge failed
  'YN0071', // nm can't be built
  'YN0072', // nm hoisting failed
  'YN0080', // network disabled
  'YN0081', // network unsafe http
  'YN0082', // resolution not found
  'YN0083', // remote invalid
]);

function yarnSeverity(code: string, text: string): LogSeverity {
  if (YARN_ERROR_CODES.has(code)) return 'error';
  if (/^Failed with errors/.test(text)) return 'error';
  if (YARN_WARNING_CODES.has(code)) return 'warning';
  if (/with warnings/.test(text)) return 'warning';
  if (/^Done(\s|$)/.test(text)) return 'success';
  return 'info';
}

function bubble(severity: LogSeverity, child: LogSeverity): LogSeverity {
  const rank: Record<LogSeverity, number> = {
    plain: 0,
    info: 1,
    success: 1,
    warning: 2,
    error: 3,
  };
  return rank[child] > rank[severity] ? child : severity;
}

export function parseCiLog(
  raw: string,
  opts?: { errorMessages?: Set<string> },
): ParsedLog {
  const rawLines = raw.replace(/\r\n?/g, '\n').split('\n');
  const root: LogNode[] = [];
  /** Stack of open groups; last is innermost. */
  const stack: LogGroup[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let visibleLines = 0;
  /** True when the previous line was a `====`/`----` ruler. */
  let afterRuler = false;

  const container = () =>
    stack.length > 0 ? stack[stack.length - 1].children : root;

  const push = (node: LogNode) => {
    container().push(node);
    if (node.type === 'line') {
      visibleLines++;
      for (const g of stack) g.lineCount++;
    }
    if (node.severity === 'error' || node.severity === 'warning') {
      for (const g of stack) g.severity = bubble(g.severity, node.severity);
    }
  };

  const open = (partial: Omit<LogGroup, 'lineCount'>) => {
    const group: LogGroup = { ...partial, lineCount: 0 };
    container().push(group);
    stack.push(group);
  };

  const closeUntil = (kinds: LogGroup['kind'][]) => {
    // Unbalanced end markers are common (a task can emit `##[endgroup]` with no
    // matching `##[group]`). Never pop past the target kind, or the rest of the
    // log would escape its enclosing section.
    if (!stack.some((g) => kinds.includes(g.kind))) return undefined;
    while (stack.length > 0) {
      const top = stack.pop()!;
      if (kinds.includes(top.kind)) return top;
    }
    return undefined;
  };

  rawLines.forEach((rawLine, idx) => {
    const lineNumber = idx + 1;
    let text = rawLine.replace(ANSI_RE, '');
    let timestamp: string | undefined;
    const tsMatch = TIMESTAMP_RE.exec(text);
    if (tsMatch) {
      timestamp = tsMatch[1];
      text = text.slice(tsMatch[0].length);
    }
    text = text.replace(/\s+$/, '');

    const line = (
      partial: Partial<LogLine> & { kind: LogLineKind; severity: LogSeverity },
    ): LogLine => ({
      type: 'line',
      lineNumber,
      timestamp,
      text,
      ...partial,
    });

    // Blank lines: skip entirely (they carry no signal in CI logs).
    if (text.trim() === '') return;

    // --- Azure DevOps directives -----------------------------------------
    const azdo = AZDO_RE.exec(text);
    if (azdo) {
      const [, directive, rest] = azdo;
      const body = rest.trim();
      if (directive === 'section') {
        const start = /^Starting:\s*(.*)$/.exec(body);
        if (start) {
          open({
            type: 'group',
            kind: 'section',
            title: start[1],
            severity: 'info',
            children: [],
            lineNumber,
            defaultCollapsed: false,
          });
          return;
        }
        const finish = /^Finishing:\s*(.*)$/.exec(body);
        if (finish) {
          closeUntil(['section']);
          return;
        }
      }
      if (directive === 'group') {
        open({
          type: 'group',
          kind: 'group',
          title: body,
          severity: 'info',
          children: [],
          lineNumber,
          defaultCollapsed: true,
        });
        return;
      }
      if (directive === 'endgroup') {
        closeUntil(['group']);
        return;
      }
      if (directive === 'error') {
        errorCount++;
        push(line({ kind: 'error', severity: 'error', text: body }));
        return;
      }
      if (directive === 'warning') {
        warningCount++;
        push(line({ kind: 'warning', severity: 'warning', text: body }));
        return;
      }
      if (directive === 'command') {
        push(line({ kind: 'command', severity: 'info', text: body }));
        return;
      }
      if (directive === 'debug') {
        push(line({ kind: 'debug', severity: 'plain', text: body }));
        return;
      }
      push(line({ kind: 'text', severity: 'plain', text: body }));
      return;
    }

    // Azure also emits a bare `[command]...` prefix (no `##`).
    const bareCommand = /^\[command\](.*)$/.exec(text);
    if (bareCommand) {
      push(
        line({ kind: 'command', severity: 'info', text: bareCommand[1].trim() }),
      );
      return;
    }

    // --- Task metadata banner --------------------------------------------
    // Only treat `Task :`/`Version :`… as banner fields when we are already in a
    // banner or the previous line was a `====` ruler; otherwise a legitimate
    // `Version: 1.2.3` log line would be hidden in a collapsed group.
    if (BANNER_FIELD_RE.test(text)) {
      const top = stack[stack.length - 1];
      if (top?.kind === 'banner') {
        push(line({ kind: 'banner', severity: 'plain' }));
        afterRuler = false;
        return;
      }
      if (afterRuler) {
        const label = /^Task\s*:\s*(.*)$/.exec(text);
        open({
          type: 'group',
          kind: 'banner',
          title: label ? `Task: ${label[1]}` : 'Task metadata',
          severity: 'plain',
          children: [],
          lineNumber,
          defaultCollapsed: true,
        });
        if (!label) push(line({ kind: 'banner', severity: 'plain' }));
        afterRuler = false;
        return;
      }
    }

    // Separators / rulers: drop them, they only add noise.
    if (SEPARATOR_RE.test(text)) {
      if (stack[stack.length - 1]?.kind === 'banner') closeUntil(['banner']);
      afterRuler = true;
      return;
    }
    afterRuler = false;
    if (stack[stack.length - 1]?.kind === 'banner') closeUntil(['banner']);

    // "======= Starting Command Output =======" style headers.
    if (/Starting Command Output/i.test(text)) return;

    // --- Yarn (Berry) structured output ----------------------------------
    const yarn = YARN_RE.exec(text);
    if (yarn) {
      const [, code, glyph, body] = yarn;
      const severity = yarnSeverity(code, body);
      if (glyph === '┌') {
        open({
          type: 'group',
          kind: 'yarn',
          title: body,
          severity: 'info',
          children: [],
          lineNumber,
          defaultCollapsed: true,
        });
        return;
      }
      if (glyph === '└') {
        const closed = closeUntil(['yarn']);
        if (closed) {
          closed.detail = body || undefined;
          closed.severity = bubble(closed.severity, severity);
          if (severity === 'warning') warningCount++;
          if (severity === 'error') errorCount++;
          // Keep failing/warning steps open by default.
          closed.defaultCollapsed =
            closed.severity !== 'warning' && closed.severity !== 'error';
          for (const g of stack) g.severity = bubble(g.severity, closed.severity);
          return;
        }
      }
      if (severity === 'warning') warningCount++;
      if (severity === 'error') errorCount++;
      push(line({ kind: 'text', severity, text: body, code }));
      return;
    }

    // --- Plain text, with heuristic severity ------------------------------
    let severity: LogSeverity = 'plain';
    let kind: LogLineKind = 'text';
    if (opts?.errorMessages?.has(text.trim())) {
      severity = 'error';
      kind = 'error';
      errorCount++;
    } else if (ERROR_HINT_RE.test(text)) {
      severity = 'error';
      kind = 'error';
      errorCount++;
    } else if (WARNING_HINT_RE.test(text)) {
      severity = 'warning';
      kind = 'warning';
      warningCount++;
    } else if (/^\s*\$\s/.test(text) || /^Script contents:/.test(text)) {
      kind = 'command';
      severity = 'info';
    }
    push(line({ kind, severity }));
  });

  return {
    nodes: root,
    totalLines: rawLines.length,
    visibleLines,
    errorCount,
    warningCount,
  };
}

/** Count of renderable leaf lines under a node (for group summaries). */
export function countLines(nodes: LogNode[]): number {
  return nodes.reduce(
    (acc, n) => acc + (n.type === 'line' ? 1 : countLines(n.children)),
    0,
  );
}
