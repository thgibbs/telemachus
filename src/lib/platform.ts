import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Alert,
  BridgeInfo,
  Operation,
  PresentationDocument,
  PresentationUpdate,
  PresentedTask,
  Question,
  ReviewProvider,
  Resource,
  ScratchpadState,
  TaskSummary,
  TaskSession,
  TerminalOutput,
  TerminalSnapshot,
} from "../types";
import { emptyDocument } from "../types";

const browserTasksKey = "agent-ui-browser-tasks";
const browserDocsKey = "agent-ui-browser-documents";
const browserActiveTaskKey = "agent-ui-browser-active-task";
const browserScratchpadsKey = "agent-ui-browser-scratchpads";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

const readBrowserTasks = (): TaskSession[] =>
  JSON.parse(localStorage.getItem(browserTasksKey) ?? "[]");

const readBrowserDocs = (): Record<string, PresentationDocument> =>
  JSON.parse(localStorage.getItem(browserDocsKey) ?? "{}");

const storeBrowserTasks = (tasks: TaskSession[]) =>
  localStorage.setItem(browserTasksKey, JSON.stringify(tasks));

const storeBrowserDocs = (docs: Record<string, PresentationDocument>) =>
  localStorage.setItem(browserDocsKey, JSON.stringify(docs));

const readBrowserScratchpads = (): Record<string, ScratchpadState> =>
  JSON.parse(localStorage.getItem(browserScratchpadsKey) ?? "{}");

const attentionFor = (doc: PresentationDocument) =>
  doc.questions.some((q) => q.state === "open" && q.blocking) ||
  doc.alerts.some((a) => a.state === "active" && a.severity === "critical");

export async function listTasks(): Promise<TaskSession[]> {
  if (isTauri()) return invoke("list_tasks");
  return readBrowserTasks();
}

export async function createTask(
  startingDirectory?: string,
): Promise<TaskSession> {
  if (isTauri()) return invoke("create_task", { startingDirectory });
  const now = new Date().toISOString();
  const task: TaskSession = {
    id: crypto.randomUUID(),
    title: "Untitled task",
    status: "idle",
    status_message: "",
    attention: false,
    archived: false,
    created_at: now,
    updated_at: now,
    layout: {
      left_width: 286,
      right_width: 330,
      left_collapsed: false,
      right_collapsed: false,
    },
  };
  const tasks = [...readBrowserTasks(), task];
  const docs = readBrowserDocs();
  docs[task.id] = emptyDocument(task.id);
  storeBrowserTasks(tasks);
  storeBrowserDocs(docs);
  window.dispatchEvent(
    new CustomEvent("browser-presentation-updated", {
      detail: { task_id: task.id },
    }),
  );
  return task;
}

export async function closeTask(taskId: string): Promise<void> {
  if (isTauri()) return invoke("close_task", { taskId });
  storeBrowserTasks(readBrowserTasks().filter((task) => task.id !== taskId));
  const docs = readBrowserDocs();
  delete docs[taskId];
  storeBrowserDocs(docs);
  const scratchpads = readBrowserScratchpads();
  delete scratchpads[taskId];
  localStorage.setItem(browserScratchpadsKey, JSON.stringify(scratchpads));
}

export async function getActiveTask(): Promise<string | null> {
  if (isTauri()) return invoke("get_active_task");
  return localStorage.getItem(browserActiveTaskKey);
}

export async function setActiveTask(taskId: string): Promise<void> {
  if (isTauri()) return invoke("set_active_task", { taskId });
  localStorage.setItem(browserActiveTaskKey, taskId);
}

export async function getDocument(
  taskId: string,
): Promise<PresentationDocument> {
  if (isTauri()) return invoke("get_document", { taskId });
  return readBrowserDocs()[taskId] ?? emptyDocument(taskId);
}

