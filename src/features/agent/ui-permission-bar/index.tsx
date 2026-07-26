import {
  Check,
  ChevronDown,
  Copy,
  FolderTree,
  MessageSquare,
  MoreHorizontal,
  Send,
  Shield,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';

import { buildBashSuggestions, type PermissionSuggestion } from '@shared/permission-suggestions';
import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { Button } from '@/common/ui/button';
import type { InteractionMode } from '@shared/types';
import type { NormalizedPermissionRequest } from '@shared/normalized-message-v2';
import type { PermissionResponse } from '@shared/agent-types';
import { Textarea } from '@/common/ui/textarea';
import { useModal } from '@/common/context/modal';


import { MarkdownContent } from '../ui-markdown-content';

/**
 * Format a file path relative to the worktree if it's a subpath.
 * Returns { displayPath, isExternal } where isExternal is true if the path is outside the worktree.
 */
function formatPathRelativeToWorktree(
  filePath: string,
  worktreePath?: string | null,
): { displayPath: string; isExternal: boolean } {
  if (!worktreePath) {
    return { displayPath: filePath, isExternal: false };
  }

  // Normalize paths (ensure no trailing slash for comparison)
  const normalizedWorktree = worktreePath.replace(/\/$/, '');
  const normalizedFile = filePath.replace(/\/$/, '');

  if (normalizedFile.startsWith(normalizedWorktree + '/')) {
    const relativePath = normalizedFile.slice(normalizedWorktree.length + 1);
    return { displayPath: `<worktree>/${relativePath}`, isExternal: false };
  }

  if (normalizedFile === normalizedWorktree) {
    return { displayPath: '<worktree>', isExternal: false };
  }

  // Path is external to the worktree
  return { displayPath: filePath, isExternal: true };
}

function ToolInputDisplay({
  toolName,
  input,
  worktreePath,
  commandExpanded = false,
}: {
  toolName: string;
  input: Record<string, unknown>;
  worktreePath?: string | null;
  commandExpanded?: boolean;
}) {
  switch (toolName) {
    case 'Bash':
      return (
        <pre
          className={`bg-bg-1 text-ink-1 rounded px-2 py-1 text-sm break-all whitespace-pre-wrap ${!commandExpanded ? 'max-h-24 overflow-hidden' : ''}`}
          title={String(input.command || '')}
        >
          {String(input.command || '')}
        </pre>
      );

    case 'Write':
    case 'Read':
    case 'Edit': {
      const filePath = String(input.filePath || input.file_path || '');
      const { displayPath, isExternal } = formatPathRelativeToWorktree(
        filePath,
        worktreePath,
      );
      return (
        <code
          className={`block truncate text-sm ${
            isExternal ? 'text-orange-400' : 'text-ink-1'
          }`}
          title={isExternal ? `External path: ${filePath}` : filePath}
        >
          {displayPath}
        </code>
      );
    }

    case 'external_directory': {
      const filePath = String(input.filepath || input.parentDir || '');
      return (
        <code
          className="block truncate text-sm text-orange-400"
          title={`External path: ${filePath}`}
        >
          {filePath}
        </code>
      );
    }

    case 'Glob':
    case 'Grep':
      return (
        <code className="text-ink-1 block truncate text-sm">
          {String(input.pattern || '')}
        </code>
      );

    case 'WebSearch':
      return (
        <span className="text-ink-1 text-sm">{String(input.query || '')}</span>
      );

    case 'WebFetch':
      return (
        <code className="text-ink-1 block truncate text-sm">
          {String(input.url || '')}
        </code>
      );

    // ExitPlanMode is handled specially in PermissionBar component
    case 'ExitPlanMode':
      return null;

    case 'Task':
      return (
        <div className="text-ink-1 text-sm">
          Launch{' '}
          <span className="font-medium text-yellow-400">
            {String(input.subagent_type)}
          </span>{' '}
          agent: {String(input.description || '')}
        </div>
      );

    default:
      return (
        <pre className="bg-bg-1 text-ink-2 rounded p-2 text-xs break-all whitespace-pre-wrap">
          {JSON.stringify(input, null, 2)}
        </pre>
      );
  }
}

function ExitPlanModeDisplay({
  input,
}: {
  input: {
    plan?: string;
    allowedPrompts?: Array<{ tool: string; prompt: string }>;
  };
}) {
  const { plan, allowedPrompts } = input;

  return (
    <div className="space-y-3">
      {plan && (
        <div className="border-glass-border bg-bg-1/50 rounded border p-3 text-xs">
          <MarkdownContent content={plan} />
        </div>
      )}
      {allowedPrompts?.length ? (
        <div>
          <div className="text-ink-2 mb-1 text-xs">Requested permissions:</div>
          <ul className="text-ink-1 list-inside list-disc space-y-0.5 text-sm">
            {allowedPrompts.map((p, i) => (
              <li key={i}>
                <span className="text-yellow-400">{p.tool}</span>: {p.prompt}
              </li>
            ))}
          </ul>
        </div>
      ) : !plan ? (
        <span className="text-ink-2 text-sm">Submit plan for approval</span>
      ) : null}
    </div>
  );
}

type SubCommandEval = NonNullable<
  NonNullable<NormalizedPermissionRequest['permissionEvaluation']>['subCommands']
>[number];

/**
 * Render a compound bash command as one row per sub-command so it is obvious
 * which part is blocked and which rule (if any) already covers the rest.
 */
function SubCommandBreakdown({
  subCommands,
  expanded,
}: {
  subCommands: SubCommandEval[];
  expanded: boolean;
}) {
  return (
    <div className="bg-bg-1 divide-glass-border/60 divide-y rounded">
      {subCommands.map((sub, index) => {
        const isAllowed = sub.action === 'allow';
        const isDenied = sub.action === 'deny';
        return (
          <div
            key={`${index}-${sub.command}`}
            className="flex items-start gap-2 px-2 py-1.5"
          >
            <span className="mt-0.5 shrink-0" title={sub.action}>
              {isAllowed ? (
                <Check className="h-3.5 w-3.5 text-green-400" />
              ) : isDenied ? (
                <X className="h-3.5 w-3.5 text-red-400" />
              ) : (
                <TriangleAlert className="h-3.5 w-3.5 text-yellow-400" />
              )}
            </span>
            <code
              className={`text-ink-1 min-w-0 flex-1 text-sm break-all whitespace-pre-wrap ${
                expanded ? '' : 'max-h-10 overflow-hidden'
              }`}
              title={sub.command}
            >
              {sub.command}
            </code>
            <span
              className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                isAllowed
                  ? 'bg-green-400/10 text-green-300'
                  : isDenied
                    ? 'bg-red-400/10 text-red-300'
                    : 'bg-yellow-400/10 text-yellow-300'
              }`}
              title={
                sub.matchedRule
                  ? `${sub.matchedRule.tool}: ${sub.matchedRule.pattern}`
                  : 'no matching rule'
              }
            >
              {sub.matchedRule ? sub.matchedRule.pattern : 'no rule'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Tools that support "Allow All" (blanket allow for the tool, not just this file) */
const ALLOW_ALL_TOOLS = new Set(['Read', 'Glob', 'Grep']);

export function PermissionBar({
  request,
  onRespond,
  onAllowForSession,
  onAllowForProject,
  onAllowForProjectWorktrees,
  onAllowGlobally,
  onSetMode,
  worktreePath,
}: {
  request: NormalizedPermissionRequest & { taskId: string };
  onRespond: (
    requestId: string,
    response: PermissionResponse,
  ) => void | Promise<void>;
  onAllowForSession?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  onAllowForProject?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  onAllowForProjectWorktrees?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  onAllowGlobally?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  onSetMode?: (mode: InteractionMode) => void;
  worktreePath?: string | null;
}) {
  const modal = useModal();
  const [isOtherOpen, setIsOtherOpen] = useState(false);
  const [otherMessage, setOtherMessage] = useState('');
  const [isCommandExpanded, setIsCommandExpanded] = useState(false);
  const directoryDropdownRef = useRef<{ toggle: () => void } | null>(null);

  const input = request.input;
  const permissionInput =
    request.toolName === 'Bash'
      ? { ...input, __permissionExact: true }
      : input;
  const isExitPlanMode = request.toolName === 'ExitPlanMode';
  const sessionAllowButton = request.sessionAllowButton;
  const directoryAccess = request.directoryAccess;
  const showAllowAll =
    !directoryAccess && ALLOW_ALL_TOOLS.has(request.toolName);
  const command = String(input.command || '');
  // The command block is clamped to max-h-24 (~6 lines), so the expand/copy
  // controls must appear for tall multi-line commands too, not just long ones.
  const isCommandClamped =
    command.length > 180 || command.split('\n').length > 5;
  const isRiskyCommand =
    request.toolName === 'Bash' &&
    /\b(rm\s+-rf|sudo|chmod\s+777|curl\b.*\|\s*(sh|bash)|mkfs|dd\s+if=)/i.test(
      command,
    );

  const subCommands = request.permissionEvaluation?.subCommands ?? [];
  const showBreakdown = request.toolName === 'Bash' && subCommands.length > 1;
  const unmatchedCount = subCommands.filter(
    (sub) => sub.action !== 'allow',
  ).length;

  // Parts that must be covered for this command to stop prompting.
  //
  // Backends other than claude-code don't send a breakdown. The evaluator
  // still splits compound commands, so a rule holding the whole `a && b`
  // string could never match — suggest nothing rather than a dead rule.
  //
  // Directory-access prompts are about workspace roots (a Bash pattern would
  // not unblock them) and risky commands should be reviewed, never one-click
  // persisted — both suppress suggestions entirely.
  const blockingParts =
    request.toolName !== 'Bash' || !command || directoryAccess || isRiskyCommand
      ? []
      : subCommands.length > 0
        ? subCommands
            .filter((sub) => sub.action !== 'allow')
            .map((sub) => sub.command)
        : /[;|&]/.test(command)
          ? []
          : [command];

  /**
   * One chip per breadth level, each covering EVERY blocking part — granting
   * a chip must actually stop the prompt, otherwise "auto-allow next time"
   * would be a lie for multi-part commands.
   */
  const suggestionGroups = (() => {
    if (blockingParts.length === 0) return [];
    const perPart = blockingParts.map(buildBashSuggestions);
    if (perPart.some((list) => list.length === 0)) return [];

    const groups: Array<{ key: string; label: string; patterns: string[] }> = [];
    const seenKeys = new Set<string>();
    for (const breadth of [0, 1, 2]) {
      const picked = perPart.map((list) =>
        list.find((suggestion) => suggestion.breadth === breadth),
      );
      if (picked.some((suggestion) => suggestion === undefined)) continue;
      const chosen = picked as PermissionSuggestion[];
      const patterns = [...new Set(chosen.map((s) => s.pattern))];
      const key = patterns.join(' ');
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      groups.push({
        key,
        label: [...new Set(chosen.map((s) => s.label))].join(' + '),
        patterns,
      });
    }
    return groups;
  })();

  const handleGrantSuggestion = async (patterns: string[]) => {
    try {
      for (const pattern of patterns) {
        await onAllowForProject?.('Bash', { command: pattern });
      }
    } catch {
      return;
    }
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
      allowMode: 'project',
    });
  };

  const handleAllow = () => {
    if (sessionAllowButton?.setModeOnAllow) {
      onSetMode?.(sessionAllowButton.setModeOnAllow);
    }
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
    });
  };

  // For ExitPlanMode, the session allow is about Edit+Write, not ExitPlanMode itself.
  // For all other tools, we pass the raw toolName+input to the backend.
  const allowForSession = async () => {
    if (isExitPlanMode) {
      await Promise.all([
        onAllowForSession?.('Edit', {}),
        onAllowForSession?.('Write', {}),
      ]);
    } else {
      await onAllowForSession?.(request.toolName, permissionInput);
    }
  };

  const handleAllowForSession = async () => {
    try {
      await allowForSession();
    } catch {
      return;
    }
    if (sessionAllowButton?.setModeOnAllow) {
      onSetMode?.(sessionAllowButton.setModeOnAllow);
    }
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
      allowMode: 'session',
    });
  };

  const handleAllowForProject = async () => {
    try {
      if (isExitPlanMode) {
        await Promise.all([
          onAllowForProject?.('Edit', {}),
          onAllowForProject?.('Write', {}),
        ]);
      } else {
        await onAllowForProject?.(request.toolName, input);
      }
    } catch {
      return;
    }
    if (sessionAllowButton?.setModeOnAllow) {
      onSetMode?.(sessionAllowButton.setModeOnAllow);
    }
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
      allowMode: 'project',
    });
  };

  const handleAllowForProjectWorktrees = async () => {
    try {
      if (isExitPlanMode) {
        await Promise.all([
          onAllowForProjectWorktrees?.('Edit', {}),
          onAllowForProjectWorktrees?.('Write', {}),
        ]);
      } else {
        await onAllowForProjectWorktrees?.(request.toolName, input);
      }
    } catch {
      return;
    }
    if (sessionAllowButton?.setModeOnAllow) {
      onSetMode?.(sessionAllowButton.setModeOnAllow);
    }
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
      allowMode: 'worktree',
    });
  };

  const handleAllowGlobally = async () => {
    try {
      if (isExitPlanMode) {
        await Promise.all([
          onAllowGlobally?.('Edit', {}),
          onAllowGlobally?.('Write', {}),
        ]);
      } else {
        await onAllowGlobally?.(request.toolName, input);
      }
    } catch {
      return;
    }
    if (sessionAllowButton?.setModeOnAllow) {
      onSetMode?.(sessionAllowButton.setModeOnAllow);
    }
    // Use 'session' allowMode: global persistence is handled separately via
    // the onAllowGlobally IPC call. Sending 'session' avoids the agent backend
    // also writing the rule to a project-scoped file.
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
      allowMode: 'session',
    });
  };

  const handleDeny = () => {
    return onRespond(request.requestId, {
      behavior: 'deny',
      message: 'User denied this action',
    });
  };

  const handleAllowDirectory = ({
    path,
    isHome,
  }: {
    path: string;
    isHome?: boolean;
  }) => {
    directoryDropdownRef.current?.toggle();
    const allow = () =>
      onRespond(request.requestId, {
        behavior: 'allow',
        updatedInput: input,
        allowMode: 'session',
        allowedDirectory: path,
      });

    if (isHome) {
      modal.confirm({
        title: 'Allow Broad Directory Access?',
        content: (
          <div className="space-y-2 text-sm">
            <p>
              This grants agent access to your home directory and possibly
              broader paths for this task session.
            </p>
            <code className="bg-bg-1 block break-all rounded px-2 py-1">
              {path}
            </code>
          </div>
        ),
        confirmLabel: 'Allow Broad Access',
        variant: 'danger',
        onConfirm: allow,
      });
      return;
    }

    return allow();
  };

  const handleOtherSubmit = () => {
    if (!otherMessage.trim()) return;
    const response = onRespond(request.requestId, {
      behavior: 'deny',
      message: otherMessage.trim(),
    });
    setIsOtherOpen(false);
    setOtherMessage('');
    return response;
  };

  const handleOtherCancel = () => {
    setIsOtherOpen(false);
    setOtherMessage('');
  };

  // "Allow All" handlers — pass empty input to get scalar "allow" (blanket permission).
  // toolsToAllow with bare tool name (e.g., "read") tells the backend to allow ALL
  // requests for that tool in the current session, not just this specific file.
  const allowAllToolName = request.toolName.toLowerCase();

  const handleAllowAllForSession = async () => {
    try {
      await onAllowForSession?.(request.toolName, {});
    } catch {
      return;
    }
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
      allowMode: 'session',
      toolsToAllow: [allowAllToolName],
    });
  };

  const handleAllowAllForProject = async () => {
    try {
      await onAllowForProject?.(request.toolName, {});
    } catch {
      return;
    }
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
      allowMode: 'project',
      toolsToAllow: [allowAllToolName],
    });
  };

  const handleAllowAllForProjectWorktrees = async () => {
    try {
      await onAllowForProjectWorktrees?.(request.toolName, {});
    } catch {
      return;
    }
    return onRespond(request.requestId, {
      behavior: 'allow',
      updatedInput: input,
      allowMode: 'worktree',
      toolsToAllow: [allowAllToolName],
    });
  };

  return (
    <div className="border border-yellow-700/50 bg-yellow-900/20 px-4 py-3">
      <div className="flex flex-col gap-3">
        {/* Header + Content */}
        <div className="flex items-start gap-3">
          <Shield
            className="mt-0.5 h-5 w-5 shrink-0 text-yellow-500"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-xs font-medium text-yellow-400">
              Permission Required: {request.toolName}
            </div>
            {isExitPlanMode ? (
              <ExitPlanModeDisplay input={input} />
            ) : (
              <ToolInputDisplay
                toolName={request.toolName}
                input={input}
                worktreePath={worktreePath}
                commandExpanded={isCommandExpanded}
              />
            )}
            {/* Annotation only — the raw command above stays the source of
                truth, since parsed parts drop redirections and whitespace. */}
            {showBreakdown && (
              <div className="mt-2">
                <div className="text-ink-3 mb-1 text-xs">
                  Command parts checked separately:
                </div>
                <SubCommandBreakdown
                  subCommands={subCommands}
                  expanded={isCommandExpanded}
                />
              </div>
            )}
            {request.permissionEvaluation && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-ink-3">Permission check:</span>
                <span
                  className={`rounded px-1.5 py-0.5 font-medium ${
                    request.permissionEvaluation.action === 'deny'
                      ? 'bg-red-400/10 text-red-300'
                      : request.permissionEvaluation.action === 'allow'
                        ? 'bg-green-400/10 text-green-300'
                        : 'bg-yellow-400/10 text-yellow-300'
                  }`}
                >
                  {request.permissionEvaluation.action}
                </span>
                {showBreakdown && unmatchedCount > 0 ? (
                  <span className="text-ink-3">
                    {unmatchedCount} of {subCommands.length} command parts need
                    approval
                  </span>
                ) : request.permissionEvaluation.matchedRule ? (
                  <code className="text-ink-2 rounded bg-black/20 px-1.5 py-0.5">
                    {request.permissionEvaluation.matchedRule.tool}:{' '}
                    {request.permissionEvaluation.matchedRule.pattern}
                  </code>
                ) : (
                  <span className="text-ink-3">
                    no matching rule, defaulting to ask
                  </span>
                )}
              </div>
            )}
            {isRiskyCommand && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-orange-300">
                <TriangleAlert className="h-3.5 w-3.5" />
                Destructive or privileged command. Review before granting.
              </div>
            )}
            {suggestionGroups.length > 0 && onAllowForProject && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-ink-3">Auto-allow next time:</span>
                {suggestionGroups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    className="border-glass-border text-ink-2 hover:border-purple-400/60 hover:text-ink-1 rounded border bg-black/20 px-1.5 py-0.5 font-mono"
                    title={`Add ${group.patterns
                      .map((pattern) => `Bash(${pattern})`)
                      .join(', ')} to project permissions and allow`}
                    onClick={() => void handleGrantSuggestion(group.patterns)}
                  >
                    + {group.label}
                  </button>
                ))}
              </div>
            )}
            {request.toolName === 'Bash' && (isCommandClamped || showBreakdown) && (
              <div className="mt-1 flex gap-2 text-xs">
                <button
                  type="button"
                  className="text-ink-3 hover:text-ink-1"
                  onClick={() => setIsCommandExpanded((expanded) => !expanded)}
                >
                  {isCommandExpanded ? 'Collapse command' : 'Expand command'}
                </button>
                <button
                  type="button"
                  className="text-ink-3 hover:text-ink-1"
                  onClick={() => void navigator.clipboard?.writeText(command)}
                >
                  <Copy className="mr-1 inline h-3 w-3" /> Copy
                </button>
              </div>
            )}
            {directoryAccess && (
              <div
                role="note"
                className="border-glass-border bg-bg-1/60 mt-2 space-y-1 rounded border px-2 py-1.5 text-xs"
              >
                <div className="text-ink-3">External directory access</div>
                <div className="flex min-w-0 gap-2">
                  <span className="text-ink-3 shrink-0">Requested path:</span>
                  <code className="text-ink-1 truncate" title={directoryAccess.requestedPath}>
                    {directoryAccess.requestedPath}
                  </code>
                </div>
                <div className="flex min-w-0 gap-2">
                  <span className="text-ink-3 shrink-0">Containing directory:</span>
                  <code
                    className="text-ink-1 truncate"
                    title={directoryAccess.requestedDirectory}
                  >
                    {directoryAccess.requestedDirectory}
                  </code>
                </div>
                <div className="text-ink-2">
                  Parent grants include every descendant for this task session.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        {isOtherOpen ? (
          <div className="space-y-2">
            <Textarea
              value={otherMessage}
              onChange={(e) => setOtherMessage(e.target.value)}
              placeholder="Tell Claude what to do instead..."
              size="sm"
              rows={3}
              autoFocus
              autoComplete="off"
              aria-label="Instructions for Claude"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  handleOtherCancel();
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleOtherSubmit();
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={handleOtherCancel} variant="ghost" size="sm">
                Cancel
              </Button>
              <Button
                onClick={handleOtherSubmit}
                disabled={!otherMessage.trim()}
                variant="secondary"
                size="sm"
                icon={<Send />}
              >
                Deny with message
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                onClick={() => setIsOtherOpen(true)}
                variant="ghost"
                size="sm"
                icon={<MessageSquare />}
              >
                Other
              </Button>
              <Button
                onClick={handleDeny}
                variant="secondary"
                size="sm"
                icon={<X />}
              >
                Deny
              </Button>
              <div className="flex-1" />
              <Button
                onClick={handleAllow}
                variant="primary"
                size="sm"
                icon={<Check />}
                className="bg-green-600 hover:bg-green-500"
              >
                Allow
              </Button>
              {directoryAccess && (
                <Dropdown
                  dropdownRef={directoryDropdownRef}
                  align="right"
                  side="top"
                  className="max-w-[min(36rem,calc(100vw-2rem))]"
                  trigger={
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<FolderTree />}
                    >
                      Allow Parent for Session
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  }
                >
                  <div className="text-ink-3 px-3 py-1.5 text-xs">
                    Recursive access for this task session
                  </div>
                  {directoryAccess.parentDirectories.map((directory) => (
                    <DropdownItem
                      key={directory.path}
                      onClick={() => handleAllowDirectory(directory)}
                      icon={<FolderTree />}
                    >
                      <code
                        className="block max-w-lg truncate text-xs"
                        title={directory.path}
                      >
                        {directory.path}
                        {directory.isHome ? ' (Includes Home)' : ''}
                      </code>
                    </DropdownItem>
                  ))}
                </Dropdown>
              )}
              {sessionAllowButton &&
                !directoryAccess &&
                (onAllowForSession ||
                  onAllowForProject ||
                  (worktreePath && onAllowForProjectWorktrees) ||
                  onAllowGlobally) && (
                <Dropdown
                  align="right"
                  side="top"
                  trigger={
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<ShieldCheck />}
                      className="bg-purple-600 hover:bg-purple-500"
                    >
                      Grant rule
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  }
                >
                  <div className="text-ink-3 px-3 py-1.5 text-xs">
                    Add exact request to permissions
                  </div>
                  <DropdownItem onClick={handleAllowForSession} icon={<ShieldCheck />}>
                    Session
                  </DropdownItem>
                  <DropdownItem onClick={handleAllowForProject} icon={<ShieldCheck />}>
                    Project (recommended)
                  </DropdownItem>
                  {worktreePath && (
                    <DropdownItem onClick={handleAllowForProjectWorktrees} icon={<FolderTree />}>
                      Project worktrees
                    </DropdownItem>
                  )}
                  {onAllowGlobally && (
                    <DropdownItem onClick={handleAllowGlobally} icon={<MoreHorizontal />}>
                      Global
                    </DropdownItem>
                 )}
                </Dropdown>
              )}
            </div>
            {showAllowAll &&
              sessionAllowButton &&
              (onAllowForSession ||
                onAllowForProject ||
                (worktreePath && onAllowForProjectWorktrees)) && (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-yellow-700/30 pt-2">
                <span className="text-ink-2 text-xs">
                  Allow all {request.toolName}:
                </span>
                <div className="flex-1" />
                {onAllowForSession && (
                  <Button
                    onClick={handleAllowAllForSession}
                    variant="secondary"
                    size="sm"
                    icon={<ShieldCheck />}
                  >
                    Session
                  </Button>
                )}
                {onAllowForProject && (
                  <Button
                    onClick={handleAllowAllForProject}
                    variant="secondary"
                    size="sm"
                    icon={<ShieldCheck />}
                    className="bg-purple-600/30 hover:bg-purple-500/30"
                  >
                    Project
                  </Button>
                )}
                {worktreePath && onAllowForProjectWorktrees && (
                  <Button
                    onClick={handleAllowAllForProjectWorktrees}
                    variant="secondary"
                    size="sm"
                    icon={<ShieldCheck />}
                    className="bg-amber-600/30 hover:bg-amber-500/30"
                  >
                    Worktree
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
