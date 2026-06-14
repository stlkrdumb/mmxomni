# mmxomni

**Model Context Protocol server for MiniMax media APIs.**

Expose image generation, text-to-speech, music, and video generation from [MiniMax](https://platform.minimax.io) as MCP tools. Works with any MCP-aware host: Open WebUI, Claude Desktop, Cursor, and more.

## Features

| Category | Tool / Capability | Status |
|---|---|---|
| 🖼️ Image Generation | `mmx_image_generate` — text-to-image (`image-01`) | ✅ |
| 🎤 Text-to-Speech | `mmx_speech_synthesize` — TTS with voice control | ✅ |
| 🎵 Music Generation | `mmx_music_generate` — style/lyrics to audio (`music-2.5`) | ✅ |
| 🎬 Video Generation | `mmx_video_generate` — async + sync (`MiniMax-Hailuo-2.3`) | ✅ |
| 📊 Video Status | `mmx_video_status` — poll task progress | ✅ |
| ⬇️ Video Download | `mmx_video_download` — save generated files | ✅ |
| 👁️ Vision (bonus) | `mmx_vision_describe` — describe an image | ✅ |
| 🔍 Web Search (bonus) | `mmx_search_query` — web search via MiniMax | ✅ |
| 📋 Quota (bonus) | `mmx_quota_show` — inspect remaining Token Plan quota | ✅ |
| 🔐 Auth | CLI flag, env var, `~/.mmx/credentials.json`, `~/.mmx/config.json` | ✅ |
| 🌐 Region | `global` / `cn` base URL switching | ✅ |
| 🔄 Retry | Exponential backoff on 429/5xx (up to 3 retries) | ✅ |
| 📝 Logging | stderr-only with `--log-level` (`error|warn|info|debug`) | ✅ |
| 🧪 Testing | 120+ unit tests using `undici` `MockAgent`, no live network | ✅ |
| 🚩 Feature Flag | Bonus tools gated behind `--enable-bonus` / `MMXOMNI_BONUS=1` | ✅ |

## Quick Start

```bash
# Run directly without installing
MINIMAX_API_KEY=sk-... npx mmxomni

# Or install globally
npm i -g mmxomni
MINIMAX_API_KEY=sk-... mmxomni
```

The server starts an MCP stdio transport. Your host spawns it and communicates over stdin/stdout — you do not run it interactively. See **Installation** below for copy-pasteable JSON blocks for your host.

## Authentication

**mmxomni** uses the same credential precedence as `mmx-cli`, so existing users have nothing to reconfigure:

| Priority | Source | Example |
|----------|--------|---------|
| 1 (highest) | `--api-key` CLI flag | `mmxomni --api-key sk-...` |
| 2 | `MINIMAX_API_KEY` env var | `MINIMAX_API_KEY=sk-... mmxomni` |
| 3 | `~/.mmx/credentials.json` | `{ "MINIMAX_API_KEY": "sk-..." }` |
| 4 (fallback) | `~/.mmx/config.json` | `{ "api_key": "sk-..." }` |

Region is resolved with the same precedence (`--region` / `MINIMAX_REGION` / config), defaulting to `global`. Region `cn` uses `https://api.minimaxi.cn/v1`.

### Setting up `~/.mmx/credentials.json`

```json
{
  "MINIMAX_API_KEY": "sk-your-key-here"
}
```

## CLI Options

```
mmxomni [options]

  --api-key <key>       MiniMax API key (overrides env / config file)
  --region <region>     API region: 'global' or 'cn' (default: global)
  --log-level <level>   Log verbosity: error|warn|info|debug (default: warn)
  --enable-bonus        Register bonus tools: mmx_vision_describe,
                          mmx_search_query, mmx_quota_show
  --version             Print the server version and exit
  --help                Show this help message and exit
```

Bonus tools can also be enabled via the `MMXOMNI_BONUS=1` environment variable.

---

## Installation

Every MCP host needs to know the command to spawn `mmxomni`, along with your MiniMax API key. Below are copy-pasteable config blocks for popular hosts.

The env-var pattern is the same everywhere: point the host at `npx -y mmxomni` with `MINIMAX_API_KEY` set in the environment.

### Open WebUI

Open **Settings → External Tools → MCP Servers → Add Server** and paste:

```json
{
  "command": "npx",
  "args": ["-y", "mmxomni"],
  "env": {
    "MINIMAX_API_KEY": "sk-your-key-here"
  }
}
```

For bonus tools, add `"MMXOMNI_BONUS": "1"` to the `env` block.

### Claude Desktop

Edit `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

With bonus tools:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni", "--enable-bonus"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Claude Code CLI

Edit `.claude/settings.json` in your project root:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Cursor

Edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Codex CLI (OpenAI)

Edit `~/.codex/mcp.json`:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Gemini CLI

Edit `~/.gemini/mcp.json`:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Opencode CLI

Edit `.opencode/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Cline / Roo Code (VS Code extension)

Edit `.cline/mcp.json` or `.roo/mcp.json`:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Continue (VS Code extension)

Edit `~/.continue/config.json`:

```json
{
  "experimental": {
    "mcpServers": {
      "mmxomni": {
        "command": "npx",
        "args": ["-y", "mmxomni"],
        "env": {
          "MINIMAX_API_KEY": "sk-your-key-here"
        }
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Edit `.vscode/mcp.json` in your project root or add to user `settings.json`:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Zed

Edit `~/.config/zed/settings.json`:

```json
{
  "mcp_servers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Windsurf

Edit `.windsurf/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Goose

Edit `~/.goose/config.json`:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Hermes Agent

Edit `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  mmxomni:
    command: npx
    args: ["-y", "mmxomni"]
    env:
      MINIMAX_API_KEY: sk-your-key-here
```

### Openclaw

Edit `~/.openclaw/mcp.json`:

```json
{
  "mcpServers": {
    "mmxomni": {
      "command": "npx",
      "args": ["-y", "mmxomni"],
      "env": {
        "MINIMAX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Generic stdio MCP entry

Any host with stdio-based MCP support uses the same shape. Configure it however the host expects:

```json
{
  "command": "npx",
  "args": ["-y", "mmxomni"],
  "env": {
    "MINIMAX_API_KEY": "sk-your-key-here"
  }
}
```

---

## Core Tools

### `mmx_image_generate`

Generate one or more images from a text description.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` (required) | string | — | Text description of the image |
| `model` | string | `image-01` | Model ID (`image-01`, `image-01-live`) |
| `aspect_ratio` | string | `1:1` | Output ratio: `16:9`, `1:1`, `4:3`, `9:16`, `3:4` |
| `n` | integer | 1 | Number of images (1–4) |
| `embed` | boolean | false | Return base64 MCP `Image` content block |
| `subject_ref` | string | — | Subject reference URL/path |
| `out_dir` | string | — | Download directory path |

**Example:**
> _"Generate an image of a red apple on a wooden table."_
> Calls `mmx_image_generate` with `prompt="a red apple on a wooden table"`.

### `mmx_speech_synthesize`

Synthesize speech from text.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` (required) | string | — | Text to synthesize (max 10,000 chars) |
| `model` | string | `speech-2.8-hd` | TTS model ID |
| `voice` | string | `English_expressive_narrator` | Voice ID |
| `format` | string | `mp3` | Audio format: `mp3`, `wav`, `flac`, `pcm` |
| `speed` | number | — | Speed multiplier (0.5–2.0) |
| `volume` | number | — | Volume (0–10) |
| `pitch` | integer | — | Pitch adjustment in semitones (-12–12) |
| `sample_rate` | integer | 32000 | Sample rate in Hz |
| `bitrate` | integer | 128000 | Bitrate in bps |
| `language_boost` | string | — | Language hint (`en`, `zh`, `ja`, etc.) |
| `embed` | boolean | false | Return base64 MCP `audio` content block |
| `save_path` | string | — | Local file path to save the audio |

**Example:**
> _"Say 'Hello, world' in a British accent."_
> Calls `mmx_speech_synthesize` with `text="Hello, world"`.

### `mmx_music_generate`

Generate music from a style prompt and/or lyrics.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | — | Music style description |
| `lyrics` | string | — | Song lyrics with structure tags |
| `model` | string | `music-2.5` | Music model ID |
| `genre` | string | — | Genre (`folk`, `pop`, `jazz`, etc.) |
| `mood` | string | — | Mood (`warm`, `melancholic`, etc.) |
| `tempo` | string | — | Tempo (`fast`, `slow`, etc.) |
| `bpm` | integer | — | Beats per minute (40–220) |
| `key` | string | — | Musical key (`C major`, `A minor`, etc.) |
| `instrumental` | boolean | false | Instrumental only (no vocals) |
| `vocals` | string | — | Vocal style hint |
| `instruments` | string | — | Featured instruments |
| `structure` | string | — | Song structure |
| `references` | string | — | Reference tracks or artists |
| `avoid` | string | — | Elements to avoid |
| `use_case` | string | — | Use case context |
| `aigc_watermark` | boolean | false | Embed AIGC watermark |
| `format` | string | `mp3` | Audio format |
| `sample_rate` | integer | 44100 | Sample rate |
| `bitrate` | integer | 256000 | Bitrate |
| `embed` | boolean | false | Return base64 MCP `audio` content block |
| `save_path` | string | — | Local file path to save the audio |

At least one of `prompt` or `lyrics` is required. `instrumental=true` and `lyrics` are mutually exclusive.

**Example:**
> _"Create an upbeat pop song with lyrics about summer."_
> Calls `mmx_music_generate` with `prompt="upbeat pop"` and `lyrics="..."`.

### `mmx_video_generate` / `mmx_video_status` / `mmx_video_download`

Async video generation in three steps, or synchronous with `wait=true`.

#### `mmx_video_generate`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` (required) | string | — | Video description (max 2,000 chars) |
| `model` | string | `MiniMax-Hailuo-2.3` | Video model ID |
| `duration` | integer | 6 | Duration in seconds (6 or 10) |
| `resolution` | string | `768P` | Output resolution (`720P`, `768P`, `1080P`) |
| `prompt_optimizer` | boolean | true | Auto-optimize the prompt |
| `first_frame` | string | — | Image URL/path for I2V |
| `wait` | boolean | false | Poll until complete |
| `wait_timeout_seconds` | integer | 600 | Max wait time when `wait=true` |
| `poll_interval_seconds` | integer | 5 | Polling interval |

Async mode (default) returns `{ task_id, status, model }`. Pass `wait=true` to poll until `Success` or `Fail`.

#### `mmx_video_status`

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` (required) | string | Task ID from `mmx_video_generate` |

Returns the raw task object with status, progress, and file URL.

#### `mmx_video_download`

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` (required) | string | Task ID from `mmx_video_generate` |
| `save_path` (required) | string | Local path to write the video file |

**Example:**
> _"Generate a 6-second video of a cat walking on a beach."_
> First calls `mmx_video_generate` with `prompt="a cat walking on a beach"`, then `mmx_video_status` to poll, then `mmx_video_download` to save the result.

---

## Bonus Tools

Enable with `--enable-bonus` or `MMXOMNI_BONUS=1`.

| Tool | Description |
|------|-------------|
| `mmx_vision_describe` | Describe an image via the vision API |
| `mmx_search_query` | Search the web via the MiniMax search API |
| `mmx_quota_show` | Inspect remaining Token Plan quota |

`mmx_quota_show` is especially useful for Token Plan users to check remaining monthly usage.

---

## Development

```bash
git clone <repo>
cd mmxomni
npm install
npm run build    # produce dist/
npm test         # 120+ tests, no live network calls
npm run lint     # eslint
```

The project uses:

- **TypeScript** + **tsup** for building
- **@modelcontextprotocol/sdk** for the MCP server framework
- **zod** for tool input schema validation
- **undici** for HTTP requests
- **vitest** for testing (with undici `MockAgent` for offline tests)

## Architecture & Design Decisions

### Feature Flag with Tri-State Resolution

The `--enable-bonus` CLI flag uses a **tri-state** (`undefined | true | false`) to distinguish "not set" from "explicitly disabled". This allows the env var `MMXOMNI_BONUS=1` to take effect when no CLI flag is passed, while `--no-enable-bonus` overrides the env var:

```
CLI --enable-bonus   → true  (bonus tools registered)
CLI not set, env=1   → true  (bonus tools registered)
CLI not set, no env  → false (core tools only)
CLI --no-enable-bonus + env=1 → false (CLI wins)
```

### MiniMax → MCP Error Code Mapping

MiniMax API error codes are mapped to the mmx-cli exit-code convention, which aligns with MCP `isError` semantics:

| MiniMax Code | HTTP Status | MCP Code | Meaning |
|---|---|---|---|
| `1001` / `1002` / `1007` | `401` / `403` | `3` | Authentication failure |
| `1004` / `1005` / `10429` | `429` | `4` | Quota / rate limit |
| — | `408` | `5` | Timeout |
| `1026` / `1027` / `2013` / `2014` | `400` | `10` | Content filter / safety |
| Any other | `5xx` | `1` | Generic / internal error |

The mapping is resolved in `src/errors.ts` via `MmxcError.toMcpErrorCode()`, which checks the MiniMax-specific code table before falling back to the HTTP status mapping.

### Async Video with Polling Seam

`mmx_video_generate` submits a task and returns `{ task_id, status, model }` immediately. The companion `mmx_video_status` tool lets the agent poll for completion. An optional `wait=true` flag bundles the two into a single call: the tool polls at `poll_interval_seconds` (default 5s) up to `wait_timeout_seconds` (default 600s), returning the resolved task on success/fail or a timeout error with MCP code 5. The polling loop is injectable via a `sleepFn` seam for zero-wait tests.

### Retry with Exponential Backoff

The shared HTTP client (`MmxcClient`) retries 429 and 5xx responses up to 3 times with exponential backoff: `baseMs * 2^attempt` (default base 250ms → delays of 250ms, 500ms, 1s). 401/403/400/408 responses are never retried — they throw `MmxcError` immediately. The retry count is configurable via the `maxRetries` constructor option.

### Credential Reuse from mmx-cli

The server reads `~/.mmx/credentials.json` and `~/.mmx/config.json` directly — the same files used by the official `mmx-cli`. Users who already configured the CLI need zero additional setup. Credentials resolve in strict order: `--api-key` flag > `MINIMAX_API_KEY` env > credentials file > config file.

### Region-Aware Base URL

The base URL is selected by region at construction time:
- `global` → `https://api.minimax.io/v1`
- `cn` → `https://api.minimaxi.cn/v1`

An explicit `--base-url` override bypasses the region lookup entirely, useful for testing against staging environments.

### Offline Testing with Call History

Every unit test uses `undici`'s `MockAgent` with `enableCallHistory()` enabled. Tests assert precise HTTP attempt counts (e.g., "exactly 4 attempts for a terminal 5xx") without relying on real network calls. The [smoke test](test/smoke.test.ts) is the only test that hits the live API, and it is gated behind `it.runIf(process.env.MINIMAX_API_KEY)` — skipped by default.

## License

MIT
