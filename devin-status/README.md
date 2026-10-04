# Devin Status Footer — herdr plugin

A 5-row borderless footer pinned under every Devin CLI pane, showing:

```
 devin swe-2-high C20% 500% D00% W00% M00% main ~/gh/meta/paniolo
 <task title> - dirty <repo> <N>m <N>u
 <state> - <session> - scrolled +N - idle <dur>
 <tokens> in - <tokens> out - <cached> cached - +<rate>/min
 quota daily <%> (<reset>) - weekly <%> (<reset>) - spent $<amt> (<cycle> left)
```

- Line 1 is the statusline (`model`, context %, 5h/daily/weekly/monthly quota,
  branch, cwd) pushed via `pane report-metadata` — also the pane's label.
- Footers are plugin-owned panes labeled `devin-status:<pane>`; they open
  reactively on `pane.agent_detected` and close when their devin pane exits.

## Install

```bash
herdr plugin install paniolo-ai/paniolo-herdr-plugins/devin-status
# or link a local checkout:
herdr plugin link /path/to/paniolo-herdr-plugins/devin-status
```

## Requirements

- herdr ≥ 0.9.0
- Node.js on PATH
- Devin CLI credentials (`credentials.toml` in the devin config dir)
- Optional config for the borderless look:
  `ui.pane_borders = "off"`, `ui.pane_gaps = false`

## How it works

`startup.mjs` runs one reconcile and spawns `daemon.mjs` detached — a 15s loop
that refreshes quotas (`GetUserStatus` RPC, 5-min cache), reads devin
transcripts for model/context/tokens, reports pane metadata, and provisions,
orphan-cleans, and height-clamps footer panes. `event.mjs` runs the same
reconcile on `pane.agent_detected`/`pane.exited`/`pane.closed` so footers
react instantly. `footer.mjs` is the per-pane render loop — it finds its
target devin pane from its own `devin-status:<pane>` label.

## Manual

```bash
herdr plugin action invoke paniolo.devin-status.reconcile
```
