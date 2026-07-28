import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";

const operations = [];
const idempotentResponses = new Map();
const taskId = "test-task";
const token = "test-token";
let document = {
  protocol_version: "1.0",
  revision: 0,
  updated_at: new Date().toISOString(),
  header: {
    title: "Untitled task",
    description: "",
    issue_url: "",
    source: "test",
    status: "idle",
    status_message: "",
  },
  tasks: [],
  questions: [],
  summary: { headline: "", sections: [], updated_at: new Date().toISOString() },
  alerts: [],
  resources: [],
};

function replaceById(items, replacement) {
  const index = items.findIndex((item) => item.id === replacement.id);
  if (index < 0) return [...items, replacement];
  return items.map((item, itemIndex) => (itemIndex === index ? replacement : item));
}

function applyOperation(operation) {
  const payload = operation.payload;
  switch (operation.op_type) {
    case "set_task":
      document.header = payload;
      break;
    case "set_task_status":
      document.header = {
        ...document.header,
        status: payload.status,
        status_message: payload.status_message ?? "",
      };
      break;
    case "replace_tasks":
      document.tasks = payload.tasks;
      break;
    case "upsert_task":
      document.tasks = replaceById(document.tasks, payload);
      break;
    case "ask_user":
      document.questions = replaceById(document.questions, {
        ...payload,
        answer: null,
        state: "open",
      });
      break;
    case "set_summary":
      document.summary = {
        ...payload,
        updated_at: new Date().toISOString(),
      };
      break;
    case "raise_alert":
      document.alerts = replaceById(document.alerts, payload);
      break;
    case "clear_alert": {
      const alert = document.alerts.find((item) => item.id === payload.id);
      if (!alert) throw new Error("alert_not_found");
      alert.state = "cleared";
      break;
    }
    case "replace_resources":
      document.resources = payload.resources;
      break;
    default:
      throw new Error(`unknown_operation: ${operation.op_type}`);
  }
  document = {
    ...document,
    revision: document.revision + 1,
    updated_at: new Date().toISOString(),
  };
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true, protocol_version: "1.0" });
    return;
  }
  if (
    request.headers.authorization !== `Bearer ${token}` ||
    request.headers["x-agent-ui-task-id"] !== taskId
  ) {
    json(response, 401, {
      ok: false,
      error: {
        code: "unauthorized",
        message: "invalid task token",
        retryable: false,
      },
    });
    return;
  }
  if (request.method === "GET" && request.url === "/v1/context") {
    json(response, 200, { ok: true, document });
    return;
  }
  if (request.method === "POST" && request.url === "/v1/operation") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const operation = body.operation;
    if (
      operation.expected_revision !== undefined &&
      operation.expected_revision !== document.revision
    ) {
      json(response, 409, {
        ok: false,
        error: {
          code: "revision_conflict",
          message: `expected ${operation.expected_revision}, current ${document.revision}`,
          retryable: true,
        },
      });
      return;
    }
    const prior = idempotentResponses.get(operation.idempotency_key);
    if (prior) {
      json(response, 200, prior);
      return;
    }
    operations.push(operation);
    applyOperation(operation);
    const result = { ok: true, document, wait: null };
    idempotentResponses.set(operation.idempotency_key, result);
    json(response, 200, result);
    return;
  }
  response.writeHead(404).end();
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const env = {
  ...process.env,
  AGENT_UI_ENDPOINT: `http://127.0.0.1:${address.port}`,
  AGENT_UI_TASK_ID: taskId,
  AGENT_UI_TOKEN: token,
  AGENT_UI_PROTOCOL_VERSION: "1.0",
  AGENT_UI_SOURCE: "bridge-test",
};