function applyBrowserOperation(
  doc: PresentationDocument,
  operation: Operation,
): PresentationDocument {
  const payload = operation.payload as Record<string, any>;
  const next = structuredClone(doc);
  switch (operation.op_type) {
    case "set_task":
      next.header = { ...next.header, ...payload };
      break;
    case "set_task_status":
      next.header.status = payload.status;
      next.header.status_message = payload.status_message ?? "";
      break;
    case "set_agent_session":
      next.header.agent_session = {
        provider: payload.provider,
        session_id: payload.session_id,
        cwd: payload.cwd,
        model: payload.model ?? "",
        start_source: payload.start_source ?? "",
        updated_at: new Date().toISOString(),
      };
      break;
    case "replace_tasks":
      next.tasks = payload.tasks;
      break;
    case "upsert_task": {
      const index = next.tasks.findIndex((item) => item.id === payload.id);
      const task = payload as PresentedTask;
      if (index >= 0) next.tasks[index] = { ...next.tasks[index], ...task };
      else next.tasks.push(task);
      break;
    }
    case "ask_user": {
      const index = next.questions.findIndex((item) => item.id === payload.id);
      const incoming = payload as unknown as Partial<Question> &
        Pick<Question, "id" | "text">;
      const question: Question = {
        id: incoming.id,
        kind: incoming.kind ?? "question",
        text: incoming.text,
        choices: incoming.kind === "action" ? [] : (incoming.choices ?? []),
        allow_free_text:
          incoming.kind === "action"
            ? false
            : (incoming.allow_free_text ?? true),
        blocking: incoming.blocking ?? true,
        answer: incoming.answer ?? null,
        state: incoming.state ?? "open",
        created_at: incoming.created_at ?? new Date().toISOString(),
      };
      if (index >= 0) next.questions[index] = question;
      else next.questions.push(question);
      break;
    }
    case "set_summary":
      next.summary = {
        ...(payload as unknown as TaskSummary),
        updated_at: new Date().toISOString(),
      };
      break;
    case "raise_alert": {
      const index = next.alerts.findIndex((item) => item.id === payload.id);
      const incoming = payload as unknown as Alert;
      const alert: Alert = {
        ...incoming,
        state: incoming.state ?? "active",
      };
      if (index >= 0) next.alerts[index] = alert;
      else next.alerts.push(alert);
      break;
    }
    case "clear_alert":
      next.alerts = next.alerts.map((item) =>
        item.id === payload.id ? { ...item, state: "cleared" } : item,
      );
      break;
    case "replace_resources":
      next.resources = payload.resources;
      break;
  }
  next.revision += 1;
  next.updated_at = new Date().toISOString();
  return next;
}

export async function applyOperation(
  operation: Operation,
): Promise<PresentationDocument> {
  if (isTauri()) return invoke("apply_operation", { operation });
  const docs = readBrowserDocs();
  const next = applyBrowserOperation(
    docs[operation.task_id] ?? emptyDocument(operation.task_id),
    operation,
  );
  docs[operation.task_id] = next;
  storeBrowserDocs(docs);
  const tasks = readBrowserTasks().map((task) =>
    task.id === operation.task_id
      ? {
          ...task,
          title: next.header.title,
          status: next.header.status,
          status_message: next.header.status_message,
          attention: attentionFor(next),
          updated_at: next.updated_at,
        }
      : task,
  );
  storeBrowserTasks(tasks);
  window.dispatchEvent(
    new CustomEvent("browser-presentation-updated", {
      detail: {
        task_id: operation.task_id,
        source: operation.source,
        op_type: operation.op_type,
      },
    }),
  );
  return next;
}

export async function answerQuestion(
  taskId: string,
  questionId: string,
  answer: string,
): Promise<PresentationDocument> {
  if (isTauri())
    return invoke("answer_question", { taskId, questionId, answer });
  const docs = readBrowserDocs();
  const next = structuredClone(docs[taskId] ?? emptyDocument(taskId));
  next.questions = next.questions.map((q) =>
    q.id === questionId ? { ...q, answer, state: "answered" as const } : q,
  );
  next.revision += 1;
  next.updated_at = new Date().toISOString();
  docs[taskId] = next;
  storeBrowserDocs(docs);
  window.dispatchEvent(
    new CustomEvent("browser-presentation-updated", {
      detail: {
        task_id: taskId,
        source: "human",
        op_type: "answer_question",
      },
    }),
  );
  return next;
}

export async function completeTodo(
  taskId: string,
  todoId: string,
): Promise<PresentationDocument> {
  if (isTauri()) return invoke("complete_todo", { taskId, todoId });
  const docs = readBrowserDocs();
  const next = structuredClone(docs[taskId] ?? emptyDocument(taskId));
  next.questions = next.questions.map((todo) =>
    todo.id === todoId
      ? { ...todo, answer: null, state: "completed" as const }
      : todo,
  );
  next.revision += 1;
  next.updated_at = new Date().toISOString();
  docs[taskId] = next;
  storeBrowserDocs(docs);
  window.dispatchEvent(
    new CustomEvent("browser-presentation-updated", {
      detail: {
        task_id: taskId,
        source: "human",
        op_type: "complete_todo",
      },
    }),
  );
  return next;
}

export async function updateLayout(
  taskId: string,
  layout: TaskSession["layout"],
): Promise<void> {
  if (isTauri()) return invoke("update_layout", { taskId, layout });
  storeBrowserTasks(
    readBrowserTasks().map((task) =>
      task.id === taskId ? { ...task, layout } : task,
    ),
  );
}

