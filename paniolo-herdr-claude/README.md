# Paniolo Herdr Claude

A 5-row borderless footer pinned under every Claude Code pane, showing:

```
 claude opus-5 high C40% 5h45% W54% plan main ~/gh/meta/paniolo
 <ai title> - dirty <repo> <N>m <N>u - <repo2> ...
 <state> - <session> - <mode> - <N> agents - <tool>… - scrolled +N - <idle> - ctx <tok>/<tok> - <tok> in - <tok> out - <tok> cached - +<rate>/min
 limits 5h <%> resets <when> (<left>) - W <%> resets <when> (<left>) - credits <%> of $<limit> - usage <age> old (/usage)
 Paniolo: stale pending <N> insuff <N> - wiki err <N> warn <N> - qmd docs <N>
```

- Line 1 is the statusline (`model`, thinking effort, context %, 5h/weekly
  rate-limit windows, permission mode, branch, cwd) pushed via `pane
  report-metadata` — also the pane's label.
- Line 2 is Claude Code's own AI-generated session title plus dirty repos.
- Line 3 merges agent state, permission mode, running subagents, in-flight
  tool calls, scroll/idle, context in use, and session token totals, plus a
  token burn rate between ticks.
- Line 4 is the rate-limit lane — a live `GET /api/oauth/usage` reading (or
  Claude Code's cache as fallback), with each window's reset as a local
  wall-clock time and date.
- Line 5 is the Paniolo lane: `paniolo stale list` state counts, `paniolo
  wiki` error/warn totals, and `paniolo qmd status` document count for the
  target pane's repo — cached 5 min per repo, blank where no stats exist.
- Footers are plugin-owned panes labeled `claude-status:<pane>`; they open
  reactively on `pane.agent_detected`, close when their Claude pane exits,
  and resurrect their render loop after herdr server restarts.

This is the Claude Code counterpart to
[`paniolo-herdr-devin`](../paniolo-herdr-devin/), and the two run side by side — each only
touches panes running its own agent.

## Install

```bash
herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-claude
# or link a local checkout:
herdr plugin link /path/to/herdr-plugins/paniolo-herdr-claude
```

## Requirements

- herdr ≥ 0.9.0
- Node.js **18 or newer** on PATH (the live usage refresh uses global `fetch`;
  on older Node the plugin skips the refresh and runs on Claude Code's cache)
- Claude Code (any recent version; read-only use of its local state)
- Optional config for the borderless look:
  `ui.pane_borders = "off"`, `ui.pane_gaps = false`

### After installing

Herdr runs `[[startup]]` hooks when its **server** starts, not when a plugin is
installed or linked. So a fresh install does nothing visible until one of:

```bash
# restart herdr, or kick it once without restarting:
herdr plugin action invoke paniolo-herdr-claude.reconcile   # footers now

# footers + the refresh daemon, from the plugin root
# (herdr plugin list prints it as [local:<path>])
cd "<plugin root>" && node startup.mjs
```

The action runs a single reconcile: footers appear and then keep refreshing
themselves, but pane labels and footers for *newly opened* Claude panes need
the daemon, which `startup.mjs` spawns (and which herdr starts on its own from
the next server start onward).

There is no config file to write and nothing to authenticate — the plugin
reads the credential store Claude Code already populated. On macOS that store
is the Keychain, which needs one environment variable; see below.

### Platform notes

Windows, macOS and Linux all run the footer. The one platform difference is
where the OAuth token lives:

| Platform | Token source | Live refresh |
| --- | --- | --- |
| Windows, Linux | `~/.claude/.credentials.json` | works out of the box |
| macOS | login Keychain | needs `CLAUDE_STATUS_KEYCHAIN_SERVICE` |

macOS stores credentials in the Keychain rather than a file. The item's service
name is not discoverable from outside Claude Code, so point the plugin at it:

```bash
export CLAUDE_STATUS_KEYCHAIN_SERVICE="<service name>"
export CLAUDE_STATUS_KEYCHAIN_ACCOUNT="<account>"   # optional, defaults to $USER
```

`security dump-keychain | grep -i -B2 -A2 claude` will show the candidates (it
prompts for Keychain access, and prints a lot). Left unset, macOS falls back to
Claude Code's cached reading — everything else works the same, the 5h and
weekly numbers are just as old as that cache.

A relocated Claude Code config dir is honored too: `CLAUDE_CONFIG_DIR` moves
where the plugin looks for `projects/`, `.claude.json` and `.credentials.json`,
the same way Claude Code treats it. Both `.claude.json` locations are checked,
and whichever actually carries the usage cache wins — a stub in one of them is
skipped rather than preferred for being first.

**Where to set it.** Every variable here is read by a plugin process that herdr
spawns, so it has to be in the environment of the **herdr server**, not of
whatever shell you happen to be typing in. Put it in your shell profile and
restart herdr, or launch herdr with it set. That applies to
`CLAUDE_STATUS_NO_FETCH` and `CLAUDE_CONFIG_DIR` as much as to the Keychain
pair.

**Tested where.** Built and verified on Windows against live panes. The Linux
path is the same credentials-file read and should behave identically. The macOS
Keychain branch is written but has not been run on a Mac — worth a check before
you rely on it; if the service name turns out to be stable, it belongs in the
code as a default rather than an env var.

## How it works

`startup.mjs` runs one reconcile and spawns `daemon.mjs` detached — a 15s loop
that reads each Claude pane's transcript for model/context/mode, reports pane
metadata, and provisions, orphan-cleans, and height-clamps footer panes.
`event.mjs` runs the same reconcile on
`pane.agent_detected`/`pane.exited`/`pane.closed` so footers react instantly.
`footer.mjs` is the per-pane render loop — it finds its target Claude pane from
its own `claude-status:<pane>` label.

Almost everything comes from local files; the one network call is the usage
refresh described below.

| Signal | Source |
| --- | --- |
| model, effort, context, mode, title, subagents, tokens | `~/.claude/projects/<slug>/<session>.jsonl` |
| rate-limit windows, credit spend | `GET /api/oauth/usage`, falling back to `~/.claude.json` → `cachedUsageUtilization` |
| branch, dirty counts | `git` in the target repo |
| Paniolo lane | `paniolo` CLI in the target repo |

### Live usage refresh

Claude Code's cached reading can be hours old, which leaves a rolled window
with no number at all. The plugin asks the same endpoint Claude Code asks —
`GET https://api.anthropic.com/api/oauth/usage` — for a current one, using the
OAuth access token from Claude Code's own credential store
(`~/.claude/.credentials.json`, or the Keychain on macOS — see
[Platform notes](#platform-notes)), cached 5 minutes.

This is your own quota, read with your own token, for your own status display.
The token is read and never written, and the token-refresh endpoint is never
called: rotating it is Claude Code's job, and touching it here could invalidate
a live session. An expired token means the plugin falls back to Claude Code's
cache rather than trying to renew anything.

Set `CLAUDE_STATUS_NO_FETCH=1` to turn the refresh off and run on Claude
Code's cache alone. The lane shows whichever reading is newer, and labels a
stale one either way.

### Reading only metadata

The transcript holds the full conversation. The footer parses only token usage,
model, record types, tool names, and edited file paths — never prompt or
response text. The one piece of prose it shows is the session title Claude Code
already writes to the terminal title.

### Context percentage

The usable context window is account-dependent, so it is resolved from
evidence rather than a fixed table: Claude Code's own
`autoCompactWindowsCache` first, then a per-model high-water mark of context
actually observed (persisted in the plugin state dir), then a family default.
A 1M-context entitlement is detected this way instead of being assumed.

### Stale quota readings

`cachedUsageUtilization` is a cache Claude Code refreshes on its own schedule,
so it can lag by hours. The footer never dresses a stale number up as a live
one:

- a window still in force renders its reset as a wall-clock stamp plus time
  remaining: `W 54% resets Fri 04:00 (4d13h)`. The stamp carries only as much
  date as it needs — `15:49` today, `Fri 03:59` within the week, `Oct 24 09:59`
  beyond it — in local time;
- a window whose `resets_at` has passed renders as `5h rolled 12:49 (1h52m
  ago), was 72%, next ~17:49`. The cache does not say what has been spent since
  the rollover, so repeating `72%` would be wrong and `0%` would be a guess —
  but when it rolled, and what the previous window ended at, are solid. The
  `next` stamp is the cached reset advanced by whole periods, so it is an
  extrapolation and carries a `~`;
- once a reading is over 10 minutes old, its age is shown — with a `(/usage)`
  hint when it came from Claude Code's cache rather than the plugin's own
  refresh.

The lane is written to fit the pane: it gives up the extras (time remaining,
credits, reading age) before it gives up the reset stamps, so a narrow footer
still shows when each window turns over.

The compact statusline on line 1 shortens a rolled window to `5h?` to stay
within a pane label.

Running `/usage` in any Claude Code session refreshes the cache for every
footer at once.

### Large transcripts

Transcripts are append-only and reach tens of megabytes. Session totals come
from an incremental walk: the file is read once, then only its new tail on each
tick, with byte-offset checkpoints per session in the plugin state dir that
survive a footer restart. Current state (model, context, mode, in-flight tools)
is read from a 512 KB tail, so it costs the same on a 400 KB file and a 50 MB
one.

## Manual

```bash
herdr plugin action invoke paniolo-herdr-claude.reconcile
```

---

Part of the [Paniolo](https://paniolo.ai) ecosystem — the intelligence layer
for coding agents. The Paniolo footer lane reads live stats from the
`paniolo` CLI (`stale`, `wiki`, `qmd`) — try it with `npx @paniolo/cli scan .`
