import { describe, expect, it } from 'vitest';

import { down, up } from './072_global_mcp_servers';

describe('072_global_mcp_servers', () => {
  it('creates explicit backend state storage', async () => {
    const columns: string[] = [];
    const uniqueColumns: string[] = [];
    const defaults = new Map<string, unknown>();
    let activeColumn = '';
    const columnBuilder = {
      notNull() { return this; },
      primaryKey() { return this; },
      defaultTo(value: unknown) { defaults.set(activeColumn, value); return this; },
      unique() { uniqueColumns.push(activeColumn); return this; },
    };
    const builder = {
      addColumn(name: string, _type: string, configure?: (column: typeof columnBuilder) => unknown) {
        columns.push(name);
        activeColumn = name;
        configure?.(columnBuilder);
        return this;
      },
      execute: async () => undefined,
    };
    const database = {
      schema: {
        createTable: () => builder,
      },
    };
    await up(database as never);
    expect(columns).toContain('backendStates');
    expect(columns).toContain('enabledBackends');
    expect(columns).toContain('normalizedName');
    expect(columns).toContain('envManaged');
    expect(uniqueColumns).toContain('normalizedName');
    expect(defaults.get('envManaged')).toBe(0);
    expect(defaults.get('env')).toBe('{}');
  });

  it('drops the global MCP table on rollback', async () => {
    let dropped = false;
    const database = {
      schema: {
        dropTable: (name: string) => ({
          ifExists() { expect(name).toBe('global_mcp_servers'); return this; },
          async execute() { dropped = true; },
        }),
      },
    };
    await down(database as never);
    expect(dropped).toBe(true);
  });
});
