# mmxomni

**Model Context Protocol server for MiniMax media APIs.**

Expose image generation, text-to-speech, music, and video generation from [MiniMax](https://platform.minimax.io) as MCP tools. Works with any MCP-aware host: Open WebUI, Claude Desktop, Cursor, and more.

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

## License

MIT
