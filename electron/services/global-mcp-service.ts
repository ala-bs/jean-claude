import type { AgentBackendType } from '@shared/agent-backend-types';
import type {
  DiscoveredMcpVariant,
  GlobalMcpBackendStates,
  GlobalMcpDiscoveryResult,
  GlobalMcpServer,
  GlobalMcpServerRecord,
  NewGlobalMcpServer,
  UpdateGlobalMcpServer,
} from '@shared/global-mcp-types';
import { normalizeGlobalMcpName } from '@shared/global-mcp-types';

import { GlobalMcpServerRepository } from '../database/repositories/global-mcp-servers';
import { dbg } from '../lib/debug';
import {
  discoverMcpEntries,
  fingerprintNativeEntry,
  getAllConfigAdapters,
  type GlobalMcpConfigAdapter,
  groupDiscoveredMcpEntries,
  normalizedCommonConfigKey,
  normalizeMcpName,
  toConfigEntry,
} from './global-mcp-config-adapters';

export interface GlobalMcpServiceDeps { adapters?: GlobalMcpConfigAdapter[] }

const BACKENDS = new Set<AgentBackendType>(['claude-code', 'opencode', 'codex', 'copilot', 'vibe']);

function normalizeBackends(value: unknown): AgentBackendType[] {
  if (!Array.isArray(value) || value.length > BACKENDS.size || value.some((backend) => typeof backend !== 'string' || !BACKENDS.has(backend as AgentBackendType))) {
    throw new Error('Invalid enabled backends');
  }
  return [...new Set(value as AgentBackendType[])];
}

function allAdapters(deps?: GlobalMcpServiceDeps): GlobalMcpConfigAdapter[] {
  return deps?.adapters ?? getAllConfigAdapters();
}

function adaptersFor(backends: AgentBackendType[], deps?: GlobalMcpServiceDeps): GlobalMcpConfigAdapter[] {
  return [...new Set(backends)].map((backend) => {
    if (!BACKENDS.has(backend)) throw new Error(`Unknown backend: ${backend}`);
    const adapter = allAdapters(deps).find((item) => item.backend === backend);
    if (!adapter) throw new Error(`Backend adapter unavailable: ${backend}`);
    return adapter;
  });
}

function validate(data: NewGlobalMcpServer): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('MCP input must be an object');
  const allowedKeys = new Set(['name', 'transportType', 'command', 'args', 'env', 'url', 'enabledBackends']);
  for (const key of Object.keys(data)) if (!allowedKeys.has(key)) throw new Error(`Unexpected MCP field: ${key}`);
  if (typeof data.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.name)) throw new Error('MCP name may contain only letters, numbers, hyphens, and underscores');
  if (data.name.length > 128) throw new Error('MCP name is too long');
  if (typeof data.transportType !== 'string' || !['stdio', 'http', 'sse'].includes(data.transportType)) throw new Error('Invalid MCP transport');
  if (data.command !== undefined && data.command !== null && typeof data.command !== 'string') throw new Error('Invalid MCP command');
  if (data.transportType === 'stdio' && !data.command?.trim()) throw new Error('stdio MCP server requires command');
  if (data.command && (typeof data.command !== 'string' || data.command.length > 4096)) throw new Error('Invalid MCP command');
  if (data.args && (!Array.isArray(data.args) || data.args.length > 256 || data.args.some((arg) => typeof arg !== 'string' || arg.length > 8192))) throw new Error('MCP args must be strings within limits');
  if (data.env && (!isPlainObject(data.env) || Object.entries(data.env).length > 256 || Object.entries(data.env).some(([key, value]) => typeof value !== 'string' || key.length > 256 || value.length > 65_536))) throw new Error('MCP environment must contain string values within limits');
  if (!Array.isArray(data.enabledBackends) || data.enabledBackends.length > BACKENDS.size || data.enabledBackends.some((backend) => typeof backend !== 'string')) throw new Error('Invalid enabled backends');
  if (data.transportType !== 'stdio') {
    if (!data.url) throw new Error('Remote MCP server requires URL');
    if (typeof data.url !== 'string' || data.url.length > 8192) throw new Error('Invalid MCP URL');
    const url = new URL(data.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP URL must use HTTP or HTTPS');
  }
  normalizeBackends(data.enabledBackends);
}

