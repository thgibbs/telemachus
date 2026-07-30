import {
  AlertCircle,
  Check,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  TerminalSquare,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyOperation,
  cancelCodexArtifactReview,
  closeTask,
  createTask,
  getActiveTask,
  getDocument,
  isTauri,
  launchCodexArtifactReview,
  listTasks,
  onPresentationUpdated,
  setActiveTask,
} from "./lib/platform";
import type {
  PresentationDocument,
  PresentationUpdate,
  Resource,
  TaskSession,
} from "./types";
import { TaskWorkspace } from "./components/TaskWorkspace";
import { SidebarMagnifier } from "./components/SidebarMagnifier";

type TextSize = "standard" | "large" | "extra-large";
type PresentationSection =
  | "header"
  | "todos"
  | "plan"
  | "artifacts"
  | "prs"
  | "resources"
  | "summary"
  | "alerts";

interface PresentationChange {
  id: string;
  section: PresentationSection;
  at: number;
}

interface TabContextMenu {
  taskId: string;
  x: number;
  y: number;
}

interface TabRenameDialog {
  taskId: string;
  title: string;
  saving: boolean;
  error: string;
}

const textSizeKey = "agent-ui-text-size";
const textSizeScale: Record<TextSize, number> = {
  standard: 1,
  large: 1.18,
  "extra-large": 1.36,
};

function savedTextSize(): TextSize {
  const saved = localStorage.getItem(textSizeKey);
  return saved === "large" || saved === "extra-large" ? saved : "standard";
}

function changedSection(
  update: PresentationUpdate,
): PresentationSection | null {
  if (!update.source || update.source === "human") return null;
  switch (update.op_type) {
    case "set_task":
    case "set_task_status":
      return "header";
    case "replace_tasks":
    case "upsert_task":
      return "plan";
    case "ask_user":
      return "todos";
    case "set_summary":
      return "summary";
    case "raise_alert":
    case "clear_alert":
      return "alerts";
    case "replace_resources":
      return "resources";
    case "review_state":
      if (update.section === "prs") return "prs";
      if (update.section === "artifacts") return "artifacts";
      return "resources";
    default:
      return null;
  }
}

