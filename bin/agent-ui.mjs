#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const AGENT_INSTRUCTIONS = `# Using Telemachus as an agent

Telemachus gives Claude, Codex, and other terminal agents one command for keeping
the task screen current:

\`\`\`bash
agent-ui
\`\`\`

Run these commands inside a terminal created by Telemachus. The application
automatically provides the task ID, local bridge address, authentication token,
protocol version, and executable path. Do not configure MCP or copy credentials.

## Start here

Confirm that the task-scoped bridge is ready:

\`\`\`bash
agent-ui doctor --output text
agent-ui context --compact
\`\`\`

See the complete built-in command reference:

\`\`\`bash
agent-ui help
\`\`\`

## Write short

The screen is small and every section competes for the same space. Long text does not
scroll gracefully — it crowds out the rest of the screen.

- **Plan item:** a stage name as the title (for example, "Phase 2") plus one
  outcome-oriented line ending with that stage's goal.
- **Status message:** a short phrase, not a sentence.
- **Alert and todo:** one line of context. The reasoning belongs in the conversation.
- **Status section:** one or two lines total.

Say the thing that changes what the human does, and stop. If it takes a paragraph, it
belongs in the conversation or in an artifact, with a pointer from the screen.

## Expected behavior

Keep the screen useful throughout the task:

1. Set the task title and mark it \`working\`.
2. Add a short plan with stable item IDs.
3. Update plan items as work progresses.
4. Report important risks as alerts.
5. Add directly related documents to Artifacts and outstanding pull requests to PRs.
6. Add a todo whenever the human owes an action, decision, or answer.
7. Finish with a concise summary and final task status.

## Alerts vs. human to dos

The two are not interchangeable. The test is whether the human owes something.

- **Alert = you are telling them something.** Findings, risks, surprises, caveats they
  should know about. Read and move on. Nothing is waiting on them.
- **Todo = the human needs to act or answer.** Deploying, merging, reviewing, approving,
  choosing, or supplying a fact all belong in the To do pane.

Never put a decision request in an alert. "Needs your sign-off", "which of these should
I do", "confirm before I proceed" — all of those belong in \`todo add\` or \`todo ask\`,
even when a plain-text message in the conversation also asks. The To do pane is where
the human looks for what they owe you; an alert phrased as a request just gets read and
forgotten.

The reverse holds too: do not add a todo for something that needs no human response or
action. An observation with no decision attached is an alert.

Do not create a new ID every time an item changes. Reuse stable IDs such as
\`phase-1\`, \`phase-2\`, \`security-risk\`, and \`release-pr\`.

## Task header

Set the title, description, status, and current activity:

\`\`\`bash
agent-ui task set \\
  --title "Fix checkout retries" \\
  --description "Prevent duplicate checkout requests after a timeout." \\
  --issue-url "https://github.com/OWNER/REPOSITORY/issues/123" \\
  --status working \\
  --message "Inspecting the retry path"
\`\`\`

Put the task's GitHub issue in \`--issue-url\`, not in Artifacts. It appears as a
link beside the title; if the same issue URL is also reported as an artifact,
the editor suppresses the duplicate.

Update only the status:

\`\`\`bash
agent-ui task status blocked --message "Waiting for deployment approval"
agent-ui task status completed --message "Implementation and verification finished"
\`\`\`

Task statuses:

- \`idle\`
- \`working\`
- \`waiting\`
- \`blocked\`
- \`completed\`
- \`failed\`
- \`cancelled\`

## Plan

**The plan is the work, not your process.** Use one item for each stage or phase of the
thing being built. Your own working steps ("read the issue", "search the codebase",
"write the file") do not belong here; they are how you complete a stage, not stages
themselves.

The title should be only the stage name, such as \`Phase 1\`, \`Phase 2\`, or the
milestone name used by the source plan. The description must be one concise line
describing what should happen during that stage. Whenever possible, end the line with
the stage's goal or completion condition.

When the effort already has a written plan, mirror its structure. The human should be able
to look at this section and the document and see the same shape.

Create or update plan items:

\`\`\`bash
agent-ui plan add phase-1 "Phase 1" \\
  --detail "Create regression tests for module A; mutation tests pass." \\
  --status in_progress

agent-ui plan add phase-2 "Phase 2" \\
  --detail "Migrate module A from React to Svelte; all tests pass." \\
  --status pending

agent-ui plan add phase-3 "Phase 3" \\
  --detail "Deploy module A to production; human tests pass." \\
  --status pending

agent-ui plan update phase-1 --status completed
agent-ui plan update phase-2 --status in_progress
\`\`\`

Plan statuses:

- \`pending\`
- \`in_progress\`
- \`completed\`
- \`blocked\`
- \`skipped\`

Read or replace the plan:

\`\`\`bash
agent-ui plan list
agent-ui plan replace --file plan.json
agent-ui plan replace --stdin
agent-ui plan remove phase-3
agent-ui plan clear
\`\`\`

Example plan JSON:

\`\`\`json
[
  {
    "id": "phase-1",
    "title": "Phase 1",
    "detail": "Create regression tests for module A; mutation tests pass.",
    "status": "completed",
    "order": 0
  },
  {
    "id": "phase-2",
    "title": "Phase 2",
    "detail": "Migrate module A from React to Svelte; all tests pass.",
    "status": "in_progress",
    "order": 1
  },
  {
    "id": "phase-3",
    "title": "Phase 3",
    "detail": "Deploy module A to production; human tests pass.",
    "status": "pending",
    "order": 2
  }
]
\`\`\`

## Status

Status is the short handoff for where the work stands right now. Apply the coffee test:
someone who steps away and comes back should be able to read one or two lines and
immediately recover enough context to continue.

Good status examples:

- "We are code reviewing PR #123."
- "We need to restart the server before testing."
- "We are closing out phase 2 and about to start phase 3."
- "I am waiting for your go-ahead to deploy."

Write the Status pane with the \`summary\` command. Keep it concise and focused on
the current handoff:

\`\`\`bash
agent-ui summary set \\
  --headline "Duplicate retries are prevented" \\
  --body "Checkout attempts now reuse the original idempotency key."
\`\`\`

Add structured sections when useful:

\`\`\`bash
agent-ui summary set \\
  --headline "Implementation complete" \\
  --section "Result=Retries reuse one request identity." \\
  --section "Verification=Focused tests and the production build passed." \\
  --section "Next=Deploy through the normal release workflow."
\`\`\`

For longer Markdown:

\`\`\`bash
agent-ui summary set --headline "Investigation complete" --body-file summary.md
\`\`\`

## Alerts

Alerts are warnings or errors the human should not ignore. Use them for actionable
risks, failures, security problems, and important exceptions. If the item needs a
reply or human action, it is a todo, not an alert.

Good alert examples:

- "Do not deploy PR #123 until SQL command A has been run."
- "The last deployment took down the production servers."
- "A secret appeared in the transcript and must be rotated."
- "CI failed for this release."

\`\`\`bash
agent-ui alert raise migration-lock "Migration may block writes" \\
  --severity warning \\
  --message "The exclusive lock may pause checkout writes for up to 30 seconds."
\`\`\`

Severities are \`info\`, \`warning\`, and \`critical\`.

Update or clear an alert using the same ID:

\`\`\`bash
agent-ui alert upsert migration-lock \\
  --title "Migration lock risk mitigated" \\
  --severity info \\
  --message "The concurrent index path avoids the exclusive lock."

agent-ui alert clear migration-lock
\`\`\`

## Artifacts

Artifacts are documents directly related to this work. They appear in the left rail
and have an explicit open action.

Good artifacts include:

- The implementation plan.
- A design document or architecture decision.
- A requirements document or directly relevant web page.
- A verification report produced by the work.

Do not add every file or URL encountered during investigation. Add durable references
that help the human understand, review, or continue this task.

Add a local document using an absolute path:

\`\`\`bash
agent-ui artifact add verification-report "Verification report" \\
  /absolute/path/to/verification.md \\
  --type local_document \\
  --status generated
\`\`\`

Local documents must already exist. They open in Zed.

Mark the implementation plan so it always stays at the top of Artifacts:

\`\`\`bash
agent-ui artifact add implementation-plan "Implementation plan" \\
  /absolute/path/to/plan.md \\
  --type local_document \\
  --status inspected \\
  --meta role=plan
\`\`\`

Plan documents appear first, open PRs second, and all remaining artifacts keep
their reported order.

Add a web document:

\`\`\`bash
agent-ui artifact add design-spec "Design specification" \\
  https://example.com/design \\
  --type web_document \\
  --status inspected
\`\`\`

### Pull requests

PRs are outstanding pull requests for this work. Add only open PRs that the human may
need to review, merge, monitor, or revisit as part of this task. Do not add unrelated
PRs merely because their URLs appeared in a tool result or conversation.

Add an outstanding GitHub pull request:

\`\`\`bash
agent-ui artifact add release-pr "Implementation pull request" \\
  https://github.com/OWNER/REPOSITORY/pull/123 \\
  --type github_pr \\
  --status generated \\
  --meta github_state=open
\`\`\`

Web documents and GitHub pull requests open in the system browser.
The editor periodically checks PR state through the GitHub CLI and removes
closed or merged PRs. If you close or merge the PR yourself, update the screen
immediately instead of waiting for the next check:

\`\`\`bash
agent-ui artifact update release-pr --meta github_state=merged
\`\`\`

The human can launch Codex from an individual PR or local-document card, or
review every open PR from the PRs heading. The editor runs the review in
the background with \`gpt-5.6-sol\` at high reasoning and includes this task's
GitHub issue. Keep the task issue link current so these review actions remain
available. Review queue, running, posted, and result-link metadata is
maintained by the editor; agents should not overwrite those metadata keys.

Manage existing artifacts:

\`\`\`bash
agent-ui artifact list
agent-ui artifact update release-pr --status inspected
agent-ui artifact remove release-pr
agent-ui artifact clear
\`\`\`

Paths, URLs, and notes belong in the same Artifacts collection:

\`\`\`bash
agent-ui artifact add source-file "Retry implementation" src/retry.js \\
  --type path --status modified

agent-ui artifact add observation "Observed behavior" \\
  "The second request reused the first response." \\
  --type note --status reported
\`\`\`

Artifact statuses:

- \`reported\`
- \`inspected\`
- \`modified\`
- \`generated\`
- \`unavailable\`

\`agent-ui resource ...\` is accepted only as a backward-compatible alias for
older instructions; it updates this same Artifacts collection.

## Human to dos

Todos are questions and tasks for the human. Anything the human needs to answer or do
goes here: deploy, merge, review, approve, make a scope call, express a preference, or
provide a fact only they have.

Good todo examples:

- "Should I implement this for all tenants or just one?"
- "Deploy main — we cannot proceed until it is deployed."
- "Run SQL command A — I do not have access to production."

Add an action when the human needs to perform work:

\`\`\`bash
agent-ui todo add deploy "Deploy the release to production"
agent-ui todo add merge "Merge PR #42 after checks pass"
agent-ui todo list --kind action --state open
\`\`\`

Actions return immediately by default. Add \`--blocking\` only when no useful agent work
can continue until the human marks the action done:

\`\`\`bash
agent-ui todo add review "Review the production migration plan" \\
  --blocking --timeout 300
\`\`\`

Use a question when the human needs to answer. Choose blocking or non-blocking by
whether work can continue meanwhile, not by how important the answer is.

Ask a blocking question when work cannot continue without an answer:

\`\`\`bash
agent-ui todo ask rollout "Which rollout should we use?" \\
  --choice Canary \\
  --choice "All at once" \\
  --timeout 300
\`\`\`

The command waits for the answer. It exits with code \`3\` if the question times
out or is cancelled.

Create a non-blocking question when other work can continue:

\`\`\`bash
agent-ui todo ask naming "Which name do you prefer?" --non-blocking
agent-ui todo get naming
agent-ui todo list --kind question --state open
\`\`\`

Create a non-blocking question when the answer shapes later work but there is still
useful work to do now — a scope call on a plan you have already delivered, for example.

Do not use a question as a substitute for making a safe, reversible engineering
decision.

\`agent-ui question list|get|ask\` remains available for compatibility, but new
instructions should use the unified \`todo\` command.

## Publish a complete screen

For initial setup or a handoff, publish multiple screen sections from one JSON
document:

\`\`\`bash
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
\`\`\`

Omitted sections stay unchanged. An included empty collection clears that
collection. \`publish\` does not replace human to dos.

## Machine-readable output

Commands emit JSON by default:

\`\`\`bash
agent-ui plan list --compact
agent-ui task status working --output quiet
agent-ui context --output document
\`\`\`

Useful global options:

- \`--output json|text|quiet|document\`
- \`--compact\`
- \`--source NAME\`
- \`--expected-revision N\`
- \`--idempotency-key KEY\`

## Conflicts and retries

Read-modify-write commands protect against overwriting a newer screen revision.
Exit code \`2\` means another writer changed the screen:

1. Read the latest state with \`agent-ui context\`.
2. Reconcile the intended update with that state.
3. Retry the command.

Use an explicit idempotency key when retrying the exact same operation and
payload:

\`\`\`bash
agent-ui task status working \\
  --message "Running tests" \\
  --idempotency-key verify-status-1
\`\`\`

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

\`\`\`bash
agent-ui plan update implement --status completed
agent-ui plan update verify --status completed

agent-ui summary set \\
  --headline "Task completed" \\
  --section "Result=Describe the completed outcome." \\
  --section "Verification=List the checks that passed." \\
  --section "Artifacts=Name the important generated files or pull requests."

agent-ui task status completed --message "Implementation and verification finished"
\`\`\`

If work fails or remains blocked, report that state honestly instead of marking
the task complete.
`;