function isPlainObject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length < 1 || id.length > 256) throw new Error('Invalid global MCP server id');
}

function commonEntry(data: NewGlobalMcpServer | GlobalMcpServerRecord) {
  return toConfigEntry({
    transportType: data.transportType,
    command: data.command ?? null,
    args: data.args ?? [],
    env: data.env ?? {},
    url: data.url ?? null,
  });
}

function throwWithCompensation(original: unknown, compensations: Array<() => void>): never {
  const errors: unknown[] = [];
  for (const compensate of [...compensations].reverse()) {
    try { compensate(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError([original, ...errors], 'MCP mutation failed and rollback was incomplete');
  throw original;
}

function installOwned(
  name: string,
  entry: ReturnType<typeof commonEntry>,
  adapters: GlobalMcpConfigAdapter[],
): { states: GlobalMcpBackendStates; undo: Array<() => void> } {
  const states: GlobalMcpBackendStates = {};
  const undo: Array<() => void> = [];
  try {
    for (const adapter of adapters) {
      if (adapter.readNativeEntries()[name]) {
        throw new Error(`MCP server ${name} already exists on ${adapter.backend}; import it to adopt ownership`);
      }
      const rawEntry = adapter.mergeNativeEntry(entry);
      adapter.writeNativeEntry(name, rawEntry, null);
      const fingerprint = fingerprintNativeEntry(rawEntry);
      states[adapter.backend] = { owned: true, entryName: name, rawEntry, fingerprint };
      undo.push(() => adapter.removeNativeEntry(name, fingerprint));
    }
  } catch (error) {
    throwWithCompensation(error, undo);
  }
  return { states, undo };
}

async function createGlobalMcpServerUnlocked(data: NewGlobalMcpServer, deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServerRecord> {
  validate(data);
  data = { ...data, enabledBackends: normalizeBackends(data.enabledBackends) };
  if (await GlobalMcpServerRepository.findByName(data.name)) throw new Error(`MCP server already exists: ${data.name}`);
  for (const adapter of allAdapters(deps)) {
    if (adapter.readNativeEntries()[data.name]) throw new Error(`MCP server ${data.name} already exists on ${adapter.backend}; import it to adopt ownership`);
  }
  const targets = adaptersFor(data.enabledBackends, deps);
  for (const adapter of targets) if (!adapter.supportsTransport(data.transportType)) throw new Error(`${adapter.backend} does not support ${data.transportType} MCP transport`);
  const { states, undo } = installOwned(data.name, commonEntry(data), targets);
  try { return await GlobalMcpServerRepository.create({ ...data, backendStates: states, envManaged: data.env !== undefined }); }
  catch (error) { throwWithCompensation(error, undo); }
}

async function enableGlobalMcpServerUnlocked(id: string, backends: AgentBackendType[], deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServerRecord> {
  backends = normalizeBackends(backends);
  const server = await required(id);
  const additions = backends.filter((backend) => !server.backendStates[backend]?.owned);
  const targets = adaptersFor(additions, deps);
  const backendStates = { ...server.backendStates };
  const undo: Array<() => void> = [];
  for (const adapter of targets) {
    if (!adapter.supportsTransport(server.transportType)) throw new Error(`${adapter.backend} does not support ${server.transportType} MCP transport`);
  }
  try {
    for (const adapter of targets) {
      const prior = backendStates[adapter.backend];
      const entryName = prior?.entryName ?? server.name;
      adapter.repairConfigRepresentation?.();
      const nativeEntries = adapter.readNativeEntries();
      const existing = nativeEntries[entryName];
      if (existing) {
        const decoded = adapter.readEntries()[entryName];
        const existingCommon = decoded && normalizedCommonConfigKey({
          transportType: decoded.type ?? 'stdio',
          command: decoded.command ?? null,
          args: decoded.args ?? [],
          url: decoded.url ?? null,
        });
        const canonicalCommon = normalizedCommonConfigKey({
          transportType: server.transportType,
          command: server.command,
          args: server.args,
          url: server.url,
        });
        if (existingCommon !== canonicalCommon) {
          throw new Error(`MCP server ${entryName} already exists on ${adapter.backend} with different configuration`);
        }
        backendStates[adapter.backend] = {
          owned: true,
          entryName,
          rawEntry: existing,
          fingerprint: fingerprintNativeEntry(existing),
        };
        continue;
      }
      const canonicalEntry = commonEntry(server);
      if (!server.envManaged) delete canonicalEntry.env;
      const rawEntry = adapter.mergeNativeEntry(canonicalEntry, prior?.rawEntry);
      adapter.writeNativeEntry(entryName, rawEntry, null);
      const fingerprint = fingerprintNativeEntry(rawEntry);
      backendStates[adapter.backend] = {
        owned: true,
        entryName,
        rawEntry,
        fingerprint,
      };
      undo.push(() => adapter.removeNativeEntry(entryName, fingerprint));
    }
  } catch (error) {
    throwWithCompensation(error, undo);
  }
  const enabledBackends = Object.entries(backendStates).filter(([, state]) => state?.owned).map(([backend]) => backend as AgentBackendType);
  try { return await GlobalMcpServerRepository.update(id, { backendStates, enabledBackends }); }
  catch (error) { throwWithCompensation(error, undo); }
}

async function disableGlobalMcpServerUnlocked(id: string, backends: AgentBackendType[], deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServerRecord> {
  backends = normalizeBackends(backends);
  const server = await required(id);
  const backendStates = { ...server.backendStates };
  const undo: Array<() => void> = [];
  try {
    for (const adapter of adaptersFor(backends, deps)) {
      const state = backendStates[adapter.backend];
      if (!state?.owned) continue;
      adapter.removeNativeEntry(state.entryName, state.fingerprint);
      undo.push(() => adapter.writeNativeEntry(state.entryName, state.rawEntry, null));
      backendStates[adapter.backend] = { ...state, owned: false };
    }
  } catch (error) { throwWithCompensation(error, undo); }
  const enabledBackends = Object.entries(backendStates).filter(([, state]) => state?.owned).map(([backend]) => backend as AgentBackendType);
  try { return await GlobalMcpServerRepository.update(id, { backendStates, enabledBackends }); }
  catch (error) { throwWithCompensation(error, undo); }
}

async function uninstallGlobalMcpServerUnlocked(id: string, deps?: GlobalMcpServiceDeps): Promise<void> {
  const server = await required(id);
  const undo: Array<() => void> = [];
  try {
    for (const adapter of allAdapters(deps)) {
      const state = server.backendStates[adapter.backend];
      if (!state?.owned) continue;
      adapter.removeNativeEntry(state.entryName, state.fingerprint);
      undo.push(() => adapter.writeNativeEntry(state.entryName, state.rawEntry, null));
    }
  } catch (error) { throwWithCompensation(error, undo); }
  try { await GlobalMcpServerRepository.delete(id); }
  catch (error) { throwWithCompensation(error, undo); }
}

async function updateGlobalMcpServerUnlocked(id: string, update: UpdateGlobalMcpServer, deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServerRecord> {
  if (!isPlainObject(update)) throw new Error('MCP update must be an object');
  const allowedUpdateKeys = new Set(['name', 'transportType', 'command', 'args', 'env', 'url', 'enabledBackends']);
  for (const key of Object.keys(update)) if (!allowedUpdateKeys.has(key)) throw new Error(`Unexpected MCP update field: ${key}`);
  const old = await required(id);
  const next: NewGlobalMcpServer = {
    name: update.name ?? old.name,
    transportType: update.transportType ?? old.transportType,
    command: update.command === undefined ? old.command : update.command,
    args: update.args ?? old.args,
    env: update.env ?? old.env,
    url: update.url === undefined ? old.url : update.url,
    enabledBackends: update.enabledBackends ?? old.enabledBackends,
  };
  validate(next);
  const duplicate = await GlobalMcpServerRepository.findByName(next.name);
  if (duplicate && duplicate.id !== id) throw new Error(`MCP server already exists: ${next.name}`);
  const backendStates = { ...old.backendStates };
  const undo: Array<() => void> = [];
  try {
    for (const adapter of allAdapters(deps)) {
      const state = backendStates[adapter.backend];
      if (!state?.owned) continue;
      if (!adapter.supportsTransport(next.transportType)) throw new Error(`${adapter.backend} does not support ${next.transportType} MCP transport`);
      const commonUpdate = commonEntry(next);
      if (update.env === undefined) delete commonUpdate.env;
      const rawEntry = adapter.mergeNativeEntry(commonUpdate, state.rawEntry);
      if (next.name === old.name) {
        adapter.writeNativeEntry(state.entryName, rawEntry, state.fingerprint);
        const fingerprint = fingerprintNativeEntry(rawEntry);
        undo.push(() => adapter.writeNativeEntry(state.entryName, state.rawEntry, fingerprint));
        backendStates[adapter.backend] = { owned: true, entryName: state.entryName, rawEntry, fingerprint };
      } else {
        if (adapter.readNativeEntries()[next.name]) throw new Error(`MCP server ${next.name} already exists on ${adapter.backend}`);
        adapter.removeNativeEntry(state.entryName, state.fingerprint);
        let destinationFingerprint: string | undefined;
        undo.push(() => {
          if (destinationFingerprint) {
            adapter.removeNativeEntry(next.name, destinationFingerprint);
          }
          adapter.writeNativeEntry(state.entryName, state.rawEntry, null);
        });
        adapter.writeNativeEntry(next.name, rawEntry, null);
        const fingerprint = fingerprintNativeEntry(rawEntry);
        destinationFingerprint = fingerprint;
        backendStates[adapter.backend] = { owned: true, entryName: next.name, rawEntry, fingerprint };
      }
    }
    const desired = new Set(next.enabledBackends);
    for (const adapter of allAdapters(deps)) {
      const state = backendStates[adapter.backend];
      if (state?.owned && !desired.has(adapter.backend)) {
        adapter.removeNativeEntry(state.entryName, state.fingerprint);
        undo.push(() => adapter.writeNativeEntry(state.entryName, state.rawEntry, null));
        backendStates[adapter.backend] = { ...state, owned: false };
      }
    }
    const additions = next.enabledBackends.filter((backend) => !backendStates[backend]?.owned);
    for (const adapter of adaptersFor(additions, deps)) {
      if (!adapter.supportsTransport(next.transportType)) throw new Error(`${adapter.backend} does not support ${next.transportType} MCP transport`);
      if (adapter.readNativeEntries()[next.name]) throw new Error(`MCP server ${next.name} already exists on ${adapter.backend}; import it to adopt ownership`);
      const rawEntry = adapter.mergeNativeEntry(commonEntry(next));
      adapter.writeNativeEntry(next.name, rawEntry, null);
      const fingerprint = fingerprintNativeEntry(rawEntry);
      backendStates[adapter.backend] = { owned: true, entryName: next.name, rawEntry, fingerprint };
      undo.push(() => adapter.removeNativeEntry(next.name, fingerprint));
    }
  } catch (error) { throwWithCompensation(error, undo); }
  const enabledBackends = Object.entries(backendStates).filter(([, state]) => state?.owned).map(([backend]) => backend as AgentBackendType);
  try { return await GlobalMcpServerRepository.update(id, { ...update, backendStates, enabledBackends, envManaged: update.env !== undefined ? true : old.envManaged }); }
  catch (error) { throwWithCompensation(error, undo); }
}

export async function discoverUnmanagedMcpEntries(deps?: GlobalMcpServiceDeps): Promise<GlobalMcpDiscoveryResult> {
  const servers = await GlobalMcpServerRepository.findAll();
  const occurrences: ReturnType<typeof discoverMcpEntries> = [];
  const result: GlobalMcpDiscoveryResult = { groups: [], errors: [] };
  for (const adapter of allAdapters(deps)) {
    try {
      occurrences.push(...discoverMcpEntries([], [adapter]).filter((entry) =>
        !servers.some((server) =>
          server.backendStates[entry.backend]?.owned &&
          server.backendStates[entry.backend]?.entryName === entry.name &&
          normalizedCommonConfigKey({
            transportType: server.transportType,
            command: server.command,
            args: server.args,
            url: server.url,
          }) === normalizedCommonConfigKey(entry),
        ),
      ));
    } catch (error) {
      result.errors.push({ backend: adapter.backend, message: error instanceof Error ? error.message : String(error) });
    }
  }
  result.groups = groupDiscoveredMcpEntries(occurrences);
  return result;
}

async function importMcpEntryUnlocked(variant: DiscoveredMcpVariant, enabledBackends: AgentBackendType[], deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServerRecord> {
  validateDiscoveredVariant(variant);
  enabledBackends = normalizeBackends(enabledBackends);
  const sourceByBackend = new Map(variant.sources.map((source) => [source.backend, source]));
  const selectedAdapters = adaptersFor(enabledBackends, deps);
  if (!selectedAdapters.some((adapter) => sourceByBackend.has(adapter.backend))) {
    throw new Error('Import must select at least one discovered source backend');
  }
  const states: GlobalMcpBackendStates = {};
  for (const adapter of selectedAdapters) {
    const source = sourceByBackend.get(adapter.backend);
    if (!source) continue;
    const nativeEntries = adapter.readNativeEntries();
    const sourceName = source.entryName;
    const current = nativeEntries[sourceName];
    const decoded = adapter.readEntries()[sourceName];
    if (!current || !decoded || fingerprintNativeEntry(current) !== source.fingerprint || normalizedCommonConfigKey({
      transportType: decoded.type ?? 'stdio',
      command: decoded.command ?? null,
      args: decoded.args ?? [],
      url: decoded.url ?? null,
    }) !== normalizedCommonConfigKey(variant.common) || normalizeMcpName(sourceName) !== normalizeMcpName(variant.name)) {
      throw new Error(`Discovered MCP entry drift on ${adapter.backend}: ${variant.name}`);
    }
    states[adapter.backend] = { owned: true, entryName: sourceName!, rawEntry: current, fingerprint: source.fingerprint };
  }
  const data: NewGlobalMcpServer = {
    name: variant.canonicalName,
    transportType: variant.common.transportType,
    command: variant.common.command,
    args: variant.common.args,
    env: {},
    url: variant.common.url,
    enabledBackends,
  };
  validate(data);
  if (await GlobalMcpServerRepository.findByName(variant.canonicalName)) throw new Error(`MCP server already exists: ${variant.canonicalName}`);
  const targets = selectedAdapters.filter((adapter) => !sourceByBackend.has(adapter.backend));
  for (const adapter of targets) if (adapter.readNativeEntries()[variant.canonicalName]) throw new Error(`MCP server ${variant.canonicalName} already exists on ${adapter.backend}; import separately to adopt ownership`);
  const { states: installed, undo } = installOwned(variant.canonicalName, commonEntry(data), targets);
  Object.assign(states, installed);
  try { return await GlobalMcpServerRepository.importEntry({ ...data, backendStates: states, envManaged: false }); }
  catch (error) { throwWithCompensation(error, undo); }
}

function validateDiscoveredVariant(variant: DiscoveredMcpVariant): void {
  if (!isPlainObject(variant) || typeof variant.name !== 'string' || !isPlainObject(variant.common) || !Array.isArray(variant.sources) || variant.sources.length === 0) throw new Error('Invalid discovered MCP variant');
  const allowed = new Set(['name', 'canonicalName', 'common', 'sources']);
  for (const key of Object.keys(variant)) if (!allowed.has(key)) throw new Error(`Unexpected discovered variant field: ${key}`);
  const allowedCommon = new Set(['transportType', 'command', 'args', 'url']);
  for (const key of Object.keys(variant.common)) if (!allowedCommon.has(key)) throw new Error(`Unexpected discovered common field: ${key}`);
  const seen = new Set<string>();
  for (const source of variant.sources) {
    if (!isPlainObject(source) || !BACKENDS.has(source.backend) || typeof source.entryName !== 'string' || !source.entryName || !/^[a-f0-9]{64}$/.test(source.fingerprint) || seen.has(source.backend)) throw new Error('Invalid discovered MCP source');
    if (Object.keys(source).some((key) => !['backend', 'entryName', 'fingerprint'].includes(key))) throw new Error('Unexpected discovered MCP source field');
    seen.add(source.backend);
  }
  validate({
    name: variant.canonicalName,
    transportType: variant.common.transportType,
    command: variant.common.command,
    args: variant.common.args,
    env: {},
    url: variant.common.url,
    enabledBackends: [],
  });
}

function publicServer(server: GlobalMcpServerRecord): GlobalMcpServer {
  const publicFields: Partial<GlobalMcpServerRecord> = { ...server };
  delete publicFields.backendStates;
  delete publicFields.normalizedName;
  delete publicFields.envManaged;
  publicFields.hasStoredEnv =
    Object.keys(server.env).length > 0 ||
    Object.values(server.backendStates).some((state) => {
      if (!state?.owned) return false;
      const env = state.rawEntry.env ?? state.rawEntry.environment;
      return !!env && typeof env === 'object' && !Array.isArray(env) && Object.keys(env).length > 0;
    });
  publicFields.env = {};
  return publicFields as GlobalMcpServer;
}

export async function getAllGlobalMcpServers(): Promise<GlobalMcpServer[]> {
  return (await GlobalMcpServerRepository.findAll()).map(publicServer);
}
export async function getGlobalMcpServer(id: string): Promise<GlobalMcpServer | undefined> {
  const server = await GlobalMcpServerRepository.findById(id);
  return server ? publicServer(server) : undefined;
}

async function required(id: string): Promise<GlobalMcpServerRecord> {
  const server = await GlobalMcpServerRepository.findById(id);
  if (!server) throw new Error(`Global MCP server not found: ${id}`);
  dbg.mcp('global MCP lifecycle server=%s ownedBackends=%d', server.name, Object.values(server.backendStates).filter((state) => state?.owned).length);
  return server;
}

const lifecycleLocks = new Map<string, Promise<void>>();

async function withLifecycleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = lifecycleLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  lifecycleLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleLocks.get(key) === queued) lifecycleLocks.delete(key);
  }
}

function configLockKeys(deps?: GlobalMcpServiceDeps): string[] {
  return allAdapters(deps).map((adapter) =>
    `path:${canonicalConfigLockPath(adapter.defaultConfigPath())}`,
  );
}

export function canonicalConfigLockPath(configPath: string): string {
  const absolute = path.resolve(configPath);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    const canonicalParent = fs.realpathSync(existing);
    return path.join(canonicalParent, path.relative(existing, absolute));
  } catch {
    return absolute;
  }
}

function withLifecycleLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  const acquire = (index: number): Promise<T> =>
    index === ordered.length
      ? operation()
      : withLifecycleLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}

export function createGlobalMcpServer(data: NewGlobalMcpServer, deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServer> {
  const lockName = typeof data?.name === 'string' ? normalizeGlobalMcpName(data.name) : 'invalid';
  return withLifecycleLocks([`name:${lockName}`, ...configLockKeys(deps)], () => createGlobalMcpServerUnlocked(data, deps)).then(publicServer);
}

export function enableGlobalMcpServer(id: string, backends: AgentBackendType[], deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServer> {
  assertId(id);
  return withLifecycleLocks([`id:${id}`, ...configLockKeys(deps)], () => enableGlobalMcpServerUnlocked(id, backends, deps)).then(publicServer);
}

export function disableGlobalMcpServer(id: string, backends: AgentBackendType[], deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServer> {
  assertId(id);
  return withLifecycleLocks([`id:${id}`, ...configLockKeys(deps)], () => disableGlobalMcpServerUnlocked(id, backends, deps)).then(publicServer);
}

export function uninstallGlobalMcpServer(id: string, deps?: GlobalMcpServiceDeps): Promise<void> {
  assertId(id);
  return withLifecycleLocks([`id:${id}`, ...configLockKeys(deps)], () => uninstallGlobalMcpServerUnlocked(id, deps));
}

export function updateGlobalMcpServer(id: string, update: UpdateGlobalMcpServer, deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServer> {
  assertId(id);
  const nameLock = update && typeof update.name === 'string'
    ? [`name:${normalizeGlobalMcpName(update.name)}`]
    : [];
  return withLifecycleLocks([`id:${id}`, ...nameLock, ...configLockKeys(deps)], () => updateGlobalMcpServerUnlocked(id, update, deps)).then(publicServer);
}

export function importMcpEntry(variant: DiscoveredMcpVariant, enabledBackends: AgentBackendType[], deps?: GlobalMcpServiceDeps): Promise<GlobalMcpServer> {
  const lockName = variant && typeof variant.canonicalName === 'string'
    ? normalizeGlobalMcpName(variant.canonicalName)
    : 'invalid';
  return withLifecycleLocks([`name:${lockName}`, ...configLockKeys(deps)], () => importMcpEntryUnlocked(variant, enabledBackends, deps)).then(publicServer);
}
import * as fs from 'fs';
import * as path from 'path';
