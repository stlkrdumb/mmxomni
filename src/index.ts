/**
 * mmxomni — Model Context Protocol server for MiniMax media APIs.
 *
 * Entry point. Parses CLI flags, resolves auth + region in the strict
 * precedence documented in `src/config.ts` (AC-4), constructs the MCP
 * server, and connects it to the stdio transport. `stdout` is reserved
 * for MCP JSON-RPC frames; all diagnostics go to `stderr` (binding for
 * AC-11). The shebang is injected by tsup's `banner` config so it does
 * not appear in source.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer, SERVER_NAME } from './server.js';
import { log } from './log.js';
import { resolveConfig, assertApiKey } from './config.js';
import { MmxcClient, type Region } from './client.js';
import { MMXOMNI_BONUS_ENV, resolveEnableBonus } from './tools/index.js';

interface ParsedArgs {
  apiKey?: string;
  region?: string;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  showHelp: boolean;
  showVersion: boolean;
  /**
   * AC-9 bonus tool flag. Tri-state:
   *   - `undefined`: user did not pass `--enable-bonus` / `--no-enable-bonus`;
   *     `resolveEnableBonus` falls back to the `MMXOMNI_BONUS` env var.
   *   - `true`: `--enable-bonus` was passed; bonus tools are registered.
   *   - `false`: `--no-enable-bonus` was passed; bonus tools are
   *     suppressed even if the env var is set.
   */
  enableBonus?: boolean;
}

const HELP_TEXT = `${SERVER_NAME} — Model Context Protocol server for MiniMax media APIs.

Usage:
  ${SERVER_NAME} [options]

Options:
  --api-key <key>       MiniMax API key (overrides env / config file)
  --region <region>     API region: 'global' or 'cn' (default: global)
  --log-level <level>   Set log verbosity: error|warn|info|debug (default: warn)
  --enable-bonus        Register the bonus tool set: mmx_vision_describe,
                          mmx_search_query, mmx_quota_show. (env: ${MMXOMNI_BONUS_ENV}=1)
  --version             Print the server version and exit
  --help                Show this help message and exit

Auth is resolved in this strict precedence:
  1. --api-key CLI flag
  2. MINIMAX_API_KEY environment variable
  3. MINIMAX_API_KEY field in ~/.mmx/credentials.json
  4. api_key field in ~/.mmx/config.json

Region follows the same precedence via --region / MINIMAX_REGION / config,
defaulting to 'global'. A missing API key produces exit code 3 and a
human-readable stderr message.

Bonus tools are gated behind the feature flag (--enable-bonus or
${MMXOMNI_BONUS_ENV}=1). When the flag is off, only the six core tools are
advertised; when it is on, the three bonus tools join them.
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    logLevel: 'warn',
    showHelp: false,
    showVersion: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    const next = argv[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        out.showHelp = true;
        break;
      case '--version':
      case '-v':
        out.showVersion = true;
        break;
      case '--api-key':
        if (!next) {
          throw new Error('--api-key requires a value');
        }
        out.apiKey = next;
        i++;
        break;
      case '--region':
        if (!next) {
          throw new Error('--region requires a value');
        }
        out.region = next;
        i++;
        break;
      case '--log-level':
        if (!next) {
          throw new Error('--log-level requires a value');
        }
        if (next !== 'error' && next !== 'warn' && next !== 'info' && next !== 'debug') {
          throw new Error(`--log-level must be one of: error, warn, info, debug (got "${next}")`);
        }
        out.logLevel = next;
        i++;
        break;
      case '--enable-bonus':
        out.enableBonus = true;
        break;
      case '--no-enable-bonus':
        out.enableBonus = false;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        // Positional args are ignored.
        break;
    }
  }
  return out;
}

function readPackageVersion(): string {
  // Resolve the package.json that ships with the published package. After
  // tsup bundles us, `import.meta.url` still points at dist/index.js, so we
  // walk one directory up to find the adjacent package.json.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', 'package.json'), resolve(here, 'package.json')];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === SERVER_NAME && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0';
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`Run "${SERVER_NAME} --help" for usage.\n`);
    return 2;
  }

  if (parsed.showHelp) {
    process.stderr.write(HELP_TEXT);
    // If stdout were also written, exit immediately so MCP
    // clients (read-only stdout consumers) don't see garbage.
    return 0;
  }
  if (parsed.showVersion) {
    const version = readPackageVersion();
    process.stderr.write(`${SERVER_NAME} ${version}\n`);
    return 0;
  }

  // Apply log level as early as possible so subsequent errors are reported.
  // `setLogLevel` lives in log.ts; import it lazily so the version/help
  // paths stay free of side effects.
  const { setLogLevel } = await import('./log.js');
  setLogLevel(parsed.logLevel);

  // AC-9: resolve the bonus-tool feature flag. CLI flag wins; env
  // var (`MMXOMNI_BONUS=1`) is the alternative. The resolved boolean
  // is passed to `createServer`, which threads it into the tool
  // registry so the bonus tools are either registered or absent.
  const enableBonus = resolveEnableBonus(parsed.enableBonus);

  // Resolve auth + region (AC-4). Strict precedence: CLI > env >
  // ~/.mmx/credentials.json > ~/.mmx/config.json; region defaults to
  // 'global'. A missing API key exits with code 3.
  const config = resolveConfig({
    cliApiKey: parsed.apiKey,
    cliRegion: parsed.region,
  });
  const keyCheck = assertApiKey(config, SERVER_NAME);
  if (!keyCheck.ok) {
    return keyCheck.code;
  }

  log.debug(
    `Resolved config: apiKeySource=${config.apiKeySource}, region=${config.region} (${config.regionSource}), enableBonus=${enableBonus}`,
  );

  const version = readPackageVersion();
  const client = new MmxcClient({
    apiKey: config.apiKey!,
    region: config.region as Region,
  });
  const server = createServer({ version, client, enableBonus });
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    try {
      await server.close();
    } catch (err) {
      log.error('Error during server.close()', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', reason);
  });

  try {
    await server.connect(transport);
    log.info(`${SERVER_NAME} v${version} stdio MCP server ready`);
  } catch (err) {
    log.error('Failed to start MCP server', err);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
