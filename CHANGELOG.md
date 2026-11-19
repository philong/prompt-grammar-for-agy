# Changelog

## 1.0.0

Initial Antigravity plugin port of [claude-grammar](https://github.com/jaklimoff/claude-grammar) v1.7.0 (`prompt-grammar` / `Prompt Grammar`):

- Native Antigravity plugin layout (`plugin.json` with Marketplace metadata, root `hooks.json`, `skills/grammar/SKILL.md`, `assets/logo.png`, and zero-dependency Node/Bun bundles in `dist/`).
- Live prompt proofreading via any configured OpenAI-compatible `endpoint` (Ollama, llama.cpp, LM Studio, Google AI Studio, OpenRouter). When `endpoint` is unset, prompt checks stay disabled without touching Antigravity credentials or spawning `agy`.
- Six display modes: `reply` (default), `auto` (`statusline` in Antigravity CLI when installed, `reply` in IDE and Antigravity 2.0 Desktop), `async`, `system`, `statusline` (`dist/statusline.mjs`, 0 ms async ANSI colors, correction-only replacements and strikethrough removals, plus `/grammar statusline [install|uninstall]` with a file-existence guard on `statusLine.command`), and `user_markdown`.
- Full `/grammar` command suite (`help`, `on|off`, `natural`, `ignore`, `stats`, `review`, `ask` with session memory, `history`, `statusline`, and `config`), standalone CLI (`dist/cli.mjs`), and Antigravity transcript importer (`scripts/import-history.ts`).
- Security and storage guardrails: auto-discover Antigravity plugin data directories when `$PLUGIN_DATA` is unset, block `.agents/grammar.json` from overriding `endpoint`, `endpoint_model`, or `endpoint_key`, and write `grammar.json` with `0600` permissions on POSIX.
