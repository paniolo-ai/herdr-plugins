# Obsidian Links — herdr plugin

Ctrl+click an `obsidian://` link in any terminal output and it opens directly
in Obsidian — no browser round-trip, no OS "unsafe location" trust prompt.

Works by routing the click to a plugin action via herdr's `[[link_handlers]]`,
then launching the Obsidian binary with the URI as argv — the same invocation
the registered protocol handler performs, minus the shell interstitial.

## Status

**Pending an upstream herdr fix.** On current releases (tested 0.9.3),
herdr routes Control-clicks on OSC 8 hyperlinks to `link_handlers` only
for `http(s)` (and `file://` after #2942). Clicks on custom schemes like
`obsidian://` fall through to the system URL opener — which is exactly
the trust-prompt path this plugin exists to bypass. Tracked upstream in
[herdrdev/herdr#4874](https://github.com/herdrdev/herdr/issues/4874).

The action itself is verified: given a clicked URL it launches Obsidian
correctly. Once the routing fix lands, the plugin works with no changes.

## Install

```bash
herdr plugin install paniolo-ai/herdr-plugins/obsidian
```

Or link a local checkout for development:

```bash
herdr plugin link /path/to/herdr-plugins/obsidian
```

## Requirements

- herdr ≥ 0.9.0
- Obsidian desktop installed and registered for the `obsidian://` scheme
- Node.js on PATH (the action is a ~30-line `open.mjs`)

## How it works

| Platform | Launch path |
| --- | --- |
| Windows | `Obsidian.exe <uri>` (from `%LOCALAPPDATA%\Programs\Obsidian`, `%PROGRAMFILES%` fallback, then PowerShell `Start-Process`) |
| macOS | `open -b md.obsidian <uri>` |
| Linux | `xdg-open <uri>` |

The clicked URL arrives via `HERDR_PLUGIN_CLICKED_URL` /
`HERDR_PLUGIN_CONTEXT_JSON.clicked_url` (herdr link-handler contract).
