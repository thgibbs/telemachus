# Telemachus CLI reference

`agent-ui` is a task-scoped command for updating the Telemachus screen from
Claude, Codex, shell scripts, and other command-line programs. Run it inside a
terminal created by Telemachus.

## Fast path for agents

```bash
agent-ui doctor --output text
agent-ui context --compact
agent-ui task status working --message "Inspecting the project"
agent-ui plan upsert inspect "Inspect project" --status in_progress
agent-ui plan update inspect --status completed
agent-ui artifact add report "Verification report" /absolute/path/report.md \
  --type local_document --status generated
agent-ui summary set --headline "Inspection complete" --body "No blockers."
```

Commands emit JSON by default. Successful writes include the operation,
task ID, resulting revision, and update timestamp. Reads return the requested
presentation data.

## Global options

Global options may appear anywhere in a command:

| Option | Meaning |
| --- | --- |
| `--output json` | Pretty JSON, the default |
| `--output text` | Concise human-readable output |
| `--output quiet` | No success output |
| `--output document` | Return the complete resulting document for writes |
| `--compact` | Emit single-line JSON |
| `--source NAME` | Attribute the operation to a named agent or script |
| `--expected-revision N` | Reject the write if the screen changed |
| `--idempotency-key KEY` | Safely retry the same operation |

`AGENT_UI_OUTPUT` and `AGENT_UI_SOURCE` provide defaults for output and source.

## Connection and context

```bash
agent-ui doctor
agent-ui context
agent-ui task get
```

`doctor` checks the bridge, authentication, task scope, and protocol, then
returns the current revision and latency.

## Task header

```bash
agent-ui task set --title TITLE \
  [--description TEXT | --description-file PATH] \
  [--issue-url https://github.com/OWNER/REPOSITORY/issues/NUMBER] \
  [--status STATUS] [--message TEXT]

agent-ui task status STATUS [--message TEXT]
```

Task statuses are `idle`, `working`, `waiting`, `blocked`, `completed`,
`failed`, and `cancelled`.

`--issue-url` adds the task's GitHub issue beside the title. Pass an empty value
to clear it. The URL must be an HTTPS `github.com/OWNER/REPOSITORY/issues/NUMBER`
link.

## Plan

```bash
agent-ui plan list
agent-ui plan add ID TITLE [--detail TEXT] [--status STATUS] [--order N]
agent-ui plan upsert ID TITLE [--detail TEXT] [--status STATUS] [--order N]
agent-ui plan update ID [--title TITLE] [--detail TEXT] [--status STATUS]
agent-ui plan remove ID
agent-ui plan clear
agent-ui plan replace JSON_ARRAY
agent-ui plan replace --file plan.json
agent-ui plan replace --stdin
```

Plan statuses are `pending`, `in_progress`, `completed`, `blocked`, and
`skipped`. `add` and `upsert` create or replace by stable ID. `update` requires
the ID to exist. Read-modify-write commands automatically use the revision read
from the screen and return exit code 2 if another writer wins the race.

Plan JSON is an array:

```json
[
  {
    "id": "verify",
    "title": "Run verification",
    "detail": "Build and execute the bridge tests.",
    "status": "in_progress",
    "order": 0
  }
]
```

## Summary

```bash
agent-ui summary get
agent-ui summary set --headline TEXT --body TEXT
agent-ui summary set --headline TEXT --body-file summary.md
agent-ui summary set --headline TEXT --stdin
agent-ui summary set --headline TEXT \
  --section "Result=Build passed." \
  --section "Next=Review the artifact."
agent-ui summary clear
```

Summary bodies support the editor's sanitized Markdown rendering.

## Alerts

```bash
agent-ui alert list
agent-ui alert raise ID TITLE \
  [--severity info|warning|critical] [--message TEXT]
agent-ui alert upsert ID [--title TITLE] [--severity SEVERITY] [--message TEXT]
agent-ui alert clear ID
```

Clearing an alert retains its history with state `cleared`.

## Artifacts

Artifacts are the unified left-rail collection for deliverables and supporting
references:

