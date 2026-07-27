# Using Telemachus as an agent

Telemachus gives Claude, Codex, and other terminal agents one command for keeping
the task screen current:

```bash
agent-ui
```

Run these commands inside a terminal created by Telemachus. The application
automatically provides the task ID, local bridge address, authentication token,
protocol version, and executable path. Do not configure MCP or copy credentials.

## Start here

Confirm that the task-scoped bridge is ready:

```bash
agent-ui doctor --output text
agent-ui context --compact
```

See the complete built-in command reference:

```bash
agent-ui help
```

## Write short

The screen is small and every section competes for the same space. Long text does not
scroll gracefully — it crowds out the rest of the screen.

- **Plan item:** a title plus one brief line. No paragraphs, no nested detail.
- **Status message:** a short phrase, not a sentence.
- **Alert and todo:** one line of context. The reasoning belongs in the conversation.
- **Summary section:** one line each.

Say the thing that changes what the human does, and stop. If it takes a paragraph, it
belongs in the conversation or in an artifact, with a pointer from the screen.

## Expected behavior

Keep the screen useful throughout the task:

1. Set the task title and mark it `working`.
2. Add a short plan with stable item IDs.
3. Update plan items as work progresses.
4. Report important risks as alerts.
5. Add produced documents and pull requests as artifacts.
6. Add a todo whenever the human owes an action, decision, or answer.
7. Finish with a concise summary and final task status.

## Alerts vs. human to dos

The two are not interchangeable. The test is whether the human owes something.

- **Alert = you are telling them something.** Findings, risks, surprises, caveats they
  should know about. Read and move on. Nothing is waiting on them.
- **Todo = the human needs to act or answer.** Deploying, merging, reviewing, approving,
  choosing, or supplying a fact all belong in the To do pane.

Never put a decision request in an alert. "Needs your sign-off", "which of these should
I do", "confirm before I proceed" — all of those belong in `todo add` or `todo ask`,
even when a plain-text message in the conversation also asks. The To do pane is where
the human looks for what they owe you; an alert phrased as a request just gets read and
forgotten.

The reverse holds too: do not add a todo for something that needs no human response or
action. An observation with no decision attached is an alert.

Do not create a new ID every time an item changes. Reuse stable IDs such as
`inspect`, `implement`, `verify`, `security-risk`, and `release-pr`.

## Task header

Set the title, description, status, and current activity:

```bash
agent-ui task set \
  --title "Fix checkout retries" \
  --description "Prevent duplicate checkout requests after a timeout." \
  --issue-url "https://github.com/OWNER/REPOSITORY/issues/123" \
  --status working \
  --message "Inspecting the retry path"
```

Put the task's GitHub issue in `--issue-url`, not in Artifacts. It appears as a
link beside the title; if the same issue URL is also reported as an artifact,
the editor suppresses the duplicate.

Update only the status:

```bash
agent-ui task status blocked --message "Waiting for deployment approval"
agent-ui task status completed --message "Implementation and verification finished"
```

Task statuses:

- `idle`
- `working`
- `waiting`
- `blocked`
- `completed`
- `failed`
- `cancelled`

## Plan

