import {
  AlertOctagon,
  AlertTriangle,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  CircleDashed,
  ClipboardList,
  Copy,
  Edit3,
  ExternalLink,
  FileText,
  GitPullRequest,
  Globe2,
  Info,
  ListTodo,
  PanelLeftClose,
  Paperclip,
  Save,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Alert,
  ItemStatus,
  Operation,
  PresentationDocument,
  Resource,
  TaskSession,
  TaskStatus,
} from "../types";
import { statusLabel } from "../types";
import {
  answerQuestion,
  applyOperation,
  completeTodo,
  discoverOpenGithubPullRequests,
  getClosedGithubPullRequests,
  openArtifact,
  updateLayout,
} from "../lib/platform";
import { Markdown } from "./Markdown";
import { TodoCard } from "./TodoCard";
import { Scratchpad } from "./Scratchpad";
import { TerminalPane } from "./TerminalPane";

const taskStatuses: TaskStatus[] = [
  "idle",
  "working",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

const closedGithubStates = new Set(["closed", "merged"]);
const activeReviewStates = new Set(["queued", "running"]);
const reviewHistoryStorageKey = "telemachus:review-history:v1";

function githubIssueIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      segments.length !== 4 ||
      segments[2] !== "issues" ||
      !/^[1-9]\d*$/.test(segments[3])
    ) {
      return null;
    }
    return `${segments[0].toLowerCase()}/${segments[1].toLowerCase()}#${segments[3]}`;
  } catch {
    return null;
  }
}

function githubIssueLabel(value: string): string {
  return githubIssueIdentity(value) ?? "GitHub issue";
}

function reportedGithubState(resource: Resource): string {
  return (
    resource.metadata.github_state ??
    resource.metadata.pr_state ??
    resource.metadata.state ??
    ""
  ).toLowerCase();
}

function isReportedClosedPullRequest(resource: Resource): boolean {
  return (
    resource.type === "github_pr" &&
    closedGithubStates.has(reportedGithubState(resource))
  );
}

function reportedReviewState(resource: Resource): string {
  return (resource.metadata.review_state ?? "").toLowerCase();
}

function completedReviewCount(taskId: string, resource: Resource): number {
  if (typeof window === "undefined") return 0;
  const historyKey = JSON.stringify([
    taskId,
    resource.type,
    resource.path_or_url,
  ]);
  let history: Record<string, string[]> = {};
  try {
    const stored = JSON.parse(
      localStorage.getItem(reviewHistoryStorageKey) ?? "{}",
    );
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      history = stored as Record<string, string[]>;
    }
  } catch {
    // Ignore malformed or unavailable local storage and start fresh.
  }

  const completedIds = Array.isArray(history[historyKey])
    ? history[historyKey].filter((value) => typeof value === "string")
    : [];
  const reviewId = resource.metadata.review_task_id;
  if (
    reportedReviewState(resource) === "posted" &&
    reviewId &&
    !completedIds.includes(reviewId)
  ) {
    completedIds.push(reviewId);
    history[historyKey] = completedIds;
    try {
      localStorage.setItem(reviewHistoryStorageKey, JSON.stringify(history));
    } catch {
      // The current count is still usable even if persistence is unavailable.
    }
  }
  return completedIds.length;
}

function isPlanDocument(resource: Resource): boolean {
  const explicitRole = (
    resource.metadata.role ??
    resource.metadata.artifact_role ??
    resource.metadata.kind ??
    ""
  ).toLowerCase();
  if (explicitRole === "plan") return true;
  if (
    !["local_document", "web_document", "path"].includes(resource.type)
  ) {
    return false;
  }
  const searchable = `${resource.label} ${resource.path_or_url}`.toLowerCase();
  return (
    /\bplan\b/.test(searchable) ||
    /(^|[/_-])plans?([/_-]|\.|$)/.test(searchable)
  );
}

function artifactRank(resource: Resource): number {
  if (isPlanDocument(resource)) return 0;
  if (resource.type === "github_pr") return 1;
  return 2;
}

const itemStatusIcon: Record<ItemStatus, React.ReactNode> = {
  pending: <CircleDashed size={15} />,
  in_progress: <Circle size={15} className="spin-soft" />,
  completed: <Check size={16} />,
  blocked: <ShieldAlert size={15} />,
  skipped: <ChevronRight size={15} />,
};

