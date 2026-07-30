#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use rand::{distributions::Alphanumeric, Rng};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command as ProcessCommand, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

const PROTOCOL_VERSION: &str = "1.0";
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_COLLECTION: usize = 500;
const MAX_STRING: usize = 64 * 1024;
const MAX_SCRATCHPAD: usize = 256 * 1024;
const MAX_TERMINAL_BUFFER: usize = 2 * 1024 * 1024;
const CODEX_REVIEW_MODEL: &str = "gpt-5.6-sol";
const CODEX_REVIEW_REASONING_CONFIG: &str = "model_reasoning_effort=high";
const AGENT_UI_CLI: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../bin/agent-ui.mjs"));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskHeader {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub issue_url: String,
    #[serde(default = "human_source")]
    pub source: String,
    #[serde(default)]
    pub status: TaskStatus,
    #[serde(default)]
    pub status_message: String,
}

fn human_source() -> String {
    "human".into()
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    #[default]
    Idle,
    Working,
    Waiting,
    Blocked,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PresentedTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    pub status: ItemStatus,
    pub order: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionState {
    Open,
    Answered,
    Completed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TodoKind {
    #[default]
    Question,
    Action,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    #[serde(default)]
    pub kind: TodoKind,
    pub text: String,
    #[serde(default = "default_true")]
    pub blocking: bool,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default = "default_true")]
    pub allow_free_text: bool,
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default = "open_question")]
    pub state: QuestionState,
    #[serde(default = "now")]
    pub created_at: String,
}

fn default_true() -> bool {
    true
}

