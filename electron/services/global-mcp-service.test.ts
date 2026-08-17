import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import type { AgentBackendType } from '@shared/agent-backend-types';
import type { McpTransportType } from '@shared/global-mcp-types';

import {
  fingerprintNativeEntry,
  type GlobalMcpConfigAdapter,
  type McpConfigEntry,
  VibeConfigAdapter,
} from './global-mcp-config-adapters';

// Mock the database
vi.mock('../database/repositories/global-mcp-servers', () => {
  const store = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  let failNextUpdate = false;

  return {
    GlobalMcpServerRepository: {
      findAll: vi.fn(async () => Array.from(store.values())),
      findById: vi.fn(async (id: string) => store.get(id) ?? undefined),
      findByName: vi.fn(async (name: string) => {
        for (const v of store.values()) {
          if (String(v.normalizedName) === name.trim().toLocaleLowerCase()) return v;
        }
        return undefined;
      }),
      create: vi.fn(async (data: Record<string, unknown>) => {
        const normalizedName = String(data.name).trim().toLocaleLowerCase();
        if ([...store.values()].some((record) => record.normalizedName === normalizedName)) {
          throw new Error('UNIQUE constraint failed: global_mcp_servers.normalizedName');
        }
        const id = `test-${nextId++}`;
        const now = new Date().toISOString();
        const record = {
          id,
          name: data.name,
          normalizedName,
          transportType: data.transportType,
          command: data.command ?? null,
          args: data.args ?? [],
          env: data.env ?? {},
          envManaged: data.envManaged ?? false,
          url: data.url ?? null,
          enabledBackends: data.enabledBackends ?? [],
          backendStates: data.backendStates ?? {},
          createdAt: now,
          updatedAt: now,
        };
        store.set(id, record);
        return record;
      }),
      update: vi.fn(async (id: string, data: Record<string, unknown>) => {
        if (failNextUpdate) {
          failNextUpdate = false;
          throw new Error('forced database update failure');
        }
        const existing = store.get(id);
        if (!existing) throw new Error('Not found');
        const updated = {
          ...existing,
          ...data,
          ...(data.name !== undefined
            ? { normalizedName: String(data.name).trim().toLocaleLowerCase() }
            : {}),
          updatedAt: new Date().toISOString(),
        };
        store.set(id, updated);
        return updated;
      }),
      delete: vi.fn(async (id: string) => {
        store.delete(id);
      }),
      importEntry: vi.fn(async (data: Record<string, unknown>) => {
        const normalizedName = String(data.name).trim().toLocaleLowerCase();
        if ([...store.values()].some((record) => record.normalizedName === normalizedName)) {
          throw new Error('UNIQUE constraint failed: global_mcp_servers.normalizedName');
        }
        const id = `test-${nextId++}`;
        const now = new Date().toISOString();
        const record = {
          id,
          name: data.name,
          normalizedName,
          transportType: data.transportType,
          command: data.command ?? null,
          args: data.args ?? [],
          env: data.env ?? {},
          envManaged: data.envManaged ?? false,
          url: data.url ?? null,
          enabledBackends: data.enabledBackends ?? [],
          backendStates: data.backendStates ?? {},
          createdAt: now,
          updatedAt: now,
        };
        store.set(id, record);
        return record;
      }),
      _reset: () => {
        store.clear();
        nextId = 1;
        failNextUpdate = false;
      },
      _failNextUpdate: () => { failNextUpdate = true; },
    },
  };
});

// Mock debug
vi.mock('../lib/debug', () => ({
  dbg: {
    mcp: () => {},
  },
}));

import { GlobalMcpServerRepository } from '../database/repositories/global-mcp-servers';
import {
  canonicalConfigLockPath,
  createGlobalMcpServer,
  disableGlobalMcpServer,
  discoverUnmanagedMcpEntries,
  enableGlobalMcpServer,
  importMcpEntry,
  uninstallGlobalMcpServer,
  updateGlobalMcpServer,
} from './global-mcp-service';

/** In-memory adapter for testing (no disk writes) */
class InMemoryAdapter implements GlobalMcpConfigAdapter {
  readonly backend: AgentBackendType;
  entries: Record<string, McpConfigEntry> = {};
  failWrite = false;
  failWriteName: string | null = null;

  constructor(backend: AgentBackendType) {
    this.backend = backend;
  }