function makeOperation(
  taskId: string,
  opType: Operation["op_type"],
  payload: unknown,
  revision?: number,
): Operation {
  return {
    protocol_version: "1.0",
    task_id: taskId,
    source: "human",
    op_type: opType,
    payload,
    expected_revision: revision,
    idempotency_key: crypto.randomUUID(),
  };
}

export function TaskWorkspace({
  task,
  document,
  active,
  onDocument,
  onTaskChanged,
  onLaunchReview,
  presentationChange,
  textScale,
}: {
  task: TaskSession;
  document: PresentationDocument;
  active: boolean;
  onDocument: (document: PresentationDocument) => void;
  onTaskChanged: () => void;
  onLaunchReview: (resources: Resource[], issueUrl: string) => Promise<void>;
  presentationChange?: {
    id: string;
    at: number;
    section:
      | "header"
      | "todos"
      | "plan"
      | "artifacts"
      | "prs"
      | "resources"
      | "summary"
      | "alerts";
  };
  textScale: number;
}) {
  const [layout, setLayout] = useState(task.layout);
  const [editingHeader, setEditingHeader] = useState(false);
  const [statusExpanded, setStatusExpanded] = useState(true);
  const [planExpanded, setPlanExpanded] = useState(true);
  const [reviewingArtifacts, setReviewingArtifacts] = useState(false);
  const [reviewingPullRequests, setReviewingPullRequests] = useState(false);
  const [artifactReviewError, setArtifactReviewError] = useState("");
  const [pullRequestReviewError, setPullRequestReviewError] = useState("");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const documentRevisionRef = useRef(document.revision);
  const pullRequestDiscoveryTimerRef = useRef<number | null>(null);
  const pullRequestDiscoveryInFlightRef = useRef(false);
  const pullRequestDiscoveryPendingRef = useRef(false);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  documentRevisionRef.current = document.revision;

  useEffect(() => setLayout(task.layout), [task.layout]);

  useEffect(() => {
    if (
      active &&
      presentationChange?.section === "summary" &&
      Date.now() - presentationChange.at <= 2500
    ) {
      setStatusExpanded(true);
    }
  }, [
    active,
    presentationChange?.at,
    presentationChange?.id,
    presentationChange?.section,
  ]);

  useEffect(() => {
    if (
      active &&
      presentationChange?.section === "plan" &&
      Date.now() - presentationChange.at <= 2500
    ) {
      setPlanExpanded(true);
    }
  }, [
    active,
    presentationChange?.at,
    presentationChange?.id,
    presentationChange?.section,
  ]);

  useEffect(() => {
    if (
      !active ||
      !presentationChange ||
      Date.now() - presentationChange.at > 2500
    ) {
      return;
    }
    const target = workspaceRef.current?.querySelector<HTMLElement>(
      `[data-agent-section="${presentationChange.section}"]`,
    );
    target?.animate(
      [
        {
          backgroundColor: "rgba(201, 243, 108, 0.26)",
          boxShadow: "0 0 0 1px rgba(201, 243, 108, 0.72)",
        },
        {
          backgroundColor: "rgba(201, 243, 108, 0)",
          boxShadow: "0 0 0 1px rgba(201, 243, 108, 0)",
        },
      ],
      { duration: 1800, easing: "ease-out" },
    );
  }, [active, document.revision, presentationChange]);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!dragRef.current) return;
      const { startX, startWidth } = dragRef.current;
      const delta = event.clientX - startX;
      setLayout((current) => ({
        ...current,
        left_width: Math.max(220, Math.min(480, startWidth + delta)),
      }));
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      globalThis.document.body.classList.remove("is-resizing");
      setLayout((current) => {
        updateLayout(task.id, current).catch(() => undefined);
        return current;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [task.id]);

  async function mutate(opType: Operation["op_type"], payload: unknown) {
    const next = await applyOperation(
      makeOperation(task.id, opType, payload, document.revision),
    );
    onDocument(next);
    onTaskChanged();
  }

  async function saveLayout(next: typeof layout) {
    setLayout(next);
    await updateLayout(task.id, next);
    onTaskChanged();
  }

  async function runTerminalPullRequestDiscovery() {
    if (!active) return;
    if (pullRequestDiscoveryInFlightRef.current) {
      pullRequestDiscoveryPendingRef.current = true;
      return;
    }
    pullRequestDiscoveryInFlightRef.current = true;
    try {
      const next = await discoverOpenGithubPullRequests(task.id);
      if (next && next.revision > documentRevisionRef.current) {
        documentRevisionRef.current = next.revision;
        onDocument(next);
        onTaskChanged();
      }
    } catch {
      // Authentication or network failures are retried after later output.
    } finally {
      pullRequestDiscoveryInFlightRef.current = false;
      if (pullRequestDiscoveryPendingRef.current) {
        pullRequestDiscoveryPendingRef.current = false;
        scheduleTerminalPullRequestDiscovery();
      }
    }
  }

  function scheduleTerminalPullRequestDiscovery() {
    if (!active) return;
    if (pullRequestDiscoveryTimerRef.current !== null) {
      window.clearTimeout(pullRequestDiscoveryTimerRef.current);
    }
    pullRequestDiscoveryTimerRef.current = window.setTimeout(() => {
      pullRequestDiscoveryTimerRef.current = null;
      void runTerminalPullRequestDiscovery();
    }, 1200);
  }

  useEffect(() => {
    if (active) scheduleTerminalPullRequestDiscovery();
    return () => {
      if (pullRequestDiscoveryTimerRef.current !== null) {
        window.clearTimeout(pullRequestDiscoveryTimerRef.current);
        pullRequestDiscoveryTimerRef.current = null;
      }
    };
  }, [active, task.id]);

  const openTodos = document.questions.filter((todo) => todo.state === "open");
  const activeAlerts = document.alerts.filter((a) => a.state !== "cleared");
  const statusHeadline = document.summary.headline || "No status yet";
  const orderedTasks = [...document.tasks].sort((a, b) => a.order - b.order);
  const currentPlanItem =
    orderedTasks.find((item) => item.status === "in_progress") ??
    orderedTasks.find((item) => item.status === "blocked") ??
    orderedTasks.find((item) => item.status === "pending") ??
    orderedTasks.at(-1);
  const planHeadline = currentPlanItem?.title ?? "No plan reported";
  const issueUrl = document.header.issue_url ?? "";
  const issueIdentity = githubIssueIdentity(issueUrl);
  const visibleResources = document.resources
    .filter(
      (resource) =>
        !isReportedClosedPullRequest(resource) &&
        (!issueIdentity ||
          githubIssueIdentity(resource.path_or_url) !== issueIdentity),
    )
    .map((resource, index) => ({ resource, index }))
    .sort(
      (left, right) =>
        artifactRank(left.resource) - artifactRank(right.resource) ||
        left.index - right.index,
    )
    .map(({ resource }) => resource);
  const artifacts = visibleResources.filter(
    (resource) => resource.type !== "github_pr",
  );
  const githubPullRequests = document.resources.filter(
    (resource) => resource.type === "github_pr",
  );
  const openPullRequests = visibleResources.filter(
    (resource) => resource.type === "github_pr",
  );
  const reviewableArtifacts = artifacts.filter(
    (resource) =>
      resource.type === "local_document" &&
      !activeReviewStates.has(reportedReviewState(resource)),
  );
  const reviewablePullRequests = openPullRequests.filter(
    (resource) =>
      !activeReviewStates.has(reportedReviewState(resource)),
  );
  const githubPullRequestSignature = githubPullRequests
    .map(
      (resource) =>
        `${resource.id}:${resource.path_or_url}:${reportedGithubState(resource)}`,
    )
    .join("|");

  useEffect(() => {
    if (!active || githubPullRequests.length === 0) return;
    let cancelled = false;

    const refresh = async () => {
      const reportedClosed = githubPullRequests.filter(
        isReportedClosedPullRequest,
      );
      const openTargets = githubPullRequests
        .filter((resource) => !isReportedClosedPullRequest(resource))
        .map((resource) => resource.path_or_url);
      const remotelyClosed = await getClosedGithubPullRequests(openTargets).catch(
        () => [],
      );
      if (cancelled) return;
      const closedTargets = new Set(remotelyClosed);
      const closedIds = new Set(reportedClosed.map((resource) => resource.id));
      if (closedIds.size === 0 && closedTargets.size === 0) return;

      try {
        const next = await applyOperation(
          makeOperation(
            task.id,
            "replace_resources",
            {
              resources: document.resources.filter(
                (resource) =>
                  !closedIds.has(resource.id) &&
                  !(
                    resource.type === "github_pr" &&
                    closedTargets.has(resource.path_or_url)
                  ),
              ),
            },
            document.revision,
          ),
        );
        if (!cancelled) {
          onDocument(next);
          onTaskChanged();
        }
      } catch {
        // A concurrent screen update wins; the next refresh uses its revision.
      }
    };

    void refresh();
    const interval = window.setInterval(refresh, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    active,
    document.revision,
    githubPullRequestSignature,
    task.id,
  ]);

  return (
    <div
      ref={workspaceRef}
      className={`task-workspace ${active ? "active" : "hidden"}`}
    >
      <div className="workspace-main-row">
      <aside
        className={`rail left-rail ${layout.left_collapsed ? "collapsed" : ""}`}
        style={{ width: layout.left_collapsed ? 42 : layout.left_width }}
      >
        <button
          className="rail-toggle"
          aria-label={layout.left_collapsed ? "Expand left panel" : "Collapse left panel"}
          onClick={() =>
            saveLayout({ ...layout, left_collapsed: !layout.left_collapsed })
          }
        >
          {layout.left_collapsed ? (
            <ChevronRight size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
        </button>
        {!layout.left_collapsed && (
          <div className="rail-content">
            {activeAlerts.length > 0 && (
              <>
                <section
                  className="presentation-section"
                  data-agent-section="alerts"
                >
                  <PanelHeading
                    icon={<Bell size={15} />}
                    title="Alerts"
                    count={activeAlerts.length}
                  />
                  <div className="alert-list">
                    {activeAlerts.map((alert) => (
                      <AlertCard
                        key={alert.id}
                        alert={alert}
                        onClear={() => mutate("clear_alert", { id: alert.id })}
                      />
                    ))}
                  </div>
                </section>
                <div className="section-divider" />
              </>
            )}
            {openTodos.length > 0 && (
              <>
                <section
                  className="presentation-section"
                  data-agent-section="todos"
                >
                  <PanelHeading
                    icon={<ListTodo size={15} />}
                    title="To do"
                    count={openTodos.length}
                  />
                  <div className="question-list">
                    {openTodos.map((todo) => (
                      <TodoCard
                        key={todo.id}
                        todo={todo}
                        onAnswer={async (answer) => {
                          const next = await answerQuestion(
                            task.id,
                            todo.id,
                            answer,
                          );
                          onDocument(next);
                          onTaskChanged();
                        }}
                        onComplete={async () => {
                          const next = await completeTodo(task.id, todo.id);
                          onDocument(next);
                          onTaskChanged();
                        }}
                      />
                    ))}
                  </div>
                </section>
                <div className="section-divider" />
              </>
            )}
            <section
              className={`presentation-section status-accordion ${
                statusExpanded ? "expanded" : "collapsed"
              }`}
              data-agent-section="summary"
            >
              <button
                type="button"
                className="status-accordion-toggle"
                aria-expanded={statusExpanded}
                aria-controls={`status-content-${task.id}`}
                onClick={() => setStatusExpanded((current) => !current)}
              >
                <span className="status-accordion-icon">
                  <Sparkles size={15} />
                </span>
                <span className="status-accordion-label">Status</span>
                <strong data-magnify={statusHeadline}>{statusHeadline}</strong>
              </button>
              {statusExpanded && (
                <div
                  id={`status-content-${task.id}`}
                  className="status-accordion-content"
                >
                  {document.summary.headline ||
                  document.summary.sections.length ? (
                    <div className="summary-block">
                      {document.summary.sections.map((section) => (
                        <section
                          key={section.id}
                          data-magnify={[section.heading, section.body]
                            .filter(Boolean)
                            .join("\n")}
                        >
                          {section.heading && <h4>{section.heading}</h4>}
                          <Markdown>{section.body}</Markdown>
                        </section>
                      ))}
                      <UpdatedAt value={document.summary.updated_at} />
                    </div>
                  ) : (
                    <EmptyState
                      icon={<BookOpen size={20} />}
                      title="No status yet"
                      body="The agent’s latest summary will appear here."
                    />
                  )}
                </div>
              )}
            </section>

            <div className="section-divider" />
            <section
              className={`presentation-section status-accordion ${
                planExpanded ? "expanded" : "collapsed"
              }`}
              data-agent-section="plan"
            >
              <button
                type="button"
                className="status-accordion-toggle"
                aria-expanded={planExpanded}
                aria-controls={`plan-content-${task.id}`}
                onClick={() => setPlanExpanded((current) => !current)}
              >
                <span className="status-accordion-icon">
                  <ClipboardList size={15} />
                </span>
                <span className="status-accordion-label">
                  Plan
                  <span className="status-accordion-count">
                    {document.tasks.length}
                  </span>
                </span>
                <strong data-magnify={planHeadline}>{planHeadline}</strong>
              </button>
              {planExpanded && (
                <div
                  id={`plan-content-${task.id}`}
                  className="status-accordion-content"
                >
                  {document.tasks.length === 0 ? (
                    <EmptyState
                      icon={<CircleDashed size={20} />}
                      title="No plan reported"
                      body="An agent or script can add stable task items here."
                    />
                  ) : (
                    <div className="task-list">
                      {orderedTasks.map((item) => (
                        <div className="task-item-row" key={item.id}>
                          <div
                            className={`task-item status-${item.status}`}
                            data-magnify={[
                              item.title,
                              item.detail,
                              `Status: ${statusLabel[item.status]}`,
                            ]
                              .filter(Boolean)
                              .join("\n")}
                          >
                            <span className="task-item-icon">
                              {itemStatusIcon[item.status]}
                            </span>
                            <span>
                              <strong>{item.title}</strong>
                              {item.detail && <small>{item.detail}</small>}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            <div className="section-divider" />
            <div className="artifact-sections" data-agent-section="resources">
              <section
                className="presentation-section"
                data-agent-section="artifacts"
              >
                <PanelHeading
                  icon={<Paperclip size={15} />}
                  title="Artifacts"
                  count={artifacts.length}
                  action={
                    <button
                      type="button"
                      className="panel-review-button"
                      disabled={
                        reviewingArtifacts ||
                        reviewableArtifacts.length === 0 ||
                        !issueIdentity
                      }
                      title={
                        !issueIdentity
                          ? "Add the task’s GitHub issue link before starting a review."
                          : reviewableArtifacts.length === 0
                            ? "All reviewable documents already have reviews running."
                            : `Review ${reviewableArtifacts.length} document${
                                reviewableArtifacts.length === 1 ? "" : "s"
                              } with Codex`
                      }
                      aria-label="Review all eligible document artifacts with Codex"
                      onClick={() => {
                        setReviewingArtifacts(true);
                        setArtifactReviewError("");
                        onLaunchReview(reviewableArtifacts, issueUrl)
                          .catch((error) =>
                            setArtifactReviewError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            ),
                          )
                          .finally(() => setReviewingArtifacts(false));
                      }}
                    >
                      <Sparkles size={11} />
                      {reviewingArtifacts ? "Launching…" : "Review"}
                    </button>
                  }
                />
                {artifactReviewError && (
                  <small className="panel-inline-error" role="status">
                    {artifactReviewError}
                  </small>
                )}
                {artifacts.length === 0 ? (
                  <EmptyState
                    icon={<Paperclip size={20} />}
                    title="No artifacts"
                    body="Documents, paths, URLs, and notes appear here."
                  />
                ) : (
                  <div className="artifact-list">
                    {artifacts.map((artifact) =>
                      ["local_document", "web_document"].includes(
                        artifact.type,
                      ) ? (
                        <ArtifactCard
                          key={artifact.id}
                          taskId={task.id}
                          resource={artifact}
                          onReview={
                            artifact.type === "local_document" && issueIdentity
                              ? () => onLaunchReview([artifact], issueUrl)
                              : undefined
                          }
                          reviewDisabledReason={
                            artifact.type === "local_document" && !issueIdentity
                              ? "Add the task’s GitHub issue link before starting a review."
                              : undefined
                          }
                        />
                      ) : (
                        <ResourceCard
                          key={artifact.id}
                          resource={artifact}
                        />
                      ),
                    )}
                  </div>
                )}
              </section>

              <div className="section-divider" />
              <section
                className="presentation-section"
                data-agent-section="prs"
              >
                <PanelHeading
                  icon={<GitPullRequest size={15} />}
                  title="PRs"
                  count={openPullRequests.length}
                  action={
                    <button
                      type="button"
                      className="panel-review-button"
                      disabled={
                        reviewingPullRequests ||
                        reviewablePullRequests.length === 0 ||
                        !issueIdentity
                      }
                      title={
                        !issueIdentity
                          ? "Add the task’s GitHub issue link before starting a review."
                          : reviewablePullRequests.length === 0
                            ? "All open pull requests already have reviews running."
                            : `Review ${reviewablePullRequests.length} open pull request${
                                reviewablePullRequests.length === 1 ? "" : "s"
                              } with Codex`
                      }
                      aria-label="Review all open pull requests with Codex"
                      onClick={() => {
                        setReviewingPullRequests(true);
                        setPullRequestReviewError("");
                        onLaunchReview(reviewablePullRequests, issueUrl)
                          .catch((error) =>
                            setPullRequestReviewError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            ),
                          )
                          .finally(() => setReviewingPullRequests(false));
                      }}
                    >
                      <Sparkles size={11} />
                      {reviewingPullRequests ? "Launching…" : "Review"}
                    </button>
                  }
                />
                {pullRequestReviewError && (
                  <small className="panel-inline-error" role="status">
                    {pullRequestReviewError}
                  </small>
                )}
                {openPullRequests.length === 0 ? (
                  <EmptyState
                    icon={<GitPullRequest size={20} />}
                    title="No open PRs"
                    body="Open pull requests appear here until they close or merge."
                  />
                ) : (
                  <div className="artifact-list">
                    {openPullRequests.map((pullRequest) => (
                      <ArtifactCard
                        key={pullRequest.id}
                        taskId={task.id}
                        resource={pullRequest}
                        onReview={
                          issueIdentity
                            ? () => onLaunchReview([pullRequest], issueUrl)
                            : undefined
                        }
                        reviewDisabledReason={
                          !issueIdentity
                            ? "Add the task’s GitHub issue link before starting a review."
                            : undefined
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>

          </div>
        )}
      </aside>
      {!layout.left_collapsed && (
        <div
          className="resize-handle"
          role="separator"
          aria-label="Resize left panel"
          onMouseDown={(event) => {
            dragRef.current = {
              startX: event.clientX,
              startWidth: layout.left_width,
            };
            globalThis.document.body.classList.add("is-resizing");
          }}
        />
      )}

      <main className="center-workspace">
        <header className="task-header" data-agent-section="header">
          {editingHeader ? (
            <HeaderEditor
              document={document}
              onCancel={() => setEditingHeader(false)}
              onSave={async (payload) => {
                await mutate("set_task", payload);
                setEditingHeader(false);
              }}
            />
          ) : (
            <>
              <div className="task-identity">
                <div className="eyebrow">
                  <StatusDot status={document.header.status} />
                  {statusLabel[document.header.status]}
                  {document.header.status_message && (
                    <span>· {document.header.status_message}</span>
                  )}
                </div>
                <div className="task-title-row">
                  <h1>{document.header.title}</h1>
                  {issueIdentity && (
                    <button
                      type="button"
                      className="task-issue-link"
                      data-magnify={`GitHub issue\n${githubIssueLabel(issueUrl)}\n${issueUrl}`}
                      aria-label={`Open GitHub issue ${githubIssueLabel(issueUrl)}`}
                      title={issueUrl}
                      onClick={() => {
                        void openArtifact({
                          id: "task-issue",
                          type: "web_document",
                          label: githubIssueLabel(issueUrl),
                          path_or_url: issueUrl,
                          status: "reported",
                          metadata: {},
                        }).catch(() => undefined);
                      }}
                    >
                      <CircleDot size={14} />
                      {githubIssueLabel(issueUrl)}
                      <ExternalLink size={12} />
                    </button>
                  )}
                </div>
                {document.header.description && (
                  <Markdown>{document.header.description}</Markdown>
                )}
              </div>
              <div className="header-actions">
                <button
                  className="icon-button bordered"
                  aria-label="Edit task header"
                  onClick={() => setEditingHeader(true)}
                >
                  <Edit3 size={15} />
                </button>
              </div>
            </>
          )}
        </header>
        <TerminalPane
          key={`task-marker-terminal-${task.id}`}
          taskId={task.id}
          active={active}
          textScale={textScale}
          onOutputActivity={scheduleTerminalPullRequestDiscovery}
        />
      </main>
      </div>

      <Scratchpad taskId={task.id} />
    </div>
  );
}

function PanelHeading({
  icon,
  title,
  count,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="panel-heading" data-magnify={title}>
      <span>{icon}</span>
      <h2>{title}</h2>
      {typeof count === "number" && <span className="count">{count}</span>}
      {action && (
        <span className="panel-action" data-magnify-ignore>
          {action}
        </span>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="empty-state" data-magnify={`${title}\n${body}`}>
      {icon}
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />;
}

function HeaderEditor({
  document,
  onCancel,
  onSave,
}: {
  document: PresentationDocument;
  onCancel: () => void;
  onSave: (payload: Record<string, string>) => Promise<void>;
}) {
  const [title, setTitle] = useState(document.header.title);
  const [description, setDescription] = useState(document.header.description);
  const [issueUrl, setIssueUrl] = useState(document.header.issue_url ?? "");
  const [status, setStatus] = useState(document.header.status);
  const [statusMessage, setStatusMessage] = useState(document.header.status_message);
  return (
    <form
      className="header-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          title: title.trim() || "Untitled task",
          description,
          issue_url: issueUrl.trim(),
          source: "human",
          status,
          status_message: statusMessage,
        });
      }}
    >
      <label>
        <span>Task title</span>
        <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="wide">
        <span>GitHub issue URL</span>
        <input
          type="url"
          placeholder="https://github.com/OWNER/REPOSITORY/issues/123"
          value={issueUrl}
          onChange={(event) => setIssueUrl(event.target.value)}
        />
      </label>
      <label className="wide">
        <span>Description (Markdown)</span>
        <textarea
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        <span>Status</span>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as TaskStatus)}
        >
          {taskStatuses.map((value) => (
            <option key={value} value={value}>
              {statusLabel[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Status message</span>
        <input
          value={statusMessage}
          onChange={(event) => setStatusMessage(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button type="button" className="button ghost compact" onClick={onCancel}>
          Cancel
        </button>
        <button className="button primary compact">
          <Save size={14} /> Save
        </button>
      </div>
    </form>
  );
}

function AlertCard({
  alert,
  onClear,
}: {
  alert: Alert;
  onClear: () => void;
}) {
  const icons = {
    info: <Info size={16} />,
    warning: <AlertTriangle size={16} />,
    critical: <AlertOctagon size={16} />,
  };
  return (
    <article
      className={`alert-card severity-${alert.severity}`}
      data-magnify={`${alert.title}\n${alert.message}\nSeverity: ${alert.severity}`}
    >
      <div className="alert-icon">{icons[alert.severity]}</div>
      <div>
        <div className="alert-label">{alert.severity}</div>
        <strong>{alert.title}</strong>
        <p>{alert.message}</p>
      </div>
      <button
        className="icon-button"
        data-magnify-ignore
        aria-label={`Clear ${alert.title}`}
        title="Clear alert"
        onClick={onClear}
      >
        <X size={14} />
      </button>
    </article>
  );
}

function ResourceCard({ resource }: { resource: Resource }) {
  const [copied, setCopied] = useState(false);
  return (
    <article
      className="resource-card"
      data-magnify={`${resource.label}\n${resource.path_or_url}\n${resource.type}`}
    >
      <div className="resource-type">{resource.type}</div>
      <strong>{resource.label}</strong>
      <code>{resource.path_or_url}</code>
      <div className="resource-footer">
        <button
          className="icon-button"
          data-magnify-ignore
          aria-label={`Copy ${resource.label}`}
          onClick={() => {
            navigator.clipboard.writeText(resource.path_or_url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </article>
  );
}

function ArtifactCard({
  taskId,
  resource,
  onReview,
  reviewDisabledReason,
}: {
  taskId: string;
  resource: Resource;
  onReview?: () => Promise<void>;
  reviewDisabledReason?: string;
}) {
  const [opening, setOpening] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const persistedReviewState = reportedReviewState(resource);
  const reviewState = reviewing ? "queued" : persistedReviewState;
  const reviewInFlight = activeReviewStates.has(reviewState);
  const [reviewCount, setReviewCount] = useState(() =>
    completedReviewCount(taskId, resource),
  );
  const reviewUrl = resource.metadata.review_url ?? "";
  const reviewable = ["github_pr", "local_document"].includes(resource.type);
  const presentation = {
    local_document: {
      icon: <FileText size={17} />,
      type: "Local document",
      openAction: "Open in Zed",
    },
    web_document: {
      icon: <Globe2 size={17} />,
      type: "Web document",
      openAction: "Open in browser",
    },
    github_pr: {
      icon: <GitPullRequest size={17} />,
      type: "GitHub PR",
      openAction: "Open in browser",
    },
  }[resource.type as "local_document" | "web_document" | "github_pr"];

  useEffect(() => {
    setReviewCount(completedReviewCount(taskId, resource));
  }, [
    taskId,
    resource.type,
    resource.path_or_url,
    persistedReviewState,
    resource.metadata.review_task_id,
  ]);

  return (
    <article className="artifact-card">
      <button
        className="artifact-link"
        data-magnify={`${presentation.type}\n${resource.label}\n${resource.path_or_url}`}
        disabled={opening}
        aria-label={`${presentation.openAction}: ${resource.label}`}
        onClick={() => {
          setOpening(true);
          setError("");
          openArtifact(resource)
            .catch((nextError) =>
              setError(
                nextError instanceof Error ? nextError.message : String(nextError),
              ),
            )
            .finally(() => setOpening(false));
        }}
      >
        <span className="artifact-icon">{presentation.icon}</span>
        <span className="artifact-copy">
          <span className="artifact-kind">{presentation.type}</span>
          <strong>{resource.label}</strong>
          <code>{resource.path_or_url}</code>
        </span>
        <ExternalLink size={14} className="artifact-external" />
      </button>
      {reviewable && (
        <div
          className={`artifact-footer${reviewState ? ` review-state-${reviewState}` : ""}`}
        >
          <button
            type="button"
            className="artifact-review-button"
            disabled={reviewInFlight || !onReview}
            title={reviewDisabledReason ?? "Launch a Codex review task"}
            aria-label={`Review ${resource.label} with Codex`}
            onClick={() => {
              if (!onReview) return;
              setReviewing(true);
              setError("");
              onReview()
                .catch((nextError) =>
                  setError(
                    nextError instanceof Error
                      ? nextError.message
                      : String(nextError),
                  ),
                )
                .finally(() => setReviewing(false));
            }}
          >
            <Sparkles size={11} />
            {reviewState === "posted"
              ? `Re-review${reviewCount > 1 ? ` (${reviewCount})` : ""}`
              : reviewState === "failed"
                ? "Retry review"
                : "Review"}
          </button>
          {reviewInFlight && (
            <span className="artifact-review-status">
              <span className="review-state-dot" />
              Reviewing
            </span>
          )}
          {reviewState === "posted" && reviewUrl && (
            <button
              type="button"
              className="review-result-link"
              onClick={() => {
                void openArtifact({
                  id: `${resource.id}-review`,
                  type: "web_document",
                  label: `Review of ${resource.label}`,
                  path_or_url: reviewUrl,
                  status: "reported",
                  metadata: {},
                }).catch((nextError) =>
                  setError(
                    nextError instanceof Error
                      ? nextError.message
                      : String(nextError),
                  ),
                );
              }}
            >
              View review <ExternalLink size={11} />
            </button>
          )}
          {reviewState === "posted" && !reviewUrl && (
            <span className="artifact-review-status">
              <span className="review-state-dot" />
              Review posted
            </span>
          )}
          {reviewState === "failed" && (
            <span className="artifact-review-status">
              <span className="review-state-dot" />
              Review failed
            </span>
          )}
        </div>
      )}
      {error && (
        <small className="artifact-error" role="status">
          {error}
        </small>
      )}
    </article>
  );
}

function UpdatedAt({ value }: { value: string }) {
  const label = useMemo(() => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? value
      : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }, [value]);
  return <small className="updated-at">Updated {label}</small>;
}
