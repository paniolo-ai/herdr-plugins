# herdr-plugins

[Paniolo](https://paniolo.ai)'s Herdr plugins — one subdirectory per plugin.

> **Paniolo is the intelligence layer for coding agents.** Agentic knowledge
> plus harness engineering, in a fast Rust CLI — your knowledge lives in git,
> linted like code, retrieved locally with no vendor API call.
> **Your knowledge. Your rules.**
>
> [paniolo.ai](https://paniolo.ai) · [docs](https://paniolo.ai/docs) ·
> free read-only scan: `npx @paniolo/cli scan .`

| Plugin | Install | Description |
|---|---|---|
| [paniolo-herdr-claude](paniolo-herdr-claude/) | `herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-claude` | Per-session status footer for Claude Code panes — model, effort, context, rate-limit windows, permission mode, subagents, tokens, dirty repos, live Paniolo CLI stats |
| [paniolo-herdr-cursor](paniolo-herdr-cursor/) | `herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-cursor` | Per-session status footer for Cursor Agent CLI panes — model, context, monthly Included/Auto/API quotas, approval mode, in-flight tools, tokens (via statusLine bridge), dirty repos, live Paniolo CLI stats |
| [paniolo-herdr-codex](paniolo-herdr-codex/) | `herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-codex` | Per-session status footer for Codex panes — model, effort, context, usage windows, sandbox/approval mode, tools, tokens, dirty repos, live Paniolo CLI stats |
| [paniolo-herdr-devin](paniolo-herdr-devin/) | `herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-devin` | Per-thread status footer for Devin CLI panes — model, context, quotas, spend, tokens, dirty repos, live Paniolo CLI stats |
| [paniolo-herdr-obsidian](paniolo-herdr-obsidian/) | `herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-obsidian` | Ctrl+click `obsidian://` links to open them in Obsidian directly |

Each subdirectory carries its own `herdr-plugin.toml`; the Herdr marketplace
indexes all manifests in the repo. See each plugin's README for requirements
and usage.

## Plugin Names

Every plugin's folder and manifest ID use `paniolo-herdr-<integration>`.
Use that ID for enable/disable commands and action names, such as
`herdr plugin action invoke paniolo-herdr-codex.reconcile`.
Built-in agent integrations keep their Herdr names: `herdr integration install codex`.

---

Built by **[Paniolo](https://paniolo.ai)** — Agentic Knowledge · Harness
Engineering. New York & Honolulu, Hawaiʻi.

- Site: <https://paniolo.ai>
- Docs: <https://paniolo.ai/docs>
- Writing: [Harnessed on Substack](https://bkinsey808.substack.com/)
- GitHub: <https://github.com/paniolo-ai>