**The plan is the work, not your process.** Items are the phases, tasks, or milestones of
the thing being built — the ones the human would recognise from the issue, the plan
document, or the request they made. Your own working steps ("read the issue", "search the
codebase", "write the file") do not belong here; they are how you get an item done, not
items themselves.

When the effort already has a written plan, mirror its structure. The human should be able
to look at this section and the document and see the same shape.

Create or update plan items:

```bash
agent-ui plan add inspect "Inspect the retry path" \
  --detail "Trace request IDs through the client and API." \
  --status in_progress

agent-ui plan add implement "Implement the fix" --status pending
agent-ui plan add verify "Run focused verification" --status pending

agent-ui plan update inspect --status completed
agent-ui plan update implement --status in_progress
```

Plan statuses:

- `pending`
- `in_progress`
- `completed`
- `blocked`
- `skipped`

Read or replace the plan:

```bash
agent-ui plan list
agent-ui plan replace --file plan.json
agent-ui plan replace --stdin
agent-ui plan remove verify
agent-ui plan clear
```

Example plan JSON:

```json
[
  {
    "id": "inspect",
    "title": "Inspect the retry path",
    "detail": "Trace request IDs through the client and API.",
    "status": "completed",
    "order": 0
  },
  {
    "id": "implement",
    "title": "Implement the fix",
    "detail": "",
    "status": "in_progress",
    "order": 1
  }
]
```

## Summary

Keep summaries concise and focused on durable results:

```bash
agent-ui summary set \
  --headline "Duplicate retries are prevented" \
  --body "Checkout attempts now reuse the original idempotency key."
```

Add structured sections when useful:

```bash
agent-ui summary set \
  --headline "Implementation complete" \
  --section "Result=Retries reuse one request identity." \
  --section "Verification=Focused tests and the production build passed." \
  --section "Next=Deploy through the normal release workflow."
```

For longer Markdown:

```bash
agent-ui summary set --headline "Investigation complete" --body-file summary.md
```

## Alerts

Use alerts for actionable risks, blockers, and important exceptions — things the human
should **know**. If the item needs a reply or human action, it is a todo, not an alert.

```bash
agent-ui alert raise migration-lock "Migration may block writes" \
  --severity warning \
  --message "The exclusive lock may pause checkout writes for up to 30 seconds."
```

Severities are `info`, `warning`, and `critical`.

Update or clear an alert using the same ID:

```bash
agent-ui alert upsert migration-lock \
  --title "Migration lock risk mitigated" \
  --severity info \
  --message "The concurrent index path avoids the exclusive lock."

agent-ui alert clear migration-lock
```

## Artifacts

Artifacts appear in the left rail and have an explicit open action.

Add a local document using an absolute path:

```bash
agent-ui artifact add verification-report "Verification report" \
  /absolute/path/to/verification.md \
  --type local_document \
  --status generated
```

Local documents must already exist. They open in Zed.

Mark the implementation plan so it always stays at the top of Artifacts:

```bash
agent-ui artifact add implementation-plan "Implementation plan" \
  /absolute/path/to/plan.md \
  --type local_document \
  --status inspected \
  --meta role=plan
```

Plan documents appear first, open PRs second, and all remaining artifacts keep
their reported order.

Add a web document:

```bash
agent-ui artifact add design-spec "Design specification" \
  https://example.com/design \
  --type web_document \
  --status inspected
```

Add a GitHub pull request:

```bash
agent-ui artifact add release-pr "Implementation pull request" \
  https://github.com/OWNER/REPOSITORY/pull/123 \
  --type github_pr \
  --status generated \
  --meta github_state=open
```

Web documents and GitHub pull requests open in the system browser.
The editor periodically checks PR state through the GitHub CLI and removes
closed or merged PRs. If you close or merge the PR yourself, update the screen
immediately instead of waiting for the next check:

```bash
agent-ui artifact update release-pr --meta github_state=merged
```

The human can launch Codex from an individual PR or local-document card, or
review every open PR from the Artifacts heading. The editor runs the review in
the background with `gpt-5.6-sol` at high reasoning and includes this task's
GitHub issue. Keep the task issue link current so these review actions remain
available. Review queue, running, posted, and result-link metadata is
maintained by the editor; agents should not overwrite those metadata keys.

Manage existing artifacts:

```bash
agent-ui artifact list
agent-ui artifact update release-pr --status inspected
agent-ui artifact remove release-pr
agent-ui artifact clear
```

Paths, URLs, and notes belong in the same Artifacts collection:

```bash
agent-ui artifact add source-file "Retry implementation" src/retry.js \
  --type path --status modified

agent-ui artifact add observation "Observed behavior" \
  "The second request reused the first response." \
  --type note --status reported
```

Artifact statuses:

- `reported`
- `inspected`
- `modified`
- `generated`
- `unavailable`

`agent-ui resource ...` is accepted only as a backward-compatible alias for
older instructions; it updates this same Artifacts collection.

## Human to dos

Anything the human needs to do goes here: deploy, merge, review, approve, make a scope
call, express a preference, or provide a fact only they have.

Add an action when the human needs to perform work:

```bash
agent-ui todo add deploy "Deploy the release to production"
agent-ui todo add merge "Merge PR #42 after checks pass"
agent-ui todo list --kind action --state open
```

Actions return immediately by default. Add `--blocking` only when no useful agent work
can continue until the human marks the action done:

```bash
agent-ui todo add review "Review the production migration plan" \
  --blocking --timeout 300
```

Use a question when the human needs to answer. Choose blocking or non-blocking by
whether work can continue meanwhile, not by how important the answer is.

Ask a blocking question when work cannot continue without an answer:

```bash
agent-ui todo ask rollout "Which rollout should we use?" \
  --choice Canary \
  --choice "All at once" \
  --timeout 300
```

The command waits for the answer. It exits with code `3` if the question times
out or is cancelled.

Create a non-blocking question when other work can continue:

```bash
agent-ui todo ask naming "Which name do you prefer?" --non-blocking
agent-ui todo get naming
agent-ui todo list --kind question --state open
```

Create a non-blocking question when the answer shapes later work but there is still
useful work to do now — a scope call on a plan you have already delivered, for example.

Do not use a question as a substitute for making a safe, reversible engineering
decision.

`agent-ui question list|get|ask` remains available for compatibility, but new
instructions should use the unified `todo` command.

## Publish a complete screen

For initial setup or a handoff, publish multiple screen sections from one JSON
document:

```bash
agent-ui publish --stdin <<'JSON'
{
  "task": {
    "title": "Fix checkout retries",
    "issue_url": "https://github.com/OWNER/REPOSITORY/issues/123",
    "status": "working",
    "status_message": "Running verification"
  },
  "plan": [
    {
      "id": "inspect",
      "title": "Inspect retry behavior",
      "status": "completed"
    },
    {
      "id": "verify",
      "title": "Run verification",
      "status": "in_progress"
    }
  ],
  "summary": {
    "headline": "The implementation is ready",
    "sections": [
      {
        "id": "result",
        "heading": "Result",
        "body": "Retries now reuse one idempotency key."
      }
    ]
  },
  "alerts": [],
  "artifacts": [
    {
      "id": "report",
      "type": "local_document",
      "label": "Verification report",
      "path_or_url": "/absolute/path/to/verification.md",
      "status": "generated"
    }
  ]
}
JSON
```

Omitted sections stay unchanged. An included empty collection clears that
collection. `publish` does not replace human to dos.

## Machine-readable output

Commands emit JSON by default:

```bash
agent-ui plan list --compact
agent-ui task status working --output quiet
agent-ui context --output document
```

Useful global options:

- `--output json|text|quiet|document`
- `--compact`
- `--source NAME`
- `--expected-revision N`
- `--idempotency-key KEY`

## Conflicts and retries

Read-modify-write commands protect against overwriting a newer screen revision.
Exit code `2` means another writer changed the screen:

1. Read the latest state with `agent-ui context`.
2. Reconcile the intended update with that state.
3. Retry the command.

Use an explicit idempotency key when retrying the exact same operation and
payload:

```bash
agent-ui task status working \
  --message "Running tests" \
  --idempotency-key verify-status-1
```

Do not reuse an idempotency key for a different payload.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | Rejected input or missing presentation item |
| 2 | Retryable revision conflict |
| 3 | Blocking todo timed out or was cancelled |
| 4 | Missing task context, bridge unavailable, or authentication failure |
| 64 | Invalid command usage |

Errors are emitted as JSON on stderr unless text or quiet output was selected.

## Recommended completion update

At the end of successful work:

```bash
agent-ui plan update implement --status completed
agent-ui plan update verify --status completed

agent-ui summary set \
  --headline "Task completed" \
  --section "Result=Describe the completed outcome." \
  --section "Verification=List the checks that passed." \
  --section "Artifacts=Name the important generated files or pull requests."

agent-ui task status completed --message "Implementation and verification finished"
```

If work fails or remains blocked, report that state honestly instead of marking
the task complete.
