// electron/database/repositories/global-mcp-servers.ts
import type {
  GlobalMcpServerRecord,
  NewGlobalMcpServer,
  UpdateGlobalMcpServer,
} from '@shared/global-mcp-types';
import { normalizeGlobalMcpName } from '@shared/global-mcp-types';
import type { AgentBackendType } from '@shared/agent-backend-types';

import { db } from '../index';

export function parseGlobalMcpServerRow(row: {
  id: string;
  name: string;
  normalizedName: string;
  transportType: string;
  command: string | null;
  args: string;
  env: string;
  envManaged: number;
  url: string | null;
  enabledBackends: string;
  backendStates: string;
  createdAt: string;
  updatedAt: string;
}): GlobalMcpServerRecord {
  try {
    if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.name)) throw new Error('invalid id or name');
    if (row.normalizedName !== normalizeGlobalMcpName(row.name)) throw new Error('invalid normalizedName');
    if (!['stdio', 'http', 'sse'].includes(row.transportType)) throw new Error('invalid transportType');
    if (row.command !== null && typeof row.command !== 'string') throw new Error('invalid command');
    if (row.url !== null && typeof row.url !== 'string') throw new Error('invalid url');
    const args = JSON.parse(row.args) as unknown;
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new Error('invalid args');
    const env = JSON.parse(row.env) as unknown;
    if (!isStringRecord(env)) throw new Error('invalid env');
    if (row.envManaged !== 0 && row.envManaged !== 1) throw new Error('invalid envManaged');
    const enabledBackends = JSON.parse(row.enabledBackends) as unknown;
    if (!Array.isArray(enabledBackends) || new Set(enabledBackends).size !== enabledBackends.length || enabledBackends.some((backend) => !isBackend(backend))) throw new Error('invalid enabledBackends');
    if (!isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)) throw new Error('invalid timestamps');
    const backendStates = parseBackendStates(row);
    const ownedBackends = Object.entries(backendStates).filter(([, state]) => state?.owned).map(([backend]) => backend).sort();
    if (JSON.stringify([...enabledBackends].sort()) !== JSON.stringify(ownedBackends)) throw new Error('enabledBackends ownership mismatch');
    return {
      id: row.id,
      name: row.name,
      normalizedName: row.normalizedName,
      transportType: row.transportType as GlobalMcpServerRecord['transportType'],
      command: row.command,
      args,
      env,
      envManaged: row.envManaged === 1,
      url: row.url,
      enabledBackends: enabledBackends as AgentBackendType[],
      backendStates,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid global MCP')) throw error;
    throw new Error(`Invalid global MCP row id=${row.id} name=${row.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isBackend(value: unknown): value is AgentBackendType {
  return typeof value === 'string' && ['claude-code', 'opencode', 'codex', 'copilot', 'vibe'].includes(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function parseBackendStates(row: { id: string; name: string; backendStates: string }): GlobalMcpServerRecord['backendStates'] {
  try {
    const parsed = JSON.parse(row.backendStates) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be object');
    const allowed = new Set(['claude-code', 'opencode', 'codex', 'copilot', 'vibe']);
    for (const [backend, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!allowed.has(backend) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid backend ${backend}`);
      const state = value as Record<string, unknown>;
      if (typeof state.owned !== 'boolean' || typeof state.entryName !== 'string' || !state.entryName || !state.rawEntry || typeof state.rawEntry !== 'object' || Array.isArray(state.rawEntry) || typeof state.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(state.fingerprint)) {
        throw new Error(`invalid state for ${backend}`);
      }
    }
    return parsed as GlobalMcpServerRecord['backendStates'];
  } catch (error) {
    throw new Error(`Invalid global MCP backend state row id=${row.id} name=${row.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const GlobalMcpServerRepository = {
  findAll: async (): Promise<GlobalMcpServerRecord[]> => {
    const rows = await db
      .selectFrom('global_mcp_servers')
      .selectAll()
      .orderBy('createdAt', 'asc')
      .execute();
    return rows.map(parseGlobalMcpServerRow);
  },

  findById: async (id: string): Promise<GlobalMcpServerRecord | undefined> => {
    const row = await db
      .selectFrom('global_mcp_servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? parseGlobalMcpServerRow(row) : undefined;
  },

  findByName: async (name: string): Promise<GlobalMcpServerRecord | undefined> => {
    const row = await db
      .selectFrom('global_mcp_servers')
      .selectAll()
      .where('normalizedName', '=', normalizeGlobalMcpName(name))
      .executeTakeFirst();
    return row ? parseGlobalMcpServerRow(row) : undefined;
  },

  create: async (data: NewGlobalMcpServer & { backendStates: GlobalMcpServerRecord['backendStates']; envManaged: boolean }): Promise<GlobalMcpServerRecord> => {
    const now = new Date().toISOString();
    const row = await db
      .insertInto('global_mcp_servers')
      .values({
        name: data.name,
        normalizedName: normalizeGlobalMcpName(data.name),
        transportType: data.transportType,
        command: data.command ?? null,
        args: JSON.stringify(data.args ?? []),
        env: JSON.stringify(data.env ?? {}),
        envManaged: data.envManaged ? 1 : 0,
        url: data.url ?? null,
        enabledBackends: JSON.stringify(data.enabledBackends),
        backendStates: JSON.stringify(data.backendStates ?? {}),
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return parseGlobalMcpServerRow(row);
  },

  update: async (
    id: string,
    data: UpdateGlobalMcpServer & { backendStates?: GlobalMcpServerRecord['backendStates']; envManaged?: boolean },
  ): Promise<GlobalMcpServerRecord> => {
    const updateData: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.name !== undefined)
      updateData.normalizedName = normalizeGlobalMcpName(data.name);
    if (data.transportType !== undefined)
      updateData.transportType = data.transportType;
    if (data.command !== undefined) updateData.command = data.command;
    if (data.args !== undefined) updateData.args = JSON.stringify(data.args);
    if (data.env !== undefined) updateData.env = JSON.stringify(data.env);
    if (data.envManaged !== undefined) updateData.envManaged = data.envManaged ? 1 : 0;
    if (data.url !== undefined) updateData.url = data.url;
    if (data.enabledBackends !== undefined)
      updateData.enabledBackends = JSON.stringify(data.enabledBackends);
    if (data.backendStates !== undefined)
      updateData.backendStates = JSON.stringify(data.backendStates);

    const row = await db
      .updateTable('global_mcp_servers')
      .set(updateData)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return parseGlobalMcpServerRow(row);
  },

  delete: async (id: string): Promise<void> => {
    await db.deleteFrom('global_mcp_servers').where('id', '=', id).execute();
  },

  /** Import adopts the entry into Jean-Claude management. */
  importEntry: async (data: NewGlobalMcpServer & { backendStates: GlobalMcpServerRecord['backendStates']; envManaged: boolean }): Promise<GlobalMcpServerRecord> => {
    const now = new Date().toISOString();
    const row = await db
      .insertInto('global_mcp_servers')
      .values({
        name: data.name,
        normalizedName: normalizeGlobalMcpName(data.name),
        transportType: data.transportType,
        command: data.command ?? null,
        args: JSON.stringify(data.args ?? []),
        env: JSON.stringify(data.env ?? {}),
        envManaged: data.envManaged ? 1 : 0,
        url: data.url ?? null,
        enabledBackends: JSON.stringify(data.enabledBackends),
        backendStates: JSON.stringify(data.backendStates ?? {}),
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return parseGlobalMcpServerRow(row);
  },
};