```bash
agent-ui artifact list
agent-ui artifact add ID LABEL TARGET \
  --type local_document|web_document|github_pr|path|url|note \
  [--status STATUS] [--meta KEY=VALUE ...]
agent-ui artifact upsert ID LABEL TARGET --type TYPE [options]
agent-ui artifact update ID [--label LABEL] [--value TARGET] [--status STATUS] \
  [--meta KEY=VALUE ...]
agent-ui artifact remove ID
agent-ui artifact replace JSON_ARRAY
agent-ui artifact replace --file artifacts.json
agent-ui artifact replace --stdin
agent-ui artifact clear
```

- `local_document` targets must be absolute paths to existing files and open in
  Zed.
- `web_document` targets must be HTTP(S) URLs and open in the system browser.
- `github_pr` targets must be HTTPS `github.com/OWNER/REPO/pull/NUMBER` URLs and
  open in the system browser.
- `path`, `url`, and `note` represent supporting references in the same
  collection.

Artifact statuses are `reported`, `inspected`, `modified`, `generated`, and
`unavailable`.

The task issue is displayed beside the title and is omitted from Artifacts when
the same canonical GitHub issue URL is present in both places. The desktop app
checks PR state through the authenticated GitHub CLI when a task becomes active
and every five minutes. Closed and merged PRs are removed. An agent that already
knows the result can remove it immediately:

```bash
agent-ui artifact update release-pr --meta github_state=closed
```

`github_state=merged` behaves the same way. This does not require MCP.

Plan documents sort to the top of Artifacts, followed by open PRs. Mark a plan
explicitly with `--meta role=plan`; existing document artifacts with “plan” in
their label or path are also recognized. Items within each group retain their
reported order.

Artifact JSON is an array:

```json
[
  {
    "id": "report",
    "type": "path",
    "label": "Verification report",
    "path_or_url": "/absolute/path/report.md",
    "status": "generated",
    "metadata": {
      "owner": "codex"
    }
  }
]
```

`agent-ui resource ...` remains as a backward-compatible alias for the same
unified collection. It does not address a separate panel.

## Questions

```bash
agent-ui question list [--state open]
agent-ui question get ID
agent-ui question ask ID TEXT \
  [--choice VALUE ...] [--timeout SECONDS] [--no-free-text]
agent-ui question ask ID TEXT --non-blocking
```

A blocking question waits for an answer for 300 seconds by default. It returns
exit code 3 if the wait times out or is cancelled. `--non-blocking` creates the
question and returns immediately; poll it with `question get`.

## Whole-screen publication

```bash
agent-ui publish DOCUMENT_JSON
agent-ui publish --file presentation.json
agent-ui publish --stdin
```

Accepted top-level fields are `task` (or `header`), `plan` (or `tasks`),
`summary`, `alerts`, and `artifacts` (`resources` remains accepted as an alias).
Omitted fields remain unchanged. An included empty array clears that
collection. Existing active alerts omitted from an included `alerts` array are
cleared.

## Low-level typed operation

```bash
agent-ui apply OPERATION PAYLOAD_JSON
agent-ui apply OPERATION --file payload.json
agent-ui apply OPERATION --stdin
```

Supported operation names are `set_task`, `set_task_status`, `replace_tasks`,
`upsert_task`, `ask_user`, `set_summary`, `raise_alert`, `clear_alert`, and
`replace_resources`. The host validates the same strict payload schemas used by
the UI.

Compatibility aliases from the prototype remain available: `set-task`,
`status`, `tasks`, `resources`, `ask`, and `op`.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | Rejected input or missing presentation item |
| 2 | Retryable revision conflict |
| 3 | Question timed out or was cancelled |
| 4 | Bridge unavailable, missing context, or authentication failure |
| 64 | Invalid command usage |

Errors are machine-readable JSON on stderr unless text or quiet output is
selected:

```json
{
  "ok": false,
  "error": {
    "code": "revision_conflict",
    "message": "expected 4, current 5",
    "retryable": true
  }
}
```

On exit code 2, read the current state, reconcile the intended change, and
retry. Reusing an explicit idempotency key is safe only when the operation and
payload are identical.
