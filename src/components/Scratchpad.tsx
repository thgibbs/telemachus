import {
  Check,
  ChevronDown,
  ChevronUp,
  LockKeyhole,
  NotebookPen,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getScratchpad, updateScratchpad } from "../lib/platform";
import type { ScratchpadState } from "../types";

type SavePhase = "loading" | "idle" | "saving" | "saved" | "error";

export function Scratchpad({ taskId }: { taskId: string }) {
  const [scratchpad, setScratchpad] = useState<ScratchpadState>({
    content: "",
    collapsed: true,
    updated_at: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<SavePhase>("loading");
  const lastSaved = useRef("");

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setPhase("loading");
    getScratchpad(taskId)
      .then((next) => {
        if (cancelled) return;
        lastSaved.current = JSON.stringify([next.content, next.collapsed]);
        setScratchpad(next);
        setLoaded(true);
        setPhase("idle");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  useEffect(() => {
    if (!loaded) return;
    const serialized = JSON.stringify([scratchpad.content, scratchpad.collapsed]);
    if (serialized === lastSaved.current) return;
    setPhase("saving");
    const timeout = window.setTimeout(() => {
      updateScratchpad(taskId, scratchpad.content, scratchpad.collapsed)
        .then((next) => {
          lastSaved.current = JSON.stringify([next.content, next.collapsed]);
          setScratchpad((current) => ({ ...current, updated_at: next.updated_at }));
          setPhase("saved");
        })
        .catch(() => setPhase("error"));
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [loaded, scratchpad.collapsed, scratchpad.content, taskId]);

  const status =
    phase === "loading"
      ? "Loading…"
      : phase === "saving"
        ? "Saving…"
        : phase === "error"
          ? "Could not save"
          : phase === "saved"
            ? "Saved"
            : scratchpad.content
              ? "Private notes"
              : "Empty";

  return (
    <section
      className={`scratchpad ${scratchpad.collapsed ? "collapsed" : ""}`}
      aria-label="Private scratchpad"
    >
      <button
        className="scratchpad-bar"
        aria-expanded={!scratchpad.collapsed}
        aria-label={scratchpad.collapsed ? "Show scratchpad" : "Hide scratchpad"}
        onClick={() =>
          setScratchpad((current) => ({
            ...current,
            collapsed: !current.collapsed,
          }))
        }
      >
        <span className="scratchpad-title">
          <NotebookPen size={14} />
          Scratchpad
        </span>
        <span className="scratchpad-private">
          <LockKeyhole size={11} />
          Private · not shared with agents
        </span>
        <span className={`scratchpad-save phase-${phase}`}>
          {phase === "saved" && <Check size={11} />}
          {status}
        </span>
        {scratchpad.collapsed ? (
          <ChevronUp size={15} />
        ) : (
          <ChevronDown size={15} />
        )}
      </button>
      {!scratchpad.collapsed && (
        <textarea
          autoFocus
          value={scratchpad.content}
          maxLength={256 * 1024}
          aria-label="Scratchpad notes"
          placeholder="Write notes for yourself…"
          onChange={(event) =>
            setScratchpad((current) => ({
              ...current,
              content: event.target.value,
            }))
          }
        />
      )}
    </section>
  );
}