  defaultConfigPath(): string {
    return '/fake/path';
  }

  supportsTransport(type: McpTransportType): boolean {
    return type === 'stdio';
  }

  readEntries(): Record<string, McpConfigEntry> {
    return { ...this.entries };
  }

  readNativeEntries(): Record<string, Record<string, unknown>> {
    return { ...this.entries } as Record<string, Record<string, unknown>>;
  }

  mergeNativeEntry(entry: McpConfigEntry, previous: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...previous, ...entry };
  }

  writeNativeEntry(name: string, entry: Record<string, unknown>, expectedFingerprint: string | null): void {
    const current = this.readNativeEntries()[name];
    const actual = current ? fingerprintNativeEntry(current) : null;
    if (actual !== expectedFingerprint) throw new Error('drift');
    this.writeEntry(name, entry as McpConfigEntry);
  }

  removeNativeEntry(name: string, expectedFingerprint: string): void {
    const current = this.readNativeEntries()[name];
    if (!current || fingerprintNativeEntry(current) !== expectedFingerprint) throw new Error('drift');
    this.removeEntry(name);
  }

  writeEntry(name: string, entry: McpConfigEntry): void {
    if (this.failWrite || this.failWriteName === name) throw new Error('write failed');
    this.entries[name] = entry;
  }

  removeEntry(name: string): void {
    delete this.entries[name];
  }
}

