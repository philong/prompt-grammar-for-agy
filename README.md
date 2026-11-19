# prompt-grammar

An [Antigravity](https://antigravity.google) plugin that proofreads each prompt you send, shows grammar fixes inline, keeps your mistakes over time for `/grammar stats`, `/grammar review`, and `/grammar ask`, and works with any OpenAI-compatible endpoint (Ollama, llama.cpp, LM Studio, Google AI Studio, OpenRouter).

Ported from [jaklimoff/claude-grammar](https://github.com/jaklimoff/claude-grammar) (v1.7.0, MIT).

## Install

```bash
agy plugin install https://github.com/philong/prompt-grammar-for-agy
```

Or from a local checkout:

```bash
git clone https://github.com/philong/prompt-grammar-for-agy
cd prompt-grammar-for-agy
bun run build
agy plugin install .
```

Requires Node.js (v20+) on `PATH` for the bundled `dist/hook.mjs` hook runtime (zero npm dependencies).

## Setup (required before first check)

**No prompts are sent to any model until you configure an OpenAI-compatible `endpoint`** (works with local servers or cloud APIs):

- **Local OpenAI-compatible server** (Ollama, llama.cpp, LM Studio):
  ```text
  /grammar config endpoint http://localhost:11434
  /grammar config endpoint_model qwen2.5:7b
  ```
- **Cloud OpenAI-compatible API** (Google AI Studio, OpenRouter):
  ```bash
  export PROMPT_GRAMMAR_ENDPOINT_KEY="<your-api-key>"
  ```
  ```text
  /grammar config endpoint https://generativelanguage.googleapis.com/v1beta/openai
  /grammar config endpoint_model gemini-2.5-flash-lite
  ```

## Use

Send prompts as usual. When a prompt has mistakes, the fixes appear at the end of the reply (or in a collapsible system row in `display: "system"` mode):

```markdown
✎ ~~i want know it~~ **I want to know it** *(missing "to")*  ·  ~~what i planing~~ **what I'm planning** *(verb form)*
↳ *I want to know it for the trip I'm planning.*
```

Clean prompts add nothing until you hit 3 in a row (`✓ no mistakes · 3 in a row`).

| Command | What it does |
|---|---|
| `/grammar help` | Lists commands and current settings. |
| `/grammar`, `/grammar on\|off` | Toggles or sets checking (`on` also resumes after 3 consecutive failures). |
| `/grammar natural [on\|off]` | Toggles the native-speaker rewrite line. |
| `/grammar ignore [add\|rm <words>]` | Shows or edits ignored words/phrases (comma-separated for phrases). |
| `/grammar stats [period] [language]` | Mistakes by kind, trend, and repeated fixes (no model call). |
| `/grammar review [period] [language]` | Summary card + 3–5 habits from your kept fixes (needs 20+ fixes). |
| `/grammar ask [period] <question>` | Ask anything about your writing with your kept + recent fixes at hand. |
| `/grammar ask list\|clear\|memory [on\|off]` | Manage follow-up memory (last 5 asks/reviews per session). |
| `/grammar history [on\|off\|clear]` | Control or clear saved mistake history. |
| `/grammar statusline [install\|uninstall]` | Configure Antigravity CLI `statusLine` band (0 ms async, ANSI colors). |
| `/grammar config [key] [value]` | View or change any setting (persisted in `~/.gemini/config/grammar.json`). |

Periods accept `7d`, `30d`, or `since 2026-10-01` (UTC days). You can also run any subcommand directly in your shell with zero tokens:

```bash
node dist/cli.mjs stats 7d
node dist/cli.mjs config endpoint http://localhost:11434
```

## Settings

Stored in `~/.gemini/config/grammar.json` (and optionally overridden per project in `.agents/grammar.json`, except `endpoint`, `endpoint_model`, and `endpoint_key`). Update via `/grammar config <key> <value>`:

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | Enable or disable prompt checking. |
| `natural` | `true` | Include native-speaker phrasing rewrites when clearly unidiomatic. |
| `language` | `English` | Language name (`French`, `German`, ...), comma-separated list (`English, French`), or `auto`. |
| `dialect` | `any` | For English: `any`, `us`, or `uk`. |
| `min_words` | `2` | Skip short prompts (`ok`, `yes`, `continue`). |
| `max_chars` | `6000` | Max characters sent per prompt, cut at a word boundary. |
| `show_why` | `true` | Include short reason after each fix. |
| `history` | `true` | Keep fixes in `$PLUGIN_DATA/grammar-history.json` (fallback `~/.gemini/config/grammar-data/grammar-history.json`). |
| `clean` | `true` | Show clean streak (`✓ no mistakes · N in a row`) starting at 3 clean prompts. |
| `ask_memory` | `true` | Remember last 5 asks/reviews per session for follow-ups. |
| `display` | `reply` | `reply` (sync, appended to current reply), `auto` (`statusline` in Antigravity CLI when installed, `reply` in IDE/Desktop), `async` (0 ms background check, appended visibly on next reply), `system` (0 ms background check, injected as system row), `statusline` (0 ms async CLI status bar with ANSI colors, 0 model tokens), or `user_markdown` (panics in `agy` 1.5.12 with `type mismatch: cannot convert string to message`; kept for future `agy` versions). |
| `timeout_ms` | `30000` | Timeout (ms) for live prompt checks. |
| `endpoint` | `""` | OpenAI-compatible API URL (Ollama, llama.cpp, LM Studio, Google AI Studio, OpenRouter). |
| `endpoint_model` | `""` | Model ID for `endpoint` (empty uses server default). |
| `endpoint_key` | `""` | Bearer token for `endpoint` (or set `PROMPT_GRAMMAR_ENDPOINT_KEY` env var). |

## CLI status line (`display: "auto"` / `"statusline"`)

For a 0 ms non-blocking colored band below Antigravity CLI's default status line (zero model context tokens), run:

```bash
/grammar statusline install
```

This configures `~/.gemini/antigravity-cli/settings.json` and sets `display` to `auto`, so Antigravity CLI uses `statusline` automatically while Antigravity IDE and Desktop stay on `reply` with zero config switching. Or add it directly in `~/.gemini/antigravity-cli/settings.json` alongside `/grammar config display auto` (or `statusline`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "[ ! -f ~/.gemini/config/plugins/prompt-grammar/dist/statusline.mjs ] || exec node ~/.gemini/config/plugins/prompt-grammar/dist/statusline.mjs",
    "stack_with_default": true,
    "padding": 0,
    "enabled": true
  }
}
```

The file-existence guard exits 0 cleanly if `prompt-grammar` is uninstalled without running `/grammar statusline uninstall` first.

## Ignore and skip lists

Add `ignore`, `skip`, and per-project `history` in `~/.gemini/config/grammar.json` (global) or `.agents/grammar.json` (project-only):

```json
{
  "ignore": ["kubectl", "pnpm", "pull request", "/^[A-Z]+-\\d+$/"],
  "skip": ["^(ok|yes|continue|go on)\\b", "^deploy "],
  "history": false
}
```

## Import past Antigravity prompts

Backfill history from existing Antigravity transcripts (`~/.gemini/antigravity-cli/brain/`) using your configured `endpoint`:

```bash
bun scripts/import-history.ts --dry-run
bun scripts/import-history.ts --days 30
```

## Development

```bash
bun run build                  # bundle dist/hook.mjs, dist/cli.mjs, dist/check-worker.mjs, dist/statusline.mjs
bun test                       # run unit & hook contract tests
agy plugin validate --strict . # validate Antigravity plugin manifest & hooks
```

## License

[MIT](LICENSE) — ported from [jaklimoff/claude-grammar](https://github.com/jaklimoff/claude-grammar) (Copyright © 2026 Jack Klimov).
