import * as fs from 'fs';
import * as path from 'path';

import { app } from 'electron';

/**
 * Returns the resolved path to the Jean-Claude MCP server script.
 * Handles dev, tests, and packaged Electron runtime.
 */
export function getJcMcpServerPath(): string {
  const electronApp = app as
    | {
        isPackaged?: boolean;
        getAppPath?: () => string;
      }
    | undefined;

  if (electronApp?.isPackaged) {
    return path.join(process.resourcesPath, 'mcp', 'jean-claude-mcp-server.js');
  }

  const appPath = electronApp?.getAppPath?.() ?? process.cwd();
  const candidates = [
    path.join(__dirname, 'jean-claude-mcp-server.js'),
    path.join(__dirname, '..', 'jean-claude-mcp-server.js'),
    path.join(appPath, 'out', 'main', 'jean-claude-mcp-server.js'),
  ];

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  return existing ?? candidates[0];
}