class CliError extends Error {
  constructor(code, message, exitCode = 1, retryable = false) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = retryable;
  }
}

function usageError(message) {
  throw new CliError("usage_error", message, 64, false);
}

function takeOption(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    usageError(`--${name} requires a value`);
  }
  const [value] = argv.splice(index + 1, 1);
  argv.splice(index, 1);
  return value;
}

function takeOptions(name) {
  const values = [];
  while (true) {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return values;
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      usageError(`--${name} requires a value`);
    }
    values.push(argv[index + 1]);
    argv.splice(index, 2);
  }
}

function takeFlag(name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
}

const outputMode = takeOption(
  "output",
  process.env.AGENT_UI_OUTPUT || (takeFlag("quiet") ? "quiet" : "json"),
);
const source = takeOption(
  "source",
  process.env.AGENT_UI_SOURCE || "agent-ui-cli",
);
const expectedRevisionRaw = takeOption("expected-revision");
const globalExpectedRevision =
  expectedRevisionRaw === undefined
    ? undefined
    : parseInteger(expectedRevisionRaw, "expected revision", 0);
const globalIdempotencyKey = takeOption("idempotency-key");
const compactJson = takeFlag("compact");
if (!["json", "text", "quiet", "document"].includes(outputMode)) {
  usageError("--output must be json, text, quiet, or document");
}