export async function getScratchpad(taskId: string): Promise<ScratchpadState> {
  if (isTauri()) return invoke("get_scratchpad", { taskId });
  return (
    readBrowserScratchpads()[taskId] ?? {
      content: "",
      collapsed: true,
      updated_at: "",
    }
  );
}

export async function updateScratchpad(
  taskId: string,
  content: string,
  collapsed: boolean,
): Promise<ScratchpadState> {
  if (isTauri()) {
    return invoke("update_scratchpad", { taskId, content, collapsed });
  }
  const scratchpads = readBrowserScratchpads();
  const next = {
    content,
    collapsed,
    updated_at: new Date().toISOString(),
  };
  scratchpads[taskId] = next;
  localStorage.setItem(browserScratchpadsKey, JSON.stringify(scratchpads));
  return next;
}

export async function createTerminal(
  taskId: string,
  startingDirectory?: string,
): Promise<string> {
  if (isTauri())
    return invoke("create_terminal", { taskId, startingDirectory });
  throw new Error(
    "Desktop host required. Start Telemachus with `npm run desktop`; the browser preview cannot create a local shell.",
  );
}

export async function getTerminalSnapshot(
  sessionId: string,
): Promise<TerminalSnapshot> {
  if (isTauri()) return invoke("get_terminal_snapshot", { sessionId });
  return {
    session_id: sessionId,
    start_offset: 0,
    next_offset: 0,
    data: [],
  };
}

export async function writeTerminal(
  sessionId: string,
  data: number[],
): Promise<void> {
  if (isTauri()) return invoke("write_terminal", { sessionId, data });
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (isTauri())
    return invoke("resize_terminal", { sessionId, cols, rows });
}

export async function closeTerminal(sessionId: string): Promise<void> {
  if (isTauri()) return invoke("close_terminal", { sessionId });
}

export async function getBridgeInfo(taskId: string): Promise<BridgeInfo> {
  if (isTauri()) return invoke("get_bridge_info", { taskId });
  return {
    endpoint: "http://127.0.0.1:47832",
    protocol_version: "1.0",
    token: "available-in-desktop-app",
  };
}

export async function openArtifact(resource: Resource): Promise<void> {
  if (isTauri()) {
    return invoke("open_artifact", {
      artifactType: resource.type,
      target: resource.path_or_url,
    });
  }
  if (resource.type === "local_document") {
    throw new Error("Local documents open in Zed from the desktop app.");
  }
  const opened = window.open(
    resource.path_or_url,
    "_blank",
    "noopener,noreferrer",
  );
  if (!opened) throw new Error("The browser blocked the artifact link.");
}

export async function getClosedGithubPullRequests(
  targets: string[],
): Promise<string[]> {
  if (isTauri()) {
    return invoke("get_closed_github_pull_requests", { targets });
  }
  return [];
}

export async function discoverOpenGithubPullRequests(
  taskId: string,
  sessionId: string,
  renderedOutput: string,
): Promise<PresentationDocument | null> {
  if (isTauri()) {
    return invoke("discover_open_github_pull_requests", {
      taskId,
      sessionId,
      renderedOutput,
    });
  }
  return null;
}

export async function launchArtifactReview(
  sourceTaskId: string,
  resources: Resource[],
  issueUrl: string,
  reviewer: ReviewProvider,
): Promise<string> {
  if (isTauri()) {
    return invoke("launch_artifact_review", {
      sourceTaskId,
      prUrls: resources
        .filter((resource) => resource.type === "github_pr")
        .map((resource) => resource.path_or_url),
      documentPaths: resources
        .filter((resource) => resource.type === "local_document")
        .map((resource) => resource.path_or_url),
      issueUrl,
      reviewer,
    });
  }
  throw new Error(
    "Desktop host required. Start Telemachus with `npm run desktop` to launch a review.",
  );
}

export async function cancelArtifactReview(
  sourceTaskId: string,
  reviewRunId: string,
): Promise<PresentationDocument> {
  if (isTauri()) {
    return invoke("cancel_artifact_review", {
      sourceTaskId,
      reviewRunId,
    });
  }
  throw new Error(
    "Desktop host required. Start Telemachus with `npm run desktop` to cancel a review.",
  );
}

export async function onPresentationUpdated(
  callback: (update: PresentationUpdate) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return listen<PresentationUpdate>("presentation-updated", (event) =>
      callback(event.payload),
    );
  }
  const listener = (event: Event) =>
    callback((event as CustomEvent<PresentationUpdate>).detail);
  window.addEventListener("browser-presentation-updated", listener);
  return () =>
    window.removeEventListener("browser-presentation-updated", listener);
}

export async function onTerminalOutput(
  callback: (payload: TerminalOutput) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return listen<TerminalOutput>("terminal-output", (event) =>
      callback(event.payload),
    );
  }
  return () => undefined;
}
