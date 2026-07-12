import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';

import { applyEdits, modify, type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { dbg } from '../lib/debug';

import type { AgentBackendType } from '@shared/agent-backend-types';
import type {
  DiscoveredMcpGroup,
  DiscoveredMcpVariant,
  McpTransportType,
} from '@shared/global-mcp-types';
import {
  normalizeGlobalMcpName,
  sanitizeGlobalMcpName,
} from '@shared/global-mcp-types';

export interface McpConfigEntry {
  type?: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface GlobalMcpConfigAdapter {
  readonly backend: AgentBackendType;
  readEntries(configPath?: string): Record<string, McpConfigEntry>;
  writeEntry(name: string, entry: McpConfigEntry, configPath?: string): void;
  removeEntry(name: string, configPath?: string): void;
  supportsTransport(type: McpTransportType): boolean;
  defaultConfigPath(): string;
  readNativeEntries(configPath?: string): Record<string, Record<string, unknown>>;
  mergeNativeEntry(entry: McpConfigEntry, previous?: Record<string, unknown>): Record<string, unknown>;
  writeNativeEntry(name: string, entry: Record<string, unknown>, expectedFingerprint: string | null, configPath?: string): void;
  removeNativeEntry(name: string, expectedFingerprint: string, configPath?: string): void;
  repairConfigRepresentation?(configPath?: string): boolean;
}

type Config = Record<string, unknown>;

export interface DiscoveredMcpOccurrence {
  name: string;
  transportType: McpTransportType;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  backend: AgentBackendType;
  fingerprint: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Config).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintNativeEntry(entry: Record<string, unknown>): string {
  return createHash('sha256').update(stable(entry)).digest('hex');
}

function assertFingerprint(
  backend: AgentBackendType,
  name: string,
  current: Record<string, unknown> | undefined,
  expected: string | null,
): void {
  const actual = current ? fingerprintNativeEntry(current) : null;
  if (actual !== expected) {
    dbg.mcp('global MCP CAS backend=%s server=%s result=drift', backend, name);
    throw new Error(`MCP entry drift on ${backend}: ${name}`);
  }
}

function readJson(configPath: string): Config {
  if (!fs.existsSync(configPath)) return {};
  const content = fs.readFileSync(configPath, 'utf8');
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) throw new Error(`Cannot mutate malformed JSON/JSONC config ${configPath}: parse error at byte ${errors[0].offset}`);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config object: ${configPath}`);
  }
  return parsed as Config;
}

function mutateJsonProperty(configPath: string, propertyPath: string[], value: unknown, backend?: AgentBackendType, expectedFingerprint?: string | null): void {
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '{}\n';
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) throw new Error(`Cannot mutate malformed JSON/JSONC config ${configPath}: parse error at byte ${errors[0].offset}`);
  if (backend && expectedFingerprint !== undefined) {
    const current = propertyPath.reduce<unknown>((valueAtPath, key) => object(valueAtPath)[key], parsed);
    assertFingerprint(backend, propertyPath.at(-1) ?? '', current && typeof current === 'object' && !Array.isArray(current) ? current as Config : undefined, expectedFingerprint);
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(content, propertyPath, value, {
    formattingOptions: { insertSpaces: !/^\t/m.test(content), tabSize: 2, eol },
  });
  const updated = applyEdits(content, edits);
  atomicWrite(configPath, updated, content);
  dbg.mcp('global config mutation backend=%s path=%s server=%s action=%s result=ok bytesChanged=%d', 'json', configPath, propertyPath.at(-1), value === undefined ? 'remove' : 'write', updated.length - content.length);
}

function mutateJsonEntryFields(
  configPath: string,
  propertyPath: string[],
  current: Config,
  next: Config,
  backend: AgentBackendType,
  expectedFingerprint: string,
): void {
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '{}\n';
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length) throw new Error(`Cannot mutate malformed JSON/JSONC config ${configPath}: parse error at byte ${errors[0].offset}`);
  const currentFromContent = propertyPath.reduce<unknown>((valueAtPath, key) => object(valueAtPath)[key], parsed);
  assertFingerprint(backend, propertyPath.at(-1) ?? '', object(currentFromContent), expectedFingerprint);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const options = { formattingOptions: { insertSpaces: !/^\t/m.test(content), tabSize: 2, eol } };
  let updated = content;
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (stable(current[key]) === stable(next[key])) continue;
    updated = applyEdits(updated, modify(updated, [...propertyPath, key], next[key], options));
  }
  atomicWrite(configPath, updated, content);
  dbg.mcp('global config mutation backend=json path=%s server=%s action=update result=ok bytesChanged=%d', configPath, propertyPath.at(-1), updated.length - content.length);
}

function readToml(configPath: string): Config {
  if (!fs.existsSync(configPath)) return {};
  return parseToml(fs.readFileSync(configPath, 'utf8')) as Config;
}

type VibeMcpBlock = {
  name: string;
  native: Config;
  start: number;
  end: number;
};

function isTomlRedefinitionError(error: unknown): boolean {
  return error instanceof Error &&
    error.constructor.name === 'TomlError' &&
    error.message.includes('redefine an already defined table or value');
}

function scanVibeMcpBlocks(content: string, configPath: string): VibeMcpBlock[] {
  const roots = [...content.matchAll(/^\s*\[\[mcp_servers\]\]\s*(?:#.*)?$/gm)];
  const blocks = roots.map((root) => {
    const start = root.index ?? 0;
    const nextHeader = /^\s*\[\[?[^\n]+\]\]?\s*(?:#.*)?$/gm;
    nextHeader.lastIndex = start + root[0].length;
    let candidate = nextHeader.exec(content);
    while (candidate && /^\s*\[\[?mcp_servers\./.test(candidate[0])) candidate = nextHeader.exec(content);
    const end = candidate?.index ?? content.length;
    let parsed: Config;
    try {
      parsed = parseToml(content.slice(start, end)) as Config;
    } catch (error) {
      throw new Error(`Cannot parse Vibe MCP block in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const raw = object((parsed.mcp_servers as unknown[])?.[0]);
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!name) throw new Error(`Cannot parse Vibe MCP block in ${configPath}: missing server name`);
    const native = { ...raw };
    delete native.name;
    return { name, native, start, end };
  });
  const names = new Set<string>();
  for (const block of blocks) {
    if (names.has(block.name)) throw new Error(`Cannot parse ambiguous Vibe config ${configPath}: duplicate MCP server ${block.name}`);
    names.add(block.name);
  }
  return blocks;
}