export function App() {
  const [tasks, setTasks] = useState<TaskSession[]>([]);
  const [documents, setDocuments] = useState<Record<string, PresentationDocument>>({});
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tabContextMenu, setTabContextMenu] =
    useState<TabContextMenu | null>(null);
  const [tabRenameDialog, setTabRenameDialog] =
    useState<TabRenameDialog | null>(null);
  const [textSize, setTextSize] = useState<TextSize>(savedTextSize);
  const [presentationChanges, setPresentationChanges] = useState<
    Record<string, PresentationChange>
  >({});
  const taskTabListRef = useRef<HTMLDivElement>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  const reloadTasks = useCallback(async () => {
    const next = await listTasks();
    setTasks(next);
    setActiveTaskId((current) =>
      current && next.some((task) => task.id === current)
        ? current
        : next[0]?.id ?? null,
    );
    return next;
  }, []);

  const loadDocument = useCallback(async (taskId: string) => {
    const next = await getDocument(taskId);
    setDocuments((current) => ({ ...current, [taskId]: next }));
  }, []);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    (async () => {
      let next = await reloadTasks();
      if (next.length === 0) {
        const first = await createTask();
        next = [first];
        setTasks(next);
        setActiveTaskId(first.id);
      }
      const preferredTaskId = await getActiveTask();
      setActiveTaskId(
        preferredTaskId && next.some((task) => task.id === preferredTaskId)
          ? preferredTaskId
          : next[0]?.id ?? null,
      );
      await Promise.all(next.map((task) => loadDocument(task.id)));
      setLoaded(true);
    })().catch((error) => {
      console.error("Unable to initialize Telemachus", error);
      setLoaded(true);
    });
  }, [loadDocument, reloadTasks]);

  useEffect(() => {
    if (!loaded || !activeTaskId) return;
    setActiveTask(activeTaskId).catch(console.error);
  }, [activeTaskId, loaded]);

  useEffect(() => {
    if (!activeTaskId || !taskTabListRef.current) return;
    const activeTab = [
      ...taskTabListRef.current.querySelectorAll<HTMLElement>("[data-task-id]"),
    ].find((element) => element.dataset.taskId === activeTaskId);
    activeTab?.scrollIntoView({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTaskId, tasks.length]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    onPresentationUpdated((update) => {
      loadDocument(update.task_id).catch(console.error);
      reloadTasks().catch(console.error);
      const section = changedSection(update);
      if (section) {
        setPresentationChanges((current) => ({
          ...current,
          [update.task_id]: {
            id: crypto.randomUUID(),
            section,
            at: Date.now(),
          },
        }));
      }
    }).then((unlisten) => (cleanup = unlisten));
    return () => cleanup?.();
  }, [loadDocument, reloadTasks]);

  const addTask = useCallback(
    async (chooseDirectory = false) => {
      setNewMenuOpen(false);
      let directory: string | undefined;
      if (chooseDirectory && isTauri()) {
        const selected = await open({
          directory: true,
          multiple: false,
          title: "Choose a starting directory",
        });
        if (!selected || Array.isArray(selected)) return;
        directory = selected;
      }
      const task = await createTask(directory);
      setTasks((current) =>
        current.some((existing) => existing.id === task.id)
          ? current
          : [...current, task],
      );
      await loadDocument(task.id);
      setActiveTaskId(task.id);
    },
    [loadDocument],
  );

  const removeTask = useCallback(
    async (taskId: string) => {
      const task = tasks.find((item) => item.id === taskId);
      if (
        !window.confirm(
          `Delete “${task?.title ?? "this task"}”, its presentation state, and its private scratchpad?`,
        )
      )
        return;
      await closeTask(taskId);
      setDocuments((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      const remaining = tasks.filter((item) => item.id !== taskId);
      setTasks(remaining);
      if (activeTaskId === taskId) setActiveTaskId(remaining[0]?.id ?? null);
    },
    [activeTaskId, tasks],
  );

  const renameTask = useCallback(
    async (taskId: string, title: string) => {
      let nextDocument: PresentationDocument | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const currentDocument = await getDocument(taskId);
        try {
          nextDocument = await applyOperation({
            protocol_version: "1.0",
            task_id: taskId,
            source: "human",
            op_type: "set_task",
            payload: {
              ...currentDocument.header,
              title,
            },
            expected_revision: currentDocument.revision,
            idempotency_key: crypto.randomUUID(),
          });
          break;
        } catch (error) {
          if (
            attempt === 1 ||
            !String(error).includes("revision_conflict")
          ) {
            throw error;
          }
        }
      }
      if (!nextDocument) return;
      setDocuments((current) => ({
        ...current,
        [taskId]: nextDocument,
      }));
      await reloadTasks();
    },
    [reloadTasks],
  );

  const launchReview = useCallback(
    async (sourceTaskId: string, resources: Resource[], issueUrl: string) => {
      await launchCodexArtifactReview(
        sourceTaskId,
        resources,
        issueUrl,
      );
      await loadDocument(sourceTaskId);
    },
    [loadDocument],
  );

  const cancelReview = useCallback(
    async (sourceTaskId: string, reviewRunId: string) => {
      const next = await cancelCodexArtifactReview(sourceTaskId, reviewRunId);
      setDocuments((current) => ({
        ...current,
        [sourceTaskId]: next,
      }));
    },
    [],
  );

  const chooseTextSize = useCallback((next: TextSize) => {
    localStorage.setItem(textSizeKey, next);
    setTextSize(next);
    setSettingsOpen(false);
  }, []);

  useEffect(() => {
    if (!tabContextMenu) return;
    const closeIfOutside = (event: PointerEvent) => {
      if (
        !tabContextMenuRef.current?.contains(event.target as Node)
      ) {
        setTabContextMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTabContextMenu(null);
    };
    const close = () => setTabContextMenu(null);
    window.addEventListener("pointerdown", closeIfOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", closeIfOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    if (!tabRenameDialog) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !tabRenameDialog.saving) {
        setTabRenameDialog(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [tabRenameDialog]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        addTask(true).catch(console.error);
      }
      if (event.metaKey && /^[1-9]$/.test(event.key)) {
        const task = tasks[Number(event.key) - 1];
        if (task) {
          event.preventDefault();
          setActiveTaskId(task.id);
        }
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [addTask, tasks]);

  if (!loaded) {
    return (
      <div className="splash">
        <div className="brand-mark large">
          <TerminalSquare />
        </div>
        <span>Opening your tasks…</span>
      </div>
    );
  }

  return (
    <div className="app-shell" data-text-size={textSize}>
      <header className="app-chrome" data-tauri-drag-region="deep">
        <div className="traffic-light-space" data-tauri-drag-region />
        <div className="brand" data-tauri-drag-region="deep">
          <div className="brand-mark">
            <TerminalSquare size={15} />
          </div>
          <span>Telemachus</span>
        </div>
        <nav className="task-tabs" aria-label="Task sessions">
          <div className="task-tab-list" ref={taskTabListRef}>
            {tasks.map((task, index) => (
              <button
                key={task.id}
                data-task-id={task.id}
                className={`task-tab ${activeTaskId === task.id ? "active" : ""}`}
                onClick={() => setActiveTaskId(task.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const menuWidth = 172;
                  const menuHeight = 46;
                  setTabContextMenu({
                    taskId: task.id,
                    x: Math.max(
                      8,
                      Math.min(event.clientX, window.innerWidth - menuWidth - 8),
                    ),
                    y: Math.max(
                      8,
                      Math.min(event.clientY, window.innerHeight - menuHeight - 8),
                    ),
                  });
                }}
                aria-current={activeTaskId === task.id ? "page" : undefined}
                title={`${task.title} — ⌘${index + 1}`}
              >
                <span className={`tab-status status-${task.status}`} />
                <span className="tab-title">{task.title}</span>
                {task.attention && (
                  <span className="attention" aria-label="Needs attention">
                    <AlertCircle size={13} />
                  </span>
                )}
                <span
                  className="tab-close"
                  role="button"
                  aria-label={`Close ${task.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeTask(task.id).catch(console.error);
                  }}
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>
          <div className="new-task-wrap">
            <button
              className="new-task-button"
              aria-label="New task"
              title="New task"
              onClick={() => addTask(false).catch(console.error)}
            >
              <Plus size={15} />
            </button>
            <button
              className="new-task-options-button"
              aria-label="New task options"
              aria-expanded={newMenuOpen}
              title="New task options"
              onClick={() => setNewMenuOpen((current) => !current)}
            >
              <ChevronDown size={11} />
            </button>
            {newMenuOpen && (
              <div className="new-task-menu">
                <button onClick={() => addTask(true).catch(console.error)}>
                  <Plus size={14} /> Choose starting directory…
                  <kbd>⌘T</kbd>
                </button>
              </div>
            )}
          </div>
        </nav>
        <div className="chrome-actions">
          <div className="settings-wrap">
            <button
              className="icon-button"
              aria-label="Display settings"
              aria-expanded={settingsOpen}
              title="Display settings"
              onClick={() => setSettingsOpen((current) => !current)}
            >
              <Settings2 size={15} />
            </button>
            {settingsOpen && (
              <div className="settings-menu" role="menu" aria-label="Text size">
                <div className="settings-menu-heading">Text size</div>
                {(
                  [
                    ["standard", "Standard"],
                    ["large", "Large"],
                    ["extra-large", "Extra large"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    role="menuitemradio"
                    aria-checked={textSize === value}
                    onClick={() => chooseTextSize(value)}
                  >
                    <span className="settings-check">
                      {textSize === value && <Check size={13} />}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-button" aria-label="More options" disabled>
            <MoreHorizontal size={16} />
          </button>
        </div>
      </header>

      {tabContextMenu && (
        <div
          ref={tabContextMenuRef}
          className="tab-context-menu"
          role="menu"
          aria-label="Tab actions"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              const taskId = tabContextMenu.taskId;
              const task = tasks.find((item) => item.id === taskId);
              setTabContextMenu(null);
              if (task) {
                setTabRenameDialog({
                  taskId,
                  title: task.title,
                  saving: false,
                  error: "",
                });
              }
            }}
          >
            <Pencil size={13} />
            Rename…
          </button>
        </div>
      )}

      {tabRenameDialog && (
        <div
          className="dialog-backdrop"
          onPointerDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !tabRenameDialog.saving
            ) {
              setTabRenameDialog(null);
            }
          }}
        >
          <form
            className="dialog record-editor tab-rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tab-rename-title"
            onSubmit={(event) => {
              event.preventDefault();
              const title = tabRenameDialog.title.trim();
              if (!title || tabRenameDialog.saving) return;
              setTabRenameDialog((current) =>
                current
                  ? { ...current, title, saving: true, error: "" }
                  : current,
              );
              renameTask(tabRenameDialog.taskId, title)
                .then(() => setTabRenameDialog(null))
                .catch((error) =>
                  setTabRenameDialog((current) =>
                    current
                      ? {
                          ...current,
                          saving: false,
                          error:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        }
                      : current,
                  ),
                );
            }}
          >
            <div className="dialog-header">
              <div>
                <div className="dialog-kicker">Tab</div>
                <h2 id="tab-rename-title">Rename tab</h2>
              </div>
            </div>
            <label>
              <span>Name</span>
              <input
                autoFocus
                value={tabRenameDialog.title}
                disabled={tabRenameDialog.saving}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) =>
                  setTabRenameDialog((current) =>
                    current
                      ? { ...current, title: event.target.value, error: "" }
                      : current,
                  )
                }
              />
            </label>
            {tabRenameDialog.error && (
              <div className="form-error" role="alert">
                {tabRenameDialog.error}
              </div>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button ghost compact"
                disabled={tabRenameDialog.saving}
                onClick={() => setTabRenameDialog(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button primary compact"
                disabled={
                  tabRenameDialog.saving ||
                  !tabRenameDialog.title.trim()
                }
              >
                {tabRenameDialog.saving ? "Renaming…" : "Rename"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="workspace-stack">
        {tasks.map((task) => {
          const document = documents[task.id];
          if (!document) return null;
          return (
            <TaskWorkspace
              key={task.id}
              task={task}
              document={document}
              active={activeTaskId === task.id}
              onDocument={(next) =>
                setDocuments((current) => ({ ...current, [task.id]: next }))
              }
              onTaskChanged={() => reloadTasks().catch(console.error)}
              onLaunchReview={(resources, issueUrl) =>
                launchReview(task.id, resources, issueUrl)
              }
              onCancelReview={(reviewRunId) =>
                cancelReview(task.id, reviewRunId)
              }
              presentationChange={presentationChanges[task.id]}
              textScale={textSizeScale[textSize]}
            />
          );
        })}
        {tasks.length === 0 && (
          <section className="no-tasks">
            <div className="brand-mark large">
              <TerminalSquare />
            </div>
            <h1>Start with a task</h1>
            <p>
              Each task keeps a terminal, plan, human to dos, summary, alerts,
              and artifacts together.
            </p>
            <button className="button primary" onClick={() => addTask(true)}>
              <Plus size={16} /> New task
            </button>
          </section>
        )}
      </div>
      <SidebarMagnifier />
      <footer className="status-bar">
        <span>
          <span className="connection-dot" /> Local
        </span>
        <span className="status-spacer" />
        <span>{tasks.length} open task{tasks.length === 1 ? "" : "s"}</span>
        <span className="shortcut-hint">⌘T new task · ⌘1–9 switch</span>
      </footer>
    </div>
  );
}