const endpoint = process.env.AGENT_UI_ENDPOINT;
const taskId = process.env.AGENT_UI_TASK_ID;
const token = process.env.AGENT_UI_TOKEN;
const protocolVersion = process.env.AGENT_UI_PROTOCOL_VERSION || "1.0";

function requireContext() {
  const missing = [
    ["AGENT_UI_ENDPOINT", endpoint],
    ["AGENT_UI_TASK_ID", taskId],
    ["AGENT_UI_TOKEN", token],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new CliError(
      "missing_task_context",
      `missing ${missing.join(", ")}; run inside an Agent UI terminal`,
      4,
      false,
    );
  }
}

function parseInteger(value, label, minimum = Number.MIN_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    usageError(`${label} must be an integer${minimum > 0 ? ` >= ${minimum}` : ""}`);
  }
  return number;
}

function parseJson(value, label = "JSON") {
  try {
    return JSON.parse(value);
  } catch (error) {
    usageError(`invalid ${label}: ${error.message}`);
  }
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function readJsonInput(positionalValue, label) {
  const file = takeOption("file");
  const stdin = takeFlag("stdin");
  const selected = [file !== undefined, stdin, positionalValue !== undefined].filter(
    Boolean,
  ).length;
  if (selected !== 1) {
    usageError(
      `${label} requires exactly one of inline JSON, --file PATH, or --stdin`,
    );
  }
  const raw = file !== undefined ? await readFile(file, "utf8") : stdin ? await readStdin() : positionalValue;
  return parseJson(raw, label);
}

async function readBody(defaultValue = "") {
  const file = takeOption("body-file");
  const stdin = takeFlag("stdin");
  const body = takeOption("body");
  const selected = [file !== undefined, stdin, body !== undefined].filter(Boolean).length;
  if (selected > 1) {
    usageError("use only one of --body, --body-file, or --stdin");
  }
  if (file !== undefined) return readFile(file, "utf8");
  if (stdin) return readStdin();
  return body ?? defaultValue;
}

function ensureNoOptions() {
  const unknown = argv.find((value) => value.startsWith("--"));
  if (unknown) usageError(`unknown option: ${unknown}`);
}

function takePositional() {
  if (argv.length === 0 || argv[0].startsWith("--")) return undefined;
  return argv.shift();
}

function print(value, textValue) {
  if (outputMode === "quiet") return;
  if (outputMode === "text") {
    process.stdout.write(`${textValue ?? humanize(value)}\n`);
    return;
  }
  const spacing = compactJson ? 0 : 2;
  process.stdout.write(`${JSON.stringify(value, null, spacing)}\n`);
}

function humanize(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.length
      ? value
          .map((item) =>
            typeof item === "object"
              ? `${item.id ?? "-"}\t${item.status ?? item.state ?? "-"}\t${
                  item.title ?? item.label ?? item.text ?? ""
                }`
              : String(item),
          )
          .join("\n")
      : "(none)";
  }
  return JSON.stringify(value);
}

