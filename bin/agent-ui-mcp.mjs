#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import readline from "node:readline";

const endpoint = process.env.AGENT_UI_ENDPOINT;
const taskId = process.env.AGENT_UI_TASK_ID;
const token =
  process.env.AGENT_UI_CREDENTIAL || process.env.AGENT_UI_TOKEN;
const protocolVersion = process.env.AGENT_UI_PROTOCOL_VERSION || "1.0";

if (!endpoint || !taskId || !token) {
  process.stderr.write(
    "agent-ui-mcp: run inside an Agent UI terminal so scoped context is inherited\n",
  );
  process.exit(1);
}

const tools = [
  {
    name: "set_task",
    description: "Set the task identity and high-level state presented in Agent UI.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        source: { type: "string" },
        status: {
          type: "string",
          enum: ["idle", "working", "waiting", "blocked", "completed", "failed", "cancelled"],
        },
        status_message: { type: "string" },
      },
    },
  },
  {
    name: "set_task_status",
    description: "Update the current task status and optional status message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["idle", "working", "waiting", "blocked", "completed", "failed", "cancelled"],
        },
        status_message: { type: "string" },
      },
    },
  },
  {
    name: "replace_tasks",
    description: "Authoritatively replace the presented task plan.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tasks"],
      properties: { tasks: { type: "array", items: { $ref: "#/$defs/task" } } },
      $defs: {
        task: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "status", "order"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            detail: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "blocked", "skipped"],
            },
            order: { type: "integer" },
          },
        },
      },
    },
  },
  {
    name: "upsert_task",
    description: "Create or replace one presented task item by stable ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "status", "order"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        detail: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "blocked", "skipped"],
        },
        order: { type: "integer" },
      },
    },
  },
  {
    name: "add_todo",
    description:
      "Add an action the human needs to complete, such as deploying, merging, or reviewing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "text"],
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        blocking: { type: "boolean", default: false },
        wait_seconds: { type: "integer", minimum: 0, maximum: 3600, default: 300 },
      },
    },
  },
  {
    name: "get_todo",
    description: "Read an action from the human To do pane.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "set_summary",
    description: "Replace the structured task summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["headline", "sections"],
      properties: {
        headline: { type: "string" },
        sections: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "raise_alert",
    description: "Create or update a persistent alert by stable ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "severity", "title"],
      properties: {
        id: { type: "string" },
        severity: { type: "string", enum: ["info", "warning", "critical"] },
        title: { type: "string" },
        message: { type: "string" },
      },
    },
  },
  {
    name: "clear_alert",
    description: "Clear a persistent alert by stable ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "replace_resources",
    description: "Authoritatively replace agent-supplied resource references.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resources"],
      properties: { resources: { type: "array", items: { type: "object" } } },
    },
  },
  {
    name: "get_task_context",
    description: "Read the current task-scoped presentation document.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

async function request(path, init = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-ui-task-id": taskId,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body.error?.message || `HTTP ${response.status}`);
  }
  return body;
}

async function callTool(name, input = {}) {
  if (name === "get_task_context") {
    return (await request("/v1/context")).document;
  }
  if (name === "get_todo") {
    const document = (await request("/v1/context")).document;
    const todo =
      document.questions.find((question) => question.id === input.id) ?? null;
    return todo ? { ...todo, kind: "action" } : null;
  }
  const isAction = name === "add_todo";
  const blocking = isAction ? input.blocking ?? false : false;
  const waitSeconds =
    isAction && blocking
      ? input.wait_seconds ?? 300
      : undefined;
  const payload = isAction
    ? {
        id: input.id,
        kind: "action",
        text: input.text,
        blocking,
        choices: [],
        allow_free_text: false,
        answer: null,
        state: "open",
        created_at: new Date().toISOString(),
      }
      : name === "raise_alert"
        ? { state: "active", message: "", ...input }
        : input;
  const body = await request("/v1/operation", {
    method: "POST",
    body: JSON.stringify({
      operation: {
        protocol_version: protocolVersion,
        task_id: taskId,
        source: "agent-ui-mcp",
        op_type: isAction ? "ask_user" : name,
        payload,
        idempotency_key: randomUUID(),
      },
      ...(waitSeconds ? { wait_seconds: waitSeconds } : {}),
    }),
  });
  return body.wait ?? body.document;
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function reject(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    reject(null, -32700, "Parse error");
    continue;
  }
  if (!("id" in message)) continue;
  try {
    switch (message.method) {
      case "initialize":
        respond(message.id, {
          protocolVersion: message.params?.protocolVersion || "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agent-ui", version: "0.1.0" },
        });
        break;
      case "ping":
        respond(message.id, {});
        break;
      case "tools/list":
        respond(message.id, { tools });
        break;
      case "tools/call": {
        const result = await callTool(
          message.params?.name,
          message.params?.arguments || {},
        );
        respond(message.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
        break;
      }
      default:
        reject(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    respond(message.id, {
      content: [{ type: "text", text: String(error.message || error) }],
      isError: true,
    });
  }
}
