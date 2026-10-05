# Paniolo Herdr Devin

A 5-row borderless footer pinned under every Devin CLI pane, showing:

```
 devin swe-2-high C20% 500% D00% W00% M00% main ~/gh/meta/paniolo
 <task title> - dirty <repo> <N>m <N>u - <repo2> ...
 <state> - <session> - scrolled +N - idle <dur> - <tok> in - <tok> out - <tok> cached - +<rate>/min
 quota daily <%> (<reset>) - weekly <%> (<reset>) - spent $<amt> (<cycle> left)
 Paniolo: stale pending <N> insuff <N> - wiki err <N> warn <N> - qmd docs <N>
```

- Line 1 is the statusline (`model`, context %, 5h/daily/weekly/monthly quota,
  branch, cwd) pushed via `pane report-metadata` — also the pane's label.
- Line 3 merges agent state, scroll/idle, and session token totals from the
  devin transcript (`final_metrics`), plus a token burn rate between ticks.
- Line 5 is the Paniolo lane: `paniolo stale list` state counts, `paniolo
  wiki` error/warn totals, and `paniolo qmd status` document count for the
  target pane's repo — cached 5 min per repo, blank where no stats exist.
- Footers are plugin-owned panes labeled `devin-status:<pane>`; they open
  reactively on `pane.agent_detected`, close when their devin pane exits,
  and resurrect their render loop after herdr server restarts.

## Install

```bash
herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-devin
# or link a local checkout:
herdr plugin link /path/to/herdr-plugins/paniolo-herdr-devin
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
herdr plugin action invoke paniolo-herdr-devin.reconcile
```

---

Part of the [Paniolo](https://paniolo.ai) ecosystem — the intelligence layer
for coding agents. The Paniolo footer lane reads live stats from the
`paniolo` CLI (`stale`, `wiki`, `qmd`) — try it with `npx @paniolo/cli scan .`
