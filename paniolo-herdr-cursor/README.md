# Paniolo Herdr Cursor

A 5-row borderless footer pinned under every Cursor Agent CLI pane, showing:

```
 cursor Auto C34% I47% A02% P00% Thinking max stale-ledger/2026-10-04-release ~/gh/meta/paniolo
 <session title> - dirty <repo> <N>m <N>u - <repo2> ...
 <state> - <session> - <mode> - <N> agents - <tool>… - scrolled +N - <idle> - ctx <tok>/<tok> - <N> tools - <tok> in - <tok> out - +<rate>/min
 quota Pro - included 47% resets <when> (<left>) - auto 2% - api 0% - on-demand off
 Paniolo: stale pend <N> ins <N> dis <N> res <N> prop <N> - wiki err <N> warn <N> - qmd docs <N>
```

- Line 1 is the statusline (`model`, context %, monthly Included/Auto/API
  buckets, thinking/max flags, approval mode when not unrestricted, branch,
  cwd) pushed via `pane report-metadata` — also the pane's label.
- Line 2 is the session title (statusLine `session_name`, else the terminal
  title) plus dirty repos touched this session.
- Line 3 merges agent state, approval mode, running subagents, in-flight
  tools, scroll/idle, context in use, tool/edit counts, and session token
  totals from the statusLine bridge, plus a token burn rate between ticks.
- Line 4 is the quota lane — Cursor's monthly plan usage (Included / Auto /
  API / On-Demand) from `GetCurrentPeriodUsage`, with the billing-cycle
  reset as a local wall-clock stamp.
- Line 5 is the Paniolo lane: `paniolo stale list` state counts (every
  non-zero state, fixed order), `paniolo wiki` error/warn totals, and
  `paniolo qmd status` document count for the target pane's repo — cached
  5 min per repo, blank where no stats exist.
- Footers are plugin-owned panes labeled `cursor-status:<pane>`; they open
  reactively on `pane.agent_detected`, close when their Cursor pane exits,
  and resurrect their render loop after herdr server restarts.

This is the Cursor counterpart to
[`paniolo-herdr-claude`](../paniolo-herdr-claude/) and [`paniolo-herdr-devin`](../paniolo-herdr-devin/) —
each only touches panes running its own agent.

## Install

```bash
herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-cursor
# or link a local checkout:
herdr plugin link /path/to/herdr-plugins/paniolo-herdr-cursor
```

## Requirements

- herdr ≥ 0.9.0
- Node.js on PATH
- Cursor Agent CLI (any recent version; read-only use of its local state)
- A `statusLine` entry in `~/.cursor/cli-config.json` pointing at this
  plugin's `statusline.mjs` (see below) — without it, model/context/token
  numbers stay blank (`C??%`, `statusline off`) because Cursor does not
  persist them to disk
- Optional config for the borderless look:
  `ui.pane_borders = "off"`, `ui.pane_gaps = false`

### After installing

Herdr runs `[[startup]]` hooks when its **server** starts, not when a plugin is
installed or linked. So a fresh install does nothing visible until one of:

```bash
# restart herdr, or kick it once without restarting:
herdr plugin action invoke paniolo-herdr-cursor.reconcile   # footers now

# footers + the refresh daemon, from the plugin root
# (herdr plugin list prints it as [local:<path>])
cd "<plugin root>" && node startup.mjs
```

### Wire the statusLine bridge

Cursor only exposes live model/context/token numbers to a `statusLine`
command (stdin JSON). This plugin's `statusline.mjs` caches that payload for
the footer and prints a compact line for Cursor's own status area.

Add (or merge) this into `~/.cursor/cli-config.json`, using the absolute path
`herdr plugin list` shows for the install:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/path/to/herdr-plugins/paniolo-herdr-cursor/statusline.mjs\"",
    "padding": 2
  }
}
```

Restart the Cursor Agent CLI session after editing. The bridge writes to
`$TMP/cursor-status/<session-id>.json` (shared with the herdr-spawned footer).

## How it works

`startup.mjs` runs one reconcile and spawns `daemon.mjs` detached — a 15s loop
that reads each Cursor pane's transcript + statusLine cache, reports pane
metadata, and provisions, orphan-cleans, and height-clamps footer panes.
`event.mjs` runs the same reconcile on
`pane.agent_detected`/`pane.exited`/`pane.closed` so footers react instantly.
`footer.mjs` is the per-pane render loop — it finds its target Cursor pane from
its own `cursor-status:<pane>` label.

| Signal | Source |
| --- | --- |
| model, context %, tokens, autorun, vim, worktree | statusLine bridge cache (`statusline.mjs`) |
| Included / Auto / API / On-Demand quotas | `GetCurrentPeriodUsage` (+ `GetHardLimit` / `GetPlanInfo`), using the OAuth token in Cursor's `auth.json`, cached 5 min |
| approval mode, maxMode fallback | `~/.cursor/cli-config.json` |
| in-flight tools, edit paths, tool counts | `~/.cursor/projects/<slug>/agent-transcripts/<session>/<session>.jsonl` |
| branch, dirty counts | `git` in the target repo |
| Paniolo lane | `paniolo` CLI in the target repo |

### Quotas (not 5h / daily / weekly)

Cursor does **not** expose Claude-style 5-hour/weekly or Devin-style
daily/weekly/monthly rate-limit windows. Its dashboard model is a **monthly
billing cycle** with three included buckets plus optional on-demand spend:

| Compact | Lane | Meaning |
| --- | --- | --- |
| `I47%` | included | share of included plan usage spent this cycle |
| `A02%` | auto | Auto/Composer bucket |
| `P00%` | api | named/API model bucket |
| — | on-demand | hard spend limit, or `off` when usage-based is disabled |

The compact `I`/`A`/`P` segment rides on line 1; line 4 spells them out with
the cycle reset. Set `CURSOR_STATUS_NO_FETCH=1` on the herdr server to skip
the network call (quota lane stays blank).

### Reading only metadata

The citation transcript holds the full conversation. The footer parses only
tool names and edited file paths — never prompt or response text. Token and
context numbers come from the statusLine payload Cursor already builds for
its own UI, not from re-parsing prose.

### Why a statusLine bridge

Unlike Claude Code, Cursor's on-disk transcript is a citation log without
token usage or model fields. Those live only in the running CLI process, and
the supported export path is the statusLine stdin payload. The bridge is
read-only caching of that payload — no network, no credentials.

## Manual

```bash
herdr plugin action invoke paniolo-herdr-cursor.reconcile
```

Test the bridge alone:

```bash
echo '{"session_id":"test","model":{"display_name":"Auto"},"context_window":{"used_percentage":25,"context_window_size":200000}}' \
  | node statusline.mjs
```

---

Part of the [Paniolo](https://paniolo.ai) ecosystem — the intelligence layer
for coding agents. The Paniolo footer lane reads live stats from the
`paniolo` CLI (`stale`, `wiki`, `qmd`) — try it with `npx @paniolo/cli scan .`