async function request(path, init = {}) {
  requireContext();
  let response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "x-agent-ui-task-id": taskId,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new CliError(
      "bridge_unreachable",
      `cannot reach the local Agent UI bridge: ${error.message}`,
      4,
      true,
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = body.error ?? {};
    const retryable = Boolean(error.retryable);
    const authFailure = response.status === 401 || response.status === 403;
    throw new CliError(
      error.code || `http_${response.status}`,
      error.message || response.statusText,
      authFailure ? 4 : retryable ? 2 : 1,
      retryable,
    );
  }
  return body;
}

async function context() {
  return request("/v1/context");
}

async function operate(opType, payload, options = {}) {
  const expectedRevision =
    options.expectedRevision ?? globalExpectedRevision;
  const idempotencyKey =
    options.idempotencyKey ?? globalIdempotencyKey ?? randomUUID();
  return request("/v1/operation", {
    method: "POST",
    body: JSON.stringify({
      operation: {
        protocol_version: protocolVersion,
        task_id: taskId,
        source,
        op_type: opType,
        payload,
        ...(expectedRevision === undefined
          ? {}
          : { expected_revision: expectedRevision }),
        idempotency_key: idempotencyKey,
      },
      ...(options.waitSeconds
        ? { wait_seconds: options.waitSeconds }
        : {}),
    }),
  });
}

function printWrite(body, operation) {
  if (outputMode === "document") {
    print(body.document);
    return;
  }
  const result = {
    ok: true,
    operation,
    task_id: taskId,
    revision: body.document?.revision,
    updated_at: body.document?.updated_at,
    ...(body.wait ? { wait: body.wait } : {}),
  };
  print(result, `${operation}: revision ${result.revision}`);
}

function normalizeTask(item, index) {
  return {
    id: item.id,
    title: item.title,
    detail: item.detail ?? "",
    status: item.status ?? "pending",
    order: item.order ?? index,
  };
}

function normalizeAlert(alert) {
  return {
    id: alert.id,
    severity: alert.severity ?? "info",
    title: alert.title,
    message: alert.message ?? "",
    state: alert.state ?? "active",
  };
}

function normalizeResource(resource) {
  return {
    id: resource.id,
    type: resource.type ?? "note",
    label: resource.label,
    path_or_url: resource.path_or_url,
    status: resource.status ?? "reported",
    metadata: resource.metadata ?? {},
  };
}

