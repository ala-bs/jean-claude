import { describe, expect, it } from 'vitest';

import { backendSupportsTransport } from './global-mcp-support';

describe('global MCP backend transport support', () => {
  it('filters unsupported backend toggles before IPC', () => {
    expect(backendSupportsTransport('claude-code', 'sse')).toBe(true);
    expect(backendSupportsTransport('opencode', 'sse')).toBe(false);
    expect(backendSupportsTransport('codex', 'http')).toBe(true);
    expect(backendSupportsTransport('copilot', 'stdio')).toBe(true);
    expect(backendSupportsTransport('vibe', 'http')).toBe(true);
  });
});
