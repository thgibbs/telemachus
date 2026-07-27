export type TaskStatus =
  | "idle"
  | "working"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type ItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "skipped";

export type QuestionState =
  | "open"
  | "answered"
  | "completed"
  | "timed_out"
  | "cancelled";
export type TodoKind = "question" | "action";
export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "active" | "acknowledged" | "cleared";
export type ResourceStatus =
  | "reported"
  | "inspected"
  | "modified"
  | "generated"
  | "unavailable";

export interface TaskHeader {
  title: string;
  description: string;
  issue_url: string;
  source: string;
  status: TaskStatus;
  status_message: string;
}

export interface PresentedTask {
  id: string;
  title: string;
  detail: string;
  status: ItemStatus;
  order: number;
}

export interface TodoItem {
  id: string;
  kind: TodoKind;
  text: string;
  blocking: boolean;
  choices: string[];
  allow_free_text: boolean;
  answer: string | null;
  state: QuestionState;
  created_at: string;
}

export type Question = TodoItem;

export interface SummarySection {
  id: string;
  heading: string;
  body: string;
}

export interface TaskSummary {
  headline: string;
  sections: SummarySection[];
  updated_at: string;
}

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  state: AlertState;
}

export interface Resource {
  id: string;
  type:
    | "path"
    | "url"
    | "note"
    | "local_document"
    | "web_document"
    | "github_pr";
  label: string;
  path_or_url: string;
  status: ResourceStatus;
  metadata: Record<string, string>;
}

export interface PresentationDocument {
  protocol_version: string;
  revision: number;
  updated_at: string;
  header: TaskHeader;
  tasks: PresentedTask[];
  questions: TodoItem[];
  summary: TaskSummary;
  alerts: Alert[];
  resources: Resource[];
}

export interface TaskSession {
  id: string;
  title: string;
  status: TaskStatus;
  status_message: string;
  attention: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  layout: {
    left_width: number;
    right_width: number;
    left_collapsed: boolean;
    right_collapsed: boolean;
  };
}

export interface Operation {
  protocol_version: "1.0";
  task_id: string;
  source: string;
  op_type:
    | "set_task"
    | "set_task_status"
    | "replace_tasks"
    | "upsert_task"
    | "ask_user"
    | "set_summary"
    | "raise_alert"
    | "clear_alert"
    | "replace_resources";
  payload: unknown;
  expected_revision?: number;
  idempotency_key?: string;
}

export interface BridgeInfo {
  endpoint: string;
  protocol_version: string;
  token: string;
}

export interface TerminalOutput {
  session_id: string;
  offset: number;
  data: number[];
}

export interface TerminalSnapshot {
  session_id: string;
  start_offset: number;
  next_offset: number;
  data: number[];
}

export interface ScratchpadState {
  content: string;
  collapsed: boolean;
  updated_at: string;
}

export interface PresentationUpdate {
  task_id: string;
  source?: string;
  op_type?: string;
}

export const emptyDocument = (taskId: string): PresentationDocument => ({
  protocol_version: "1.0",
  revision: 0,
  updated_at: new Date().toISOString(),
  header: {
    title: "Untitled task",
    description: "",
    issue_url: "",
    source: "human",
    status: "idle",
    status_message: "",
  },
  tasks: [],
  questions: [],
  summary: { headline: "", sections: [], updated_at: new Date().toISOString() },
  alerts: [],
  resources: [],
});

export const statusLabel: Record<TaskStatus | ItemStatus, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  pending: "Pending",
  in_progress: "In progress",
  skipped: "Skipped",
};