function runRaw(script, args = [], input = "", envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: new URL("..", import.meta.url),
      env: { ...env, ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function run(script, args = [], input = "") {
  const result = await runRaw(script, args, input);
  assert.equal(result.code, 0, `${script}: ${result.stderr}`);
  return result;
}

const help = await run("bin/agent-ui.mjs", ["help"]);
assert.match(help.stdout, /No MCP setup is required/);

const instructions = await run("bin/agent-ui.mjs", ["instructions"]);
assert.match(instructions.stdout, /^# Using Telemachus as an agent/);
assert.match(instructions.stdout, /## Alerts vs\. human to dos/);
assert.match(instructions.stdout, /## Recommended completion update/);

const doctor = await run("bin/agent-ui.mjs", ["doctor", "--compact"]);
assert.equal(JSON.parse(doctor.stdout).task_id, taskId);

await run("bin/agent-ui.mjs", [
  "task",
  "set",
  "--title",
  "CLI-driven task",
  "--issue-url",
  "https://github.com/openai/codex/issues/456",
  "--status",
  "working",
  "--message",
  "Updating the screen",
]);
assert.equal(document.header.title, "CLI-driven task");
assert.equal(
  document.header.issue_url,
  "https://github.com/openai/codex/issues/456",
);

await run("bin/agent-ui.mjs", [
  "plan",
  "add",
  "implement",
  "Implement the CLI",
  "--detail",
  "Cover every presentation panel.",
  "--status",
  "in_progress",
]);
await run("bin/agent-ui.mjs", [
  "plan",
  "update",
  "implement",
  "--status",
  "completed",
]);
assert.equal(document.tasks[0].status, "completed");
const plan = await run("bin/agent-ui.mjs", ["plan", "list", "--compact"]);
assert.equal(JSON.parse(plan.stdout)[0].id, "implement");

await run("bin/agent-ui.mjs", [
  "summary",
  "set",
  "--headline",
  "CLI ready",
  "--body",
  "Claude and Codex can now update the full presentation.",
  "--section",
  "Verification=Bridge integration passed.",
]);
assert.equal(document.summary.sections.length, 2);

await run("bin/agent-ui.mjs", [
  "alert",
  "raise",
  "review",
  "Review needed",
  "--severity",
  "warning",
  "--message",
  "Check the generated resource.",
]);
await run("bin/agent-ui.mjs", ["alert", "clear", "review"]);
assert.equal(document.alerts[0].state, "cleared");

await run("bin/agent-ui.mjs", [
  "resource",
  "add",
  "cli-docs",
  "CLI reference",
  "CLI.md",
  "--type",
  "path",
  "--status",
  "generated",
  "--meta",
  "owner=codex",
]);
await run("bin/agent-ui.mjs", [
  "resource",
  "update",
  "cli-docs",
  "--status",
  "inspected",
]);
assert.deepEqual(document.resources[0].metadata, { owner: "codex" });

await run("bin/agent-ui.mjs", [
  "artifact",
  "add",
  "web-spec",
  "Web specification",
  "https://example.com/spec",
  "--type",
  "web_document",
  "--status",
  "reported",
]);
await run("bin/agent-ui.mjs", [
  "artifact",
  "add",
  "pull-request",
  "Implementation PR",
  "https://github.com/openai/codex/pull/123",
  "--type",
  "github_pr",
]);
const artifacts = await run("bin/agent-ui.mjs", [
  "artifact",
  "list",
  "--compact",
]);
assert.deepEqual(
  JSON.parse(artifacts.stdout).map((artifact) => artifact.id),
  ["cli-docs", "web-spec", "pull-request"],
);
await run("bin/agent-ui.mjs", [
  "artifact",
  "update",
  "pull-request",
  "--meta",
  "github_state=closed",
]);
assert.equal(document.resources[2].metadata.github_state, "closed");
await run("bin/agent-ui.mjs", [
  "artifact",
  "update",
  "web-spec",
  "--status",
  "inspected",
]);
await run("bin/agent-ui.mjs", ["artifact", "remove", "web-spec"]);
await run("bin/agent-ui.mjs", ["artifact", "clear"]);
assert.equal(document.resources.length, 0);

await run("bin/agent-ui.mjs", [
  "todo",
  "add",
  "deploy",
  "Deploy the release to production",
]);
const actionTodo = await run("bin/agent-ui.mjs", [
  "todo",
  "get",
  "deploy",
  "--compact",
]);
assert.equal(JSON.parse(actionTodo.stdout).kind, "action");
const actionTodos = await run("bin/agent-ui.mjs", [
  "todo",
  "list",
  "--kind",
  "action",
  "--state",
  "open",
  "--compact",
]);
assert.deepEqual(
  JSON.parse(actionTodos.stdout).map((todo) => todo.id),
  ["deploy"],
);

await run("bin/agent-ui.mjs", [
  "todo",
  "ask",
  "rollout",
  "Which rollout?",
  "--choice",
  "Canary",
  "--choice",
  "All at once",
  "--non-blocking",
]);
const question = await run("bin/agent-ui.mjs", [
  "question",
  "get",
  "rollout",
  "--compact",
]);
assert.equal(JSON.parse(question.stdout).state, "open");
assert.equal(JSON.parse(question.stdout).kind, "question");
const legacyQuestionList = await run("bin/agent-ui.mjs", [
  "question",
  "list",
  "--compact",
]);
assert.deepEqual(
  JSON.parse(legacyQuestionList.stdout).map((todo) => todo.id),
  ["rollout"],
);

await run(
  "bin/agent-ui.mjs",
  ["publish", "--stdin", "--output", "document", "--compact"],
  JSON.stringify({
    task: {
      title: "Published screen",
      issue_url: "https://github.com/openai/codex/issues/789",
      status: "completed",
      status_message: "All panels updated",
    },
    plan: [{ id: "done", title: "Finish", status: "completed" }],
    summary: {
      headline: "Finished",
      sections: [{ id: "result", heading: "Result", body: "Success." }],
    },
    alerts: [],
    artifacts: [
      {
        id: "artifact",
        type: "web_document",
        label: "Published artifact",
        path_or_url: "https://example.com/artifact",
        status: "generated",
      },
    ],
  }),
);
assert.equal(document.header.status, "completed");
assert.equal(
  document.header.issue_url,
  "https://github.com/openai/codex/issues/789",
);
assert.equal(document.tasks[0].id, "done");
assert.equal(document.resources[0].id, "artifact");

await run("bin/agent-ui.mjs", [
  "apply",
  "set_task_status",
  '{"status":"waiting","status_message":"Low-level operation"}',
]);
assert.equal(document.header.status, "waiting");

const stale = await runRaw("bin/agent-ui.mjs", [
  "task",
  "status",
  "working",
  "--expected-revision",
  "0",
]);
assert.equal(stale.code, 2);
assert.equal(JSON.parse(stale.stderr).error.code, "revision_conflict");

const missingContext = await runRaw(
  "bin/agent-ui.mjs",
  ["context"],
  "",
  {
    AGENT_UI_ENDPOINT: "",
    AGENT_UI_TASK_ID: "",
    AGENT_UI_TOKEN: "",
  },
);
assert.equal(missingContext.code, 4);
assert.equal(JSON.parse(missingContext.stderr).error.code, "missing_task_context");

const idempotencyKey = "stable-test-key";
const firstIdempotent = await run("bin/agent-ui.mjs", [
  "task",
  "status",
  "working",
  "--idempotency-key",
  idempotencyKey,
]);
const firstRevision = JSON.parse(firstIdempotent.stdout).revision;
const secondIdempotent = await run("bin/agent-ui.mjs", [
  "task",
  "status",
  "working",
  "--idempotency-key",
  idempotencyKey,
]);
assert.equal(JSON.parse(secondIdempotent.stdout).revision, firstRevision);

const mcp = await run(
  "bin/agent-ui-mcp.mjs",
  [],
  [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_task_context", arguments: {} },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "add_todo",
        arguments: {
          id: "mcp-review",
          text: "Review the MCP-generated artifact",
        },
      },
    }),
  ].join("\n") + "\n",
);
const responses = mcp.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(responses[0].result.serverInfo.name, "agent-ui");
assert.equal(responses[1].result.tools.length, 13);
assert.equal(responses[2].result.structuredContent.protocol_version, "1.0");
assert.equal(
  responses[3].result.structuredContent.questions.find(
    (todo) => todo.id === "mcp-review",
  ).kind,
  "action",
);

assert.ok(operations.every((operation) => operation.task_id === taskId));
assert.ok(operations.every((operation) => operation.idempotency_key));
assert.ok(
  operations.every((operation) =>
    ["bridge-test", "agent-ui-mcp"].includes(operation.source),
  ),
);
assert.equal(operations.at(-1).source, "agent-ui-mcp");

server.close();
await once(server, "close");
process.stdout.write(
  `Agent UI CLI and optional MCP adapter passed ${operations.length} bridge operations.\n`,
);
