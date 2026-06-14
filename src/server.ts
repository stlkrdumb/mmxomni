/**
 * mmxomni — MCP server factory.
 *
 * Wraps the high-level `McpServer` from `@modelcontextprotocol/sdk` and
 * registers the full core tool set (image, speech, music, video
 * generate / status / download) via the tool registry. When
 * `options.enableBonus` is true, the AC-9 bonus tools (vision, search,
 * quota) are also registered. The bootstrap entry point
 * (`src/index.ts`) wires the resulting instance to the stdio transport.
 *
 * The shared `MmxcClient` is passed in so every tool handler shares one
 * connection pool, retry policy, and base-URL selection (per region /
 * `--base-url` override).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

import type { MmxcClient } from './client.js';
import { registerAllTools, type RegisterAllToolsOptions } from './tools/index.js';

export const SERVER_NAME = 'mmxomni';

export interface CreateServerOptions {
  /** Server version string; should match `package.json#version`. */
  version: string;
  /** Shared MiniMax HTTP client (apiKey + region baked in). */
  client: MmxcClient;
  /** AC-9: when true, also register the bonus tool set. */
  enableBonus?: boolean;
}

/**
 * Construct a fresh `McpServer` instance with every core tool
 * registered. Each call returns a new server so tests and the CLI entry
 * point can both own independent instances.
 *
 * The first `server.tool(...)` call also triggers the SDK's lazy
 * `setToolRequestHandlers()`, which installs the `tools/list` and
 * `tools/call` request handlers.
 */
export function createServer(options: CreateServerOptions): McpServer {
  const serverInfo: Implementation = {
    name: SERVER_NAME,
    version: options.version,
  };
  const server = new McpServer(serverInfo, {
    capabilities: {
      tools: {},
    },
  });

  const toolOptions: RegisterAllToolsOptions = {
    enableBonus: options.enableBonus === true,
  };
  registerAllTools(server, options.client, toolOptions);

  return server;
}
