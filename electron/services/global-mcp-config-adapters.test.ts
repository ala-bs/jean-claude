import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import {
  ClaudeCodeConfigAdapter,
  CodexConfigAdapter,
  CopilotConfigAdapter,
  discoverMcpEntries,
  fingerprintNativeEntry,
  groupDiscoveredMcpEntries,
  OpenCodeConfigAdapter,
  toConfigEntry,
  VibeConfigAdapter,
} from './global-mcp-config-adapters';

describe('global-mcp-config-adapters', () => {
  let tmpDir: string;

  beforeEach((context) => {
    tmpDir = path.join(
      os.tmpdir(),
      `jc-mcp-adapter-${context.task.id}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ClaudeCodeConfigAdapter', () => {
    const adapter = new ClaudeCodeConfigAdapter();

    it('reads empty entries from missing config', () => {
      const entries = adapter.readEntries(
        path.join(tmpDir, 'missing.json'),
      );
      expect(entries).toEqual({});
    });

    it('writes and reads an entry preserving unrelated config', () => {
      const configPath = path.join(tmpDir, 'claude.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ otherSetting: true }),
      );

      adapter.writeEntry(
        'test-server',
        { command: 'npx', args: ['test'] },
        configPath,
      );

      const entries = adapter.readEntries(configPath);
      expect(entries['test-server']).toEqual({
        command: 'npx',
        args: ['test'],
      });

      // Verify unrelated config preserved
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.otherSetting).toBe(true);
    });

    it('removes an entry preserving others', () => {
      const configPath = path.join(tmpDir, 'claude.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            keep: { command: 'a' },
            remove: { command: 'b' },
          },
        }),
      );

      adapter.removeEntry('remove', configPath);

      const entries = adapter.readEntries(configPath);
      expect(entries['keep']).toBeDefined();
      expect(entries['remove']).toBeUndefined();
    });

    it('supports native transports', () => {
      expect(adapter.supportsTransport('stdio')).toBe(true);
      expect(adapter.supportsTransport('sse')).toBe(true);
      expect(adapter.supportsTransport('http')).toBe(true);
    });
  });

  describe('OpenCodeConfigAdapter', () => {
    const adapter = new OpenCodeConfigAdapter();

    it('reads from mcp key instead of mcpServers', () => {
      const configPath = path.join(tmpDir, 'opencode.json');
      fs.writeFileSync(
        configPath,
        `{// comment\n"other":true,"mcp":{"my-server":{"type":"local","command":["test","arg"],"environment":{"A":"1"}}},}`,
      );

      const entries = adapter.readEntries(configPath);
      expect(entries['my-server']).toEqual({ command: 'test', args: ['arg'], env: { A: '1' } });
    });

    it('writes backend-native local and remote entries', () => {
      const configPath = path.join(tmpDir, 'opencode.jsonc');
      adapter.writeEntry('local', { command: 'npx', args: ['-y'], env: { A: '1' } }, configPath);
      adapter.writeEntry('remote', { type: 'http', url: 'https://example.com/mcp' }, configPath);
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(raw.mcp.local).toEqual({ type: 'local', command: ['npx', '-y'], environment: { A: '1' }, enabled: true });
      expect(raw.mcp.remote).toEqual({ type: 'remote', url: 'https://example.com/mcp', enabled: true });
    });

    it('preserves unrelated JSONC bytes and comments', () => {
      const configPath = path.join(tmpDir, 'comments.jsonc');
      const before = '{\r\n  // keep exactly\r\n  "theme": { "x": 1, },\r\n  "mcp": {}\r\n}\r\n';
      fs.writeFileSync(configPath, before);
      adapter.writeEntry('new', { command: 'npx' }, configPath);
      const after = fs.readFileSync(configPath, 'utf8');
      expect(after).toContain('// keep exactly\r\n  "theme": { "x": 1, },');
      adapter.removeEntry('new', configPath);
      expect(fs.readFileSync(configPath, 'utf8')).toContain(
        '// keep exactly\r\n  "theme": { "x": 1, },',
      );
    });

    it('supports local and remote MCP', () => {
      expect(adapter.supportsTransport('stdio')).toBe(true);
      expect(adapter.supportsTransport('http')).toBe(true);
      expect(adapter.supportsTransport('sse')).toBe(false);
    });
  });

  describe('TOML adapters', () => {
    it.each([
      ['codex', new CodexConfigAdapter()],
      ['vibe', new VibeConfigAdapter()],
    ])('round trips %s MCP entries while preserving unrelated TOML', (_, adapter) => {
      const configPath = path.join(tmpDir, `${adapter.backend}.toml`);
      fs.writeFileSync(configPath, 'model = "keep-me"\n');
      adapter.writeEntry('local', { command: 'npx', args: ['-y'], env: { TOKEN: 'x' } }, configPath);
      adapter.writeEntry('remote', { type: 'http', url: 'https://example.com/mcp' }, configPath);
      expect(adapter.readEntries(configPath)).toEqual({
        local: { command: 'npx', args: ['-y'], env: { TOKEN: 'x' } },
        remote: { type: 'http', url: 'https://example.com/mcp' },
      });
      expect(fs.readFileSync(configPath, 'utf8')).toContain('model = "keep-me"');
      expect(fs.readFileSync(configPath, 'utf8')).toContain(
        adapter.backend === 'vibe' ? '[[mcp_servers]]' : '[mcp_servers.local]',
      );
    });

    it('preserves unrelated TOML comments and supports quoted dotted names', () => {
      const configPath = path.join(tmpDir, 'codex-comments.toml');
      const unrelated = '# exact comment\nmodel = "keep"\n\n[other.table]\nvalue = 1 # inline\n';
      fs.writeFileSync(configPath, unrelated);
      const adapter = new CodexConfigAdapter();
      adapter.writeEntry('a.b "quoted"', { command: 'npx', args: ['-y'] }, configPath);
      expect(fs.readFileSync(configPath, 'utf8')).toContain(unrelated.trimEnd());
      expect(adapter.readEntries(configPath)['a.b "quoted"']).toBeDefined();
      adapter.removeEntry('a.b "quoted"', configPath);
      expect(fs.readFileSync(configPath, 'utf8')).toContain(unrelated.trimEnd());
    });

    it('replaces and removes Codex nested MCP subtables without touching siblings', () => {
      const configPath = path.join(tmpDir, 'codex-nested.toml');
      const unrelated = '[mcp_servers.sibling]\ncommand = "keep"\n\n[unrelated]\nvalue = "exact" # keep\n';
      fs.writeFileSync(
        configPath,
        '[mcp_servers."a.b"]\ncommand = "old"\n\n[mcp_servers."a.b".env]\nTOKEN = "stale"\n\n' + unrelated,
      );
      const adapter = new CodexConfigAdapter();
      adapter.writeEntry('a.b', { command: 'new', env: { FRESH: 'yes' } }, configPath);
      let content = fs.readFileSync(configPath, 'utf8');
      expect(content).not.toContain('TOKEN = "stale"');
      expect(adapter.readEntries(configPath)['a.b'].env).toEqual({ FRESH: 'yes' });
      expect(content).toContain(unrelated);
      adapter.removeEntry('a.b', configPath);
      content = fs.readFileSync(configPath, 'utf8');
      expect(content).not.toContain('mcp_servers."a.b"');
      expect(content).toContain(unrelated);
    });

    it('reads and surgically removes valid Vibe blocks from mixed table layouts', () => {
      const configPath = path.join(tmpDir, 'vibe-mixed.toml');
      const prefix = '[mcp_servers]\nlegacy = "keep"\n\n';
      const target = '[[mcp_servers]]\nname = "maestro"\ntransport = "stdio"\ncommand = "maestro"\nargs = ["serve"]\ncustom = "keep-option"\n\n[mcp_servers.env]\nTOKEN = "secret"\n\n';
      const suffix = '[unrelated]\nvalue = "keep-exact" # comment\n';
      fs.writeFileSync(configPath, prefix + target + suffix);
      const adapter = new VibeConfigAdapter();

      const native = adapter.readNativeEntries(configPath).maestro;
      expect(native).toEqual(expect.objectContaining({
        command: 'maestro',
        args: ['serve'],
        custom: 'keep-option',
        env: { TOKEN: 'secret' },
      }));
      adapter.removeNativeEntry('maestro', fingerprintNativeEntry(native), configPath);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(prefix + suffix);
    });

    it('rejects malformed or duplicate Vibe fallback blocks', () => {
      const adapter = new VibeConfigAdapter();
      const malformedPath = path.join(tmpDir, 'vibe-malformed-block.toml');
      fs.writeFileSync(malformedPath, '[mcp_servers]\nlegacy = "keep"\n[[mcp_servers]]\nname = "maestro"\nargs = [\n');
      expect(() => adapter.readNativeEntries(malformedPath)).toThrow('Cannot parse Vibe MCP block');

      const duplicatePath = path.join(tmpDir, 'vibe-duplicate-block.toml');
      fs.writeFileSync(duplicatePath, '[mcp_servers]\nlegacy = "keep"\n[[mcp_servers]]\nname = "maestro"\ncommand = "one"\n[[mcp_servers]]\nname = "maestro"\ncommand = "two"\n');
      expect(() => adapter.readNativeEntries(duplicatePath)).toThrow('duplicate MCP server maestro');

      const unrelatedPath = path.join(tmpDir, 'vibe-malformed-unrelated.toml');
      fs.writeFileSync(unrelatedPath, '[mcp_servers]\nlegacy = "keep"\n[[mcp_servers]]\nname = "maestro"\ncommand = "ok"\n[unrelated]\nbroken = [\n');
      expect(() => adapter.readNativeEntries(unrelatedPath)).toThrow('Cannot parse unrelated Vibe TOML');
    });

    it('replaces empty root assignment when adding first Vibe server', () => {
      const configPath = path.join(tmpDir, 'vibe-empty-assignment.toml');
      const unrelated = '# keep exact\nmodel = "keep"\n';
      fs.writeFileSync(configPath, `mcp_servers = []\n${unrelated}`);
      const adapter = new VibeConfigAdapter();
      adapter.writeEntry('maestro', { command: 'maestro', args: ['serve'] }, configPath);
      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = parseToml(content) as { mcp_servers: unknown[] };
      expect(content).not.toContain('mcp_servers = []');
      expect(content).toContain(unrelated.trimEnd());
      expect(Array.isArray(parsed.mcp_servers)).toBe(true);
      expect(parsed.mcp_servers).toHaveLength(1);
    });

    it('converts multiline root array entries without losing native fields', () => {
      const configPath = path.join(tmpDir, 'vibe-inline-assignment.toml');
      const unrelated = '# unrelated exact\nmodel = "keep"\n';
      fs.writeFileSync(configPath, `mcp_servers = [\n  { name = "existing", transport = "stdio", command = "old", custom = "native", env = { TOKEN = "secret" } },\n]\n${unrelated}`);
      const adapter = new VibeConfigAdapter();
      adapter.writeEntry('maestro', { command: 'maestro' }, configPath);
      const content = fs.readFileSync(configPath, 'utf8');
      const parsed = parseToml(content) as { mcp_servers: Array<Record<string, unknown>> };
      expect(content).toContain(unrelated.trimEnd());
      expect(parsed.mcp_servers).toHaveLength(2);
      expect(parsed.mcp_servers[0]).toEqual(expect.objectContaining({
        name: 'existing',
        command: 'old',
        custom: 'native',
        env: { TOKEN: 'secret' },
      }));
    });
  });

  it('does not replace malformed existing config', () => {
    const configPath = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(configPath, '{broken');
    expect(() => new ClaudeCodeConfigAdapter().writeEntry('x', { command: 'x' }, configPath)).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{broken');
  });

  describe('CopilotConfigAdapter', () => {
    const adapter = new CopilotConfigAdapter();

    it('supports stdio and http', () => {
      expect(adapter.supportsTransport('stdio')).toBe(true);
      expect(adapter.supportsTransport('http')).toBe(true);
      expect(adapter.supportsTransport('sse')).toBe(false);
    });

    it('uses Copilot CLI global MCP path', () => {
      expect(adapter.defaultConfigPath()).toBe(path.join(os.homedir(), '.copilot', 'mcp-config.json'));
    });
  });

  it('retains unknown native options when merging common fields', () => {
    const adapter = new CodexConfigAdapter();
    const merged = adapter.mergeNativeEntry(
      { command: 'node', args: ['new'] },
      { command: 'old', cwd: '/work', tool_timeout_sec: 30, http_headers: { Authorization: 'secret' } },
    );
    expect(merged).toEqual({
      command: 'node',
      args: ['new'],
      cwd: '/work',
      tool_timeout_sec: 30,
      http_headers: { Authorization: 'secret' },
    });
  });

  it('preserves comments around unknown JSONC options during managed leaf edits', () => {
    const configPath = path.join(tmpDir, 'leaf.jsonc');
    fs.writeFileSync(configPath, '{\n  "mcpServers": {\n    "x": {\n      // keep unknown\n      "custom": { "value": 1 },\n      "command": "old"\n    }\n  }\n}\n');
    const adapter = new ClaudeCodeConfigAdapter();
    const current = adapter.readNativeEntries(configPath).x;
    adapter.writeNativeEntry('x', adapter.mergeNativeEntry({ command: 'new' }, current), fingerprintNativeEntry(current), configPath);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('// keep unknown\n      "custom": { "value": 1 },');
    expect(content).toContain('"command": "new"');
  });

  it('preserves comments around unknown TOML options during managed leaf edits', () => {
    const configPath = path.join(tmpDir, 'leaf.toml');
    fs.writeFileSync(configPath, '[mcp_servers.x]\n# keep unknown\ncustom_option = "exact" # inline\ncommand = "old"\n');
    const adapter = new CodexConfigAdapter();
    const current = adapter.readNativeEntries(configPath).x;
    adapter.writeNativeEntry('x', adapter.mergeNativeEntry({ command: 'new' }, current), fingerprintNativeEntry(current), configPath);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('# keep unknown\ncustom_option = "exact" # inline');
    expect(content).toContain('command = "new"');
  });

  it('preserves TOML managed-value indentation and inline comments', () => {
    const configPath = path.join(tmpDir, 'toml-format.toml');
    fs.writeFileSync(configPath, '[mcp_servers.x]\n  command   = "old"  # keep command note\n  args = ["old"] # keep args note\n');
    const adapter = new CodexConfigAdapter();
    const current = adapter.readNativeEntries(configPath).x;
    adapter.writeNativeEntry(
      'x',
      adapter.mergeNativeEntry({ command: 'new', args: ['fresh'] }, current),
      fingerprintNativeEntry(current),
      configPath,
    );
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('  command = "new"  # keep command note');
    expect(content).toContain('  args = ["fresh"] # keep args note');
  });

  it('rejects CAS mutation after native entry drift', () => {
    const configPath = path.join(tmpDir, 'cas.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { x: { command: 'changed' } } }));
    expect(() => new ClaudeCodeConfigAdapter().removeNativeEntry('x', 'stale', configPath)).toThrow('drift');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.x.command).toBe('changed');
  });

  it('preserves existing file mode during atomic replacement', () => {
    const configPath = path.join(tmpDir, 'mode.json');
    fs.writeFileSync(configPath, '{}', { mode: 0o640 });
    new ClaudeCodeConfigAdapter().writeEntry('x', { command: 'x' }, configPath);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o640);
  });

  it('creates missing parent directories with private permissions', () => {
    const configPath = path.join(tmpDir, 'fresh', 'nested', 'config.json');
    new ClaudeCodeConfigAdapter().writeEntry('x', { command: 'x' }, configPath);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.x.command).toBe('x');
    expect(fs.statSync(path.dirname(configPath)).mode & 0o077).toBe(0);
  });

  it('updates a symlink target without replacing the symlink', () => {
    const target = path.join(tmpDir, 'target.json');
    const link = path.join(tmpDir, 'config.json');
    fs.writeFileSync(target, JSON.stringify({ keep: true }), { mode: 0o640 });
    fs.symlinkSync(target, link);
    new ClaudeCodeConfigAdapter().writeEntry('x', { command: 'x' }, link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).keep).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it('rejects dangling config symlinks without replacing them', () => {
    const link = path.join(tmpDir, 'dangling.json');
    fs.symlinkSync(path.join(tmpDir, 'missing.json'), link);
    expect(() => new ClaudeCodeConfigAdapter().writeEntry('x', { command: 'x' }, link)).toThrow('dangling');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  describe('toConfigEntry', () => {
    it('builds entry for stdio server', () => {
      const entry = toConfigEntry({
        transportType: 'stdio',
        command: 'npx',
        args: ['-y', 'server'],
        env: { DEBUG: '1' },
        url: null,
      });
      expect(entry).toEqual({
        command: 'npx',
        args: ['-y', 'server'],
        env: { DEBUG: '1' },
      });
    });

    it('builds entry for http server', () => {
      const entry = toConfigEntry({
        transportType: 'http',
        command: null,
        args: [],
        env: {},
        url: 'http://localhost:3000',
      });
      expect(entry).toEqual({
        type: 'http',
        url: 'http://localhost:3000',
      });
    });
  });

  describe('discoverMcpEntries', () => {
    it('discovers entries not in known set', () => {
      const configPath = path.join(tmpDir, 'discover.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            unknown: { command: 'test' },
            known: { command: 'known-cmd' },
          },
        }),
      );

      const adapter = new ClaudeCodeConfigAdapter();
      // Override readEntries to use our test path
      const origRead = adapter.readEntries.bind(adapter);
      adapter.readEntries = () => origRead(configPath);

      const discovered = discoverMcpEntries(
        new Set(['known']),
        [adapter],
      );

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('unknown');
      expect(discovered[0].backend).toBe('claude-code');
    });

    it('keeps differing same-name entries across backends', () => {
      const configPath1 = path.join(tmpDir, 'c1.json');
      const configPath2 = path.join(tmpDir, 'c2.json');
      fs.writeFileSync(
        configPath1,
        JSON.stringify({ mcpServers: { shared: { command: 'a' } } }),
      );
      fs.writeFileSync(
        configPath2,
        'mcp_servers.shared.command = "b"\n',
      );

      const a1 = new ClaudeCodeConfigAdapter();
      a1.readEntries = () =>
        new ClaudeCodeConfigAdapter().readEntries(configPath1);

      const a2 = new CodexConfigAdapter();
      a2.readEntries = () =>
        new CodexConfigAdapter().readEntries(configPath2);

      const discovered = discoverMcpEntries(new Set(), [a1, a2]);
      expect(discovered).toHaveLength(2);
    });
  });

  describe('groupDiscoveredMcpEntries', () => {
    it('combines four matching maestro sources into one renderer-safe variant', () => {
      const groups = groupDiscoveredMcpEntries(
        (['claude-code', 'opencode', 'codex', 'vibe'] as const).map(
          (backend, index) => ({
            name: index % 2 === 0 ? 'Maestro' : ' maestro ',
            transportType: 'stdio' as const,
            command: 'npx',
            args: ['maestro-mcp'],
            env: { SECRET: `backend-${index}` },
            url: null,
            backend,
            fingerprint: String(index).padStart(64, 'a'),
          }),
        ),
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].conflict).toBe(false);
      expect(groups[0].variants).toHaveLength(1);
      expect(groups[0].variants[0].sources).toHaveLength(4);
      expect(groups[0].variants[0]).not.toHaveProperty('env');
    });

    it('keeps same-name common-config mismatches as conflict variants', () => {
      const groups = groupDiscoveredMcpEntries([
        { name: 'docs', transportType: 'stdio', command: 'npx', args: ['a'], env: {}, url: null, backend: 'claude-code', fingerprint: 'a'.repeat(64) },
        { name: 'DOCS', transportType: 'http', command: null, args: [], env: {}, url: 'https://example.com/mcp', backend: 'opencode', fingerprint: 'b'.repeat(64) },
      ]);
      expect(groups[0].conflict).toBe(true);
      expect(groups[0].variants).toHaveLength(2);
    });

    it('groups normalized backend-native shapes despite env and fingerprint differences', () => {
      const groups = groupDiscoveredMcpEntries([
        { name: 'server', transportType: 'stdio', command: 'node', args: ['index.js'], env: { A: '1' }, url: null, backend: 'claude-code', fingerprint: 'a'.repeat(64) },
        { name: 'server', transportType: 'stdio', command: 'node', args: ['index.js'], env: { B: '2' }, url: null, backend: 'opencode', fingerprint: 'b'.repeat(64) },
      ]);
      expect(groups[0].variants).toHaveLength(1);
      expect(groups[0].variants[0].sources.map((source) => source.backend).sort()).toEqual(['claude-code', 'opencode']);
    });

    it('keeps same-backend normalized-name aliases as explicit conflict variants', () => {
      const groups = groupDiscoveredMcpEntries([
        { name: 'Foo', transportType: 'stdio', command: 'node', args: [], env: {}, url: null, backend: 'claude-code', fingerprint: 'a'.repeat(64) },
        { name: ' foo ', transportType: 'stdio', command: 'node', args: [], env: {}, url: null, backend: 'claude-code', fingerprint: 'b'.repeat(64) },
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].conflict).toBe(true);
      expect(groups[0].variants).toHaveLength(2);
      expect(groups[0].variants.map((variant) => variant.sources[0].entryName)).toEqual(['Foo', ' foo ']);
    });
  });
});
