# Agent Standards — `mmxomni`

This file is the standing project standards document for any coding agent
(or human contributor) working in this repository. Read it before making
non-trivial changes.

## 1. Project identity

- **Name**: `mmxomni` (npm package + CLI command)
- **Purpose**: A Model Context Protocol (MCP) server that exposes MiniMax
  image, TTS, music, and video generation endpoints as MCP tools, so any
  MCP-aware host (Open WebUI, Claude Desktop, Cursor, etc.) can call them
  with a MiniMax Token Plan API key.
- **Distribution**: `npx mmxomni` / `npm i -g mmxomni` → stdio MCP server.

## 2. Tech stack (do not change without updating the plan)

- **Language**: TypeScript ≥ 5.4, ESM, strict mode.
- **Runtime**: Node.js ≥ 20 (declared in `package.json#engines`).
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport in v1).
- **Schema**: `zod` for tool input validation; zod-derived JSON Schema for
  `tools/list`.
- **HTTP**: `undici` (no `node-fetch`, no `axios`). Mocked with
  `undici.MockAgent` in tests.
- **Logging**: stderr-only. `stdout` is reserved for the MCP transport.
- **Build**: `tsup` → single-file `dist/index.js` with shebang.
- **Tests**: `vitest`.
- **Lint**: `eslint` (flat config) + `@typescript-eslint`.

## 3. Directory layout

```
mmxomni/
├── src/
│   ├── index.ts          # Entry: CLI parse + MCP server start
│   ├── server.ts         # McpServer instance + tool registration
│   ├── client.ts         # undici HTTP client (auth, region, retries)
│   ├── config.ts         # CLI flags + env + ~/.mmx/* resolution
│   ├── errors.ts         # MiniMax error normalization + MCP code mapping
│   ├── log.ts            # stderr-only logger with --log-level
│   └── tools/            # One file per tool (image, speech, music, video, ...)
├── test/                 # Vitest specs
├── dist/                 # tsup build output (gitignored)
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── eslint.config.mjs
├── agent.md              # this file
└── README.md
```

## 4. Code conventions

- **Strict TS**: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`.
- **ESM only**: `"type": "module"`. No CommonJS, no `require()`.
- **No default exports** for library code; default export only for `main`
  entry where it makes sense.
- **Error handling**: throw `MmxError` (from `src/errors.ts`) with a stable
  `code` (matches mmx-cli exit codes 1/3/4/5/10); never throw raw
  `Error` out of a tool handler.
- **Logging**: use `src/log.ts`; never `console.log`. `console.error` and
  `console.warn` are allowed but `log.ts` is preferred for consistency.
- **Async**: all I/O is async. No blocking calls in the request path.
- **Naming**: tools use the `mmx_<verb>_<noun>` convention.
- **MIME types**: use the canonical IANA values.

## 5. Auth & config precedence (binding for AC-4)

API key (and region) resolution, in this exact order:

1. CLI flag (`--api-key`, `--region`)
2. Env var (`MINIMAX_API_KEY`, `MINIMAX_REGION`)
3. `~/.mmx/credentials.json` field `MINIMAX_API_KEY` / `MINIMAX_REGION`
4. `~/.mmx/config.json` field `api_key` / `region`

Default region: `global` → `https://api.minimax.io/v1`.
`cn` → `https://api.minimaxi.cn/v1`.
A missing key exits with code 3 and a human-readable stderr message.

## 6. Testing rules

- Unit tests use `vitest` and mock the network with `undici.MockAgent`.
- A single smoke test against the real API is gated on
  `process.env.MINIMAX_API_KEY` being set; it must `it.skip` otherwise.
- `npm test` must exit 0 with no live network calls by default.
- Do not add tests that take more than a few seconds each.

## 7. Stdout vs stderr (binding for AC-11)

- `process.stdout` is **only** for MCP JSON-RPC frames. Never `console.log`.
- All logging, progress, and diagnostics go to `process.stderr`.
- `--log-level error|warn|info|debug` controls verbosity; default `warn`.

## 8. Versioning & releases

- `package.json#version` is the source of truth.
- `serverInfo.version` in `initialize` must match.
- Bump deliberately on each AC slice; do not auto-bump.

## 9. Plan awareness

The plan in `.humanize/rlcr/<id>/plan.md` is the contract. If a slice
requires deviating from the plan, call it out in the iteration summary's
"Plan Evolution Log" entry rather than silently drifting.
