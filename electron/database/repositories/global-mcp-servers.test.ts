import { describe, expect, it, vi } from 'vitest';

vi.mock('../index', () => ({ db: {} }));

import { parseGlobalMcpServerRow } from './global-mcp-servers';

describe('GlobalMcpServerRepository backend state', () => {
  it('round trips explicit ownership and exact native entry data', () => {
    const backendStates = {
      codex: {
        owned: true,
        entryName: 'server',
        rawEntry: {
          command: 'npx',
          cwd: '/repo',
          tool_timeout_sec: 30,
          http_headers: { Authorization: 'secret' },
        },
        fingerprint: 'a'.repeat(64),
      },
    };
    expect(parseGlobalMcpServerRow({
      id: 'id',
      name: 'server',
      normalizedName: 'server',
      transportType: 'stdio',
      command: 'npx',
      args: '[]',
      env: '{}',
      envManaged: 0,
      url: null,
      enabledBackends: '["codex"]',
      backendStates: JSON.stringify(backendStates),
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    }).backendStates).toEqual(backendStates);
  });

  it('fails closed with row context for invalid ownership state', () => {
    expect(() => parseGlobalMcpServerRow({
      id: 'bad-id',
      name: 'bad-server',
      normalizedName: 'bad-server',
      transportType: 'stdio',
      command: 'npx',
      args: '[]',
      env: '{}',
      envManaged: 0,
      url: null,
      enabledBackends: '["codex"]',
      backendStates: '{"codex":{"owned":true}}',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    })).toThrow('id=bad-id name=bad-server');
  });

  it.each([
    ['transportType', { transportType: 'invalid' }],
    ['args', { args: '[1]' }],
    ['env', { env: '{"TOKEN":1}' }],
    ['enabledBackends', { enabledBackends: '["codex","codex"]' }],
    ['timestamp', { updatedAt: 'not-a-date' }],
  ])('rejects invalid persisted %s with row context', (_, override) => {
    expect(() => parseGlobalMcpServerRow({
      id: 'row-id',
      name: 'server',
      normalizedName: 'server',
      transportType: 'stdio',
      command: 'npx',
      args: '[]',
      env: '{}',
      envManaged: 0,
      url: null,
      enabledBackends: '[]',
      backendStates: '{}',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      ...override,
    })).toThrow('id=row-id name=server');
  });
});