function readVibeMcpBlocks(content: string, configPath: string): VibeMcpBlock[] {
  let fallback = false;
  try {
    parseToml(content);
  } catch (error) {
    if (!isTomlRedefinitionError(error)) throw error;
    fallback = true;
    dbg.mcp('global MCP TOML fallback backend=vibe path=%s errorClass=%s', configPath, error instanceof Error ? error.constructor.name : typeof error);
  }
  const blocks = scanVibeMcpBlocks(content, configPath);
  if (fallback) {
    let unrelated = content;
    for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
      unrelated = unrelated.slice(0, block.start) + unrelated.slice(block.end);
    }
    try {
      parseToml(unrelated);
    } catch (error) {
      throw new Error(`Cannot parse unrelated Vibe TOML in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return blocks;
}

function rootVibeAssignment(content: string): { start: number; end: number; entries: Config[] } | undefined {
  const firstHeader = content.search(/^\s*\[/m);
  const prefix = firstHeader < 0 ? content : content.slice(0, firstHeader);
  const match = /^\s*mcp_servers\s*=\s*/m.exec(prefix);
  if (!match) return undefined;
  const start = match.index;
  const valueStart = start + match[0].length;
  if (content[valueStart] !== '[') throw new Error('Invalid Vibe mcp_servers root assignment: expected array value');
  let depth = 0;
  let quote = '';
  let escaped = false;
  let valueEnd = -1;
  for (let index = valueStart; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\' && quote === '"') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') depth += 1;
    else if (char === ']' && --depth === 0) {
      valueEnd = index + 1;
      break;
    }
  }
  if (valueEnd < 0) throw new Error('Invalid Vibe mcp_servers root assignment: unterminated array');
  const lineEnd = content.indexOf('\n', valueEnd);
  const end = lineEnd < 0 ? content.length : lineEnd + 1;
  const parsed = parseToml(content.slice(start, end)) as Config;
  if (!Array.isArray(parsed.mcp_servers)) throw new Error('Invalid Vibe mcp_servers root assignment');
  return { start, end, entries: parsed.mcp_servers.map(object) };
}

function normalizeVibeRepresentation(content: string, configPath: string): string {
  const assignment = rootVibeAssignment(content);
  if (!assignment) return content;
  const blocks = scanVibeMcpBlocks(content, configPath);
  const names = new Set(blocks.map((block) => block.name));
  for (const entry of assignment.entries) {
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!name) throw new Error(`Cannot repair Vibe MCP representation in ${configPath}: inline entry missing name`);
    if (names.has(name)) throw new Error(`Cannot repair ambiguous Vibe config ${configPath}: duplicate MCP server ${name}`);
    names.add(name);
  }
  const withoutAssignment = content.slice(0, assignment.start) + content.slice(assignment.end);
  const serialized = assignment.entries.length > 0
    ? stringifyToml({ mcp_servers: assignment.entries })
    : '';
  const updated = serialized
    ? `${withoutAssignment.replace(/\s*$/, '')}${withoutAssignment.trim() ? '\n\n' : ''}${serialized}`
    : withoutAssignment;
  try {
    parseToml(updated);
  } catch (error) {
    throw new Error(`Cannot repair Vibe MCP representation in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return updated;
}

function mutateTomlServer(
  configPath: string,
  backend: 'codex' | 'vibe',
  name: string,
  rawEntry: Config | undefined,
  previousRawEntry?: Config,
  expectedFingerprint?: string | null,
): void {
  const originalContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const content = backend === 'vibe'
    ? normalizeVibeRepresentation(originalContent, configPath)
    : originalContent;
  let parsedContent: Config;
  let vibeBlocks: VibeMcpBlock[] | undefined;
  try {
    if (backend === 'vibe') {
      vibeBlocks = readVibeMcpBlocks(content, configPath);
      parsedContent = {};
    } else {
      parsedContent = parseToml(content) as Config;
    }
  } catch (error) {
    throw new Error(`Cannot mutate malformed TOML config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (expectedFingerprint !== undefined) {
    const current = backend === 'vibe'
      ? vibeBlocks?.find((candidate) => candidate.name === name)?.native
      : object(parsedContent.mcp_servers)[name];
    const native = current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Config) }
      : undefined;
    assertFingerprint(backend, name, native, expectedFingerprint);
  }
  const header = backend === 'codex' ? /^\s*\[mcp_servers(?:\.([^\]]+))\]\s*(?:#.*)?$/gm : /^\s*\[\[mcp_servers\]\]\s*(?:#.*)?$/gm;
  const matches = [...content.matchAll(header)].filter((match) => {
    if (backend === 'vibe') return true;
    try {
      const parsed = parseToml(`${match[0].trim()}\n`) as Config;
      const serverName = Object.keys(object(parsed.mcp_servers))[0];
      return serverName !== undefined && Object.keys(object(object(parsed.mcp_servers)[serverName])).length === 0;
    } catch {
      return false;
    }
  });
  const blocks = backend === 'vibe'
    ? (vibeBlocks ?? []).filter((candidate) => candidate.name === name)
    : matches.map((match) => ({
    start: match.index ?? 0,
    end: (() => {
      const start = (match.index ?? 0) + match[0].length;
      const nextHeader = /^\s*\[\[?[^\n]+\]\]?\s*(?:#.*)?$/gm;
      nextHeader.lastIndex = start;
      let candidate = nextHeader.exec(content);
      while (candidate) {
        const headerText = candidate[0].trim();
        let belongs = false;
        if (backend === 'codex') {
          try {
            const parsed = parseToml(`${headerText}\n`) as Config;
            belongs = Object.prototype.hasOwnProperty.call(
              object(parsed.mcp_servers),
              nameFromRootHeader(content.slice(match.index ?? 0, start)),
            );
          } catch {
            belongs = false;
          }
        } else {
          belongs = /^\[mcp_servers(?:\.|\])/.test(headerText);
        }
        if (!belongs) return candidate.index;
        candidate = nextHeader.exec(content);
      }
      return content.length;
    })(),
    match,
    })).filter((block) => {
    try {
      const parsed = parseToml(content.slice(block.start, block.end)) as Config;
      return Object.prototype.hasOwnProperty.call(object(parsed.mcp_servers), name);
    } catch { return false; }
    });
  if (blocks.length > 1) throw new Error(`Cannot mutate ambiguous TOML config ${configPath}: duplicate MCP server ${name}`);
  const block = blocks[0];
  const replacement = rawEntry
    ? block && previousRawEntry
      ? patchTomlCommonFields(
          content.slice(block.start, block.end),
          previousRawEntry,
          rawEntry,
        )
      : stringifyToml(backend === 'vibe' ? { mcp_servers: [{ name, ...rawEntry }] } : { mcp_servers: { [name]: rawEntry } })
    : '';
  const prefix = block ? content.slice(0, block.start) : content.replace(/\s*$/, '');
  const suffix = block ? content.slice(block.end) : '';
  const separator = replacement && prefix ? (prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n') : '';
  const updated = block
    ? `${prefix}${replacement}${replacement && suffix && !replacement.endsWith('\n') ? '\n' : ''}${suffix}`
    : `${prefix}${separator}${replacement}`;
  try {
    parseToml(updated);
  } catch (error) {
    throw new Error(`Refusing to write invalid TOML config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  atomicWrite(configPath, updated, originalContent);
  dbg.mcp('global config mutation backend=%s path=%s server=%s action=%s result=ok bytesChanged=%d', backend, configPath, name, rawEntry ? 'write' : 'remove', updated.length - content.length);
}

function patchTomlCommonFields(
  block: string,
  previous: Config,
  next: Config,
): string {
  let updated = block;
  const keys = ['transport', 'command', 'args', 'url', 'env'];
  for (const key of keys) {
    if (stable(previous[key]) === stable(next[key])) continue;
    if (key === 'env') {
      updated = updated.replace(
        /^\s*\[mcp_servers[^\n]*\.env\]\s*(?:#.*)?\r?\n[\s\S]*?(?=^\s*\[|$)/gm,
        '',
      );
    }
    const assignment = new RegExp(`^([ \\t]*)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*=.*?(\\s+#.*)?(\\r?\\n|$)`, 'm');
    if (next[key] === undefined) {
      updated = updated.replace(assignment, '');
      continue;
    }
    const line = `${key} = ${tomlInlineValue(next[key])}\n`;
    if (assignment.test(updated)) {
      updated = updated.replace(
        assignment,
        (_match, indentation: string, inlineComment: string | undefined, newline: string) =>
          `${indentation}${key} = ${tomlInlineValue(next[key])}${inlineComment ?? ''}${newline || '\n'}`,
      );
    } else {
      const firstLineEnd = updated.indexOf('\n');
      updated = firstLineEnd < 0
        ? `${updated}\n${line}`
        : `${updated.slice(0, firstLineEnd + 1)}${line}${updated.slice(firstLineEnd + 1)}`;
    }
  }
  return updated;
}

function tomlInlineValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlInlineValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value as Config).map(([key, item]) => `${JSON.stringify(key)} = ${tomlInlineValue(item)}`).join(', ')} }`;
  }
  throw new Error('Unsupported TOML MCP value');
}

function nameFromRootHeader(header: string): string {
  try {
    const parsed = parseToml(`${header.trim()}\n`) as Config;
    return Object.keys(object(parsed.mcp_servers))[0] ?? '';
  } catch {
    return '';
  }
}

function atomicWrite(configPath: string, content: string, expectedContent: string): void {
  const target = resolveWriteTarget(configPath);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const exists = fs.existsSync(target);
  const stat = exists ? fs.statSync(target) : undefined;
  const mode = stat?.mode ?? 0o600;
  const current = exists ? fs.readFileSync(target, 'utf8') : expectedContent;
  if (current !== expectedContent) {
    throw new Error(`Config changed during MCP mutation: ${configPath}`);
  }
  const temporaryPath = path.join(parent, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(fileDescriptor, content, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.chmodSync(temporaryPath, mode);
    if (stat) {
      try { fs.chownSync(temporaryPath, stat.uid, stat.gid); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }
    }
    fs.renameSync(temporaryPath, target);
    const directoryDescriptor = fs.openSync(parent, 'r');
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try { fs.closeSync(fileDescriptor); } catch { /* preserve original error */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

function resolveWriteTarget(configPath: string): string {
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isSymbolicLink()) return configPath;
    try { return fs.realpathSync(configPath); }
    catch { throw new Error(`Cannot mutate dangling MCP config symlink: ${configPath}`); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configPath;
    throw error;
  }
}

function object(value: unknown): Config {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Config)
    : {};
}

abstract class JsonMcpAdapter implements GlobalMcpConfigAdapter {
  abstract readonly backend: AgentBackendType;
  abstract defaultConfigPath(): string;
  abstract supportsTransport(type: McpTransportType): boolean;
  protected key = 'mcpServers';

  protected resolvePath(configPath?: string): string {
    return configPath ?? this.defaultConfigPath();
  }

  protected decode(raw: Config): McpConfigEntry {
    return raw as McpConfigEntry;
  }

  protected encode(entry: McpConfigEntry): Config {
    return entry as Config;
  }

  readEntries(configPath?: string): Record<string, McpConfigEntry> {
    return Object.fromEntries(Object.entries(this.readNativeEntries(configPath)).map(([name, raw]) => [name, this.decode(raw)]));
  }

  readNativeEntries(configPath?: string): Record<string, Record<string, unknown>> {
    const config = readJson(this.resolvePath(configPath));
    return Object.fromEntries(
      Object.entries(object(config[this.key])).map(([name, value]) => [
        name,
        object(value),
      ]),
    );
  }

  mergeNativeEntry(entry: McpConfigEntry, previous: Record<string, unknown> = {}): Record<string, unknown> {
    const encoded = this.encode(entry);
    const merged = { ...previous, ...encoded };
    if (entry.type && entry.type !== 'stdio') {
      for (const key of ['command', 'args', 'env', 'environment']) delete merged[key];
    } else {
      delete merged.url;
      if (!('type' in encoded)) delete merged.type;
      if (entry.env === undefined) {
        if ('env' in previous) merged.env = previous.env;
        if ('environment' in previous) merged.environment = previous.environment;
      } else {
        if (!('env' in encoded)) delete merged.env;
        if (!('environment' in encoded)) delete merged.environment;
      }
    }
    return merged;
  }

  writeNativeEntry(name: string, entry: Record<string, unknown>, expectedFingerprint: string | null, configPath?: string): void {
    const target = this.resolvePath(configPath);
    const current = this.readNativeEntries(target)[name];
    assertFingerprint(this.backend, name, current, expectedFingerprint);
    if (current) mutateJsonEntryFields(target, [this.key, name], current, entry, this.backend, expectedFingerprint ?? '');
    else mutateJsonProperty(target, [this.key, name], entry, this.backend, expectedFingerprint);
  }

  removeNativeEntry(name: string, expectedFingerprint: string, configPath?: string): void {
    const target = this.resolvePath(configPath);
    assertFingerprint(this.backend, name, this.readNativeEntries(target)[name], expectedFingerprint);
    mutateJsonProperty(target, [this.key, name], undefined, this.backend, expectedFingerprint);
  }

  writeEntry(name: string, entry: McpConfigEntry, configPath?: string): void {
    const existing = this.readNativeEntries(configPath)[name];
    this.writeNativeEntry(name, this.mergeNativeEntry(entry, existing), existing ? fingerprintNativeEntry(existing) : null, configPath);
  }

  removeEntry(name: string, configPath?: string): void {
    const existing = this.readNativeEntries(configPath)[name];
    if (existing) this.removeNativeEntry(name, fingerprintNativeEntry(existing), configPath);
  }
}

export class ClaudeCodeConfigAdapter extends JsonMcpAdapter {
  readonly backend = 'claude-code' as const;
  defaultConfigPath(): string { return path.join(os.homedir(), '.claude.json'); }
  supportsTransport(type: McpTransportType): boolean { return type === 'stdio' || type === 'http' || type === 'sse'; }
}

export class OpenCodeConfigAdapter extends JsonMcpAdapter {
  readonly backend = 'opencode' as const;
  protected key = 'mcp';

  defaultConfigPath(): string {
    const dir = path.join(os.homedir(), '.config', 'opencode');
    const jsonc = path.join(dir, 'opencode.jsonc');
    const json = path.join(dir, 'opencode.json');
    return fs.existsSync(jsonc) || !fs.existsSync(json) ? jsonc : json;
  }

  supportsTransport(type: McpTransportType): boolean { return type === 'stdio' || type === 'http'; }

  protected decode(raw: Config): McpConfigEntry {
    if (raw.type === 'remote') return { type: 'http', url: String(raw.url ?? '') };
    const command = Array.isArray(raw.command) ? raw.command.map(String) : [];
    return {
      command: command[0],
      args: command.slice(1),
      env: object(raw.environment) as Record<string, string>,
    };
  }

  protected encode(entry: McpConfigEntry): Config {
    if (entry.type === 'http') return { type: 'remote', url: entry.url, enabled: true };
    return {
      type: 'local',
      command: [entry.command, ...(entry.args ?? [])],
      ...(entry.env && Object.keys(entry.env).length > 0 ? { environment: entry.env } : {}),
      enabled: true,
    };
  }
}

abstract class TomlMapMcpAdapter implements GlobalMcpConfigAdapter {
  abstract readonly backend: AgentBackendType;
  abstract defaultConfigPath(): string;
  abstract supportsTransport(type: McpTransportType): boolean;

  readEntries(configPath?: string): Record<string, McpConfigEntry> {
    return Object.fromEntries(
      Object.entries(this.readNativeEntries(configPath)).map(([name, raw]) => {
        return [name, raw.url
          ? { type: 'http' as const, url: String(raw.url) }
          : {
              command: typeof raw.command === 'string' ? raw.command : undefined,
              args: Array.isArray(raw.args) ? raw.args.map(String) : [],
              env: object(raw.env) as Record<string, string>,
            }];
      }),
    );
  }

  readNativeEntries(configPath?: string): Record<string, Record<string, unknown>> {
    return Object.fromEntries(Object.entries(object(readToml(configPath ?? this.defaultConfigPath()).mcp_servers)).map(([name, raw]) => [name, object(raw)]));
  }

  mergeNativeEntry(entry: McpConfigEntry, previous: Record<string, unknown> = {}): Record<string, unknown> {
    const merged = { ...previous };
    for (const key of ['command', 'args', 'url']) delete merged[key];
    if (entry.env !== undefined || entry.type === 'http') delete merged.env;
    return entry.type === 'http'
      ? { ...merged, url: entry.url }
      : { ...merged, command: entry.command, ...(entry.args?.length ? { args: entry.args } : {}), ...(entry.env && Object.keys(entry.env).length ? { env: entry.env } : {}) };
  }

  writeNativeEntry(name: string, entry: Record<string, unknown>, expectedFingerprint: string | null, configPath?: string): void {
    const target = configPath ?? this.defaultConfigPath();
    assertFingerprint(this.backend, name, this.readNativeEntries(target)[name], expectedFingerprint);
    mutateTomlServer(target, 'codex', name, entry, this.readNativeEntries(target)[name], expectedFingerprint);
  }

  removeNativeEntry(name: string, expectedFingerprint: string, configPath?: string): void {
    const target = configPath ?? this.defaultConfigPath();
    assertFingerprint(this.backend, name, this.readNativeEntries(target)[name], expectedFingerprint);
    mutateTomlServer(target, 'codex', name, undefined, undefined, expectedFingerprint);
  }

  writeEntry(name: string, entry: McpConfigEntry, configPath?: string): void {
    const target = configPath ?? this.defaultConfigPath();
    const existing = this.readNativeEntries(target)[name];
    this.writeNativeEntry(name, this.mergeNativeEntry(entry, existing), existing ? fingerprintNativeEntry(existing) : null, target);
  }

  removeEntry(name: string, configPath?: string): void {
    const target = configPath ?? this.defaultConfigPath();
    const existing = this.readNativeEntries(target)[name];
    if (existing) this.removeNativeEntry(name, fingerprintNativeEntry(existing), target);
  }
}

export class CodexConfigAdapter extends TomlMapMcpAdapter {
  readonly backend = 'codex' as const;
  defaultConfigPath(): string { return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'); }
  supportsTransport(type: McpTransportType): boolean { return type === 'stdio' || type === 'http'; }
}

export class VibeConfigAdapter implements GlobalMcpConfigAdapter {
  readonly backend = 'vibe' as const;
  defaultConfigPath(): string { return path.join(process.env.VIBE_HOME ?? path.join(os.homedir(), '.vibe'), 'config.toml'); }
  supportsTransport(type: McpTransportType): boolean { return type === 'stdio' || type === 'http'; }

  repairConfigRepresentation(configPath?: string): boolean {
    const target = configPath ?? this.defaultConfigPath();
    if (!fs.existsSync(target)) return false;
    const content = fs.readFileSync(target, 'utf8');
    const updated = normalizeVibeRepresentation(content, target);
    if (updated === content) return false;
    atomicWrite(target, updated, content);
    dbg.mcp('global MCP representation repair backend=vibe path=%s result=ok bytesChanged=%d', target, updated.length - content.length);
    return true;
  }

  readEntries(configPath?: string): Record<string, McpConfigEntry> {
    return Object.fromEntries(Object.entries(this.readNativeEntries(configPath)).map(([name, raw]) => {
      return [name, raw.transport === 'http' || raw.transport === 'streamable-http'
        ? { type: 'http' as const, url: String(raw.url ?? '') }
        : {
            command: typeof raw.command === 'string' ? raw.command : undefined,
            args: Array.isArray(raw.args) ? raw.args.map(String) : [],
            env: object(raw.env) as Record<string, string>,
          }];
    }));
  }

  readNativeEntries(configPath?: string): Record<string, Record<string, unknown>> {
    const target = configPath ?? this.defaultConfigPath();
    if (!fs.existsSync(target)) return {};
    const content = fs.readFileSync(target, 'utf8');
    try {
      const config = parseToml(content) as Config;
      const servers = Array.isArray(config.mcp_servers) ? config.mcp_servers : [];
      const names = new Set<string>();
      return Object.fromEntries(servers.map((rawValue) => {
        const raw = object(rawValue);
        const name = String(raw.name ?? '');
        if (name && names.has(name)) throw new Error(`Duplicate Vibe MCP server name: ${name}`);
        names.add(name);
        const native = { ...raw };
        delete native.name;
        return [name, native];
      }).filter(([name]) => name));
    } catch (error) {
      if (!isTomlRedefinitionError(error)) throw error;
      return Object.fromEntries(readVibeMcpBlocks(content, target).map((block) => [block.name, block.native]));
    }
  }

  mergeNativeEntry(entry: McpConfigEntry, previous: Record<string, unknown> = {}): Record<string, unknown> {
    const merged = { ...previous };
    for (const key of ['transport', 'command', 'args', 'url']) delete merged[key];
    if (entry.env !== undefined || entry.type === 'http') delete merged.env;
    return entry.type === 'http'
      ? { ...merged, transport: 'http', url: entry.url }
      : { ...merged, transport: 'stdio', command: entry.command, ...(entry.args?.length ? { args: entry.args } : {}), ...(entry.env && Object.keys(entry.env).length ? { env: entry.env } : {}) };
  }

  writeNativeEntry(name: string, entry: Record<string, unknown>, expectedFingerprint: string | null, configPath?: string): void {
    const target = configPath ?? this.defaultConfigPath();
    assertFingerprint(this.backend, name, this.readNativeEntries(target)[name], expectedFingerprint);
    mutateTomlServer(target, 'vibe', name, entry, this.readNativeEntries(target)[name], expectedFingerprint);
  }

  removeNativeEntry(name: string, expectedFingerprint: string, configPath?: string): void {
    const target = configPath ?? this.defaultConfigPath();
    assertFingerprint(this.backend, name, this.readNativeEntries(target)[name], expectedFingerprint);
    mutateTomlServer(target, 'vibe', name, undefined, undefined, expectedFingerprint);
  }

  writeEntry(name: string, entry: McpConfigEntry, configPath?: string): void {
    const target = configPath ?? this.defaultConfigPath();
    const existing = this.readNativeEntries(target)[name];
    this.writeNativeEntry(name, this.mergeNativeEntry(entry, existing), existing ? fingerprintNativeEntry(existing) : null, target);
  }

  removeEntry(name: string, configPath?: string): void {
    const target = configPath ?? this.defaultConfigPath();
    const existing = this.readNativeEntries(target)[name];
    if (existing) this.removeNativeEntry(name, fingerprintNativeEntry(existing), target);
  }
}

export class CopilotConfigAdapter extends JsonMcpAdapter {
  readonly backend = 'copilot' as const;
  defaultConfigPath(): string { return path.join(os.homedir(), '.copilot', 'mcp-config.json'); }
  supportsTransport(type: McpTransportType): boolean { return type === 'stdio' || type === 'http'; }
}

const adapters: Record<AgentBackendType, GlobalMcpConfigAdapter> = {
  'claude-code': new ClaudeCodeConfigAdapter(),
  opencode: new OpenCodeConfigAdapter(),
  codex: new CodexConfigAdapter(),
  copilot: new CopilotConfigAdapter(),
  vibe: new VibeConfigAdapter(),
};

export function getConfigAdapter(backend: AgentBackendType): GlobalMcpConfigAdapter { return adapters[backend]; }
export function getAllConfigAdapters(): GlobalMcpConfigAdapter[] { return Object.values(adapters); }

export function toConfigEntry(server: {
  transportType: McpTransportType;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
}): McpConfigEntry {
  return server.transportType === 'stdio'
    ? { command: server.command ?? undefined, args: server.args, env: server.env }
    : { type: server.transportType, url: server.url ?? undefined };
}

export function entriesEqual(a: McpConfigEntry | undefined, b: McpConfigEntry): boolean {
  if (!a) return false;
  const normalize = (entry: McpConfigEntry) => ({
    type: entry.type ?? 'stdio',
    command: entry.command ?? null,
    args: entry.args ?? [],
    env: entry.env ?? {},
    url: entry.url ?? null,
  });
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

export function discoverMcpEntries(
  knownEntries: Array<{ name: string; entry: McpConfigEntry }> | Set<string>,
  selectedAdapters = getAllConfigAdapters(),
): DiscoveredMcpOccurrence[] {
  const known = knownEntries instanceof Set ? [] : knownEntries;
  const discovered: DiscoveredMcpOccurrence[] = [];
  for (const adapter of selectedAdapters) {
    const nativeEntries = adapter.readNativeEntries();
    for (const [name, entry] of Object.entries(adapter.readEntries())) {
      if (knownEntries instanceof Set && knownEntries.has(name)) continue;
      if (known.some((item) => item.name === name && entriesEqual(entry, item.entry))) continue;
      discovered.push({
        name,
        transportType: entry.type ?? 'stdio',
        command: entry.command ?? null,
        args: entry.args ?? [],
        env: entry.env ?? {},
        url: entry.url ?? null,
        backend: adapter.backend,
        fingerprint: fingerprintNativeEntry(
          nativeEntries[name] ?? (entry as Record<string, unknown>),
        ),
      });
    }
  }
  return discovered;
}

export function normalizeMcpName(name: string): string {
  return normalizeGlobalMcpName(name);
}

export function normalizedCommonConfigKey(
  entry: Pick<DiscoveredMcpOccurrence, 'transportType' | 'command' | 'args' | 'url'>,
): string {
  return stable(
    entry.transportType === 'stdio'
      ? {
          transportType: 'stdio',
          command: entry.command ?? null,
          args: entry.args ?? [],
        }
      : {
          transportType: entry.transportType,
          url: entry.url ?? null,
        },
  );
}

export function groupDiscoveredMcpEntries(
  entries: DiscoveredMcpOccurrence[],
): DiscoveredMcpGroup[] {
  const groups = new Map<string, { name: string; variants: Map<string, DiscoveredMcpVariant> }>();
  for (const entry of entries) {
    const normalizedName = normalizeMcpName(entry.name);
    const group = groups.get(normalizedName) ?? {
      name: entry.name,
      variants: new Map<string, DiscoveredMcpVariant>(),
    };
    const commonKey = normalizedCommonConfigKey(entry);
    let variantKey = commonKey;
    const matchingVariant = group.variants.get(commonKey);
    if (matchingVariant?.sources.some((source) => source.backend === entry.backend)) {
      variantKey = `${commonKey}|ambiguous:${entry.backend}:${entry.name}:${entry.fingerprint}`;
    }
    const variant = group.variants.get(variantKey) ?? {
      name: entry.name,
      canonicalName: sanitizeGlobalMcpName(entry.name),
      common: {
        transportType: entry.transportType,
        command: entry.transportType === 'stdio' ? entry.command : null,
        args: entry.transportType === 'stdio' ? entry.args : [],
        url: entry.transportType === 'stdio' ? null : entry.url,
      },
      sources: [],
    };
    if (!variant.sources.some((source) => source.backend === entry.backend)) {
      variant.sources.push({ backend: entry.backend, entryName: entry.name, fingerprint: entry.fingerprint });
      variant.sources.sort((a, b) => a.backend.localeCompare(b.backend));
    }
    group.variants.set(variantKey, variant);
    groups.set(normalizedName, group);
  }
  return [...groups.entries()]
    .map(([normalizedName, group]) => ({
      name: group.name,
      normalizedName,
      conflict: group.variants.size > 1,
      variants: [...group.variants.values()],
    }))
    .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
}
