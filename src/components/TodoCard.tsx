import { AlertCircle, ArrowRight, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import type { TodoItem } from "../types";

export function TodoCard({
  todo,
  onAnswer,
  onComplete,
}: {
  todo: TodoItem;
  onAnswer: (answer: string) => Promise<void>;
  onComplete: () => Promise<void>;
}) {
  const kind = todo.kind ?? "question";
  const [selected, setSelected] = useState(todo.choices[0] ?? "");
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const resolved = todo.state === "answered" || todo.state === "completed";

  async function submitAnswer() {
    const answer = freeText.trim() || selected;
    if (!answer) return;
    setSubmitting(true);
    await onAnswer(answer).finally(() => setSubmitting(false));
  }

  async function complete() {
    setSubmitting(true);
    await onComplete().finally(() => setSubmitting(false));
  }

  if (resolved) {
    return (
      <article
        className="question-card answered"
        data-magnify={
          kind === "action"
            ? `${todo.text}\nCompleted`
            : `${todo.text}\nAnswer: ${todo.answer ?? ""}`
        }
      >
        <div className="question-kicker">
          <CheckCircle2 size={14} />
          {kind === "action" ? "Completed" : "Answered"}
        </div>
        <p>{todo.text}</p>
        {kind === "question" && <blockquote>{todo.answer}</blockquote>}
      </article>
    );
  }

  if (kind === "action") {
    return (
      <article
        className={`question-card todo-action ${todo.blocking ? "blocking" : ""}`}
        data-magnify={[
          todo.text,
          todo.blocking ? "Blocking action" : "Action needed",
        ].join("\n")}
      >
        <div className="question-kicker">
          <AlertCircle size={14} />
          {todo.blocking ? "Blocking action" : "Action needed"}
        </div>
        <p>{todo.text}</p>
        <button
          className="button primary compact"
          data-magnify-ignore
          onClick={complete}
          disabled={submitting}
        >
          <CheckCircle2 size={14} />
          {submitting ? "Completing…" : "Done"}
        </button>
      </article>
    );
  }

  return (
    <article
      className={`question-card ${todo.blocking ? "blocking" : ""}`}
      data-magnify={[
        todo.text,
        todo.choices.length
          ? `Choices: ${todo.choices.join(" · ")}`
          : "",
        todo.blocking ? "Blocking question" : "Question",
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <div className="question-kicker">
        <AlertCircle size={14} />
        {todo.blocking ? "Blocking question" : "Question"}
      </div>
      <p>{todo.text}</p>
      {todo.choices.length > 0 && (
        <div className="choice-list" role="radiogroup" aria-label="Answer choices">
          {todo.choices.map((choice) => (
            <label key={choice}>
              <input
                type="radio"
                checked={selected === choice}
                onChange={() => setSelected(choice)}
              />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      )}
      {todo.allow_free_text && (
        <textarea
          rows={2}
          value={freeText}
          onChange={(event) => setFreeText(event.target.value)}
          placeholder="Or write an answer…"
          aria-label="Free text answer"
        />
      )}
      <button
        className="button primary compact"
        data-magnify-ignore
        onClick={submitAnswer}
        disabled={submitting || (!selected && !freeText.trim())}
      >
        Answer <ArrowRight size={14} />
      </button>
    </article>
  );
}