fn open_question() -> QuestionState {
    QuestionState::Open
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SummarySection {
    pub id: String,
    #[serde(default)]
    pub heading: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct TaskSummary {
    #[serde(default)]
    pub headline: String,
    #[serde(default)]
    pub sections: Vec<SummarySection>,
    #[serde(default = "now")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlertSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlertState {
    Active,
    Acknowledged,
    Cleared,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Alert {
    pub id: String,
    pub severity: AlertSeverity,
    pub title: String,
    #[serde(default)]
    pub message: String,
    #[serde(default = "active_alert")]
    pub state: AlertState,
}

fn active_alert() -> AlertState {
    AlertState::Active
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceStatus {
    Reported,
    Inspected,
    Modified,
    Generated,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub id: String,
    #[serde(rename = "type")]
    pub resource_type: String,
    pub label: String,
    pub path_or_url: String,
    pub status: ResourceStatus,
    #[serde(default)]
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PresentationDocument {
    pub protocol_version: String,
    pub revision: u64,
    pub updated_at: String,
    pub header: TaskHeader,
    pub tasks: Vec<PresentedTask>,
    pub questions: Vec<Question>,
    pub summary: TaskSummary,
    pub alerts: Vec<Alert>,
    pub resources: Vec<Resource>,
}

impl Default for PresentationDocument {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.into(),
            revision: 0,
            updated_at: now(),
            header: TaskHeader {
                title: "Untitled task".into(),
                description: String::new(),
                issue_url: String::new(),
                source: "human".into(),
                status: TaskStatus::Idle,
                status_message: String::new(),
            },
            tasks: Vec::new(),
            questions: Vec::new(),
            summary: TaskSummary::default(),
            alerts: Vec::new(),
            resources: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layout {
    pub left_width: f64,
    pub right_width: f64,
    pub left_collapsed: bool,
    pub right_collapsed: bool,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            left_width: 286.0,
            right_width: 330.0,
            left_collapsed: false,
            right_collapsed: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScratchpadState {
    pub content: String,
    pub collapsed: bool,
    pub updated_at: String,
}

impl Default for ScratchpadState {
    fn default() -> Self {
        Self {
            content: String::new(),
            collapsed: true,
            updated_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskSession {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub status_message: String,
    pub attention: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub layout: Layout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub protocol_version: String,
    pub task_id: String,
    pub source: String,
    pub op_type: String,
    pub payload: Value,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutput {
    pub session_id: String,
    pub offset: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSnapshot {
    pub session_id: String,
    pub start_offset: u64,
    pub next_offset: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeInfo {
    pub endpoint: String,
    pub protocol_version: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitResult {
    pub status: String,
    pub answer: Option<String>,
    pub question_id: String,
}

struct TerminalSession {
    task_id: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    output: Mutex<TerminalBuffer>,
}

#[derive(Clone)]
struct ActiveReview {
    source_task_id: String,
    targets: Vec<String>,
    started_at: String,
    child: Arc<Mutex<Child>>,
    cancel_requested: Arc<AtomicBool>,
}

#[derive(Default)]
struct TerminalBuffer {
    start_offset: u64,
    next_offset: u64,
    data: VecDeque<u8>,
}

impl TerminalBuffer {
    fn append(&mut self, data: &[u8]) -> u64 {
        let offset = self.next_offset;
        self.next_offset += data.len() as u64;
        self.data.extend(data);
        let overflow = self.data.len().saturating_sub(MAX_TERMINAL_BUFFER);
        self.data.drain(..overflow);
        self.start_offset += overflow as u64;
        offset
    }

    fn snapshot(&self, session_id: String) -> TerminalSnapshot {
        TerminalSnapshot {
            session_id,
            start_offset: self.start_offset,
            next_offset: self.next_offset,
            data: self.data.iter().copied().collect(),
        }
    }
}

pub struct AppState {
    db: Mutex<Connection>,
    terminals: Mutex<HashMap<String, Arc<TerminalSession>>>,
    active_reviews: Mutex<HashMap<String, ActiveReview>>,
    closed_terminal_pull_requests: Mutex<HashMap<String, HashSet<String>>>,
    tokens: Mutex<HashMap<String, String>>,
    bridge_endpoint: RwLock<String>,
    waiters: Mutex<HashMap<String, oneshot::Sender<WaitResult>>>,
    app_handle: Mutex<Option<AppHandle>>,
    cli_path: PathBuf,
    cli_bin_dir: PathBuf,
}

impl AppState {
    fn new(db_path: &Path, cli_path: PathBuf, cli_bin_dir: PathBuf) -> Result<Self, String> {
        let connection = Connection::open(db_path).map_err(display_error)?;
        migrate(&connection)?;
        Ok(Self {
            db: Mutex::new(connection),
            terminals: Mutex::new(HashMap::new()),
            active_reviews: Mutex::new(HashMap::new()),
            closed_terminal_pull_requests: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            bridge_endpoint: RwLock::new(String::new()),
            waiters: Mutex::new(HashMap::new()),
            app_handle: Mutex::new(None),
            cli_path,
            cli_bin_dir,
        })
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        Self {
            db: Mutex::new(connection),
            terminals: Mutex::new(HashMap::new()),
            active_reviews: Mutex::new(HashMap::new()),
            closed_terminal_pull_requests: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            bridge_endpoint: RwLock::new("http://127.0.0.1:1".into()),
            waiters: Mutex::new(HashMap::new()),
            app_handle: Mutex::new(None),
            cli_path: PathBuf::from("/tmp/agent-ui"),
            cli_bin_dir: PathBuf::from("/tmp"),
        }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY,
              document_json TEXT NOT NULL,
              layout_json TEXT NOT NULL,
              starting_directory TEXT,
              archived INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS idempotency (
              task_id TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              response_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY (task_id, idempotency_key),
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scratchpads (
              task_id TEXT PRIMARY KEY,
              content TEXT NOT NULL DEFAULT '',
              collapsed INTEGER NOT NULL DEFAULT 1,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );
            PRAGMA user_version = 2;
            ",
        )
        .map_err(display_error)
}

fn task_exists(state: &AppState, task_id: &str) -> Result<bool, String> {
    let connection = state.db.lock().map_err(display_error)?;
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
            [task_id],
            |row| row.get(0),
        )
        .map_err(display_error)
}

#[tauri::command]
fn list_tasks(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<TaskSession>, String> {
    list_tasks_core(&state)
}

fn list_tasks_core(state: &AppState) -> Result<Vec<TaskSession>, String> {
    let connection = state.db.lock().map_err(display_error)?;
    let mut statement = connection
        .prepare(
            "SELECT id, document_json, layout_json, archived, created_at, updated_at
             FROM tasks WHERE archived = 0 ORDER BY created_at ASC",
        )
        .map_err(display_error)?;
    let rows = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let document_json: String = row.get(1)?;
            let layout_json: String = row.get(2)?;
            let archived: bool = row.get(3)?;
            let created_at: String = row.get(4)?;
            let updated_at: String = row.get(5)?;
            Ok((
                id,
                document_json,
                layout_json,
                archived,
                created_at,
                updated_at,
            ))
        })
        .map_err(display_error)?;

    let mut result = Vec::new();
    for row in rows {
        let (id, document_json, layout_json, archived, created_at, updated_at) =
            row.map_err(display_error)?;
        let document: PresentationDocument =
            serde_json::from_str(&document_json).map_err(display_error)?;
        let layout: Layout = serde_json::from_str(&layout_json).map_err(display_error)?;
        result.push(TaskSession {
            id,
            title: document.header.title.clone(),
            status: document.header.status,
            status_message: document.header.status_message.clone(),
            attention: has_attention(&document),
            archived,
            created_at,
            updated_at,
            layout,
        });
    }
    Ok(result)
}

#[tauri::command]
fn create_task(
    state: tauri::State<'_, Arc<AppState>>,
    starting_directory: Option<String>,
) -> Result<TaskSession, String> {
    create_task_core(&state, starting_directory)
}

fn create_task_core(
    state: &AppState,
    starting_directory: Option<String>,
) -> Result<TaskSession, String> {
    if let Some(directory) = starting_directory.as_deref() {
        validate_directory(directory)?;
    }
    let id = Uuid::new_v4().to_string();
    let document = PresentationDocument::default();
    let layout = Layout::default();
    let timestamp = now();
    let document_json = serde_json::to_string(&document).map_err(display_error)?;
    let layout_json = serde_json::to_string(&layout).map_err(display_error)?;
    let connection = state.db.lock().map_err(display_error)?;
    connection
        .execute(
            "INSERT INTO tasks (
               id, document_json, layout_json, starting_directory, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                id,
                document_json,
                layout_json,
                starting_directory,
                timestamp
            ],
        )
        .map_err(display_error)?;
    drop(connection);
    Ok(TaskSession {
        id,
        title: document.header.title,
        status: document.header.status,
        status_message: document.header.status_message,
        attention: false,
        archived: false,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        layout,
    })
}

#[tauri::command]
fn close_task(state: tauri::State<'_, Arc<AppState>>, task_id: String) -> Result<(), String> {
    stop_active_reviews_for_task(&state, &task_id)?;
    let sessions: Vec<String> = state
        .terminals
        .lock()
        .map_err(display_error)?
        .iter()
        .filter(|(_, session)| session.task_id == task_id)
        .map(|(id, _)| id.clone())
        .collect();
    for session_id in sessions {
        close_terminal_core(&state, &session_id)?;
    }
    state.tokens.lock().map_err(display_error)?.remove(&task_id);
    cancel_waiters(&state, &task_id, "task_closed")?;
    let connection = state.db.lock().map_err(display_error)?;
    let starting_directory: Option<String> = connection
        .query_row(
            "SELECT starting_directory FROM tasks WHERE id = ?1",
            [&task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(display_error)?
        .flatten();
    connection
        .execute(
            "DELETE FROM settings WHERE key = 'active_task' AND value = ?1",
            [&task_id],
        )
        .map_err(display_error)?;
    connection
        .execute("DELETE FROM tasks WHERE id = ?1", [task_id])
        .map_err(display_error)?;
    drop(connection);
    if let Some(directory) = starting_directory {
        let path = PathBuf::from(directory);
        if is_codex_review_workspace(&path) {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    Ok(())
}

fn stop_active_reviews_for_task(state: &AppState, task_id: &str) -> Result<(), String> {
    let reviews = state
        .active_reviews
        .lock()
        .map_err(display_error)?
        .values()
        .filter(|review| review.source_task_id == task_id)
        .cloned()
        .collect::<Vec<_>>();
    for review in reviews {
        review.cancel_requested.store(true, Ordering::SeqCst);
        if let Ok(mut child) = review.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

fn stop_all_active_reviews(state: &AppState) -> Result<(), String> {
    let reviews = state
        .active_reviews
        .lock()
        .map_err(display_error)?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for review in reviews {
        review.cancel_requested.store(true, Ordering::SeqCst);
        if let Ok(mut child) = review.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[tauri::command]
fn get_active_task(state: tauri::State<'_, Arc<AppState>>) -> Result<Option<String>, String> {
    let connection = state.db.lock().map_err(display_error)?;
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'active_task'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(display_error)
}

#[tauri::command]
fn set_active_task(state: tauri::State<'_, Arc<AppState>>, task_id: String) -> Result<(), String> {
    validate_id(&task_id)?;
    if !task_exists(&state, &task_id)? {
        return Err("task_not_found".into());
    }
    let connection = state.db.lock().map_err(display_error)?;
    connection
        .execute(
            "INSERT INTO settings (key, value) VALUES ('active_task', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&task_id],
        )
        .map_err(display_error)?;
    Ok(())
}

#[tauri::command]
fn get_document(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
) -> Result<PresentationDocument, String> {
    get_document_core(&state, &task_id)
}

fn get_document_core(state: &AppState, task_id: &str) -> Result<PresentationDocument, String> {
    let connection = state.db.lock().map_err(display_error)?;
    let json: String = connection
        .query_row(
            "SELECT document_json FROM tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => "task_not_found".into(),
            other => display_error(other),
        })?;
    serde_json::from_str(&json).map_err(display_error)
}

#[tauri::command]
fn apply_operation(
    state: tauri::State<'_, Arc<AppState>>,
    operation: Operation,
) -> Result<PresentationDocument, String> {
    apply_operation_core(&state, operation)
}

fn apply_operation_core(
    state: &AppState,
    operation: Operation,
) -> Result<PresentationDocument, String> {
    validate_operation(&operation)?;
    let update_source = operation.source.clone();
    let update_op_type = operation.op_type.clone();
    let payload_size = serde_json::to_vec(&operation.payload)
        .map_err(display_error)?
        .len();
    if payload_size > MAX_PAYLOAD_BYTES {
        return Err("payload_too_large".into());
    }
    let mut connection = state.db.lock().map_err(display_error)?;
    let transaction = connection.transaction().map_err(display_error)?;

    if let Some(key) = operation.idempotency_key.as_deref() {
        validate_id(key)?;
        let cached: Option<String> = transaction
            .query_row(
                "SELECT response_json FROM idempotency
                 WHERE task_id = ?1 AND idempotency_key = ?2",
                params![operation.task_id, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(display_error)?;
        if let Some(cached) = cached {
            return serde_json::from_str(&cached).map_err(display_error);
        }
    }

    let document_json: String = transaction
        .query_row(
            "SELECT document_json FROM tasks WHERE id = ?1",
            [&operation.task_id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => "task_not_found".into(),
            other => display_error(other),
        })?;
    let mut document: PresentationDocument =
        serde_json::from_str(&document_json).map_err(display_error)?;

    if let Some(expected) = operation.expected_revision {
        if expected != document.revision {
            return Err(format!(
                "revision_conflict: expected {expected}, current {}",
                document.revision
            ));
        }
    }

    apply_to_document(&mut document, &operation.op_type, operation.payload)?;
    validate_document(&document)?;
    document.revision += 1;
    document.updated_at = now();
    let next_json = serde_json::to_string(&document).map_err(display_error)?;
    transaction
        .execute(
            "UPDATE tasks SET document_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![next_json, document.updated_at, operation.task_id],
        )
        .map_err(display_error)?;
    if let Some(key) = operation.idempotency_key {
        transaction
            .execute(
                "INSERT INTO idempotency (
                   task_id, idempotency_key, response_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    operation.task_id,
                    key,
                    serde_json::to_string(&document).map_err(display_error)?,
                    now()
                ],
            )
            .map_err(display_error)?;
    }
    transaction.commit().map_err(display_error)?;
    drop(connection);
    emit_presentation_updated(
        state,
        &operation.task_id,
        Some(&update_source),
        Some(&update_op_type),
    );
    Ok(document)
}

fn apply_to_document(
    document: &mut PresentationDocument,
    op_type: &str,
    payload: Value,
) -> Result<(), String> {
    match op_type {
        "set_task" => {
            document.header = serde_json::from_value(payload).map_err(payload_error)?;
        }
        "set_task_status" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Payload {
                status: TaskStatus,
                #[serde(default)]
                status_message: String,
            }
            let payload: Payload = serde_json::from_value(payload).map_err(payload_error)?;
            document.header.status = payload.status;
            document.header.status_message = payload.status_message;
        }
        "replace_tasks" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Payload {
                tasks: Vec<PresentedTask>,
            }
            document.tasks = serde_json::from_value::<Payload>(payload)
                .map_err(payload_error)?
                .tasks;
        }
        "upsert_task" => {
            let payload: PresentedTask = serde_json::from_value(payload).map_err(payload_error)?;
            if let Some(item) = document.tasks.iter_mut().find(|item| item.id == payload.id) {
                *item = payload;
            } else {
                document.tasks.push(payload);
            }
        }
        "ask_user" => {
            let mut payload: Question = serde_json::from_value(payload).map_err(payload_error)?;
            if payload.kind == TodoKind::Action {
                payload.choices.clear();
                payload.allow_free_text = false;
            }
            payload.answer = None;
            payload.state = QuestionState::Open;
            if let Some(item) = document
                .questions
                .iter_mut()
                .find(|item| item.id == payload.id)
            {
                *item = payload;
            } else {
                document.questions.push(payload);
            }
        }
        "set_summary" => {
            let mut payload: TaskSummary =
                serde_json::from_value(payload).map_err(payload_error)?;
            payload.updated_at = now();
            document.summary = payload;
        }
        "raise_alert" => {
            let payload: Alert = serde_json::from_value(payload).map_err(payload_error)?;
            if let Some(item) = document
                .alerts
                .iter_mut()
                .find(|item| item.id == payload.id)
            {
                *item = payload;
            } else {
                document.alerts.push(payload);
            }
        }
        "clear_alert" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Payload {
                id: String,
            }
            let payload: Payload = serde_json::from_value(payload).map_err(payload_error)?;
            validate_id(&payload.id)?;
            let alert = document
                .alerts
                .iter_mut()
                .find(|item| item.id == payload.id)
                .ok_or_else(|| "alert_not_found".to_string())?;
            alert.state = AlertState::Cleared;
        }
        "replace_resources" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Payload {
                resources: Vec<Resource>,
            }
            document.resources = serde_json::from_value::<Payload>(payload)
                .map_err(payload_error)?
                .resources;
        }
        _ => return Err(format!("unknown_operation: {op_type}")),
    }
    Ok(())
}

fn payload_error(error: serde_json::Error) -> String {
    format!("invalid_payload: {error}")
}

fn validate_operation(operation: &Operation) -> Result<(), String> {
    if operation.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "unsupported_protocol_version: {}",
            operation.protocol_version
        ));
    }
    validate_id(&operation.task_id)?;
    validate_string("source", &operation.source, 128)?;
    if operation.source.trim().is_empty() {
        return Err("source_required".into());
    }
    Ok(())
}

fn validate_document(document: &PresentationDocument) -> Result<(), String> {
    validate_string("header.title", &document.header.title, 512)?;
    validate_string(
        "header.description",
        &document.header.description,
        MAX_STRING,
    )?;
    validate_string("header.issue_url", &document.header.issue_url, 8192)?;
    if !document.header.issue_url.is_empty() {
        validate_github_issue_url(&document.header.issue_url)?;
    }
    validate_string(
        "header.status_message",
        &document.header.status_message,
        2048,
    )?;
    validate_collection("tasks", &document.tasks)?;
    validate_collection("questions", &document.questions)?;
    validate_collection("summary.sections", &document.summary.sections)?;
    validate_collection("alerts", &document.alerts)?;
    validate_collection("resources", &document.resources)?;
    for item in &document.tasks {
        validate_id(&item.id)?;
        validate_string("task.title", &item.title, 1024)?;
        validate_string("task.detail", &item.detail, MAX_STRING)?;
    }
    ensure_unique(document.tasks.iter().map(|item| item.id.as_str()), "tasks")?;
    for question in &document.questions {
        validate_id(&question.id)?;
        validate_string("question.text", &question.text, 8192)?;
        validate_collection("question.choices", &question.choices)?;
        if question.kind == TodoKind::Action
            && (!question.choices.is_empty() || question.allow_free_text)
        {
            return Err("invalid_action_todo".into());
        }
        for choice in &question.choices {
            validate_string("question.choice", choice, 1024)?;
        }
    }
    ensure_unique(
        document.questions.iter().map(|item| item.id.as_str()),
        "questions",
    )?;
    for section in &document.summary.sections {
        validate_id(&section.id)?;
        validate_string("summary.heading", &section.heading, 1024)?;
        validate_string("summary.body", &section.body, MAX_STRING)?;
    }
    for alert in &document.alerts {
        validate_id(&alert.id)?;
        validate_string("alert.title", &alert.title, 1024)?;
        validate_string("alert.message", &alert.message, MAX_STRING)?;
    }
    ensure_unique(
        document.alerts.iter().map(|item| item.id.as_str()),
        "alerts",
    )?;
    for resource in &document.resources {
        validate_id(&resource.id)?;
        if !matches!(
            resource.resource_type.as_str(),
            "path" | "url" | "note" | "local_document" | "web_document" | "github_pr"
        ) {
            return Err("invalid_resource_type".into());
        }
        validate_string("resource.label", &resource.label, 1024)?;
        validate_string("resource.path_or_url", &resource.path_or_url, 8192)?;
        if matches!(
            resource.resource_type.as_str(),
            "local_document" | "web_document" | "github_pr"
        ) {
            validate_artifact_target(&resource.resource_type, &resource.path_or_url)?;
        }
    }
    ensure_unique(
        document.resources.iter().map(|item| item.id.as_str()),
        "resources",
    )?;
    Ok(())
}

fn validate_collection<T>(field: &str, value: &[T]) -> Result<(), String> {
    if value.len() > MAX_COLLECTION {
        return Err(format!("{field}_too_large"));
    }
    Ok(())
}

fn validate_string(field: &str, value: &str, max: usize) -> Result<(), String> {
    if value.len() > max {
        return Err(format!("{field}_too_large"));
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err("invalid_identifier".into());
    }
    Ok(())
}

fn ensure_unique<'a>(
    mut values: impl Iterator<Item = &'a str>,
    collection: &str,
) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    if values.any(|value| !seen.insert(value)) {
        return Err(format!("duplicate_id_in_{collection}"));
    }
    Ok(())
}

fn has_attention(document: &PresentationDocument) -> bool {
    document
        .questions
        .iter()
        .any(|question| question.blocking && question.state == QuestionState::Open)
        || document.alerts.iter().any(|alert| {
            alert.severity == AlertSeverity::Critical && alert.state == AlertState::Active
        })
}

fn emit_presentation_updated(
    state: &AppState,
    task_id: &str,
    source: Option<&str>,
    op_type: Option<&str>,
) {
    emit_presentation_section_updated(state, task_id, source, op_type, None);
}

fn emit_presentation_section_updated(
    state: &AppState,
    task_id: &str,
    source: Option<&str>,
    op_type: Option<&str>,
    section: Option<&str>,
) {
    if let Ok(handle) = state.app_handle.lock() {
        if let Some(handle) = handle.as_ref() {
            let _ = handle.emit(
                "presentation-updated",
                json!({
                    "task_id": task_id,
                    "source": source,
                    "op_type": op_type,
                    "section": section,
                }),
            );
        }
    }
}

#[tauri::command]
fn answer_question(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
    question_id: String,
    answer: String,
) -> Result<PresentationDocument, String> {
    answer_question_core(&state, task_id, question_id, answer)
}

fn answer_question_core(
    state: &AppState,
    task_id: String,
    question_id: String,
    answer: String,
) -> Result<PresentationDocument, String> {
    validate_id(&task_id)?;
    validate_id(&question_id)?;
    validate_string("answer", &answer, 8192)?;
    if answer.trim().is_empty() {
        return Err("answer_required".into());
    }
    let mut connection = state.db.lock().map_err(display_error)?;
    let transaction = connection.transaction().map_err(display_error)?;
    let document_json: String = transaction
        .query_row(
            "SELECT document_json FROM tasks WHERE id = ?1",
            [&task_id],
            |row| row.get(0),
        )
        .map_err(display_error)?;
    let mut document: PresentationDocument =
        serde_json::from_str(&document_json).map_err(display_error)?;
    let question = document
        .questions
        .iter_mut()
        .find(|question| question.id == question_id)
        .ok_or_else(|| "question_not_found".to_string())?;
    if question.kind != TodoKind::Question {
        return Err("todo_is_not_question".into());
    }
    if question.state != QuestionState::Open {
        return Err("question_not_open".into());
    }
    question.answer = Some(answer.clone());
    question.state = QuestionState::Answered;
    document.revision += 1;
    document.updated_at = now();
    transaction
        .execute(
            "UPDATE tasks SET document_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&document).map_err(display_error)?,
                document.updated_at,
                task_id
            ],
        )
        .map_err(display_error)?;
    transaction.commit().map_err(display_error)?;
    drop(connection);

    let key = waiter_key(&task_id, &question_id);
    if let Some(waiter) = state.waiters.lock().map_err(display_error)?.remove(&key) {
        let _ = waiter.send(WaitResult {
            status: "answered".into(),
            answer: Some(answer),
            question_id,
        });
    }
    emit_presentation_updated(&state, &task_id, Some("human"), Some("answer_question"));
    Ok(document)
}

#[tauri::command]
fn complete_todo(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
    todo_id: String,
) -> Result<PresentationDocument, String> {
    complete_todo_core(&state, task_id, todo_id)
}

fn complete_todo_core(
    state: &AppState,
    task_id: String,
    todo_id: String,
) -> Result<PresentationDocument, String> {
    validate_id(&task_id)?;
    validate_id(&todo_id)?;
    let mut connection = state.db.lock().map_err(display_error)?;
    let transaction = connection.transaction().map_err(display_error)?;
    let document_json: String = transaction
        .query_row(
            "SELECT document_json FROM tasks WHERE id = ?1",
            [&task_id],
            |row| row.get(0),
        )
        .map_err(display_error)?;
    let mut document: PresentationDocument =
        serde_json::from_str(&document_json).map_err(display_error)?;
    let todo = document
        .questions
        .iter_mut()
        .find(|todo| todo.id == todo_id)
        .ok_or_else(|| "todo_not_found".to_string())?;
    if todo.kind != TodoKind::Action {
        return Err("todo_is_not_action".into());
    }
    if todo.state != QuestionState::Open {
        return Err("todo_not_open".into());
    }
    todo.answer = None;
    todo.state = QuestionState::Completed;
    document.revision += 1;
    document.updated_at = now();
    transaction
        .execute(
            "UPDATE tasks SET document_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&document).map_err(display_error)?,
                document.updated_at,
                task_id
            ],
        )
        .map_err(display_error)?;
    transaction.commit().map_err(display_error)?;
    drop(connection);

    let key = waiter_key(&task_id, &todo_id);
    if let Some(waiter) = state.waiters.lock().map_err(display_error)?.remove(&key) {
        let _ = waiter.send(WaitResult {
            status: "completed".into(),
            answer: None,
            question_id: todo_id,
        });
    }
    emit_presentation_updated(&state, &task_id, Some("human"), Some("complete_todo"));
    Ok(document)
}

#[tauri::command]
fn update_layout(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
    layout: Layout,
) -> Result<(), String> {
    validate_id(&task_id)?;
    if !(180.0..=800.0).contains(&layout.left_width)
        || !(180.0..=800.0).contains(&layout.right_width)
    {
        return Err("invalid_layout_width".into());
    }
    let connection = state.db.lock().map_err(display_error)?;
    let count = connection
        .execute(
            "UPDATE tasks SET layout_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&layout).map_err(display_error)?,
                now(),
                task_id
            ],
        )
        .map_err(display_error)?;
    if count == 0 {
        return Err("task_not_found".into());
    }
    Ok(())
}

#[tauri::command]
fn get_scratchpad(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
) -> Result<ScratchpadState, String> {
    get_scratchpad_core(&state, &task_id)
}

fn get_scratchpad_core(state: &AppState, task_id: &str) -> Result<ScratchpadState, String> {
    validate_id(task_id)?;
    if !task_exists(state, task_id)? {
        return Err("task_not_found".into());
    }
    let connection = state.db.lock().map_err(display_error)?;
    connection
        .query_row(
            "SELECT content, collapsed, updated_at FROM scratchpads WHERE task_id = ?1",
            [task_id],
            |row| {
                Ok(ScratchpadState {
                    content: row.get(0)?,
                    collapsed: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .optional()
        .map(|value| value.unwrap_or_default())
        .map_err(display_error)
}

#[tauri::command]
fn update_scratchpad(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
    content: String,
    collapsed: bool,
) -> Result<ScratchpadState, String> {
    update_scratchpad_core(&state, &task_id, content, collapsed)
}

fn update_scratchpad_core(
    state: &AppState,
    task_id: &str,
    content: String,
    collapsed: bool,
) -> Result<ScratchpadState, String> {
    validate_id(task_id)?;
    validate_string("scratchpad", &content, MAX_SCRATCHPAD)?;
    if !task_exists(state, task_id)? {
        return Err("task_not_found".into());
    }
    let scratchpad = ScratchpadState {
        content,
        collapsed,
        updated_at: now(),
    };
    let connection = state.db.lock().map_err(display_error)?;
    connection
        .execute(
            "INSERT INTO scratchpads (task_id, content, collapsed, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(task_id) DO UPDATE SET
               content = excluded.content,
               collapsed = excluded.collapsed,
               updated_at = excluded.updated_at",
            params![
                task_id,
                scratchpad.content,
                scratchpad.collapsed,
                scratchpad.updated_at
            ],
        )
        .map_err(display_error)?;
    Ok(scratchpad)
}

#[tauri::command]
fn create_terminal(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
    starting_directory: Option<String>,
) -> Result<String, String> {
    if !task_exists(&state, &task_id)? {
        return Err("task_not_found".into());
    }
    if let Some(session_id) = terminal_for_task(&state, &task_id)? {
        return Ok(session_id);
    }
    let directory = match starting_directory {
        Some(directory) => {
            validate_directory(&directory)?;
            directory
        }
        None => {
            let connection = state.db.lock().map_err(display_error)?;
            connection
                .query_row(
                    "SELECT starting_directory FROM tasks WHERE id = ?1",
                    [&task_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(display_error)?
                .unwrap_or_else(default_directory)
        }
    };
    create_terminal_core(&state, task_id, directory)
}

fn terminal_for_task(state: &AppState, task_id: &str) -> Result<Option<String>, String> {
    let terminals = state.terminals.lock().map_err(display_error)?;
    Ok(terminal_id_for_task(
        terminals
            .iter()
            .map(|(session_id, session)| (session_id.as_str(), session.task_id.as_str())),
        task_id,
    ))
}

fn terminal_id_for_task<'a>(
    mut sessions: impl Iterator<Item = (&'a str, &'a str)>,
    task_id: &str,
) -> Option<String> {
    sessions
        .find(|(_, session_task_id)| *session_task_id == task_id)
        .map(|(session_id, _)| session_id.to_string())
}

fn terminal_belongs_to_task<'a>(
    mut sessions: impl Iterator<Item = (&'a str, &'a str)>,
    session_id: &str,
    task_id: &str,
) -> bool {
    sessions.any(|(candidate_session_id, candidate_task_id)| {
        candidate_session_id == session_id && candidate_task_id == task_id
    })
}

fn create_terminal_core(
    state: &Arc<AppState>,
    task_id: String,
    starting_directory: String,
) -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if !Path::new(&shell).is_absolute() || !Path::new(&shell).exists() {
        return Err("configured_shell_not_found".into());
    }
    let mut command = CommandBuilder::new(shell);
    command.arg("-l");
    command.arg("-i");
    spawn_terminal_command_core(state, task_id, starting_directory, command)
}

fn spawn_terminal_command_core(
    state: &Arc<AppState>,
    task_id: String,
    starting_directory: String,
    mut command: CommandBuilder,
) -> Result<String, String> {
    validate_directory(&starting_directory)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(display_error)?;
    let bridge = get_bridge_info_core(state, &task_id)?;
    command.cwd(starting_directory);
    command.env("AGENT_UI_TASK_ID", &task_id);
    command.env("AGENT_UI_ENDPOINT", bridge.endpoint);
    command.env("AGENT_UI_PROTOCOL_VERSION", PROTOCOL_VERSION);
    command.env("AGENT_UI_TOKEN", bridge.token);
    command.env("AGENT_UI_SOURCE", "agent-ui-terminal");
    command.env("AGENT_UI_CLI", &state.cli_path);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("CLICOLOR", "1");
    command.env("TERM_PROGRAM", "AgentUI");
    command.env_remove("NO_COLOR");
    command.env_remove("npm_config_prefix");
    command.env_remove("NPM_CONFIG_PREFIX");
    let mut search_paths = vec![state.cli_bin_dir.clone()];
    if let Some(existing_path) = std::env::var_os("PATH") {
        search_paths.extend(std::env::split_paths(&existing_path));
    }
    if let Ok(path) = std::env::join_paths(search_paths) {
        command.env("PATH", path);
    }
    let child = pair.slave.spawn_command(command).map_err(display_error)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(display_error)?;
    let writer = pair.master.take_writer().map_err(display_error)?;
    let session_id = Uuid::new_v4().to_string();
    let session = Arc::new(TerminalSession {
        task_id,
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        output: Mutex::new(TerminalBuffer::default()),
    });
    {
        let mut terminals = state.terminals.lock().map_err(display_error)?;
        if let Some(existing_id) = terminal_id_for_task(
            terminals
                .iter()
                .map(|(id, existing)| (id.as_str(), existing.task_id.as_str())),
            &session.task_id,
        ) {
            drop(terminals);
            let _ = session.child.lock().map_err(display_error)?.kill();
            return Ok(existing_id);
        }
        terminals.insert(session_id.clone(), session.clone());
    }

    let app_handle = state
        .app_handle
        .lock()
        .map_err(display_error)?
        .clone()
        .ok_or_else(|| "application_not_ready".to_string())?;
    let reader_session_id = session_id.clone();
    let reader_session = session.clone();
    thread::Builder::new()
        .name(format!("pty-{reader_session_id}"))
        .spawn(move || {
            let mut buffer = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let offset = match reader_session.output.lock() {
                            Ok(mut output) => output.append(&buffer[..count]),
                            Err(_) => break,
                        };
                        let _ = app_handle.emit(
                            "terminal-output",
                            TerminalOutput {
                                session_id: reader_session_id.clone(),
                                offset,
                                data: buffer[..count].to_vec(),
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(display_error)?;
    Ok(session_id)
}

#[tauri::command]
fn get_terminal_snapshot(
    state: tauri::State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<TerminalSnapshot, String> {
    let session = state
        .terminals
        .lock()
        .map_err(display_error)?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "terminal_not_found".to_string())?;
    let snapshot = session
        .output
        .lock()
        .map_err(display_error)?
        .snapshot(session_id);
    Ok(snapshot)
}

#[tauri::command]
fn write_terminal(
    state: tauri::State<'_, Arc<AppState>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > 64 * 1024 {
        return Err("terminal_write_too_large".into());
    }
    let session = state
        .terminals
        .lock()
        .map_err(display_error)?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "terminal_not_found".to_string())?;
    let mut writer = session.writer.lock().map_err(display_error)?;
    writer.write_all(&data).map_err(display_error)?;
    writer.flush().map_err(display_error)
}

#[tauri::command]
fn resize_terminal(
    state: tauri::State<'_, Arc<AppState>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if !(2..=1000).contains(&cols) || !(2..=1000).contains(&rows) {
        return Err("invalid_terminal_size".into());
    }
    let session = state
        .terminals
        .lock()
        .map_err(display_error)?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "terminal_not_found".to_string())?;
    let result = session
        .master
        .lock()
        .map_err(display_error)?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(display_error);
    result
}

#[tauri::command]
fn close_terminal(
    state: tauri::State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<(), String> {
    close_terminal_core(&state, &session_id)
}

fn close_terminal_core(state: &AppState, session_id: &str) -> Result<(), String> {
    let session = state
        .terminals
        .lock()
        .map_err(display_error)?
        .remove(session_id)
        .ok_or_else(|| "terminal_not_found".to_string())?;
    let result = session
        .child
        .lock()
        .map_err(display_error)?
        .kill()
        .map_err(display_error);
    result
}

#[derive(Debug, PartialEq, Eq)]
enum ArtifactTarget {
    LocalDocument(PathBuf),
    Web(String),
}

fn validate_artifact_target(artifact_type: &str, target: &str) -> Result<ArtifactTarget, String> {
    validate_string("artifact.target", target, 8192)?;
    match artifact_type {
        "local_document" => {
            let path = Path::new(target);
            if !path.is_absolute() {
                return Err("artifact_path_must_be_absolute".into());
            }
            let canonical = path
                .canonicalize()
                .map_err(|_| "artifact_file_not_found".to_string())?;
            if !canonical.is_file() {
                return Err("artifact_path_must_be_a_file".into());
            }
            Ok(ArtifactTarget::LocalDocument(canonical))
        }
        "web_document" | "github_pr" => {
            let parsed = url::Url::parse(target).map_err(|_| "invalid_artifact_url".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
                return Err("artifact_url_must_be_http".into());
            }
            if artifact_type == "github_pr" {
                let segments = parsed
                    .path_segments()
                    .map(|segments| segments.collect::<Vec<_>>())
                    .unwrap_or_default();
                let valid_pull_number = segments
                    .get(3)
                    .and_then(|value| value.parse::<u64>().ok())
                    .is_some();
                if parsed.scheme() != "https"
                    || parsed.host_str() != Some("github.com")
                    || segments.len() < 4
                    || segments.first().is_none_or(|value| value.is_empty())
                    || segments.get(1).is_none_or(|value| value.is_empty())
                    || segments.get(2) != Some(&"pull")
                    || !valid_pull_number
                {
                    return Err("invalid_github_pull_request_url".into());
                }
            }
            Ok(ArtifactTarget::Web(parsed.to_string()))
        }
        _ => Err("invalid_artifact_type".into()),
    }
}

fn validate_github_issue_url(target: &str) -> Result<(), String> {
    let parsed = url::Url::parse(target).map_err(|_| "invalid_github_issue_url".to_string())?;
    let segments = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let valid_issue_number = segments
        .get(3)
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|number| number > 0);
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || segments.len() != 4
        || segments.first().is_none_or(|value| value.is_empty())
        || segments.get(1).is_none_or(|value| value.is_empty())
        || segments.get(2) != Some(&"issues")
        || !valid_issue_number
    {
        return Err("invalid_github_issue_url".into());
    }
    Ok(())
}

fn github_cli_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    for candidate in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from("gh")
}

fn github_pull_request_is_closed(target: &str) -> bool {
    let output = ProcessCommand::new(github_cli_path())
        .args(["pr", "view"])
        .arg(target)
        .args(["--json", "state", "--jq", ".state"])
        .env("GH_PROMPT_DISABLED", "1")
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    github_pull_request_state_is_closed(&String::from_utf8_lossy(&output.stdout))
}

fn github_pull_request_state_is_closed(state: &str) -> bool {
    matches!(
        state.trim().to_ascii_lowercase().as_str(),
        "closed" | "merged"
    )
}

#[tauri::command]
fn get_closed_github_pull_requests(targets: Vec<String>) -> Result<Vec<String>, String> {
    validate_collection("github_pull_requests", &targets)?;
    for target in &targets {
        validate_artifact_target("github_pr", target)?;
    }
    Ok(targets
        .into_iter()
        .filter(|target| github_pull_request_is_closed(target))
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitHubPullRequestReference {
    owner: String,
    repository: String,
    number: u64,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitHubIssueReference {
    owner: String,
    repository: String,
    number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalDocumentReviewReference {
    source_path: String,
    canonical_path: PathBuf,
}

fn github_pull_request_reference(target: &str) -> Result<GitHubPullRequestReference, String> {
    validate_artifact_target("github_pr", target)?;
    let parsed = url::Url::parse(target).map_err(display_error)?;
    let segments = parsed
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(GitHubPullRequestReference {
        owner: segments[0].to_string(),
        repository: segments[1].to_string(),
        number: segments[3]
            .parse::<u64>()
            .map_err(|_| "invalid_github_pull_request_url".to_string())?,
        url: target.to_string(),
    })
}

fn github_pull_request_identity(reference: &GitHubPullRequestReference) -> String {
    format!(
        "{}/{}#{}",
        reference.owner.to_ascii_lowercase(),
        reference.repository.to_ascii_lowercase(),
        reference.number
    )
}

fn canonical_github_pull_request_url(reference: &GitHubPullRequestReference) -> String {
    format!(
        "https://github.com/{}/{}/pull/{}",
        reference.owner, reference.repository, reference.number
    )
}

fn terminal_github_pull_request_urls(output: &str) -> Vec<String> {
    let prefix = "https://github.com/";
    let mut seen = HashSet::new();
    let mut urls = Vec::new();
    for (start, _) in output.match_indices(prefix) {
        let candidate = &output[start..];
        let end = candidate
            .char_indices()
            .find_map(|(index, character)| {
                (character.is_whitespace()
                    || character.is_control()
                    || matches!(character, '"' | '\'' | '<' | '>' | '`'))
                .then_some(index)
            })
            .unwrap_or(candidate.len());
        let candidate = candidate[..end].trim_end_matches(|character: char| {
            matches!(
                character,
                '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}'
            )
        });
        let Ok(reference) = github_pull_request_reference(candidate) else {
            continue;
        };
        let canonical = canonical_github_pull_request_url(&reference);
        if seen.insert(github_pull_request_identity(&reference)) {
            urls.push(canonical);
        }
    }
    urls
}

#[derive(Debug, Deserialize)]
struct GitHubPullRequestView {
    state: String,
    title: String,
}

fn github_pull_request_view(target: &str) -> Result<GitHubPullRequestView, String> {
    let output = ProcessCommand::new(github_cli_path())
        .args(["pr", "view"])
        .arg(target)
        .args(["--json", "state,title"])
        .env("GH_PROMPT_DISABLED", "1")
        .output()
        .map_err(display_error)?;
    if !output.status.success() {
        return Err("github_pull_request_lookup_failed".into());
    }
    serde_json::from_slice(&output.stdout).map_err(display_error)
}

fn next_terminal_pull_request_id(document: &PresentationDocument, number: u64) -> String {
    let base = format!("terminal-pr-{number}");
    if !document
        .resources
        .iter()
        .any(|resource| resource.id == base)
    {
        return base;
    }
    for suffix in 2.. {
        let candidate = format!("{base}-{suffix}");
        if !document
            .resources
            .iter()
            .any(|resource| resource.id == candidate)
        {
            return candidate;
        }
    }
    unreachable!()
}

#[tauri::command]
fn discover_open_github_pull_requests(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
    session_id: String,
    rendered_output: String,
) -> Result<PresentationDocument, String> {
    discover_open_github_pull_requests_core(&state, task_id, session_id, rendered_output)
}

fn discover_open_github_pull_requests_core(
    state: &AppState,
    task_id: String,
    session_id: String,
    rendered_output: String,
) -> Result<PresentationDocument, String> {
    validate_id(&task_id)?;
    validate_id(&session_id)?;
    if rendered_output.len() > MAX_TERMINAL_BUFFER {
        return Err("terminal_rendered_output_too_large".into());
    }
    let terminals = state.terminals.lock().map_err(display_error)?;
    if !terminal_belongs_to_task(
        terminals
            .iter()
            .map(|(id, session)| (id.as_str(), session.task_id.as_str())),
        &session_id,
        &task_id,
    ) {
        return Err("terminal_task_mismatch".into());
    }
    drop(terminals);
    let candidates = terminal_github_pull_request_urls(&rendered_output);
    if candidates.is_empty() {
        return get_document_core(state, &task_id);
    }

    let document = get_document_core(state, &task_id)?;
    let existing = document
        .resources
        .iter()
        .filter(|resource| resource.resource_type == "github_pr")
        .filter_map(|resource| github_pull_request_reference(&resource.path_or_url).ok())
        .map(|reference| github_pull_request_identity(&reference))
        .collect::<HashSet<_>>();
    let known_closed = state
        .closed_terminal_pull_requests
        .lock()
        .map_err(display_error)?
        .get(&task_id)
        .cloned()
        .unwrap_or_default();

    let mut discovered = Vec::new();
    let mut closed = Vec::new();
    let mut lookups = 0;
    for candidate in candidates {
        let reference = github_pull_request_reference(&candidate)?;
        let identity = github_pull_request_identity(&reference);
        if existing.contains(&identity) || known_closed.contains(&identity) {
            continue;
        }
        if lookups >= 20 {
            break;
        }
        lookups += 1;
        let Ok(view) = github_pull_request_view(&candidate) else {
            continue;
        };
        match view.state.trim().to_ascii_lowercase().as_str() {
            "open" => discovered.push((reference, view.title)),
            "closed" | "merged" => closed.push(identity),
            _ => {}
        }
    }
    if !closed.is_empty() {
        state
            .closed_terminal_pull_requests
            .lock()
            .map_err(display_error)?
            .entry(task_id.clone())
            .or_default()
            .extend(closed);
    }
    if discovered.is_empty() {
        return Ok(document);
    }

    let mut connection = state.db.lock().map_err(display_error)?;
    let transaction = connection.transaction().map_err(display_error)?;
    let document_json: String = transaction
        .query_row(
            "SELECT document_json FROM tasks WHERE id = ?1",
            [&task_id],
            |row| row.get(0),
        )
        .map_err(display_error)?;
    let mut document: PresentationDocument =
        serde_json::from_str(&document_json).map_err(display_error)?;
    let mut identities = document
        .resources
        .iter()
        .filter(|resource| resource.resource_type == "github_pr")
        .filter_map(|resource| github_pull_request_reference(&resource.path_or_url).ok())
        .map(|reference| github_pull_request_identity(&reference))
        .collect::<HashSet<_>>();
    let mut changed = false;
    for (reference, title) in discovered {
        if !identities.insert(github_pull_request_identity(&reference)) {
            continue;
        }
        let id = next_terminal_pull_request_id(&document, reference.number);
        document.resources.push(Resource {
            id,
            resource_type: "github_pr".into(),
            label: if title.trim().is_empty() {
                format!(
                    "{}/{}#{}",
                    reference.owner, reference.repository, reference.number
                )
            } else {
                title
            },
            path_or_url: canonical_github_pull_request_url(&reference),
            status: ResourceStatus::Reported,
            metadata: HashMap::from([
                ("github_state".into(), "open".into()),
                ("discovered_from".into(), "terminal".into()),
            ]),
        });
        changed = true;
    }
    if !changed {
        return Ok(document);
    }
    validate_document(&document)?;
    document.revision += 1;
    document.updated_at = now();
    transaction
        .execute(
            "UPDATE tasks SET document_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&document).map_err(display_error)?,
                document.updated_at,
                task_id
            ],
        )
        .map_err(display_error)?;
    transaction.commit().map_err(display_error)?;
    drop(connection);
    emit_presentation_updated(
        state,
        &task_id,
        Some("terminal-discovery"),
        Some("replace_resources"),
    );
    Ok(document)
}

fn github_issue_reference(target: &str) -> Result<GitHubIssueReference, String> {
    validate_github_issue_url(target)?;
    let parsed = url::Url::parse(target).map_err(display_error)?;
    let segments = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(GitHubIssueReference {
        owner: segments[0].to_string(),
        repository: segments[1].to_string(),
        number: segments[3]
            .parse::<u64>()
            .map_err(|_| "invalid_github_issue_url".to_string())?,
    })
}

fn codex_review_prompt(
    pull_requests: &[GitHubPullRequestReference],
    documents: &[LocalDocumentReviewReference],
    issue: &GitHubIssueReference,
    issue_url: &str,
) -> String {
    let pull_request_list = pull_requests
        .iter()
        .map(|pull_request| {
            format!(
                "- {}/{} PR #{}: {}",
                pull_request.owner, pull_request.repository, pull_request.number, pull_request.url
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let document_list = documents
        .iter()
        .map(|document| format!("- {}", document.canonical_path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    let mut targets = Vec::new();
    if !pull_requests.is_empty() {
        targets.push(format!("Pull requests:\n{pull_request_list}"));
    }
    if !documents.is_empty() {
        targets.push(format!("Local documents:\n{document_list}"));
    }
    let mut outcomes = Vec::new();
    if !pull_requests.is_empty() {
        outcomes.push(
            "For every listed pull request, submit the completed review on GitHub using \
`gh pr review` (approve, comment, or request changes as warranted). Include \
actionable inline comments when appropriate.",
        );
    }
    if !documents.is_empty() {
        outcomes.push(
            "For the local documents, submit the completed review as a comment on the \
related GitHub issue using `gh issue comment`. Identify each reviewed file by its \
path and organize findings by severity. Do not modify the reviewed documents.",
        );
    }
    format!(
        "Review the following artifact{} for the related issue.\n\n\
Related GitHub issue ID: {}/{}#{}\n\
Related GitHub issue URL: {}\n\n\
{}\n\n\
Use the authenticated GitHub CLI to retrieve the issue and, for pull requests, \
the description, commits, complete diff, existing discussion, and checks. Read \
each listed local document directly from its absolute path. Clone or fetch \
repositories into this review workspace when source context is needed.\n\n\
Review for correctness, regressions, security, data integrity, concurrency, error \
handling, tests, maintainability, and whether the implementation satisfies the \
issue. Do not change or push implementation code as part of this review.\n\n\
{}\n\n\
Do not merely print the review: complete every applicable GitHub submission \
described above before exiting.",
        if pull_requests.len() + documents.len() == 1 {
            ""
        } else {
            "s"
        },
        issue.owner,
        issue.repository,
        issue.number,
        issue_url,
        targets.join("\n\n"),
        outcomes.join("\n\n")
    )
}

fn codex_review_arguments(prompt: String) -> Vec<String> {
    vec![
        "-a".into(),
        "never".into(),
        "exec".into(),
        "-m".into(),
        CODEX_REVIEW_MODEL.into(),
        "-c".into(),
        CODEX_REVIEW_REASONING_CONFIG.into(),
        "-s".into(),
        "workspace-write".into(),
        "-c".into(),
        "sandbox_workspace_write.network_access=true".into(),
        prompt,
    ]
}

fn executable_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn locate_codex_cli() -> Result<PathBuf, String> {
    if let Some(path) = executable_on_path("codex") {
        return Ok(path);
    }
    if let Some(home) = std::env::var_os("HOME") {
        for relative in [".local/bin/codex", ".npm-global/bin/codex"] {
            let candidate = PathBuf::from(&home).join(relative);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    for candidate in ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if Path::new(&shell).is_absolute() && Path::new(&shell).is_file() {
        if let Ok(output) = ProcessCommand::new(shell)
            .args(["-lic", "command -v codex"])
            .output()
        {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines().rev() {
                    let candidate = PathBuf::from(line.trim());
                    if candidate.is_absolute() && candidate.is_file() {
                        return Ok(candidate);
                    }
                }
            }
        }
    }
    Err("codex_cli_not_found".into())
}

fn create_codex_review_workspace() -> Result<PathBuf, String> {
    let root = std::env::temp_dir().join("agent-ui-codex-reviews");
    let workspace = root.join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&workspace).map_err(display_error)?;
    let initialized = ProcessCommand::new("git")
        .args(["init", "--quiet"])
        .arg(&workspace)
        .status()
        .map_err(display_error)?;
    if !initialized.success() {
        let _ = std::fs::remove_dir_all(&workspace);
        return Err("review_workspace_git_init_failed".into());
    }
    Ok(workspace)
}

fn is_codex_review_workspace(path: &Path) -> bool {
    let root = std::env::temp_dir().join("agent-ui-codex-reviews");
    path.parent() == Some(root.as_path())
        && path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| Uuid::parse_str(value).is_ok())
}

#[derive(Debug, Deserialize)]
struct GitHubReviewAuthor {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GitHubPullRequestReview {
    html_url: String,
    submitted_at: Option<String>,
    user: GitHubReviewAuthor,
}

#[derive(Debug, Clone)]
struct ReviewResourceUpdate {
    state: String,
    review_url: Option<String>,
    error: Option<String>,
}

fn review_updates(
    targets: &[String],
    state: &str,
    review_urls: &HashMap<String, String>,
    error: Option<&str>,
) -> HashMap<String, ReviewResourceUpdate> {
    targets
        .iter()
        .map(|target| {
            (
                target.clone(),
                ReviewResourceUpdate {
                    state: state.into(),
                    review_url: review_urls.get(target).cloned(),
                    error: error.map(str::to_string),
                },
            )
        })
        .collect()
}

fn update_source_review_state(
    state: &AppState,
    source_task_id: &str,
    review_task_id: &str,
    started_at: &str,
    updates: &HashMap<String, ReviewResourceUpdate>,
) -> Result<(), String> {
    let mut connection = state.db.lock().map_err(display_error)?;
    let transaction = connection.transaction().map_err(display_error)?;
    let document_json: String = transaction
        .query_row(
            "SELECT document_json FROM tasks WHERE id = ?1",
            [source_task_id],
            |row| row.get(0),
        )
        .map_err(display_error)?;
    let mut document: PresentationDocument =
        serde_json::from_str(&document_json).map_err(display_error)?;
    let mut changed = false;
    let mut changed_artifacts = false;
    let mut changed_pull_requests = false;
    for resource in &mut document.resources {
        let Some(update) = updates.get(&resource.path_or_url) else {
            continue;
        };
        let is_pull_request = match resource.resource_type.as_str() {
            "github_pr" => true,
            "local_document" => false,
            _ => continue,
        };
        if update.state != "queued"
            && resource
                .metadata
                .get("review_task_id")
                .is_some_and(|current| current != review_task_id)
        {
            continue;
        }
        if update.state != "queued"
            && resource
                .metadata
                .get("review_state")
                .is_some_and(|current| {
                    matches!(current.as_str(), "posted" | "failed" | "cancelled")
                        && current != &update.state
                })
        {
            continue;
        }
        if update.state == "queued"
            && resource.metadata.get("review_state").map(String::as_str) == Some("posted")
            && !resource.metadata.contains_key("review_count")
        {
            resource.metadata.insert("review_count".into(), "1".into());
            if let Some(previous_review_id) = resource.metadata.get("review_task_id").cloned() {
                resource
                    .metadata
                    .insert("review_counted_task_id".into(), previous_review_id);
            }
        }
        if is_pull_request {
            changed_pull_requests = true;
        } else {
            changed_artifacts = true;
        }
        changed = true;
        resource
            .metadata
            .insert("review_state".into(), update.state.clone());
        resource
            .metadata
            .insert("review_task_id".into(), review_task_id.into());
        resource
            .metadata
            .insert("review_started_at".into(), started_at.into());
        if update.state == "posted"
            && resource
                .metadata
                .get("review_counted_task_id")
                .is_none_or(|counted| counted != review_task_id)
        {
            let count = resource
                .metadata
                .get("review_count")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0)
                .saturating_add(1);
            resource
                .metadata
                .insert("review_count".into(), count.to_string());
            resource
                .metadata
                .insert("review_counted_task_id".into(), review_task_id.into());
        }
        match update.review_url.as_deref() {
            Some(review_url) => {
                resource
                    .metadata
                    .insert("review_url".into(), review_url.into());
            }
            None => {
                resource.metadata.remove("review_url");
            }
        }
        match update.error.as_deref() {
            Some(error) => {
                resource
                    .metadata
                    .insert("review_error".into(), error.into());
            }
            None => {
                resource.metadata.remove("review_error");
            }
        }
    }
    if !changed {
        return Err("review_artifact_not_found_in_source_task".into());
    }
    validate_document(&document)?;
    document.revision += 1;
    document.updated_at = now();
    transaction
        .execute(
            "UPDATE tasks SET document_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&document).map_err(display_error)?,
                document.updated_at,
                source_task_id
            ],
        )
        .map_err(display_error)?;
    transaction.commit().map_err(display_error)?;
    drop(connection);
    let section = match (changed_artifacts, changed_pull_requests) {
        (true, false) => Some("artifacts"),
        (false, true) => Some("prs"),
        _ => None,
    };
    emit_presentation_section_updated(
        state,
        source_task_id,
        Some("agent-ui-review-launcher"),
        Some("review_state"),
        section,
    );
    Ok(())
}

fn github_authenticated_login() -> Option<String> {
    let output = ProcessCommand::new("gh")
        .args(["api", "user", "--jq", ".login"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let login = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!login.is_empty()).then_some(login)
}

fn github_review_url(
    pull_request: &GitHubPullRequestReference,
    login: &str,
    started_at: DateTime<Utc>,
) -> Option<String> {
    let endpoint = format!(
        "repos/{}/{}/pulls/{}/reviews?per_page=100",
        pull_request.owner, pull_request.repository, pull_request.number
    );
    let output = ProcessCommand::new("gh")
        .args(["api", &endpoint])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let reviews: Vec<GitHubPullRequestReview> = serde_json::from_slice(&output.stdout).ok()?;
    reviews
        .into_iter()
        .filter(|review| review.user.login.eq_ignore_ascii_case(login))
        .filter_map(|review| {
            let submitted_at = review
                .submitted_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())?
                .with_timezone(&Utc);
            (submitted_at >= started_at).then_some((submitted_at, review.html_url))
        })
        .max_by_key(|(submitted_at, _)| *submitted_at)
        .map(|(_, url)| url)
}

fn find_posted_review_urls(
    pull_requests: &[GitHubPullRequestReference],
    started_at: &str,
    cancel_requested: &AtomicBool,
) -> HashMap<String, String> {
    let Some(login) = github_authenticated_login() else {
        return HashMap::new();
    };
    let Ok(started_at) = DateTime::parse_from_rfc3339(started_at) else {
        return HashMap::new();
    };
    let started_at = started_at.with_timezone(&Utc);
    let mut found = HashMap::new();
    for attempt in 0..6 {
        if cancel_requested.load(Ordering::SeqCst) {
            break;
        }
        for pull_request in pull_requests {
            if cancel_requested.load(Ordering::SeqCst) {
                break;
            }
            if found.contains_key(&pull_request.url) {
                continue;
            }
            if let Some(url) = github_review_url(pull_request, &login, started_at) {
                found.insert(pull_request.url.clone(), url);
            }
        }
        if found.len() == pull_requests.len() || attempt == 5 {
            break;
        }
        thread::sleep(Duration::from_secs(2));
    }
    found
}

#[derive(Debug, Deserialize)]
struct GitHubIssueComment {
    html_url: String,
    created_at: String,
    user: GitHubReviewAuthor,
}

fn github_issue_comment_url(
    issue: &GitHubIssueReference,
    login: &str,
    started_at: DateTime<Utc>,
) -> Option<String> {
    let endpoint = format!(
        "repos/{}/{}/issues/{}/comments?per_page=100",
        issue.owner, issue.repository, issue.number
    );
    let output = ProcessCommand::new("gh")
        .args(["api", &endpoint])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let comments: Vec<GitHubIssueComment> = serde_json::from_slice(&output.stdout).ok()?;
    comments
        .into_iter()
        .filter(|comment| comment.user.login.eq_ignore_ascii_case(login))
        .filter_map(|comment| {
            let created_at = DateTime::parse_from_rfc3339(&comment.created_at)
                .ok()?
                .with_timezone(&Utc);
            (created_at >= started_at).then_some((created_at, comment.html_url))
        })
        .max_by_key(|(created_at, _)| *created_at)
        .map(|(_, url)| url)
}

fn find_posted_issue_comment_url(
    issue: &GitHubIssueReference,
    started_at: &str,
    cancel_requested: &AtomicBool,
) -> Option<String> {
    let login = github_authenticated_login()?;
    let started_at = DateTime::parse_from_rfc3339(started_at)
        .ok()?
        .with_timezone(&Utc);
    for attempt in 0..6 {
        if cancel_requested.load(Ordering::SeqCst) {
            return None;
        }
        if let Some(url) = github_issue_comment_url(issue, &login, started_at) {
            return Some(url);
        }
        if attempt < 5 {
            thread::sleep(Duration::from_secs(2));
        }
    }
    None
}

fn finish_active_review(state: &AppState, review_run_id: &str, review_workspace: &Path) {
    if let Ok(mut reviews) = state.active_reviews.lock() {
        reviews.remove(review_run_id);
    }
    let _ = std::fs::remove_dir_all(review_workspace);
}

fn watch_codex_review(
    state: Arc<AppState>,
    child: Arc<Mutex<Child>>,
    cancel_requested: Arc<AtomicBool>,
    source_task_id: String,
    review_run_id: String,
    pull_requests: Vec<GitHubPullRequestReference>,
    documents: Vec<LocalDocumentReviewReference>,
    issue: GitHubIssueReference,
    started_at: String,
    review_workspace: PathBuf,
) {
    let _ = thread::Builder::new()
        .name(format!("review-{review_run_id}"))
        .spawn(move || {
            let succeeded = loop {
                let status = match child.lock() {
                    Ok(mut child) => child.try_wait(),
                    Err(_) => break false,
                };
                match status {
                    Ok(Some(status)) => break status.success(),
                    Ok(None) => thread::sleep(Duration::from_secs(1)),
                    Err(_) => break false,
                }
            };

            if cancel_requested.load(Ordering::SeqCst) {
                finish_active_review(&state, &review_run_id, &review_workspace);
                return;
            }

            if !succeeded {
                let targets = pull_requests
                    .iter()
                    .map(|pull_request| pull_request.url.clone())
                    .chain(
                        documents
                            .iter()
                            .map(|document| document.source_path.clone()),
                    )
                    .collect::<Vec<_>>();
                let updates = review_updates(
                    &targets,
                    "failed",
                    &HashMap::new(),
                    Some("Codex review exited before posting its review."),
                );
                let _ = update_source_review_state(
                    &state,
                    &source_task_id,
                    &review_run_id,
                    &started_at,
                    &updates,
                );
                finish_active_review(&state, &review_run_id, &review_workspace);
                return;
            }

            let mut review_urls =
                find_posted_review_urls(&pull_requests, &started_at, &cancel_requested);
            if !documents.is_empty() {
                if let Some(issue_comment_url) =
                    find_posted_issue_comment_url(&issue, &started_at, &cancel_requested)
                {
                    for document in &documents {
                        review_urls.insert(document.source_path.clone(), issue_comment_url.clone());
                    }
                }
            }
            if cancel_requested.load(Ordering::SeqCst) {
                finish_active_review(&state, &review_run_id, &review_workspace);
                return;
            }
            let targets = pull_requests
                .iter()
                .map(|pull_request| pull_request.url.clone())
                .chain(
                    documents
                        .iter()
                        .map(|document| document.source_path.clone()),
                )
                .collect::<Vec<_>>();
            let updates = targets
                .iter()
                .map(|target| {
                    let review_url = review_urls.get(target).cloned();
                    (
                        target.clone(),
                        ReviewResourceUpdate {
                            state: if review_url.is_some() {
                                "posted".into()
                            } else {
                                "failed".into()
                            },
                            review_url,
                            error: (!review_urls.contains_key(target)).then(|| {
                                "Codex finished, but no newly posted GitHub review was found."
                                    .into()
                            }),
                        },
                    )
                })
                .collect();
            let _ = update_source_review_state(
                &state,
                &source_task_id,
                &review_run_id,
                &started_at,
                &updates,
            );
            finish_active_review(&state, &review_run_id, &review_workspace);
        });
}

#[tauri::command]
fn cancel_codex_artifact_review(
    state: tauri::State<'_, Arc<AppState>>,
    source_task_id: String,
    review_run_id: String,
) -> Result<PresentationDocument, String> {
    cancel_codex_artifact_review_core(&state, source_task_id, review_run_id)
}

fn cancel_codex_artifact_review_core(
    state: &AppState,
    source_task_id: String,
    review_run_id: String,
) -> Result<PresentationDocument, String> {
    validate_id(&source_task_id)?;
    validate_id(&review_run_id)?;
    let review = state
        .active_reviews
        .lock()
        .map_err(display_error)?
        .get(&review_run_id)
        .cloned()
        .ok_or_else(|| "review_not_running".to_string())?;
    if review.source_task_id != source_task_id {
        return Err("review_task_mismatch".into());
    }
    let document = get_document_core(state, &source_task_id)?;
    let has_running_target = document.resources.iter().any(|resource| {
        review.targets.contains(&resource.path_or_url)
            && resource.metadata.get("review_task_id") == Some(&review_run_id)
            && resource
                .metadata
                .get("review_state")
                .is_some_and(|state| matches!(state.as_str(), "queued" | "running"))
    });
    if !has_running_target {
        return Err("review_not_running".into());
    }
    review.cancel_requested.store(true, Ordering::SeqCst);
    if let Ok(mut child) = review.child.lock() {
        let _ = child.kill();
    }
    let updates = review_updates(
        &review.targets,
        "cancelled",
        &HashMap::new(),
        Some("Codex review cancelled by the user."),
    );
    update_source_review_state(
        state,
        &source_task_id,
        &review_run_id,
        &review.started_at,
        &updates,
    )?;
    get_document_core(state, &source_task_id)
}

#[tauri::command]
fn launch_codex_artifact_review(
    state: tauri::State<'_, Arc<AppState>>,
    source_task_id: String,
    pr_urls: Vec<String>,
    document_paths: Vec<String>,
    issue_url: String,
) -> Result<String, String> {
    launch_codex_artifact_review_core(&state, source_task_id, pr_urls, document_paths, issue_url)
}

fn launch_codex_artifact_review_core(
    state: &Arc<AppState>,
    source_task_id: String,
    pr_urls: Vec<String>,
    document_paths: Vec<String>,
    issue_url: String,
) -> Result<String, String> {
    validate_id(&source_task_id)?;
    let target_count = pr_urls.len() + document_paths.len();
    if target_count == 0 || target_count > 20 {
        return Err("review_requires_one_to_twenty_artifacts".into());
    }
    let source_document = get_document_core(state, &source_task_id)?;
    let source_issue = github_issue_reference(&source_document.header.issue_url)
        .map_err(|_| "task_github_issue_required".to_string())?;
    let requested_issue = github_issue_reference(&issue_url)?;
    if source_issue != requested_issue {
        return Err("task_github_issue_mismatch".into());
    }
    let source_artifacts = source_document
        .resources
        .iter()
        .map(|resource| {
            (
                (
                    resource.resource_type.as_str(),
                    resource.path_or_url.as_str(),
                ),
                resource,
            )
        })
        .collect::<HashMap<_, _>>();

    let mut seen = HashSet::new();
    let mut pull_requests = Vec::new();
    for pr_url in pr_urls {
        if !source_artifacts.contains_key(&("github_pr", pr_url.as_str())) {
            return Err("review_artifact_not_found_in_source_task".into());
        }
        let reference = github_pull_request_reference(&pr_url)?;
        let identity = format!(
            "{}/{}#{}",
            reference.owner.to_ascii_lowercase(),
            reference.repository.to_ascii_lowercase(),
            reference.number
        );
        if seen.insert(identity) {
            pull_requests.push(reference);
        }
    }
    let mut documents = Vec::new();
    for document_path in document_paths {
        if !source_artifacts.contains_key(&("local_document", document_path.as_str())) {
            return Err("review_artifact_not_found_in_source_task".into());
        }
        if !seen.insert(format!("document:{document_path}")) {
            continue;
        }
        let ArtifactTarget::LocalDocument(canonical_path) =
            validate_artifact_target("local_document", &document_path)?
        else {
            return Err("review_document_invalid".into());
        };
        documents.push(LocalDocumentReviewReference {
            source_path: document_path,
            canonical_path,
        });
    }

    let codex_path = locate_codex_cli()?;
    let review_workspace = create_codex_review_workspace()?;
    let review_run_id = Uuid::new_v4().to_string();
    let timestamp = now();
    let targets = pull_requests
        .iter()
        .map(|pull_request| pull_request.url.clone())
        .chain(
            documents
                .iter()
                .map(|document| document.source_path.clone()),
        )
        .collect::<Vec<_>>();
    let queued_updates = review_updates(&targets, "queued", &HashMap::new(), None);
    if let Err(error) = update_source_review_state(
        state,
        &source_task_id,
        &review_run_id,
        &timestamp,
        &queued_updates,
    ) {
        let _ = std::fs::remove_dir_all(review_workspace);
        return Err(error);
    }

    let prompt = codex_review_prompt(&pull_requests, &documents, &requested_issue, &issue_url);
    let child = match ProcessCommand::new(codex_path)
        .args(codex_review_arguments(prompt))
        .current_dir(&review_workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("NO_COLOR")
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let failed_updates = review_updates(
                &targets,
                "failed",
                &HashMap::new(),
                Some("Codex review could not be started."),
            );
            let _ = update_source_review_state(
                state,
                &source_task_id,
                &review_run_id,
                &timestamp,
                &failed_updates,
            );
            let _ = std::fs::remove_dir_all(review_workspace);
            return Err(display_error(error));
        }
    };
    let child = Arc::new(Mutex::new(child));
    let cancel_requested = Arc::new(AtomicBool::new(false));
    state.active_reviews.lock().map_err(display_error)?.insert(
        review_run_id.clone(),
        ActiveReview {
            source_task_id: source_task_id.clone(),
            targets: targets.clone(),
            started_at: timestamp.clone(),
            child: child.clone(),
            cancel_requested: cancel_requested.clone(),
        },
    );
    let running_updates = review_updates(&targets, "running", &HashMap::new(), None);
    if let Err(error) = update_source_review_state(
        state,
        &source_task_id,
        &review_run_id,
        &timestamp,
        &running_updates,
    ) {
        cancel_requested.store(true, Ordering::SeqCst);
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
        finish_active_review(state, &review_run_id, &review_workspace);
        return Err(error);
    }
    watch_codex_review(
        state.clone(),
        child,
        cancel_requested,
        source_task_id,
        review_run_id.clone(),
        pull_requests,
        documents,
        requested_issue,
        timestamp,
        review_workspace,
    );
    Ok(review_run_id)
}

#[tauri::command]
fn open_artifact(artifact_type: String, target: String) -> Result<(), String> {
    let artifact = validate_artifact_target(&artifact_type, &target)?;
    #[cfg(target_os = "macos")]
    let status = match artifact {
        ArtifactTarget::LocalDocument(path) => ProcessCommand::new("/usr/bin/open")
            .args(["-a", "Zed"])
            .arg(path)
            .status(),
        ArtifactTarget::Web(url) => ProcessCommand::new("/usr/bin/open").arg(url).status(),
    };
    #[cfg(target_os = "linux")]
    let status = match artifact {
        ArtifactTarget::LocalDocument(path) => ProcessCommand::new("zed").arg(path).status(),
        ArtifactTarget::Web(url) => ProcessCommand::new("xdg-open").arg(url).status(),
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err("artifact_open_unsupported_platform".into());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err("artifact_application_rejected_target".into()),
        Err(error) => Err(format!("artifact_application_unavailable: {error}")),
    }
}

#[tauri::command]
fn get_bridge_info(
    state: tauri::State<'_, Arc<AppState>>,
    task_id: String,
) -> Result<BridgeInfo, String> {
    get_bridge_info_core(&state, &task_id)
}

fn get_bridge_info_core(state: &AppState, task_id: &str) -> Result<BridgeInfo, String> {
    validate_id(task_id)?;
    if !task_exists(state, task_id)? {
        return Err("task_not_found".into());
    }
    let token = {
        let mut tokens = state.tokens.lock().map_err(display_error)?;
        tokens
            .entry(task_id.to_string())
            .or_insert_with(random_token)
            .clone()
    };
    let endpoint = state.bridge_endpoint.read().map_err(display_error)?.clone();
    if endpoint.is_empty() {
        return Err("bridge_not_ready".into());
    }
    Ok(BridgeInfo {
        endpoint,
        protocol_version: PROTOCOL_VERSION.into(),
        token,
    })
}

fn random_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn validate_directory(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if !path.is_absolute() || !path.is_dir() {
        return Err("starting_directory_must_be_an_existing_absolute_directory".into());
    }
    Ok(())
}

fn default_directory() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|home| Path::new(home).is_dir())
        .unwrap_or_else(|| "/".into())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgeRequest {
    operation: Operation,
    #[serde(default)]
    wait_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
struct BridgeResponse {
    ok: bool,
    document: Option<PresentationDocument>,
    wait: Option<WaitResult>,
    error: Option<BridgeError>,
}

#[derive(Debug, Serialize)]
struct BridgeError {
    code: String,
    message: String,
    retryable: bool,
}

async fn bridge_health() -> impl IntoResponse {
    Json(json!({ "ok": true, "protocol_version": PROTOCOL_VERSION }))
}

async fn bridge_context(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    match authenticate(&state, &headers) {
        Ok(task_id) => match get_document_core(&state, &task_id) {
            Ok(document) => (
                StatusCode::OK,
                Json(BridgeResponse {
                    ok: true,
                    document: Some(document),
                    wait: None,
                    error: None,
                }),
            ),
            Err(error) => bridge_error(StatusCode::NOT_FOUND, error, false),
        },
        Err(error) => bridge_error(StatusCode::UNAUTHORIZED, error, false),
    }
}

async fn bridge_operation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<BridgeRequest>,
) -> impl IntoResponse {
    let task_id = match authenticate(&state, &headers) {
        Ok(task_id) => task_id,
        Err(error) => return bridge_error(StatusCode::UNAUTHORIZED, error, false),
    };
    if request.operation.task_id != task_id {
        return bridge_error(StatusCode::FORBIDDEN, "task_scope_mismatch".into(), false);
    }

    let should_wait =
        request.operation.op_type == "ask_user" && request.wait_seconds.unwrap_or(0) > 0;
    let mut receiver = None;
    let mut waiter_id = None;
    if should_wait {
        let question_id = request
            .operation
            .payload
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Err(error) = validate_id(question_id) {
            return bridge_error(StatusCode::BAD_REQUEST, error, false);
        }
        let key = waiter_key(&task_id, question_id);
        let (sender, next_receiver) = oneshot::channel();
        if state
            .waiters
            .lock()
            .map_err(display_error)
            .and_then(|mut waiters| {
                if waiters.contains_key(&key) {
                    Err("question_already_waiting".into())
                } else {
                    waiters.insert(key.clone(), sender);
                    Ok(())
                }
            })
            .is_err()
        {
            return bridge_error(
                StatusCode::CONFLICT,
                "question_already_waiting".into(),
                false,
            );
        }
        waiter_id = Some(key);
        receiver = Some(next_receiver);
    }

    let document = match apply_operation_core(&state, request.operation) {
        Ok(document) => document,
        Err(error) => {
            if let Some(key) = waiter_id {
                let _ = state.waiters.lock().map(|mut waiters| waiters.remove(&key));
            }
            let status = if error.starts_with("revision_conflict") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            return bridge_error(status, error, true);
        }
    };

    if let Some(receiver) = receiver {
        let timeout_seconds = request.wait_seconds.unwrap_or(300).min(3600);
        let result = tokio::time::timeout(Duration::from_secs(timeout_seconds), receiver).await;
        let wait = match result {
            Ok(Ok(wait)) => wait,
            Ok(Err(_)) => WaitResult {
                status: "cancelled".into(),
                answer: None,
                question_id: waiter_id
                    .as_deref()
                    .and_then(|key| key.rsplit(':').next())
                    .unwrap_or_default()
                    .into(),
            },
            Err(_) => {
                if let Some(key) = waiter_id.as_deref() {
                    let _ = state.waiters.lock().map(|mut waiters| waiters.remove(key));
                }
                WaitResult {
                    status: "timed_out".into(),
                    answer: None,
                    question_id: waiter_id
                        .as_deref()
                        .and_then(|key| key.rsplit(':').next())
                        .unwrap_or_default()
                        .into(),
                }
            }
        };
        return (
            StatusCode::OK,
            Json(BridgeResponse {
                ok: true,
                document: Some(document),
                wait: Some(wait),
                error: None,
            }),
        );
    }

    (
        StatusCode::OK,
        Json(BridgeResponse {
            ok: true,
            document: Some(document),
            wait: None,
            error: None,
        }),
    )
}

fn bridge_error(
    status: StatusCode,
    message: String,
    retryable: bool,
) -> (StatusCode, Json<BridgeResponse>) {
    let code = message
        .split(':')
        .next()
        .unwrap_or("operation_error")
        .to_string();
    (
        status,
        Json(BridgeResponse {
            ok: false,
            document: None,
            wait: None,
            error: Some(BridgeError {
                code,
                message,
                retryable,
            }),
        }),
    )
}

fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<String, String> {
    let task_id = headers
        .get("x-agent-ui-task-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "missing_task_id".to_string())?;
    let provided = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| "missing_bearer_token".to_string())?;
    let expected = state
        .tokens
        .lock()
        .map_err(display_error)?
        .get(task_id)
        .cloned()
        .ok_or_else(|| "unknown_task_token".to_string())?;
    if provided.len() != expected.len()
        || !provided
            .as_bytes()
            .iter()
            .zip(expected.as_bytes())
            .fold(0u8, |diff, (left, right)| diff | (left ^ right))
            .eq(&0)
    {
        return Err("invalid_task_token".into());
    }
    Ok(task_id.into())
}

fn waiter_key(task_id: &str, question_id: &str) -> String {
    format!("{task_id}:{question_id}")
}

fn cancel_waiters(state: &AppState, task_id: &str, status: &str) -> Result<(), String> {
    let prefix = format!("{task_id}:");
    let keys: Vec<String> = state
        .waiters
        .lock()
        .map_err(display_error)?
        .keys()
        .filter(|key| key.starts_with(&prefix))
        .cloned()
        .collect();
    let mut waiters = state.waiters.lock().map_err(display_error)?;
    for key in keys {
        if let Some(sender) = waiters.remove(&key) {
            let question_id = key.rsplit(':').next().unwrap_or_default().into();
            let _ = sender.send(WaitResult {
                status: status.into(),
                answer: None,
                question_id,
            });
        }
    }
    Ok(())
}

fn start_bridge(state: Arc<AppState>) -> Result<(), String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(display_error)?;
    listener.set_nonblocking(true).map_err(display_error)?;
    let address = listener.local_addr().map_err(display_error)?;
    *state.bridge_endpoint.write().map_err(display_error)? = format!("http://{address}");
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Telemachus bridge listener failed: {error}");
                return;
            }
        };
        let router = Router::new()
            .route("/health", get(bridge_health))
            .route("/v1/context", get(bridge_context))
            .route("/v1/operation", post(bridge_operation))
            .layer(DefaultBodyLimit::max(MAX_PAYLOAD_BYTES + 16 * 1024))
            .with_state(state);
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("Telemachus bridge stopped: {error}");
        }
    });
    Ok(())
}

fn install_cli(app_data_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let cli_bin_dir = app_data_dir.join("bin");
    std::fs::create_dir_all(&cli_bin_dir).map_err(display_error)?;
    let cli_path = cli_bin_dir.join("agent-ui");
    std::fs::write(&cli_path, AGENT_UI_CLI).map_err(display_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli_path, std::fs::Permissions::from_mode(0o755))
            .map_err(display_error)?;
    }
    Ok((cli_path, cli_bin_dir))
}

fn application_state(app: &tauri::App) -> Result<Arc<AppState>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(display_error)?;
    std::fs::create_dir_all(&app_data_dir).map_err(display_error)?;
    let db_path: PathBuf = app_data_dir.join("agent-ui.sqlite3");
    let (cli_path, cli_bin_dir) = install_cli(&app_data_dir)?;
    Ok(Arc::new(AppState::new(&db_path, cli_path, cli_bin_dir)?))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = application_state(app).map_err(std::io::Error::other)?;
            *state.app_handle.lock().map_err(display_error)? = Some(app.handle().clone());
            start_bridge(state.clone()).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<Arc<AppState>>();
                let _ = stop_all_active_reviews(&state);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            create_task,
            close_task,
            get_active_task,
            set_active_task,
            get_document,
            apply_operation,
            answer_question,
            complete_todo,
            update_layout,
            get_scratchpad,
            update_scratchpad,
            create_terminal,
            get_terminal_snapshot,
            write_terminal,
            resize_terminal,
            close_terminal,
            open_artifact,
            get_closed_github_pull_requests,
            discover_open_github_pull_requests,
            launch_codex_artifact_review,
            cancel_codex_artifact_review,
            get_bridge_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running Telemachus");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(task_id: &str, op_type: &str, payload: Value) -> Operation {
        Operation {
            protocol_version: PROTOCOL_VERSION.into(),
            task_id: task_id.into(),
            source: "test".into(),
            op_type: op_type.into(),
            payload,
            expected_revision: None,
            idempotency_key: None,
        }
    }

    #[test]
    fn bundled_cli_is_installed_as_an_executable() {
        let app_data_dir =
            std::env::temp_dir().join(format!("agent-ui-cli-test-{}", Uuid::new_v4()));
        let (cli_path, cli_bin_dir) = install_cli(&app_data_dir).unwrap();
        assert_eq!(cli_bin_dir, app_data_dir.join("bin"));
        assert_eq!(std::fs::read(&cli_path).unwrap(), AGENT_UI_CLI);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&cli_path).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0);
        }
        std::fs::remove_dir_all(&app_data_dir).unwrap();
    }

    #[test]
    fn artifact_targets_are_strictly_classified() {
        let local = tempfile::NamedTempFile::new().unwrap();
        assert!(matches!(
            validate_artifact_target("local_document", local.path().to_str().unwrap()).unwrap(),
            ArtifactTarget::LocalDocument(_)
        ));
        assert_eq!(
            validate_artifact_target("local_document", "relative/report.md").unwrap_err(),
            "artifact_path_must_be_absolute"
        );
        assert_eq!(
            validate_artifact_target("web_document", "file:///tmp/report.pdf").unwrap_err(),
            "artifact_url_must_be_http"
        );
        assert!(matches!(
            validate_artifact_target(
                "github_pr",
                "https://github.com/openai/codex/pull/123/files",
            )
            .unwrap(),
            ArtifactTarget::Web(_)
        ));
        assert_eq!(
            validate_artifact_target("github_pr", "https://example.com/org/repo/pull/1")
                .unwrap_err(),
            "invalid_github_pull_request_url"
        );
        assert!(validate_github_issue_url(
            "https://github.com/openai/codex/issues/456#issuecomment-1"
        )
        .is_ok());
        assert_eq!(
            validate_github_issue_url("https://github.com/openai/codex/pull/456").unwrap_err(),
            "invalid_github_issue_url"
        );
        assert_eq!(
            validate_github_issue_url("http://github.com/openai/codex/issues/456").unwrap_err(),
            "invalid_github_issue_url"
        );
        assert!(github_pull_request_state_is_closed("CLOSED\n"));
        assert!(github_pull_request_state_is_closed("merged"));
        assert!(!github_pull_request_state_is_closed("OPEN"));
    }

    #[test]
    fn terminal_output_discovers_and_canonicalizes_pull_request_links() {
        let output = concat!(
            "\u{1b}[32mCreated https://github.com/openai/codex/pull/123\u{1b}[0m\n",
            "Review: https://github.com/acme/store/pull/42/files).\n",
            "Duplicate: https://github.com/openai/codex/pull/123?notification_referrer=1\n",
            "Not a PR: https://github.com/openai/codex/issues/123\n",
            "Not GitHub: https://example.com/acme/store/pull/42\n"
        );
        assert_eq!(
            terminal_github_pull_request_urls(output),
            vec![
                "https://github.com/openai/codex/pull/123",
                "https://github.com/acme/store/pull/42",
            ]
        );
    }

    #[test]
    fn codex_review_launch_is_issue_grounded_and_uses_sol_high() {
        let issue = github_issue_reference("https://github.com/openai/codex/issues/456").unwrap();
        let pull_requests = vec![
            github_pull_request_reference("https://github.com/openai/codex/pull/123").unwrap(),
            github_pull_request_reference("https://github.com/openai/codex/pull/124").unwrap(),
        ];
        let documents = vec![LocalDocumentReviewReference {
            source_path: "/tmp/plan.md".into(),
            canonical_path: PathBuf::from("/tmp/plan.md"),
        }];
        let prompt = codex_review_prompt(
            &pull_requests,
            &documents,
            &issue,
            "https://github.com/openai/codex/issues/456",
        );
        assert!(prompt.contains("openai/codex#456"));
        assert!(prompt.contains("https://github.com/openai/codex/pull/123"));
        assert!(prompt.contains("https://github.com/openai/codex/pull/124"));
        assert!(prompt.contains("/tmp/plan.md"));
        assert!(prompt.contains("submit the completed review on GitHub"));
        assert!(prompt.contains("submit the completed review as a comment"));
        assert!(prompt.contains("Do not merely print the review"));

        let arguments = codex_review_arguments(prompt);
        assert_eq!(
            arguments
                .iter()
                .take(3)
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["-a", "never", "exec"]
        );
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["-m", CODEX_REVIEW_MODEL]));
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["-c", CODEX_REVIEW_REASONING_CONFIG]));
        assert!(arguments.windows(2).any(|pair| pair == ["-a", "never"]));
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["-s", "workspace-write"]));
        assert!(arguments
            .windows(2)
            .any(|pair| { pair == ["-c", "sandbox_workspace_write.network_access=true"] }));
        assert!(!arguments
            .iter()
            .any(|argument| argument == "--no-alt-screen"));
        assert!(!arguments
            .iter()
            .any(|argument| argument == "--dangerously-bypass-approvals-and-sandbox"));

        let review_path = std::env::temp_dir()
            .join("agent-ui-codex-reviews")
            .join(Uuid::new_v4().to_string());
        assert!(is_codex_review_workspace(&review_path));
        assert!(!is_codex_review_workspace(Path::new("/tmp")));
    }

    #[test]
    fn review_state_is_persisted_on_source_pull_request() {
        let state = AppState::in_memory();
        let task = create_task_core(&state, None).unwrap();
        let pull_request =
            github_pull_request_reference("https://github.com/openai/codex/pull/123").unwrap();
        apply_operation_core(
            &state,
            operation(
                &task.id,
                "replace_resources",
                json!({
                    "resources": [{
                        "id": "implementation-pr",
                        "type": "github_pr",
                        "label": "openai/codex PR #123",
                        "path_or_url": pull_request.url.clone(),
                        "status": "reported",
                        "metadata": {"github_state": "open"}
                    }]
                }),
            ),
        )
        .unwrap();

        let started_at = now();
        let running = review_updates(
            std::slice::from_ref(&pull_request.url),
            "running",
            &HashMap::new(),
            None,
        );
        update_source_review_state(&state, &task.id, "review-task-1", &started_at, &running)
            .unwrap();
        let running_document = get_document_core(&state, &task.id).unwrap();
        assert_eq!(
            running_document.resources[0]
                .metadata
                .get("review_state")
                .map(String::as_str),
            Some("running")
        );

        let review_url =
            "https://github.com/openai/codex/pull/123#pullrequestreview-456".to_string();
        let posted = review_updates(
            std::slice::from_ref(&pull_request.url),
            "posted",
            &HashMap::from([(pull_request.url.clone(), review_url.clone())]),
            None,
        );
        update_source_review_state(&state, &task.id, "review-task-1", &started_at, &posted)
            .unwrap();
        let posted_document = get_document_core(&state, &task.id).unwrap();
        assert_eq!(
            posted_document.resources[0]
                .metadata
                .get("review_state")
                .map(String::as_str),
            Some("posted")
        );
        assert_eq!(
            posted_document.resources[0].metadata.get("review_url"),
            Some(&review_url)
        );
        assert_eq!(
            posted_document.resources[0]
                .metadata
                .get("review_count")
                .map(String::as_str),
            Some("1")
        );

        update_source_review_state(&state, &task.id, "review-task-1", &started_at, &posted)
            .unwrap();
        assert_eq!(
            get_document_core(&state, &task.id).unwrap().resources[0]
                .metadata
                .get("review_count")
                .map(String::as_str),
            Some("1")
        );

        let second_started_at = now();
        let second_running = review_updates(
            std::slice::from_ref(&pull_request.url),
            "queued",
            &HashMap::new(),
            None,
        );
        update_source_review_state(
            &state,
            &task.id,
            "review-task-2",
            &second_started_at,
            &second_running,
        )
        .unwrap();
        let second_posted = review_updates(
            std::slice::from_ref(&pull_request.url),
            "posted",
            &HashMap::from([(pull_request.url.clone(), review_url)]),
            None,
        );
        update_source_review_state(
            &state,
            &task.id,
            "review-task-2",
            &second_started_at,
            &second_posted,
        )
        .unwrap();
        assert_eq!(
            get_document_core(&state, &task.id).unwrap().resources[0]
                .metadata
                .get("review_count")
                .map(String::as_str),
            Some("2")
        );
    }

    #[test]
    fn running_review_can_be_cancelled() {
        let state = AppState::in_memory();
        let task = create_task_core(&state, None).unwrap();
        let pull_request =
            github_pull_request_reference("https://github.com/openai/codex/pull/123").unwrap();
        apply_operation_core(
            &state,
            operation(
                &task.id,
                "replace_resources",
                json!({
                    "resources": [{
                        "id": "implementation-pr",
                        "type": "github_pr",
                        "label": "openai/codex PR #123",
                        "path_or_url": pull_request.url.clone(),
                        "status": "reported",
                        "metadata": {"github_state": "open"}
                    }]
                }),
            ),
        )
        .unwrap();
        let review_run_id = "review-task-1";
        let started_at = now();
        let running = review_updates(
            std::slice::from_ref(&pull_request.url),
            "running",
            &HashMap::new(),
            None,
        );
        update_source_review_state(&state, &task.id, review_run_id, &started_at, &running).unwrap();

        let child = Arc::new(Mutex::new(
            ProcessCommand::new("/bin/sh")
                .args(["-c", "sleep 30"])
                .spawn()
                .unwrap(),
        ));
        let cancel_requested = Arc::new(AtomicBool::new(false));
        state.active_reviews.lock().unwrap().insert(
            review_run_id.into(),
            ActiveReview {
                source_task_id: task.id.clone(),
                targets: vec![pull_request.url],
                started_at,
                child: child.clone(),
                cancel_requested: cancel_requested.clone(),
            },
        );

        let document =
            cancel_codex_artifact_review_core(&state, task.id, review_run_id.into()).unwrap();
        assert!(cancel_requested.load(Ordering::SeqCst));
        assert_eq!(
            document.resources[0]
                .metadata
                .get("review_state")
                .map(String::as_str),
            Some("cancelled")
        );
        assert_eq!(
            document.resources[0]
                .metadata
                .get("review_error")
                .map(String::as_str),
            Some("Codex review cancelled by the user.")
        );

        state.active_reviews.lock().unwrap().remove(review_run_id);
        let _ = child.lock().unwrap().wait();
    }

    #[test]
    fn review_state_is_persisted_on_source_local_document() {
        let state = AppState::in_memory();
        let task = create_task_core(&state, None).unwrap();
        let path = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        apply_operation_core(
            &state,
            operation(
                &task.id,
                "replace_resources",
                json!({
                    "resources": [{
                        "id": "plan-document",
                        "type": "local_document",
                        "label": "Plan",
                        "path_or_url": path.clone(),
                        "status": "generated"
                    }]
                }),
            ),
        )
        .unwrap();

        let started_at = now();
        let running = review_updates(
            std::slice::from_ref(&path),
            "running",
            &HashMap::new(),
            None,
        );
        update_source_review_state(&state, &task.id, "review-run-1", &started_at, &running)
            .unwrap();

        let document = get_document_core(&state, &task.id).unwrap();
        assert_eq!(
            document.resources[0]
                .metadata
                .get("review_state")
                .map(String::as_str),
            Some("running")
        );
    }

    #[test]
    fn task_documents_are_isolated() {
        let state = AppState::in_memory();
        let first = create_task_core(&state, None).unwrap();
        let second = create_task_core(&state, None).unwrap();
        let payload = json!({
            "id": "same-id",
            "title": "Only in first",
            "detail": "",
            "status": "pending",
            "order": 0
        });
        apply_operation_core(&state, operation(&first.id, "upsert_task", payload)).unwrap();
        assert_eq!(get_document_core(&state, &first.id).unwrap().tasks.len(), 1);
        assert!(get_document_core(&state, &second.id)
            .unwrap()
            .tasks
            .is_empty());
    }

    #[test]
    fn live_terminal_lookup_is_task_scoped() {
        let sessions = [
            ("session-a", "task-a"),
            ("session-b", "task-b"),
            ("session-c", "task-c"),
        ];
        assert_eq!(
            terminal_id_for_task(sessions.iter().copied(), "task-b"),
            Some("session-b".into())
        );
        assert_eq!(
            terminal_id_for_task(sessions.iter().copied(), "missing"),
            None
        );
        assert!(terminal_belongs_to_task(
            sessions.iter().copied(),
            "session-b",
            "task-b"
        ));
        assert!(!terminal_belongs_to_task(
            sessions.iter().copied(),
            "session-a",
            "task-b"
        ));
    }

    #[test]
    fn terminal_buffer_tracks_offsets_and_bounds_replay() {
        let mut output = TerminalBuffer::default();
        assert_eq!(output.append(b"abc"), 0);
        assert_eq!(output.append(b"def"), 3);
        let snapshot = output.snapshot("session-a".into());
        assert_eq!(snapshot.start_offset, 0);
        assert_eq!(snapshot.next_offset, 6);
        assert_eq!(snapshot.data, b"abcdef");

        output.append(&vec![b'x'; MAX_TERMINAL_BUFFER]);
        let bounded = output.snapshot("session-a".into());
        assert_eq!(bounded.data.len(), MAX_TERMINAL_BUFFER);
        assert_eq!(bounded.start_offset, 6);
        assert_eq!(bounded.next_offset, MAX_TERMINAL_BUFFER as u64 + 6);
    }

    #[test]
    fn scratchpads_are_private_and_task_scoped() {
        let state = AppState::in_memory();
        let first = create_task_core(&state, None).unwrap();
        let second = create_task_core(&state, None).unwrap();

        let saved =
            update_scratchpad_core(&state, &first.id, "Human-only note".into(), false).unwrap();
        assert_eq!(saved.content, "Human-only note");
        assert!(!saved.collapsed);
        assert_eq!(
            get_scratchpad_core(&state, &first.id).unwrap().content,
            "Human-only note"
        );
        assert_eq!(
            get_scratchpad_core(&state, &second.id).unwrap(),
            ScratchpadState::default()
        );

        let agent_document =
            serde_json::to_value(get_document_core(&state, &first.id).unwrap()).unwrap();
        assert!(agent_document.get("scratchpad").is_none());
        assert_eq!(
            update_scratchpad_core(&state, &first.id, "x".repeat(MAX_SCRATCHPAD + 1), false,)
                .unwrap_err(),
            "scratchpad_too_large"
        );
    }

    #[test]
    fn idempotency_returns_original_revision() {
        let state = AppState::in_memory();
        let task = create_task_core(&state, None).unwrap();
        let mut op = operation(
            &task.id,
            "set_task_status",
            json!({"status": "working", "status_message": "Testing"}),
        );
        op.idempotency_key = Some("same-request".into());
        let first = apply_operation_core(&state, op.clone()).unwrap();
        let second = apply_operation_core(&state, op).unwrap();
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.revision, 1);
    }

    #[test]
    fn stale_revisions_are_rejected() {
        let state = AppState::in_memory();
        let task = create_task_core(&state, None).unwrap();
        let mut op = operation(&task.id, "set_task_status", json!({"status": "working"}));
        op.expected_revision = Some(9);
        assert!(apply_operation_core(&state, op)
            .unwrap_err()
            .starts_with("revision_conflict"));
    }

    #[test]
    fn malformed_and_oversized_content_is_rejected() {
        let state = AppState::in_memory();
        let task = create_task_core(&state, None).unwrap();
        let malformed = operation(&task.id, "set_task_status", json!({"status": "invented"}));
        assert!(apply_operation_core(&state, malformed)
            .unwrap_err()
            .starts_with("invalid_payload"));
        let oversized = operation(
            &task.id,
            "set_task",
            json!({
                "title": "x".repeat(MAX_PAYLOAD_BYTES),
                "description": "",
                "source": "test",
                "status": "idle",
                "status_message": ""
            }),
        );
        assert_eq!(
            apply_operation_core(&state, oversized).unwrap_err(),
            "payload_too_large"
        );
    }

    #[test]
    fn question_answers_update_state_and_release_waiter_once() {
        let state = AppState::in_memory();
        let task = create_task_core(&state, None).unwrap();
        apply_operation_core(
            &state,
            operation(
                &task.id,
                "ask_user",
                json!({
                    "id": "rollout",
                    "text": "Which rollout?",
                    "blocking": true,
                    "choices": ["Canary", "All at once"],
                    "allow_free_text": true
                }),
            ),
        )
        .unwrap();

        let (sender, receiver) = oneshot::channel();
        state
            .waiters
            .lock()
            .unwrap()
            .insert(waiter_key(&task.id, "rollout"), sender);
        let document =
            answer_question_core(&state, task.id.clone(), "rollout".into(), "Canary".into())
                .unwrap();

        assert_eq!(document.questions[0].state, QuestionState::Answered);
        assert_eq!(document.questions[0].answer.as_deref(), Some("Canary"));
        let wait = receiver.blocking_recv().unwrap();
        assert_eq!(wait.status, "answered");
        assert_eq!(wait.answer.as_deref(), Some("Canary"));
        assert_eq!(
            answer_question_core(&state, task.id, "rollout".into(), "Again".into()).unwrap_err(),
            "question_not_open"
        );
    }

    #[test]
    fn action_todos_are_completed_by_the_human() {
        let state = AppState::in_memory();
        let task = create_task_core(&state, None).unwrap();
        let document = apply_operation_core(
            &state,
            operation(
                &task.id,
                "ask_user",
                json!({
                    "id": "deploy",
                    "kind": "action",
                    "text": "Deploy the release to production.",
                    "blocking": true,
                    "choices": [],
                    "allow_free_text": false
                }),
            ),
        )
        .unwrap();

        assert_eq!(document.questions[0].kind, TodoKind::Action);
        assert_eq!(document.questions[0].state, QuestionState::Open);
        assert!(has_attention(&document));
        assert_eq!(
            answer_question_core(&state, task.id.clone(), "deploy".into(), "Done".into())
                .unwrap_err(),
            "todo_is_not_question"
        );

        let (sender, receiver) = oneshot::channel();
        state
            .waiters
            .lock()
            .unwrap()
            .insert(waiter_key(&task.id, "deploy"), sender);
        let document = complete_todo_core(&state, task.id.clone(), "deploy".into()).unwrap();
        assert_eq!(document.questions[0].state, QuestionState::Completed);
        assert!(!has_attention(&document));
        let wait = receiver.blocking_recv().unwrap();
        assert_eq!(wait.status, "completed");
        assert_eq!(wait.answer, None);
        assert_eq!(
            complete_todo_core(&state, task.id, "deploy".into()).unwrap_err(),
            "todo_not_open"
        );
    }
}
