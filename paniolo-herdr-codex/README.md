# Paniolo Herdr Codex

A five-row Herdr footer under each Codex pane, matching the other status plugins:

```text
 codex gpt-6.1-sol low C32% 5h3% W45% work/ask main ~/repo
 <terminal title> - dirty <repo> 2m 1u
 working - <session> - <sandbox/approval> - <tool> - ctx 85k/258k - 788k in - 3k out
 limits 5h 3% resets 17:00 - W 45% resets Fri 12:00 - usage 12m old (/status)
 Paniolo: stale pend 2 ins 1 - wiki err 1 warn 3 - qmd docs 12k
```

## Setup

### Requirements

- Herdr 0.9.0 or newer, with its Codex integration installed.
- Node.js 18 or newer on the Herdr server's PATH.
- Codex running inside a Herdr pane, with local session records enabled.
- Optional: the `paniolo` CLI on PATH for the Paniolo stats row.

No API key, extra authentication, or plugin configuration file is required.
The footer reads Codex's local session metadata and recorded usage limits.

### Install The Integration And Plugin

Run these commands on the machine hosting the Herdr panes. They work in PowerShell and bash:

```bash
herdr integration install codex
herdr plugin install paniolo-ai/herdr-plugins/paniolo-herdr-codex
```

For a local checkout, replace the plugin install command with:

```bash
herdr plugin link "/absolute/path/to/herdr-plugins/paniolo-herdr-codex"
```

Start a new Codex session inside Herdr after installing the integration.
The SessionStart hook reports the exact session ID to its pane.
Existing sessions may need to be resumed in a new Codex process for that hook to run.

### Start The Footer Immediately

Herdr runs plugin startup hooks when its server starts. Installing or linking the plugin
does not start its refresh daemon immediately. To activate it without restarting Herdr,
run `herdr plugin list` to find the plugin root, then run:

```bash
cd "/path/to/plugin/root"
node startup.mjs
```

Use the same directory for a local checkout: `herdr-plugins/paniolo-herdr-codex`.
Startup provisions existing Codex footers and starts the daemon that discovers new panes.
On future Herdr server starts, this happens automatically.

To repair existing footers without starting a daemon:

```bash
herdr plugin action invoke paniolo-herdr-codex.reconcile
```

### Verify Setup

```bash
herdr integration status
herdr plugin list
herdr agent list
```

Confirm that the Codex integration is installed, `paniolo-herdr-codex` is enabled,
and the Codex pane has an `agent_session.value`. A five-row footer should appear below it.
Model, context and token totals populate as Codex writes session records.

### Troubleshooting

- **No footer:** confirm Node.js is on the Herdr server's PATH and run `node startup.mjs`
  from the plugin root. Check `herdr plugin log --help` for log inspection options.
- **Unknown context (`C??%`) or no usage:** check `herdr agent list` for a session ID.
  Install the Codex integration and start or resume Codex in a new process if it is missing.
  The plugin never guesses a session from another pane with the same working directory.
- **Relocated Codex state:** set `CODEX_HOME` in the Herdr server's environment before
  launching the server. The plugin must see the same Codex home as the agent.
- **Blank limits row:** API-key sessions may not record quota windows. For ChatGPT sessions,
  run `/status` in Codex to inspect limits; the footer shows the last recorded reading.
- **Blank Paniolo row:** install the `paniolo` CLI on the server's PATH if you want these
  optional stats. Allow up to five minutes for the cached probes to refresh.

## Data Sources

- Model, effort, sandbox and approval policy come from session `turn_context` records.
- Context, cumulative input/output/cached tokens and quota windows come from `token_count`.
- Pending tools are matched by call ID and cleared on completion or turn abort.
- Titles and activity come from Herdr. Branch and dirty counts come from Git.
- The Paniolo lane runs the local `paniolo stale`, `wiki` and `qmd` commands.

Rollouts live under `$CODEX_HOME/sessions`, defaulting to `~/.codex/sessions`.
The reader checkpoints completed JSONL records and scans at most 8 MiB per tick.
Large sessions catch up across ticks. Token totals are cumulative values reported by Codex;
cached tokens are part of the input total. Context uses the last request's usage and the
reported window, so it updates when Codex records usage, including after compaction.

Quota data is the last reading Codex recorded, with age shown after ten minutes.
An expired window displays unknown usage and its previous reading. Run `/status` in Codex
to inspect current limits. The footer never reads credentials or calls a usage endpoint.
API-key sessions without recorded quota windows leave that row blank.

Only metadata is retained in checkpoints. Conversation text, tool arguments and tool outputs
are not rendered or saved. Dirty repositories come from explicit session cwd metadata.
All commands run locally on the machine hosting the pane.

## Validation

```bash
node --test lib/codex.test.mjs
```

Tests cover session isolation, partial records, UTF-8 byte offsets, transcript truncation,
token totals, expired limits, tool completion, and footer ownership.
