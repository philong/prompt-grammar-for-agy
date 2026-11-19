---
name: grammar
description: >-
  Manage the prompt-grammar prompt proofreader and mistake tracker (/grammar help,
  /grammar on|off, /grammar natural, /grammar ignore, /grammar stats,
  /grammar review, /grammar ask, /grammar history, /grammar config).
---

# prompt-grammar

When the user runs `/grammar ...` or `/prompt-grammar:grammar ...`, the plugin's `PreInvocation` hook executes the command locally and injects the exact output as a system message. Reply with that injected output verbatim without calling any tools.

If the hook output was not injected, run the bundled CLI directly:

```bash
node ~/.gemini/config/plugins/prompt-grammar/dist/cli.mjs <subcommand>
```

## Commands

| Command | What it does |
|---|---|
| `/grammar help` | Show current settings and command list. |
| `/grammar [on\|off]` | Enable, disable, or toggle prompt checking (`on` resets failure pause). |
| `/grammar natural [on\|off]` | Toggle native-speaker phrasing suggestions. |
| `/grammar ignore [add\|rm] <words>` | Show, add, or remove ignored words/phrases (comma-separated for phrases). |
| `/grammar stats [7d\|30d\|since YYYY-MM-DD] [lang]` | Show mistake breakdown by kind, trend, and repeated fixes. |
| `/grammar review [period] [lang]` | Coaching summary card + 3–5 top habits from kept fixes (needs 20+ fixes). |
| `/grammar ask [period] <question>` | Ask about your writing using kept fixes and recent session fixes. |
| `/grammar ask list\|clear\|memory [on\|off]` | Manage follow-up memory (last 5 asks/reviews). |
| `/grammar history [on\|off\|clear]` | Show, toggle, or clear mistake history. |
| `/grammar statusline [install\|uninstall]` | Configure Antigravity CLI `statusLine` band (0 ms, ANSI colors). |
| `/grammar config [key] [value]` | View or update settings (e.g., `endpoint http://localhost:11434`, `endpoint_model qwen2.5:7b`, `display auto`, `language French`). |
