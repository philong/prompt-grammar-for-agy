# Security

Report security issues privately via GitHub Security Advisories on `philong/prompt-grammar-for-agy`.

- `prompt-grammar` never invokes `agy -p` or accesses Antigravity credentials; it sends model requests only to your configured OpenAI-compatible `endpoint`.
- Prefer setting `PROMPT_GRAMMAR_ENDPOINT_KEY` in your environment instead of storing API keys in `~/.gemini/config/grammar.json`.
- Project-level `.agents/grammar.json` files cannot override global `endpoint`, `endpoint_model`, or `endpoint_key` settings, and `~/.gemini/config/grammar.json` is written with `0600` permissions on POSIX.
