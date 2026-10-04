# paniolo-herdr-plugins

Paniolo's Herdr plugins, one subdirectory per plugin.

| Plugin | Install | Description |
|---|---|---|
| [devin-status](devin-status/) | `herdr plugin install paniolo-ai/paniolo-herdr-plugins/devin-status` | Per-thread status footer for Devin CLI panes (model, context, quotas, spend, tokens, dirty repos) |
| [obsidian](obsidian/) | `herdr plugin install paniolo-ai/paniolo-herdr-plugins/obsidian` | Ctrl+click `obsidian://` links to open them in Obsidian directly |

Each subdirectory carries its own `herdr-plugin.toml`; the Herdr marketplace
indexes all manifests in the repo. See each plugin's README for requirements
and usage.
