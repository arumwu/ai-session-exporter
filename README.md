# AI Session Exporter

[繁體中文](README.zh-TW.md)

Link existing local Claude and Codex conversations, export only selected human/assistant text, and continue the original session through its native provider. The library, CLI and localhost web interface work independently of Project Hub.

## Requirements

Node.js **22.13 or newer**. No npm dependencies are required. Continuing a conversation also requires the matching installed Claude or Codex CLI, its existing login, the original history and working directory. Listing and exporting do not start a provider or model turn.

```sh
git clone https://github.com/arumwu/ai-session-exporter.git
cd ai-session-exporter
node bin/session-exporter.js --help
```

## List and export selected conversations

```sh
node bin/session-exporter.js list --provider codex
node bin/session-exporter.js export --provider codex --id SESSION_ID_FROM_LIST
node bin/session-exporter.js export --provider codex --id SESSION_ID_FROM_LIST --id ANOTHER_ID --format markdown --output selected.md
```

Use IDs returned by `list`, not a filename or guessed native UUID. Export requires at least one explicit `--id`; there is no implicit all-session export. JSON is the default and goes to stdout. `--format markdown` creates readable UTF-8 text. An explicit `--output` creates a new file without overwriting an existing file, and must be outside source history directories.

The JSON contains a format version, export time, provider, selected ID, title, original working directory and user/assistant text rows. Reading warnings are included. It excludes system/developer messages, hidden reasoning, tool calls/results, attachments, credentials and permission settings. Selected exports remain private unless you separately share the output.

## Local web interface

```sh
node bin/session-exporter.js serve --data-dir /path/to/private/session-links
```

Open `http://127.0.0.1:4747`. Select only the conversations you need; all start unselected. Preview the counts and reading warnings, then confirm saving links. Export downloads only the current explicit selection as JSON or Markdown.

A saved link points to the existing source. Conversation history and working folders remain in their original locations. The private metadata directory contains `_hub/session-links.json` and delivery receipts, without copied conversation bodies. Removing a link removes only this metadata. Missing sources remain listed as broken links.

To continue, open a saved link and explicitly send a message. Claude resumes the same native session ID; Codex reads and resumes the same thread before starting a turn. The provider records the new turn at its original source using its existing login and permission rules. Approvals are shown for an explicit decision, and stop interrupts only the provider process started for that turn. No new/forked session is used as a fallback when a source is missing, changed or busy.

The original App and this interface use the same session history. Reopen the original conversation to read it there; simultaneous live screen refresh is not guaranteed. A delivery is marked completed only after the provider confirms the intended session and an update to the original history is verified. If a delivery outcome is unknown after a failure or restart, check the original conversation before sending it again.

## Source and storage options

| Option | Purpose |
| --- | --- |
| `--codex-home DIR` | Codex history root; otherwise `CODEX_HOME` or `~/.codex`. |
| `--codex-sqlite-home DIR` | Separate metadata root; otherwise `CODEX_SQLITE_HOME` or the Codex history root. |
| `--claude-desktop-dir DIR` | Claude Desktop metadata root; otherwise `HUB_CLAUDE_DESKTOP_DIR` or the platform's local Claude Desktop directory. |
| `--claude-projects-dir DIR` | Local Claude Code transcripts matched to Desktop sessions; otherwise `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. |
| `--data-dir DIR` | Private link/receipt directory; otherwise `AI_SESSION_EXPORTER_HOME` or `~/.config/ai-session-exporter`. |
| `--port PORT` | Local server port; default `4747`. |
| `--host 127.0.0.1\|::1` | Loopback listener; default `127.0.0.1`. |

Pass source options on the CLI or through environment variables. HTTP requests cannot supply a source path. The existing `HUB_STORAGE_GUARD` command, when configured, must return `STATUS=OK` before private metadata is created or saved and before a turn is sent. Choose an available private data disk when your local storage rules require one; there is no automatic fallback to another disk.

Claude discovery matches Desktop groups to locally available CLI transcripts. Codex discovery combines read-only SQLite metadata, its session index and bounded history headers, labels Desktop/CLI/IDE/unknown from available evidence, and retains archive/subagent information. Metadata may be incomplete: pending SQLite journal data is skipped to avoid changing source sidecars, then index/headers are used with a warning. Configuration/auth files are not migrated. New provider versions or missing local records can prevent a session from being listed or resumed.

Selected history is streamed with limits: 200 selected conversations, 128 MiB per file, 256 MiB total input, 8 MiB retained text, and 10,000 retained text rows. Invalid or changing records stop the export rather than producing a silently truncated conversation.

## Local API and library

```js
const { sourcesFor, listSessions, exportSessions, formatExport } = require('./lib');
const sources = sourcesFor({ codexHome: '/path/to/codex' });
const inventory = await listSessions(sources, 'codex');
const selected = inventory.providers[0].sessions[0];
const output = await exportSessions(sources, [{ provider: 'codex', id: selected.id }]);
console.log(formatExport(output, 'json'));
```

Read endpoints are `GET /api/session-links`, `/history?id=...`, and `/status?id=...`. JSON POST endpoints are `/preview`, `/apply`, `/remove`, `/export`, `/send`, `/answer`, and `/stop` under `/api/session-links/`. Writes require `X-Hub: 1`, same-origin requests and a valid local Host header. Export accepts `{ "selected": ["inventory-opaque-id"], "format": "json" }`; the selected IDs come from the local web inventory, which differs from stable CLI IDs. There is no CORS or remote listener. Static files are allowlisted.

## Verification and license

```sh
npm test
```

Tests use fictional isolated sources and mocked provider protocols. They check selected-only reads, source preservation, stale records, local API protections, same-session identity, approvals and delivery deduplication. A passing fixture does not establish live refresh behavior in every version of the original Apps.

A controlled live test on 2026-10-07 used the official bundled Codex **0.160.1** and Claude **2.1.289** CLIs. Both resumed the same native session ID, saved the next reply in the original file and preserved its existing prefix. The test used newly created, isolated conversations, without importing existing user conversations or copying credentials. Immediate refresh of the original App screen remains unverified.

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the origin of the shared source adapters.
