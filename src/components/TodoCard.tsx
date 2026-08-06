import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useState } from "react";
import type { TodoItem } from "../types";

export function TodoCard({
  todo,
  onCompletedChange,
  onDismiss,
}: {
  todo: TodoItem;
  onCompletedChange: (completed: boolean) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const [updating, setUpdating] = useState(false);
  const completed = todo.state === "answered" || todo.state === "completed";

  async function update(action: () => Promise<void>) {
    setUpdating(true);
    await action().finally(() => setUpdating(false));
  }

  return (
    <article
      className={`question-card todo-action ${todo.blocking ? "blocking" : ""} ${
        completed ? "completed" : ""
      }`}
      data-magnify={[
        todo.text,
        completed
          ? "Completed"
          : todo.blocking
            ? "Blocking action"
            : "Action needed",
      ].join("\n")}
    >
      <input
        className="todo-checkbox"
        data-magnify-ignore
        type="checkbox"
        checked={completed}
        disabled={updating}
        aria-label={`${completed ? "Reopen" : "Complete"} todo: ${todo.text}`}
        onChange={(event) => {
          const checked = event.currentTarget.checked;
          void update(() => onCompletedChange(checked));
        }}
      />
      <div className="todo-content">
        <div className="question-kicker">
          {completed ? (
            <CheckCircle2 size={14} />
          ) : (
            <AlertCircle size={14} />
          )}
          {completed
            ? "Completed"
            : todo.blocking
              ? "Blocking action"
              : "Action needed"}
        </div>
        <p>{todo.text}</p>
      </div>
      <button
        type="button"
        className="todo-dismiss-button"
        data-magnify-ignore
        onClick={() => void update(onDismiss)}
        disabled={updating}
        aria-label={`Dismiss todo: ${todo.text}`}
        title={updating ? "Updating…" : "Dismiss todo"}
      >
        <X size={14} />
      </button>
    </article>
  );
}
