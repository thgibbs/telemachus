import { AlertCircle, ArrowRight, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import type { Question } from "../types";

export function QuestionCard({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState(question.choices[0] ?? "");
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const answered = question.state === "answered";

  async function submit() {
    const answer = freeText.trim() || selected;
    if (!answer) return;
    setSubmitting(true);
    await onAnswer(answer).finally(() => setSubmitting(false));
  }

  if (answered) {
    return (
      <article
        className="question-card answered"
        data-magnify={`${question.text}\nAnswer: ${question.answer ?? ""}`}
      >
        <div className="question-kicker">
          <CheckCircle2 size={14} /> Answered
        </div>
        <p>{question.text}</p>
        <blockquote>{question.answer}</blockquote>
      </article>
    );
  }

  return (
    <article
      className={`question-card ${question.blocking ? "blocking" : ""}`}
      data-magnify={[
        question.text,
        question.choices.length
          ? `Choices: ${question.choices.join(" · ")}`
          : "",
        question.blocking ? "Blocking question" : "Question",
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <div className="question-kicker">
        <AlertCircle size={14} />
        {question.blocking ? "Blocking question" : "Question"}
      </div>
      <p>{question.text}</p>
      {question.choices.length > 0 && (
        <div className="choice-list" role="radiogroup" aria-label="Answer choices">
          {question.choices.map((choice) => (
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
      {question.allow_free_text && (
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
        onClick={submit}
        disabled={submitting || (!selected && !freeText.trim())}
      >
        Answer <ArrowRight size={14} />
      </button>
    </article>
  );
}