describe('global-mcp-service', () => {
  let claudeAdapter: InMemoryAdapter;
  let opencodeAdapter: InMemoryAdapter;
  let adapters: GlobalMcpConfigAdapter[];

  beforeEach(() => {
    (GlobalMcpServerRepository as unknown as { _reset: () => void })._reset();
    claudeAdapter = new InMemoryAdapter('claude-code');
    opencodeAdapter = new InMemoryAdapter('opencode');
    adapters = [claudeAdapter, opencodeAdapter];
  });

  it('creates a server and writes to enabled backends', async () => {
    const server = await createGlobalMcpServer(
      {
        name: 'test-server',
        transportType: 'stdio',
        command: 'npx',
        args: ['-y', 'test'],
        enabledBackends: ['claude-code'],
      },
      { adapters },
    );

    expect(server.name).toBe('test-server');
    expect(server.enabledBackends).toEqual(['claude-code']);
    expect(claudeAdapter.entries['test-server']).toBeDefined();
    expect(opencodeAdapter.entries['test-server']).toBeUndefined();
  });

  it('enables a server on additional backends', async () => {
    const server = await createGlobalMcpServer(
      {
        name: 'test-server',
        transportType: 'stdio',
        command: 'npx',
        enabledBackends: ['claude-code'],
      },
      { adapters },
    );

    await enableGlobalMcpServer(server.id, ['opencode'], { adapters });

    expect(opencodeAdapter.entries['test-server']).toBeDefined();
  });

  it.each(['claude-code', 'opencode', 'codex', 'copilot', 'vibe'] as const)(
    'adopts semantically matching existing %s entry on explicit enable',
    async (backend) => {
      const adapter = new InMemoryAdapter(backend);
      const raw = { command: 'npx', args: ['serve'], env: { TOKEN: backend }, nativeOption: true };
      const write = vi.spyOn(adapter, 'writeNativeEntry');
      const server = await createGlobalMcpServer({
        name: 'maestro', transportType: 'stdio', command: 'npx', args: ['serve'], enabledBackends: [],
      }, { adapters: [adapter] });
      adapter.entries.maestro = structuredClone(raw);

      await enableGlobalMcpServer(server.id, [backend], { adapters: [adapter] });
      expect(write).not.toHaveBeenCalled();
      expect(adapter.entries.maestro).toEqual(raw);
      expect((await GlobalMcpServerRepository.findById(server.id))?.backendStates[backend]).toEqual({
        owned: true,
        entryName: 'maestro',
        rawEntry: raw,
        fingerprint: fingerprintNativeEntry(raw),
      });
    },
  );

  it('adopts and removes matching Vibe entry from mixed TOML without rewriting unrelated bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-vibe-enable-'));
    const configPath = path.join(root, 'config.toml');
    class TestVibeAdapter extends VibeConfigAdapter {
      override defaultConfigPath(): string { return configPath; }
    }
    const adapter = new TestVibeAdapter();
    try {
      const server = await createGlobalMcpServer({
        name: 'maestro', transportType: 'stdio', command: 'maestro', args: ['serve'], enabledBackends: [],
      }, { adapters: [adapter] });
      const assignment = 'mcp_servers = []\n';
      const prefix = '# keep exact\nmodel = "keep"\n\n';
      const target = '[[mcp_servers]]\nname = "maestro"\ntransport = "stdio"\ncommand = "maestro"\nargs = ["serve"]\nnative_option = true\n\n[mcp_servers.env]\nTOKEN = "secret"\n\n';
      const suffix = '[unrelated]\nvalue = "keep-exact" # comment\n';
      const original = assignment + prefix + target + suffix;
      fs.writeFileSync(configPath, original);

      await enableGlobalMcpServer(server.id, ['vibe'], { adapters: [adapter] });
      const repaired = fs.readFileSync(configPath, 'utf8');
      expect(repaired).toBe(prefix + target + suffix);
      expect(Array.isArray((parseToml(repaired) as { mcp_servers: unknown[] }).mcp_servers)).toBe(true);
      await disableGlobalMcpServer(server.id, ['vibe'], { adapters: [adapter] });
      expect(fs.readFileSync(configPath, 'utf8')).toBe(prefix + suffix);

      fs.writeFileSync(configPath, assignment + prefix + target.replace('command = "maestro"', 'command = "different"') + suffix);
      await expect(enableGlobalMcpServer(server.id, ['vibe'], { adapters: [adapter] })).rejects.toThrow('different configuration');
      expect(fs.readFileSync(configPath, 'utf8')).toContain('command = "different"');

      fs.writeFileSync(configPath, original);
      await enableGlobalMcpServer(server.id, ['vibe'], { adapters: [adapter] });
      await uninstallGlobalMcpServer(server.id, { adapters: [adapter] });
      expect(fs.readFileSync(configPath, 'utf8')).toBe(prefix + suffix);
      expect(await GlobalMcpServerRepository.findById(server.id)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('disables a server removing from backend config', async () => {
    const server = await createGlobalMcpServer(
      {
        name: 'test-server',
        transportType: 'stdio',
        command: 'npx',
        enabledBackends: ['claude-code'],
      },
      { adapters },
    );

    await disableGlobalMcpServer(server.id, ['claude-code'], { adapters });

    expect(claudeAdapter.entries['test-server']).toBeUndefined();
  });

  it('uninstalls a server removing from all backends and DB', async () => {
    const server = await createGlobalMcpServer(
      {
        name: 'test-server',
        transportType: 'stdio',
        command: 'npx',
        enabledBackends: ['claude-code', 'opencode'],
      },
      { adapters },
    );

    await uninstallGlobalMcpServer(server.id, { adapters });

    expect(claudeAdapter.entries['test-server']).toBeUndefined();
    expect(opencodeAdapter.entries['test-server']).toBeUndefined();
    expect(
      await GlobalMcpServerRepository.findById(server.id),
    ).toBeUndefined();
  });

  it('imports and adopts a discovered entry', async () => {
    claudeAdapter.entries.external = { command: 'some-cmd', args: [], env: {} };
    const server = await importMcpEntry(
      {
        name: 'external',
        canonicalName: 'external',
        common: {
          transportType: 'stdio',
          command: 'some-cmd',
          args: [],
          url: null,
        },
        sources: [{
          backend: 'claude-code',
          entryName: 'external',
          fingerprint: fingerprintNativeEntry({ command: 'some-cmd', args: [], env: {} }),
        }],
      },
      ['claude-code', 'opencode'],
      { adapters },
    );

    expect(server.enabledBackends).toEqual(['claude-code', 'opencode']);
    const stored = await GlobalMcpServerRepository.findById(server.id);
    expect(stored?.backendStates['claude-code']).toEqual({
      owned: true,
      entryName: 'external',
      rawEntry: { command: 'some-cmd', args: [], env: {} },
      fingerprint: fingerprintNativeEntry({ command: 'some-cmd', args: [], env: {} }),
    });
    // Should write to opencode (new) but not re-write to claude-code (already there)
    expect(opencodeAdapter.entries['external']).toBeDefined();
  });

  it('adopts multiple matching sources with exact raw entries and installs selected missing backend', async () => {
    const claudeRaw = { command: 'node', args: ['server.js'], env: { TOKEN: 'one' }, cwd: '/claude' };
    const opencodeRaw = { command: 'node', args: ['server.js'], env: { TOKEN: 'two' }, timeout: 9000 };
    claudeAdapter.entries.multi = claudeRaw;
    opencodeAdapter.entries.multi = opencodeRaw;
    const codexAdapter = new InMemoryAdapter('codex');
    const all = [...adapters, codexAdapter];
    const server = await importMcpEntry({
      name: 'multi',
      canonicalName: 'multi',
      common: { transportType: 'stdio', command: 'node', args: ['server.js'], url: null },
      sources: [
        { backend: 'claude-code', entryName: 'multi', fingerprint: fingerprintNativeEntry(claudeRaw) },
        { backend: 'opencode', entryName: 'multi', fingerprint: fingerprintNativeEntry(opencodeRaw) },
      ],
    }, ['claude-code', 'opencode', 'codex'], { adapters: all });
    const stored = await GlobalMcpServerRepository.findById(server.id);
    expect(stored?.backendStates['claude-code']?.rawEntry).toEqual(claudeRaw);
    expect(stored?.backendStates.opencode?.rawEntry).toEqual(opencodeRaw);
    expect(stored?.backendStates.codex?.owned).toBe(true);
    expect(codexAdapter.entries.multi).toBeDefined();
    expect(codexAdapter.entries.multi?.env).toEqual({});
    expect(server.env).toEqual({});
    expect(server.hasStoredEnv).toBe(true);

    await updateGlobalMcpServer(server.id, { command: 'node-updated' }, { adapters: all });
    expect(claudeAdapter.entries.multi?.env).toEqual({ TOKEN: 'one' });
    expect(opencodeAdapter.entries.multi?.env).toEqual({ TOKEN: 'two' });
    expect(codexAdapter.entries.multi?.env).toEqual({});

    await updateGlobalMcpServer(server.id, { env: { SHARED: 'replacement' } }, { adapters: all });
    expect(claudeAdapter.entries.multi?.env).toEqual({ SHARED: 'replacement' });
    expect(opencodeAdapter.entries.multi?.env).toEqual({ SHARED: 'replacement' });
    expect(codexAdapter.entries.multi?.env).toEqual({ SHARED: 'replacement' });
  });

  it('rejects grouped import when no discovered source backend is selected', async () => {
    claudeAdapter.entries.source_only = { command: 'npx' };
    const codexAdapter = new InMemoryAdapter('codex');
    await expect(importMcpEntry({
      name: 'source_only',
      canonicalName: 'source_only',
      common: { transportType: 'stdio', command: 'npx', args: [], url: null },
      sources: [{ backend: 'claude-code', entryName: 'source_only', fingerprint: fingerprintNativeEntry({ command: 'npx' }) }],
    }, ['codex'], { adapters: [...adapters, codexAdapter] })).rejects.toThrow('at least one discovered source');
    expect(codexAdapter.entries.source_only).toBeUndefined();
    expect(await GlobalMcpServerRepository.findByName('source_only')).toBeUndefined();
  });

  it('restores exact disabled native source state when re-enabling', async () => {
    const claudeRaw = { command: 'node', args: ['server.js'], env: { CLAUDE_TOKEN: 'one' }, custom: 'claude' };
    const opencodeRaw = { command: 'node', args: ['server.js'], env: { OPENCODE_TOKEN: 'two' }, timeout: 7777 };
    claudeAdapter.entries.restore = structuredClone(claudeRaw);
    opencodeAdapter.entries.restore = structuredClone(opencodeRaw);
    const server = await importMcpEntry({
      name: 'restore',
      canonicalName: 'restore',
      common: { transportType: 'stdio', command: 'node', args: ['server.js'], url: null },
      sources: [
        { backend: 'claude-code', entryName: 'restore', fingerprint: fingerprintNativeEntry(claudeRaw) },
        { backend: 'opencode', entryName: 'restore', fingerprint: fingerprintNativeEntry(opencodeRaw) },
      ],
    }, ['claude-code', 'opencode'], { adapters });
    await disableGlobalMcpServer(server.id, ['opencode'], { adapters });
    expect(opencodeAdapter.entries.restore).toBeUndefined();
    expect(claudeAdapter.entries.restore).toEqual(claudeRaw);

    await enableGlobalMcpServer(server.id, ['opencode'], { adapters });
    expect(opencodeAdapter.entries.restore).toEqual(opencodeRaw);
    expect(claudeAdapter.entries.restore).toEqual(claudeRaw);
    const stored = await GlobalMcpServerRepository.findById(server.id);
    expect(stored?.backendStates.opencode).toEqual({
      owned: true,
      entryName: 'restore',
      rawEntry: opencodeRaw,
      fingerprint: fingerprintNativeEntry(opencodeRaw),
    });
  });

  it('merges current canonical fields into disabled raw state before re-enable', async () => {
    const raw = { command: 'old-command', args: ['old'], env: { TOKEN: 'backend-only' }, custom: 'preserve' };
    opencodeAdapter.entries.stale_restore = structuredClone(raw);
    const server = await importMcpEntry({
      name: 'stale_restore',
      canonicalName: 'stale_restore',
      common: { transportType: 'stdio', command: 'old-command', args: ['old'], url: null },
      sources: [{ backend: 'opencode', entryName: 'stale_restore', fingerprint: fingerprintNativeEntry(raw) }],
    }, ['opencode'], { adapters });
    await disableGlobalMcpServer(server.id, ['opencode'], { adapters });
    await updateGlobalMcpServer(server.id, { command: 'new-command', args: ['new'] }, { adapters });
    await enableGlobalMcpServer(server.id, ['opencode'], { adapters });
    expect(opencodeAdapter.entries.stale_restore).toEqual({
      command: 'new-command',
      args: ['new'],
      env: { TOKEN: 'backend-only' },
      custom: 'preserve',
    });
  });

  it('imports backend-valid unsafe alias under separately validated canonical name', async () => {
    const alias = 'my.server "quoted"';
    const raw = { command: 'node', custom: true };
    opencodeAdapter.entries[alias] = raw;
    const server = await importMcpEntry({
      name: alias,
      canonicalName: 'my_server_quoted',
      common: { transportType: 'stdio', command: 'node', args: [], url: null },
      sources: [{ backend: 'opencode', entryName: alias, fingerprint: fingerprintNativeEntry(raw) }],
    }, ['opencode'], { adapters });
    expect(server.name).toBe('my_server_quoted');
    expect((await GlobalMcpServerRepository.findById(server.id))?.backendStates.opencode?.entryName).toBe(alias);
  });

  it('rejects collision instead of overwriting disabled native state', async () => {
    const raw = { command: 'node', env: { TOKEN: 'owned' }, custom: true };
    opencodeAdapter.entries.disabled_collision = structuredClone(raw);
    const server = await importMcpEntry({
      name: 'disabled_collision',
      canonicalName: 'disabled_collision',
      common: { transportType: 'stdio', command: 'node', args: [], url: null },
      sources: [{ backend: 'opencode', entryName: 'disabled_collision', fingerprint: fingerprintNativeEntry(raw) }],
    }, ['opencode'], { adapters });
    await disableGlobalMcpServer(server.id, ['opencode'], { adapters });
    const external = { command: 'external', env: { TOKEN: 'external' } };
    opencodeAdapter.entries.disabled_collision = structuredClone(external);

    await expect(enableGlobalMcpServer(server.id, ['opencode'], { adapters })).rejects.toThrow('different configuration');
    expect(opencodeAdapter.entries.disabled_collision).toEqual(external);
    expect((await GlobalMcpServerRepository.findById(server.id))?.backendStates.opencode?.owned).toBe(false);
  });

  it('rolls back grouped import on source drift and creates no row', async () => {
    claudeAdapter.entries.drifted = { command: 'changed' };
    const codexAdapter = new InMemoryAdapter('codex');
    await expect(importMcpEntry({
      name: 'drifted',
      canonicalName: 'drifted',
      common: { transportType: 'stdio', command: 'expected', args: [], url: null },
      sources: [{ backend: 'claude-code', entryName: 'drifted', fingerprint: fingerprintNativeEntry({ command: 'expected' }) }],
    }, ['codex', 'claude-code'], { adapters: [...adapters, codexAdapter] })).rejects.toThrow('drift');
    expect(codexAdapter.entries.drifted).toBeUndefined();
    expect(await GlobalMcpServerRepository.findByName('drifted')).toBeUndefined();
  });

  it('does not persist enabled backend when transport is unsupported', async () => {
    await expect(createGlobalMcpServer({
      name: 'remote',
      transportType: 'http',
      url: 'https://example.com/mcp',
      enabledBackends: ['claude-code'],
    }, { adapters })).rejects.toThrow('does not support');
    expect(await GlobalMcpServerRepository.findByName('remote')).toBeUndefined();
  });

  it('does not persist enabled backend when config write fails', async () => {
    claudeAdapter.failWrite = true;
    await expect(createGlobalMcpServer({
      name: 'broken', transportType: 'stdio', command: 'npx', enabledBackends: ['claude-code'],
    }, { adapters })).rejects.toThrow('write failed');
    expect(await GlobalMcpServerRepository.findByName('broken')).toBeUndefined();
  });

  it('blocks unmanaged differing same-name entries', async () => {
    claudeAdapter.entries.collision = { command: 'other' };
    await expect(createGlobalMcpServer({
      name: 'collision', transportType: 'stdio', command: 'npx', enabledBackends: ['claude-code'],
    }, { adapters })).rejects.toThrow('collision');
    expect(claudeAdapter.entries.collision).toEqual({ command: 'other' });
  });

  it('blocks identical unmanaged entries instead of silently adopting them', async () => {
    claudeAdapter.entries.identical = { command: 'npx', args: [], env: {} };
    await expect(createGlobalMcpServer({
      name: 'identical', transportType: 'stdio', command: 'npx', enabledBackends: ['claude-code'],
    }, { adapters })).rejects.toThrow('import it');
  });

  it('does not disable externally changed entries or update database state', async () => {
    const server = await createGlobalMcpServer({
      name: 'owned', transportType: 'stdio', command: 'npx', enabledBackends: ['claude-code'],
    }, { adapters });
    claudeAdapter.entries.owned = { command: 'changed' };
    await expect(disableGlobalMcpServer(server.id, ['claude-code'], { adapters })).rejects.toThrow('drift');
    expect((await GlobalMcpServerRepository.findById(server.id))?.enabledBackends).toEqual(['claude-code']);
    expect(claudeAdapter.entries.owned).toEqual({ command: 'changed' });
  });

  it('rolls back earlier backend writes after a partial create failure', async () => {
    opencodeAdapter.failWrite = true;
    await expect(createGlobalMcpServer({
      name: 'partial', transportType: 'stdio', command: 'npx', enabledBackends: ['claude-code', 'opencode'],
    }, { adapters })).rejects.toThrow('write failed');
    expect(claudeAdapter.entries.partial).toBeUndefined();
    expect(await GlobalMcpServerRepository.findByName('partial')).toBeUndefined();
  });

  it('renames and synchronizes enabled backend entries', async () => {
    const server = await createGlobalMcpServer({
      name: 'before', transportType: 'stdio', command: 'npx', enabledBackends: ['claude-code'],
    }, { adapters });
    await updateGlobalMcpServer(server.id, { name: 'after', command: 'node' }, { adapters });
    expect(claudeAdapter.entries.before).toBeUndefined();
    expect(claudeAdapter.entries.after).toEqual({ command: 'node', args: [], env: {} });
  });

  it('restores old native entry when rename destination write fails', async () => {
    const server = await createGlobalMcpServer({
      name: 'source', transportType: 'stdio', command: 'npx', enabledBackends: ['claude-code'],
    }, { adapters });
    claudeAdapter.failWriteName = 'destination';
    await expect(updateGlobalMcpServer(server.id, { name: 'destination' }, { adapters })).rejects.toThrow('write failed');
    expect(claudeAdapter.entries.source).toEqual({ command: 'npx', args: [], env: {} });
    expect(claudeAdapter.entries.destination).toBeUndefined();
  });

  it('restores exact source and destination dependencies when rename plus disable DB update fails', async () => {
    const server = await createGlobalMcpServer({
      name: 'combined-old', transportType: 'stdio', command: 'npx', args: ['old'], enabledBackends: ['claude-code', 'opencode'],
    }, { adapters });
    const claudeOriginal = structuredClone(claudeAdapter.entries['combined-old']);
    const opencodeOriginal = structuredClone(opencodeAdapter.entries['combined-old']);
    (GlobalMcpServerRepository as unknown as { _failNextUpdate: () => void })._failNextUpdate();
    await expect(updateGlobalMcpServer(server.id, {
      name: 'combined-new',
      command: 'node',
      enabledBackends: ['opencode'],
    }, { adapters })).rejects.toThrow('forced database update failure');
    expect(claudeAdapter.entries['combined-old']).toEqual(claudeOriginal);
    expect(opencodeAdapter.entries['combined-old']).toEqual(opencodeOriginal);
    expect(claudeAdapter.entries['combined-new']).toBeUndefined();
    expect(opencodeAdapter.entries['combined-new']).toBeUndefined();
    const stored = await GlobalMcpServerRepository.findById(server.id);
    expect(stored?.name).toBe('combined-old');
    expect(stored?.enabledBackends.sort()).toEqual(['claude-code', 'opencode']);
  });

  it('serializes concurrent enables and preserves both backend ownership states', async () => {
    const server = await createGlobalMcpServer({
      name: 'concurrent', transportType: 'stdio', command: 'npx', enabledBackends: [],
    }, { adapters });
    await Promise.all([
      enableGlobalMcpServer(server.id, ['claude-code'], { adapters }),
      enableGlobalMcpServer(server.id, ['opencode'], { adapters }),
    ]);
    const updated = await GlobalMcpServerRepository.findById(server.id);
    expect(updated?.enabledBackends.sort()).toEqual(['claude-code', 'opencode']);
    expect(updated?.backendStates['claude-code']?.owned).toBe(true);
    expect(updated?.backendStates.opencode?.owned).toBe(true);
    expect(claudeAdapter.entries.concurrent).toBeDefined();
    expect(opencodeAdapter.entries.concurrent).toBeDefined();
  });

  it('reconciles backend additions and removals through edit', async () => {
    const server = await createGlobalMcpServer({
      name: 'edit-backends', transportType: 'stdio', command: 'npx', enabledBackends: ['claude-code'],
    }, { adapters });
    const updated = await updateGlobalMcpServer(server.id, {
      enabledBackends: ['opencode'],
    }, { adapters });
    expect(updated.enabledBackends).toEqual(['opencode']);
    const stored = await GlobalMcpServerRepository.findById(updated.id);
    expect(stored?.backendStates['claude-code']?.owned).toBe(false);
    expect(stored?.backendStates.opencode?.owned).toBe(true);
    expect(claudeAdapter.entries['edit-backends']).toBeUndefined();
    expect(opencodeAdapter.entries['edit-backends']).toBeDefined();
  });

  it('uses imported alias for edit disable and restores it on rollback', async () => {
    const alias = 'my server';
    const raw = { command: 'node', args: ['old'], env: { TOKEN: 'native' }, custom: true };
    opencodeAdapter.entries[alias] = structuredClone(raw);
    const server = await importMcpEntry({
      name: alias,
      canonicalName: 'my-server',
      common: { transportType: 'stdio', command: 'node', args: ['old'], url: null },
      sources: [{ backend: 'opencode', entryName: alias, fingerprint: fingerprintNativeEntry(raw) }],
    }, ['opencode'], { adapters });

    (GlobalMcpServerRepository as unknown as { _failNextUpdate: () => void })._failNextUpdate();
    await expect(updateGlobalMcpServer(server.id, {
      command: 'new-command',
      enabledBackends: [],
    }, { adapters })).rejects.toThrow('forced database update failure');
    expect(opencodeAdapter.entries[alias]).toEqual(raw);
    expect(opencodeAdapter.entries['my-server']).toBeUndefined();

    await updateGlobalMcpServer(server.id, { enabledBackends: [] }, { adapters });
    expect(opencodeAdapter.entries[alias]).toBeUndefined();
    expect(opencodeAdapter.entries['my-server']).toBeUndefined();
  });

  it('serializes different servers sharing one physical config path', async () => {
    await Promise.all([
      createGlobalMcpServer({ name: 'one', transportType: 'stdio', command: 'one', enabledBackends: ['claude-code'] }, { adapters }),
      createGlobalMcpServer({ name: 'two', transportType: 'stdio', command: 'two', enabledBackends: ['claude-code'] }, { adapters }),
    ]);
    expect(claudeAdapter.entries.one).toBeDefined();
    expect(claudeAdapter.entries.two).toBeDefined();
  });

  it('prevents concurrent normalized canonical duplicates', async () => {
    const results = await Promise.allSettled([
      createGlobalMcpServer({ name: 'Foo', transportType: 'stdio', command: 'one', enabledBackends: [] }, { adapters }),
      createGlobalMcpServer({ name: 'foo', transportType: 'stdio', command: 'two', enabledBackends: [] }, { adapters }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it.each([
    [{ name: 42, transportType: 'stdio', command: 'x', enabledBackends: [] }, 'name'],
    [{ name: 'x', transportType: {}, command: 'x', enabledBackends: [] }, 'transport'],
    [{ name: 'x', transportType: 'stdio', command: 42, enabledBackends: [] }, 'command'],
    [{ name: 'x', transportType: 'stdio', command: 'x', args: [1], enabledBackends: [] }, 'args'],
    [{ name: 'x', transportType: 'stdio', command: 'x', env: { A: 1 }, enabledBackends: [] }, 'environment'],
    [{ name: 'x', transportType: 'stdio', command: 'x', enabledBackends: new Array(10).fill('codex') }, 'backends'],
  ])('rejects hostile create payload %# with actionable error', async (payload, message) => {
    await expect(createGlobalMcpServer(payload as never, { adapters })).rejects.toThrow(message);
  });

  it('withholds backend state and stored environment values from public results', async () => {
    const server = await createGlobalMcpServer({
      name: 'secret-safe', transportType: 'stdio', command: 'npx', env: { TOKEN: 'secret' }, enabledBackends: ['claude-code'],
    }, { adapters });
    expect(server).not.toHaveProperty('backendStates');
    expect(server.env).toEqual({});
    expect(server.hasStoredEnv).toBe(true);
  });

  it('isolates discovery failures by backend while returning successes', async () => {
    claudeAdapter.entries.good = { command: 'good' };
    opencodeAdapter.readNativeEntries = () => { throw new Error('malformed opencode config'); };
    const result = await discoverUnmanagedMcpEntries({ adapters });
    expect(result.groups.some((group) => group.name === 'good')).toBe(true);
    expect(result.errors).toEqual([{ backend: 'opencode', message: 'malformed opencode config' }]);
  });

  it('filters known matching backend source while retaining conflicting unmanaged variant', async () => {
    await createGlobalMcpServer({
      name: 'known', transportType: 'stdio', command: 'managed', enabledBackends: ['claude-code'],
    }, { adapters });
    opencodeAdapter.entries.known = { command: 'conflict', args: [], env: {} };
    const result = await discoverUnmanagedMcpEntries({ adapters });
    const group = result.groups.find((item) => item.normalizedName === 'known');
    expect(group?.variants).toHaveLength(1);
    expect(group?.variants[0].common.command).toBe('conflict');
    expect(group?.variants[0].sources).toEqual([
      expect.objectContaining({ backend: 'opencode' }),
    ]);
  });

  it('filters exact owned alias while retaining a genuine conflict', async () => {
    const alias = 'my server';
    const raw = { command: 'managed', args: [], env: { TOKEN: 'native' } };
    opencodeAdapter.entries[alias] = structuredClone(raw);
    await importMcpEntry({
      name: alias,
      canonicalName: 'my-server',
      common: { transportType: 'stdio', command: 'managed', args: [], url: null },
      sources: [{ backend: 'opencode', entryName: alias, fingerprint: fingerprintNativeEntry(raw) }],
    }, ['opencode'], { adapters });
    claudeAdapter.entries[alias] = { command: 'conflict', args: [], env: {} };

    const result = await discoverUnmanagedMcpEntries({ adapters });
    const group = result.groups.find((item) => item.normalizedName === alias);
    expect(group?.variants).toHaveLength(1);
    expect(group?.variants[0].common.command).toBe('conflict');
    expect(group?.variants[0].sources).toEqual([
      expect.objectContaining({ backend: 'claude-code', entryName: alias }),
    ]);
    expect(group?.variants[0].sources.some((source) => source.backend === 'opencode')).toBe(false);
  });

  it('keeps lock identity stable through missing file creation under symlinked parent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-mcp-lock-'));
    try {
      const realParent = path.join(root, 'real');
      const linkedParent = path.join(root, 'linked');
      fs.mkdirSync(realParent);
      fs.symlinkSync(realParent, linkedParent);
      const configPath = path.join(linkedParent, 'nested', 'config.json');
      const before = canonicalConfigLockPath(configPath);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{}');
      const after = canonicalConfigLockPath(configPath);
      expect(after).toBe(before);
      expect(after.startsWith(fs.realpathSync(realParent))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