function parseMetadata(values) {
  return Object.fromEntries(
    values.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) usageError(`metadata must be KEY=VALUE: ${entry}`);
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

async function taskCommand(subcommand) {
  if (subcommand === "get") {
    const body = await context();
    print(body.document.header);
    return;
  }
  if (subcommand === "set") {
    const current = (await context()).document;
    const title = takeOption("title", current.header.title);
    const descriptionFile = takeOption("description-file");
    const description =
      descriptionFile === undefined
        ? takeOption("description", current.header.description)
        : await readFile(descriptionFile, "utf8");
    const issueUrl = takeOption(
      "issue-url",
      current.header.issue_url ?? "",
    );
    const status = takeOption("status", current.header.status);
    const statusMessage = takeOption(
      "message",
      current.header.status_message,
    );
    ensureNoOptions();
    const body = await operate(
      "set_task",
      {
        title,
        description,
        issue_url: issueUrl,
        source,
        status,
        status_message: statusMessage,
      },
      { expectedRevision: globalExpectedRevision ?? current.revision },
    );
    printWrite(body, "set_task");
    return;
  }
  if (subcommand === "status") {
    const status = argv.shift();
    if (!status) usageError("task status requires STATUS");
    const statusMessage = takeOption("message", argv.join(" "));
    argv.length = 0;
    const body = await operate("set_task_status", {
      status,
      status_message: statusMessage,
    });
    printWrite(body, "set_task_status");
    return;
  }
  usageError("task requires get, set, or status");
}

async function planCommand(subcommand) {
  if (subcommand === "list") {
    const body = await context();
    print(body.document.tasks);
    return;
  }
  if (subcommand === "replace") {
    const inline = takePositional();
    const input = await readJsonInput(inline, "plan");
    const tasks = (Array.isArray(input) ? input : input.tasks).map(normalizeTask);
    ensureNoOptions();
    const body = await operate("replace_tasks", { tasks });
    printWrite(body, "replace_tasks");
    return;
  }
  if (["add", "upsert", "update"].includes(subcommand)) {
    const id = argv.shift();
    if (!id) usageError(`plan ${subcommand} requires ID`);
    const current = (await context()).document;
    const existing = current.tasks.find((item) => item.id === id);
    if (subcommand === "update" && !existing) {
      throw new CliError("task_item_not_found", `no plan item named ${id}`);
    }
    const titleOption = takeOption("title");
    const positionalTitle = takePositional();
    const title = titleOption ?? positionalTitle ?? existing?.title;
    if (!title) usageError(`plan ${subcommand} requires TITLE or --title`);
    const detail = takeOption("detail", existing?.detail ?? "");
    const status = takeOption("status", existing?.status ?? "pending");
    const nextOrder =
      current.tasks.reduce((maximum, item) => Math.max(maximum, item.order), -1) +
      1;
    const order = parseInteger(
      takeOption("order", String(existing?.order ?? nextOrder)),
      "order",
      0,
    );
    ensureNoOptions();
    const body = await operate(
      "upsert_task",
      { id, title, detail, status, order },
      { expectedRevision: globalExpectedRevision ?? current.revision },
    );
    printWrite(body, "upsert_task");
    return;
  }
  if (subcommand === "remove") {
    const id = argv.shift();
    if (!id) usageError("plan remove requires ID");
    ensureNoOptions();
    const current = (await context()).document;
    if (!current.tasks.some((item) => item.id === id)) {
      throw new CliError("task_item_not_found", `no plan item named ${id}`);
    }
    const body = await operate(
      "replace_tasks",
      { tasks: current.tasks.filter((item) => item.id !== id) },
      { expectedRevision: globalExpectedRevision ?? current.revision },
    );
    printWrite(body, "replace_tasks");
    return;
  }
  if (subcommand === "clear") {
    ensureNoOptions();
    const body = await operate("replace_tasks", { tasks: [] });
    printWrite(body, "replace_tasks");
    return;
  }
  usageError("plan requires list, replace, add, upsert, update, remove, or clear");
}

async function summaryCommand(subcommand) {
  if (subcommand === "get") {
    const body = await context();
    print(body.document.summary);
    return;
  }
  if (subcommand === "set") {
    const headlineOption = takeOption("headline");
    const headline = headlineOption ?? takePositional() ?? "";
    const sectionArgs = takeOptions("section");
    const mainBody = await readBody(takePositional() ?? "");
    ensureNoOptions();
    const sections = [];
    if (mainBody.trim()) {
      sections.push({ id: "current", heading: "", body: mainBody });
    }
    for (const [index, section] of sectionArgs.entries()) {
      const separator = section.indexOf("=");
      if (separator < 0) {
        usageError("--section must use HEADING=BODY");
      }
      sections.push({
        id: `section-${index + 1}`,
        heading: section.slice(0, separator),
        body: section.slice(separator + 1),
      });
    }
    const body = await operate("set_summary", { headline, sections });
    printWrite(body, "set_summary");
    return;
  }
  if (subcommand === "clear") {
    const body = await operate("set_summary", { headline: "", sections: [] });
    printWrite(body, "set_summary");
    return;
  }
  usageError("summary requires get, set, or clear");
}

async function alertCommand(subcommand) {
  if (subcommand === "list") {
    const body = await context();
    print(body.document.alerts);
    return;
  }
  if (["raise", "upsert"].includes(subcommand)) {
    const id = argv.shift();
    if (!id) usageError(`alert ${subcommand} requires ID`);
    const current = (await context()).document;
    const existing = current.alerts.find((alert) => alert.id === id);
    const titleOption = takeOption("title");
    const positionalTitle = takePositional();
    const title = titleOption ?? positionalTitle ?? existing?.title;
    if (!title) usageError(`alert ${subcommand} requires TITLE or --title`);
    const severity = takeOption("severity", existing?.severity ?? "info");
    const message = takeOption("message", argv.join(" ") || existing?.message || "");
    argv.length = 0;
    const body = await operate(
      "raise_alert",
      normalizeAlert({ id, severity, title, message, state: "active" }),
      { expectedRevision: globalExpectedRevision ?? current.revision },
    );
    printWrite(body, "raise_alert");
    return;
  }
  if (subcommand === "clear") {
    const id = argv.shift();
    if (!id) usageError("alert clear requires ID");
    ensureNoOptions();
    const body = await operate("clear_alert", { id });
    printWrite(body, "clear_alert");
    return;
  }
  usageError("alert requires list, raise, upsert, or clear");
}

async function artifactCommand(subcommand, noun = "artifact") {
  if (subcommand === "list") {
    const body = await context();
    print(body.document.resources);
    return;
  }
  if (subcommand === "replace") {
    const inline = takePositional();
    const input = await readJsonInput(inline, "artifacts");
    const collection = Array.isArray(input)
      ? input
      : input.artifacts ?? input.resources;
    if (!Array.isArray(collection)) {
      usageError("artifact replace requires an array or an artifacts field");
    }
    const resources = collection.map(normalizeResource);
    const body = await operate("replace_resources", { resources });
    printWrite(body, "replace_resources");
    return;
  }
  if (["add", "upsert", "update"].includes(subcommand)) {
    const id = argv.shift();
    if (!id) usageError(`${noun} ${subcommand} requires ID`);
    const current = (await context()).document;
    const existing = current.resources.find((resource) => resource.id === id);
    if (subcommand === "update" && !existing) {
      throw new CliError("artifact_not_found", `no artifact named ${id}`);
    }
    const labelOption = takeOption("label");
    const positionalLabel = takePositional();
    const label = labelOption ?? positionalLabel ?? existing?.label;
    if (!label) usageError(`${noun} ${subcommand} requires LABEL or --label`);
    const valueOption = takeOption("value");
    const pathOrUrl =
      valueOption ?? takePositional() ?? existing?.path_or_url;
    if (pathOrUrl === undefined) {
      usageError(`${noun} ${subcommand} requires VALUE or --value`);
    }
    const type = takeOption("type", existing?.type ?? "note");
    const status = takeOption("status", existing?.status ?? "reported");
    const metadataValues = takeOptions("meta");
    ensureNoOptions();
    const resource = normalizeResource({
      id,
      type,
      label,
      path_or_url: pathOrUrl,
      status,
      metadata: metadataValues.length
        ? { ...(existing?.metadata ?? {}), ...parseMetadata(metadataValues) }
        : existing?.metadata ?? {},
    });
    const resources = existing
      ? current.resources.map((item) => (item.id === id ? resource : item))
      : [...current.resources, resource];
    const body = await operate(
      "replace_resources",
      { resources },
      { expectedRevision: globalExpectedRevision ?? current.revision },
    );
    printWrite(body, "replace_resources");
    return;
  }
  if (subcommand === "remove") {
    const id = argv.shift();
    if (!id) usageError(`${noun} remove requires ID`);
    ensureNoOptions();
    const current = (await context()).document;
    if (!current.resources.some((resource) => resource.id === id)) {
      throw new CliError("artifact_not_found", `no artifact named ${id}`);
    }
    const body = await operate(
      "replace_resources",
      { resources: current.resources.filter((resource) => resource.id !== id) },
      { expectedRevision: globalExpectedRevision ?? current.revision },
    );
    printWrite(body, "replace_resources");
    return;
  }
  if (subcommand === "clear") {
    const body = await operate("replace_resources", { resources: [] });
    printWrite(body, "replace_resources");
    return;
  }
  usageError(
    `${noun} requires list, replace, add, upsert, update, remove, or clear`,
  );
}

async function questionCommand(subcommand, noun = "question") {
  if (subcommand === "list") {
    const body = await context();
    const state = takeOption("state");
    ensureNoOptions();
    const questions = body.document.questions.filter(
      (item) =>
        (item.kind ?? "question") === "question" &&
        (!state || item.state === state),
    );
    print(questions);
    return;
  }
  if (subcommand === "get") {
    const id = argv.shift();
    if (!id) usageError(`${noun} get requires ID`);
    ensureNoOptions();
    const body = await context();
    const question = body.document.questions.find(
      (item) => item.id === id && (item.kind ?? "question") === "question",
    );
    if (!question) {
      throw new CliError("question_not_found", `no question named ${id}`);
    }
    print(question);
    return;
  }
  if (subcommand === "ask") {
    const id = argv.shift();
    const textOption = takeOption("text");
    const text = textOption ?? takePositional();
    if (!id || !text) usageError(`${noun} ask requires ID and TEXT`);
    const choices = takeOptions("choice");
    const blocking = !takeFlag("non-blocking");
    const waitSeconds = blocking
      ? parseInteger(takeOption("timeout", "300"), "timeout", 1)
      : 0;
    const allowFreeText = !takeFlag("no-free-text");
    ensureNoOptions();
    const body = await operate(
      "ask_user",
      {
        id,
        kind: "question",
        text,
        blocking,
        choices,
        allow_free_text: allowFreeText,
        answer: null,
        state: "open",
        created_at: new Date().toISOString(),
      },
      { waitSeconds },
    );
    printWrite(body, "ask_user");
    if (body.wait && body.wait.status !== "answered") {
      process.exitCode = 3;
    }
    return;
  }
  usageError(`${noun} requires list, get, or ask`);
}

async function todoCommand(subcommand) {
  if (subcommand === "ask") {
    return questionCommand("ask", "todo");
  }
  if (subcommand === "list") {
    const body = await context();
    const state = takeOption("state");
    const kind = takeOption("kind");
    if (kind && !["question", "action"].includes(kind)) {
      usageError("--kind must be question or action");
    }
    ensureNoOptions();
    const todos = body.document.questions
      .filter(
        (item) =>
          (!state || item.state === state) &&
          (!kind || (item.kind ?? "question") === kind),
      )
      .map((item) => ({ kind: "question", ...item }));
    print(todos);
    return;
  }
  if (subcommand === "get") {
    const id = argv.shift();
    if (!id) usageError("todo get requires ID");
    ensureNoOptions();
    const body = await context();
    const todo = body.document.questions.find((item) => item.id === id);
    if (!todo) {
      throw new CliError("todo_not_found", `no todo named ${id}`);
    }
    print({ kind: "question", ...todo });
    return;
  }
  if (subcommand === "add") {
    const id = argv.shift();
    const textOption = takeOption("text");
    const text = textOption ?? takePositional();
    if (!id || !text) usageError("todo add requires ID and TEXT");
    const blocking = takeFlag("blocking");
    const timeout = takeOption("timeout");
    if (timeout !== undefined && !blocking) {
      usageError("--timeout requires --blocking");
    }
    const waitSeconds = blocking
      ? parseInteger(timeout ?? "300", "timeout", 1)
      : 0;
    ensureNoOptions();
    const body = await operate(
      "ask_user",
      {
        id,
        kind: "action",
        text,
        blocking,
        choices: [],
        allow_free_text: false,
        answer: null,
        state: "open",
        created_at: new Date().toISOString(),
      },
      { waitSeconds },
    );
    printWrite(body, "ask_user");
    if (body.wait && body.wait.status !== "completed") {
      process.exitCode = 3;
    }
    return;
  }
  usageError("todo requires list, get, add, or ask");
}

async function publishCommand() {
  const inline = takePositional();
  const input = await readJsonInput(inline, "presentation document");
  ensureNoOptions();
  let current = (await context()).document;
  let revision = globalExpectedRevision ?? current.revision;
  let index = 0;
  const sequence = async (opType, payload) => {
    const body = await operate(opType, payload, {
      expectedRevision: revision,
      idempotencyKey: globalIdempotencyKey
        ? `${globalIdempotencyKey}.${index++}`
        : undefined,
    });
    current = body.document;
    revision = current.revision;
  };

  const task = input.task ?? input.header;
  if (task) {
    await sequence("set_task", {
      title: task.title ?? current.header.title,
      description: task.description ?? current.header.description,
      issue_url: task.issue_url ?? current.header.issue_url ?? "",
      source,
      status: task.status ?? current.header.status,
      status_message: task.status_message ?? current.header.status_message,
    });
  }
  const plan = input.plan ?? input.tasks;
  if (plan) {
    await sequence("replace_tasks", { tasks: plan.map(normalizeTask) });
  }
  if (input.summary) {
    await sequence("set_summary", {
      headline: input.summary.headline ?? "",
      sections: input.summary.sections ?? [],
    });
  }
  if (input.alerts) {
    const desiredIds = new Set(input.alerts.map((alert) => alert.id));
    for (const alert of current.alerts) {
      if (alert.state !== "cleared" && !desiredIds.has(alert.id)) {
        await sequence("clear_alert", { id: alert.id });
      }
    }
    for (const alert of input.alerts) {
      await sequence("raise_alert", normalizeAlert(alert));
    }
  }
  const artifacts = input.artifacts ?? input.resources;
  if (artifacts) {
    await sequence("replace_resources", {
      resources: artifacts.map(normalizeResource),
    });
  }
  if (outputMode === "document") {
    print(current);
  } else {
    print(
      {
        ok: true,
        operation: "publish",
        task_id: taskId,
        revision: current.revision,
        updated_at: current.updated_at,
      },
      `publish: revision ${current.revision}`,
    );
  }
}

async function demo() {
  const body = {
    task: {
      title: "Ship the task-focused editor",
      description:
        "Build and verify the **local desktop MVP** while preserving a narrow security boundary.",
      status: "working",
      status_message: "Command-line bridge connected",
    },
    plan: [
      {
        id: "review-prd",
        title: "Review product requirements",
        detail: "Translate P0 requirements into typed services.",
        status: "completed",
      },
      {
        id: "native-shell",
        title: "Connect the native terminal",
        detail: "Route PTY bytes without parsing output.",
        status: "completed",
      },
      {
        id: "verify",
        title: "Exercise task isolation and recovery",
        detail: "Run protocol, build, and interaction checks.",
        status: "in_progress",
      },
    ],
    summary: {
      headline: "The command-line presentation bridge is live",
      sections: [
        {
          id: "current",
          heading: "Current state",
          body:
            "Codex, Claude, and scripts can update every panel with the `agent-ui` command.",
        },
        {
          id: "next",
          heading: "Next action",
          body: "Use `agent-ui help` or publish a complete JSON document.",
        },
      ],
    },
    alerts: [
      {
        id: "security-boundary",
        severity: "warning",
        title: "Keep the bridge presentation-only",
        message:
          "Do not add generic file, process, Git, repository, or credential commands.",
      },
    ],
    resources: [
      {
        id: "readme",
        type: "path",
        label: "Command-line integration guide",
        path_or_url: "README.md",
        status: "generated",
      },
    ],
  };
  argv.unshift(JSON.stringify(body));
  await publishCommand();
}

async function doctor() {
  const started = Date.now();
  const health = await request("/health");
  const body = await context();
  print(
    {
      ok: true,
      bridge: endpoint,
      protocol_version: health.protocol_version,
      task_id: taskId,
      revision: body.document.revision,
      latency_ms: Date.now() - started,
      source,
    },
    `Agent UI bridge ready · task ${taskId} · revision ${body.document.revision}`,
  );
}

function usage() {
  process.stdout.write(`Agent UI command-line presentation tools

Usage:
  agent-ui [global options] COMMAND [SUBCOMMAND] [arguments]

Read:
  agent-ui instructions
  agent-ui doctor
  agent-ui context
  agent-ui task get
  agent-ui plan list
  agent-ui summary get
  agent-ui alert list
  agent-ui artifact list
  agent-ui todo list [--state open] [--kind question|action]
  agent-ui todo get ID

Write task state:
  agent-ui task set --title TITLE [--description TEXT] [--issue-url URL] [--status STATUS] [--message TEXT]
  agent-ui task status STATUS [--message TEXT]

Write the plan:
  agent-ui plan replace JSON_ARRAY
  agent-ui plan replace --file plan.json
  agent-ui plan replace --stdin
  agent-ui plan add ID TITLE [--detail TEXT] [--status STATUS] [--order N]
  agent-ui plan update ID [--title TITLE] [--detail TEXT] [--status STATUS]
  agent-ui plan remove ID
  agent-ui plan clear

Write summary, alerts, and artifacts:
  agent-ui summary set --headline TEXT --body TEXT
  agent-ui summary set --headline TEXT --body-file summary.md
  agent-ui summary clear
  agent-ui alert raise ID TITLE [--severity info|warning|critical] [--message TEXT]
  agent-ui alert clear ID
  agent-ui artifact list
  agent-ui artifact add ID LABEL TARGET [--type local_document|web_document|github_pr|path|url|note] [--meta KEY=VALUE]
  agent-ui artifact update ID [--label LABEL] [--value TARGET] [--status STATUS] [--meta KEY=VALUE]
  agent-ui artifact remove ID
  agent-ui artifact replace --file artifacts.json
  agent-ui artifact clear

Compatibility:
  agent-ui resource ...    Alias for agent-ui artifact ...
  agent-ui question ...    Question-only alias for agent-ui todo ...

Human to dos:
  agent-ui todo add ID TEXT [--blocking] [--timeout SECONDS]
  agent-ui todo ask ID TEXT [--choice VALUE ...] [--timeout SECONDS]
  agent-ui todo ask ID TEXT --non-blocking

Whole-screen and low-level updates:
  agent-ui publish --file presentation.json
  agent-ui publish --stdin
  agent-ui apply OPERATION JSON_PAYLOAD
  agent-ui demo

Global options:
  --output json|text|quiet|document
  --compact
  --source NAME
  --expected-revision N
  --idempotency-key KEY

Exit codes:
  0 success
  1 rejected input or missing presentation item
  2 retryable conflict
  3 blocking todo timed out or was cancelled
  4 bridge unavailable or authentication failed
  64 command usage error

The app injects AGENT_UI_ENDPOINT, AGENT_UI_TASK_ID, AGENT_UI_TOKEN,
AGENT_UI_PROTOCOL_VERSION, AGENT_UI_SOURCE, and AGENT_UI_CLI into each terminal.
No MCP setup is required.
`);
}

async function main() {
  let command = argv.shift();
  if (!command || ["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }
  if (command === "version" || command === "--version") {
    print({ name: "agent-ui", version: "0.2.0", protocol_version: protocolVersion }, "agent-ui 0.2.0");
    return;
  }
  if (command === "instructions") {
    ensureNoOptions();
    if (argv.length) usageError("instructions does not accept arguments");
    process.stdout.write(
      AGENT_INSTRUCTIONS.endsWith("\n")
        ? AGENT_INSTRUCTIONS
        : `${AGENT_INSTRUCTIONS}\n`,
    );
    return;
  }

  // Compact compatibility aliases for the original prototype CLI.
  if (command === "set-task") {
    argv.unshift("set");
    command = "task";
  } else if (command === "status") {
    argv.unshift("status");
    command = "task";
  } else if (command === "tasks") {
    argv.unshift("replace");
    command = "plan";
  } else if (command === "resources") {
    argv.unshift("replace");
    command = "resource";
  } else if (command === "ask") {
    argv.unshift("ask");
    command = "question";
  } else if (command === "op") {
    command = "apply";
  }

  if (command === "doctor") return doctor();
  if (command === "context") {
    const body = await context();
    print(body.document);
    return;
  }
  if (command === "task") return taskCommand(argv.shift());
  if (command === "plan") return planCommand(argv.shift());
  if (command === "summary") {
    const subcommand = ["get", "set", "clear"].includes(argv[0])
      ? argv.shift()
      : "set";
    return summaryCommand(subcommand);
  }
  if (command === "alert") {
    const subcommand = ["list", "raise", "upsert", "clear"].includes(argv[0])
      ? argv.shift()
      : "raise";
    return alertCommand(subcommand);
  }
  if (command === "resource") return artifactCommand(argv.shift(), "resource");
  if (command === "artifact") return artifactCommand(argv.shift());
  if (command === "todo") return todoCommand(argv.shift());
  if (command === "question") return questionCommand(argv.shift());
  if (command === "publish") return publishCommand();
  if (command === "demo") return demo();
  if (command === "apply") {
    const opType = argv.shift();
    if (!opType) usageError("apply requires OPERATION");
    const inline = takePositional();
    const payload = await readJsonInput(inline, "operation payload");
    ensureNoOptions();
    const body = await operate(opType, payload);
    printWrite(body, opType);
    return;
  }
  usageError(`unknown command: ${command}`);
}

main().catch((error) => {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError("internal_error", error.message || String(error), 1, false);
  const payload = {
    ok: false,
    error: {
      code: cliError.code,
      message: cliError.message,
      retryable: cliError.retryable,
    },
  };
  if (outputMode === "json" || outputMode === "document") {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else if (outputMode !== "quiet") {
    process.stderr.write(`agent-ui: ${cliError.code}: ${cliError.message}\n`);
  }
  process.exitCode = cliError.exitCode;
});
