# Privacy

`prompt-grammar` is a local Antigravity plugin. It has no server of its own and collects nothing for its author.

## What it sends

- Each checkable prompt (first `max_chars` characters, default 6000) is sent only to your configured OpenAI-compatible `endpoint`.
- When `endpoint` is unset, no prompts leave your machine or reach any model.
- Slash commands, prompts shorter than `min_words`, and prompts matching your `skip` list are never sent.
- `/grammar review` sends grouped mistake pairs (not raw prompts) to your configured `endpoint`.
- `/grammar ask` sends your question, grouped mistake pairs, up to 10 recent session fixes, and (if `ask_memory` is on) up to 5 recent ask/review exchanges.

## What it keeps on disk

- **Settings & lists:** `~/.gemini/config/grammar.json` (global) and optional `.agents/grammar.json` (project).
- **Mistake history:** `$PLUGIN_DATA/grammar-history.json` (fallback `~/.gemini/config/grammar-data/grammar-history.json`) — keeps at most 90 days and 2000 short prose fixes (`<= 60` chars, no code/paths, no raw prompts, no native rewrites).
- **Per-session state:** `$PLUGIN_DATA/sessions/<conversationId>.json` — tracks failure count, streak, recent fixes, and ask follow-up thread; auto-pruned after 7 days.
- Set `"history": false` in `.agents/grammar.json` to leave no history trace for a specific project, or run `/grammar history off` / `/grammar history clear`.
