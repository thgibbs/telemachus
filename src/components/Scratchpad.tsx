import {
  Check,
  ChevronDown,
  ChevronUp,
  LockKeyhole,
  NotebookPen,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { getScratchpad, updateScratchpad } from "../lib/platform";
import type { ScratchpadState } from "../types";

type SavePhase = "loading" | "idle" | "saving" | "saved" | "error";

function ScratchpadComponent({ taskId }: { taskId: string }) {
  const [scratchpad, setScratchpad] = useState<ScratchpadState>({
    content: "",
    collapsed: true,
    updated_at: "",
  });
  const [phase, setPhase] = useState<SavePhase>("loading");
  const phaseRef = useRef<SavePhase>("loading");
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);
  const bufferRef = useRef({ content: "", collapsed: true });
  const lastSavedRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  const serializedSnapshot = (snapshot: {
    content: string;
    collapsed: boolean;
  }) => JSON.stringify([snapshot.content, snapshot.collapsed]);

  const changePhase = (next: SavePhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  };

  const persistSnapshot = (
    snapshot: { content: string; collapsed: boolean },
    showProgress = true,
  ) => {
    const serialized = serializedSnapshot(snapshot);
    saveChainRef.current = saveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (serialized === lastSavedRef.current) return;
        if (showProgress) changePhase("saving");
        const next = await updateScratchpad(
          taskId,
          snapshot.content,
          snapshot.collapsed,
        );
        lastSavedRef.current = serialized;
        if (!mountedRef.current) return;
        setScratchpad((current) => ({
          ...current,
          updated_at: next.updated_at,
        }));
        changePhase(
          serializedSnapshot(bufferRef.current) === serialized
            ? "saved"
            : "idle",
        );
      })
      .catch(() => {
        if (mountedRef.current) changePhase("error");
      });
  };

  const scheduleSave = (delay = 350) => {
    if (!loadedRef.current) return;
    const snapshot = { ...bufferRef.current };
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      persistSnapshot(snapshot);
    }, delay);
  };

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    loadedRef.current = false;
    changePhase("loading");
    getScratchpad(taskId)
      .then((next) => {
        if (cancelled) return;
        bufferRef.current = {
          content: next.content,
          collapsed: next.collapsed,
        };
        lastSavedRef.current = serializedSnapshot(bufferRef.current);
        setScratchpad(next);
        loadedRef.current = true;
        changePhase("idle");
      })
      .catch(() => {
        if (!cancelled) changePhase("error");
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (
        loadedRef.current &&
        serializedSnapshot(bufferRef.current) !== lastSavedRef.current
      ) {
        persistSnapshot({ ...bufferRef.current }, false);
      }
    };
  }, [taskId]);

  const status =
    phase === "loading"
      ? "Loading…"
      : phase === "saving"
        ? "Saving…"
        : phase === "error"
          ? "Could not save"
          : phase === "saved"
            ? "Saved"
            : bufferRef.current.content
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
        onClick={() => {
          const collapsed = !bufferRef.current.collapsed;
          bufferRef.current = { ...bufferRef.current, collapsed };
          setScratchpad((current) => ({ ...current, collapsed }));
          scheduleSave(0);
        }}
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
          defaultValue={bufferRef.current.content}
          maxLength={256 * 1024}
          aria-label="Scratchpad notes"
          placeholder="Write notes for yourself…"
          onChange={(event) => {
            bufferRef.current = {
              ...bufferRef.current,
              content: event.currentTarget.value,
            };
            if (phaseRef.current !== "idle") changePhase("idle");
            scheduleSave();
          }}
        />
      )}
    </section>
  );
}

export const Scratchpad = memo(ScratchpadComponent);
