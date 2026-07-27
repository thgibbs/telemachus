# Telemachus

A local, task-focused terminal workspace for Codex, Claude, shell scripts, and
ordinary command-line work. Each task keeps a real interactive terminal beside
durable plan, artifact, question, summary, and alert panels, plus a private
human scratchpad. Alerts appear only while active at the top of the left
sidebar. The agent summary appears beneath Questions as a Status accordion,
automatically expands when updated, and can be collapsed to its headline.

## Prerequisites

- Node.js 20+
- Rust 1.88+
- macOS developer tools
- [Codex CLI](https://developers.openai.com/codex/cli), installed and
  authenticated

Telemachus uses `codex exec` for artifact reviews. The Codex CLI is a required
system prerequisite and is not installed by this project's npm dependencies.

```bash
npm install --global @openai/codex
codex login
codex --version
codex login status
```

## Run it

```bash
npm install
npm run desktop
```

The first launch creates an untitled task. Every terminal opened by Telemachus has
the `agent-ui` command ready to use:

```bash
agent-ui doctor
agent-ui demo
agent-ui help
```

No MCP server, endpoint configuration, token copy, or working-directory
assumption is required. The application installs its bundled CLI into a private
application-data directory and prepends that directory to the child terminal's
`PATH`.

## Give Claude or Codex screen access

Launch the agent inside a Telemachus terminal and include a short instruction
such as:

> Keep this task's Telemachus screen current with the `agent-ui` command. Update
> task status, plan items, artifacts, summary, alerts, and questions
> as useful.
> Run `agent-ui help` for the command reference.

The agent can then update each panel directly:

```bash
agent-ui task set --title "Fix checkout" \
  --issue-url https://github.com/acme/store/issues/41 \
  --status working \
  --message "Reproducing the failure"

agent-ui plan add reproduce "Reproduce the failure" --status in_progress
agent-ui plan update reproduce --status completed

agent-ui summary set --headline "Root cause found" \
  --body "The stale cache key is shared across tenants."

agent-ui alert raise cache-risk "Cache invalidation required" \
  --severity warning --message "Invalidate after deploy."

agent-ui artifact add patch "Checkout patch" src/checkout.js \
  --type path --status modified

agent-ui artifact add report "Verification report" /absolute/path/report.md \
  --type local_document --status generated

agent-ui artifact add design "Design document" https://example.com/design \
  --type web_document

agent-ui artifact add pr "Checkout fix PR" \
  https://github.com/acme/store/pull/42 --type github_pr \
  --meta github_state=open

agent-ui question ask rollout "Which rollout should we use?" \
  --choice Canary --choice "All at once" --timeout 300
```

Use stable IDs such as `reproduce`, `cache-risk`, and `rollout`; subsequent
commands can update, clear, or remove those entries without screen scraping.
The issue link lives beside the task title and is suppressed from Artifacts if
it is reported twice. The desktop app also removes closed or merged PRs after
checking GitHub; an agent can make that immediate with
`agent-ui artifact update pr --meta github_state=closed`.

Every open PR artifact has a **Review** button, and the Artifacts heading has a
**Review** action for all open PRs. Local-document artifacts also have an
individual **Review** button. Reviews run non-interactively in the background
with `codex exec`, using `gpt-5.6-sol` at high reasoning in an isolated
temporary Git workspace; they do not create or replace a terminal tab. Codex
receives the linked GitHub issue and the selected artifacts. PR reviews are
submitted to their pull requests, while local-document findings are posted as
a comment on the linked issue. Each reviewed artifact records **Queued**,
**Running**, and **Posted** states; after posting it links directly to the
GitHub result and changes the action to **Re-review**. A run that exits without
a newly posted result is shown as failed and can be retried.
Give an agent [AGENT-UI-GUIDE.md](AGENT-UI-GUIDE.md) for workflow guidance, or
see [CLI.md](CLI.md) for the complete command and JSON reference.

## Publish the whole screen

For an initial render or atomic agent handoff, pass one JSON document:

```bash
agent-ui publish --stdin <<'JSON'
{
  "task": {
    "title": "Ship the editor",
    "issue_url": "https://github.com/acme/store/issues/41",
    "status": "working",
    "status_message": "Running verification"
  },
  "plan": [
    {
      "id": "build",
      "title": "Build release",
      "status": "completed"
    },
    {
      "id": "verify",
      "title": "Run checks",
      "status": "in_progress"
    }
  ],
  "summary": {
    "headline": "Implementation is ready",
    "sections": [
      {
        "id": "result",
        "heading": "Result",
        "body": "The command-line bridge is connected."
      }
    ]
  },
  "alerts": [],
  "artifacts": [
    {
      "id": "release",
      "type": "path",
      "label": "Release binary",
      "path_or_url": "src-tauri/target/release/agent-ui",
      "status": "generated"
    }
  ]
}
JSON
```

`publish` applies revision-checked typed operations in order. It intentionally
does not alter questions, because replacing a pending human decision could lose
an answer.

## Task-scoped environment

Telemachus injects these values into every child terminal:

- `AGENT_UI_CLI` — absolute path to the installed command
- `AGENT_UI_ENDPOINT` — random loopback bridge address
- `AGENT_UI_TASK_ID` — current task scope
- `AGENT_UI_TOKEN` — random token for this task and app session
- `AGENT_UI_PROTOCOL_VERSION` — presentation protocol version
- `AGENT_UI_SOURCE` — default operation source

The token is passed directly to child processes and is not written to shell
history or persisted by the application.

## Private scratchpad

Each task has a hideable scratchpad across the bottom of the workspace. Notes
auto-save locally and restore with the task. Scratchpad content is stored
separately from the presentation document and is never returned by the local
bridge, exposed through `agent-ui`, or injected into terminal processes.

## Task tabs and terminal isolation

The top-bar plus button creates and activates a task immediately. Use the
adjacent chevron when you want to choose its starting directory. The tab strip
scrolls as it fills and always reveals the active task.

Each task owns one live shell. Switching tasks leaves every terminal mounted,
and a frontend remount reattaches to the existing task shell instead of
launching a replacement. Up to 2 MiB of recent terminal output is retained in
memory for reattachment; it is not persisted after the desktop app exits.
Shift+Enter sends Escape followed by Return, allowing Claude Code to insert a
newline without submitting the prompt.

## Sidebar text magnifier

Hover over meaningful text in the sidebar to show a larger visual copy in an
overlay. The magnified copy preserves the source item's colors, emphasis, icons,
and other text styling while enlarging its typography. The overlay also appears
when an interactive sidebar item receives keyboard focus, does not reflow the
panels, and never intercepts clicks.

The display-settings menu in the title bar also provides persistent Standard,
Large, and Extra large text sizes. This scales both application text and the
embedded terminal.

Agent-originated changes briefly highlight the affected task header, Questions,
Plan, Artifacts, Status, or Alerts section. Human actions such as answering a
question or clearing an alert do not trigger that highlight.

For development outside a Telemachus terminal, `npm link` exposes the same
`agent-ui` command globally, but write commands still require the task-scoped
environment above.

## Optional MCP adapter

The command line is the primary integration. For clients that specifically
require MCP, `node /absolute/path/to/editor/bin/agent-ui-mcp.mjs` remains
available as a stdio adapter. It uses the same task-scoped environment and typed
operation service as the CLI.

## Security boundary

The bridge contains typed task, presentation, question, layout, and
terminal-session operations. It does not expose generic file reads/writes,
arbitrary execution, Git, GitHub, repository, or credential APIs.

The Rust host:

- owns PTYs, SQLite, task/session identity, and the loopback bridge;
- validates task scope, statuses, IDs, payload sizes, and revision checks;
- uses opaque terminal session IDs;
- binds the bridge to a random localhost port;
- injects a distinct random token into each task terminal;
- stores presentation state transactionally and does not persist terminal
  keystrokes or transcripts.

Displayed Markdown, paths, and URLs are untrusted presentation state. Raw HTML
is removed. Artifact links open only after an explicit click: local documents
are validated as absolute files and sent to Zed; web documents accept only
HTTP(S), and GitHub PR links must match an HTTPS `github.com/.../pull/<number>`
URL.

## Verification

```bash
npm run build
npm run test:bridge
npm run test:rust
npm run check:rust
npm run tauri -- build --no-bundle
```

Browser preview mode uses local storage and a non-interactive terminal shell:

```bash
npm run dev
```

The desktop app is the product path and is required for PTY, SQLite, task-token,
blocking-wait, and restart behavior.

## Current MVP boundaries

- One live terminal per task; terminal processes end when the app exits.
- Presentation state and panel dimensions restore after restart.
- Task deletion is explicit and revokes scoped bridge access.
- No transcript persistence, archive browser, remote terminals, cloud sync,
  repository features, or autonomous orchestration.
