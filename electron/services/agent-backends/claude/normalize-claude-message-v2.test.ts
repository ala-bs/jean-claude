import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@shared/agent-types';
import type { ResolvedPermissionRule } from '@shared/permission-types';

import {
  type NormalizationContext,
  normalizeClaudeMessageV2,
} from './normalize-claude-message-v2';

function makeCtx(
  permissionRules?: ResolvedPermissionRule[],
): NormalizationContext {
  return {
    sessionIdEmitted: true,
    pendingToolUses: new Map(),
    permissionRules,
  };
}

function toolUseMessage(
  name: string,
  input: Record<string, unknown>,
): AgentMessage {
  return {
    type: 'assistant',
    session_id: 'session-1',
    message: {
      content: [{ type: 'tool_use', id: 'tool-1', name, input }],
    },
  } as unknown as AgentMessage;
}

function permissionOf(events: ReturnType<typeof normalizeClaudeMessageV2>) {
  const entry = events.find((event) => event.type === 'entry');
  if (entry?.type !== 'entry') throw new Error('no entry event');
  if (entry.entry.type !== 'tool-use') throw new Error('not a tool-use entry');
  return entry.entry.permission;
}

describe('normalizeClaudeMessageV2 permission attribution', () => {
  it('attributes a rule-allowed bash command to the system, with the matched rule', () => {
    const rules: ResolvedPermissionRule[] = [
      { tool: 'bash', pattern: 'pnpm *', action: 'allow' },
    ];

    const permission = permissionOf(
      normalizeClaudeMessageV2(
        toolUseMessage('Bash', { command: 'pnpm test' }),
        makeCtx(rules),
      ),
    );

    expect(permission).toEqual({
      allowedBy: 'system',
      rule: { tool: 'bash', pattern: 'pnpm *' },
    });
  });

  it('falls back to agent when no rule matches', () => {
    const rules: ResolvedPermissionRule[] = [
      { tool: 'bash', pattern: 'pnpm *', action: 'allow' },
    ];

    const permission = permissionOf(
      normalizeClaudeMessageV2(
        toolUseMessage('Bash', { command: 'rm -rf /' }),
        makeCtx(rules),
      ),
    );

    expect(permission).toEqual({ allowedBy: 'agent' });
  });

  it('falls back to agent when a rule denies or asks', () => {
    const rules: ResolvedPermissionRule[] = [
      { tool: 'bash', pattern: '*', action: 'ask' },
    ];

    const permission = permissionOf(
      normalizeClaudeMessageV2(
        toolUseMessage('Bash', { command: 'pnpm test' }),
        makeCtx(rules),
      ),
    );

    expect(permission).toEqual({ allowedBy: 'agent' });
  });

  it('falls back to agent when the context carries no permission rules', () => {
    const permission = permissionOf(
      normalizeClaudeMessageV2(
        toolUseMessage('Bash', { command: 'pnpm test' }),
        makeCtx(undefined),
      ),
    );

    expect(permission).toEqual({ allowedBy: 'agent' });
  });

  // Regression: rules are keyed on the raw SDK tool name ('webfetch'), while
  // the normalized display name is 'web-fetch'. Keying the lookup on the
  // display name made every non-core tool render as "allowed by agent".
  it('matches rules for tools whose normalized name differs from the raw SDK name', () => {
    const rules: ResolvedPermissionRule[] = [
      { tool: 'webfetch', pattern: '*', action: 'allow' },
    ];

    const permission = permissionOf(
      normalizeClaudeMessageV2(
        toolUseMessage('WebFetch', { url: 'https://example.com' }),
        makeCtx(rules),
      ),
    );

    expect(permission).toEqual({
      allowedBy: 'system',
      rule: { tool: 'webfetch', pattern: '*' },
    });
  });

  it('keeps the resolved permission when the tool result patches the entry', () => {
    const rules: ResolvedPermissionRule[] = [
      { tool: 'bash', pattern: 'pnpm *', action: 'allow' },
    ];
    const ctx = makeCtx(rules);

    normalizeClaudeMessageV2(
      toolUseMessage('Bash', { command: 'pnpm test' }),
      ctx,
    );

    const resultEvents = normalizeClaudeMessageV2(
      {
        type: 'user',
        session_id: 'session-1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'ok',
            },
          ],
        },
      } as unknown as AgentMessage,
      ctx,
    );

    const update = resultEvents.find((event) => event.type === 'entry-update');
    expect(update).toMatchObject({
      entry: {
        permission: {
          allowedBy: 'system',
          rule: { tool: 'bash', pattern: 'pnpm *' },
        },
      },
    });
  });
});
