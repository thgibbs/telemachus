import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useRef, useState } from "react";
import {
  createTerminal,
  getTerminalSnapshot,
  onTerminalOutput,
  resizeTerminal,
  writeTerminal,
} from "../lib/platform";
import { TerminalSquare } from "lucide-react";
import type { TerminalOutput } from "../types";

export function TerminalPane({
  taskId,
  active,
  textScale,
  onOutputActivity,
}: {
  taskId: string;
  active: boolean;
  textScale: number;
  onOutputActivity?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const activeRef = useRef(active);
  const inputArmedRef = useRef(false);
  const recoveryArmedRef = useRef(false);
  const onOutputActivityRef = useRef(onOutputActivity);
  const [legacyHost, setLegacyHost] = useState(false);
  const [recovering, setRecovering] = useState(false);
  activeRef.current = active;
  onOutputActivityRef.current = onOutputActivity;

  const reportError = (error: unknown) => {
    console.error("Telemachus terminal error", error);
  };

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        '"SFMono-Regular", "Cascadia Code", "Roboto Mono", ui-monospace, monospace',
      fontSize: Math.round(13 * textScale),
      fontWeight: "400",
      lineHeight: 1.28,
      letterSpacing: 0,
      scrollback: 6000,
      theme: {
        background: "#121318",
        foreground: "#d7d9e0",
        cursor: "#c9f36c",
        cursorAccent: "#121318",
        selectionBackground: "#6272a455",
        black: "#17181e",
        red: "#ff6b73",
        green: "#b6df63",
        yellow: "#e8c96d",
        blue: "#83a8ff",
        magenta: "#c797ff",
        cyan: "#6fd3cf",
        white: "#e5e7eb",
        brightBlack: "#686b78",
        brightRed: "#ff8c93",
        brightGreen: "#c9f36c",
        brightYellow: "#f5d984",
        brightBlue: "#9ab8ff",
        brightMagenta: "#d6b4ff",
        brightCyan: "#90e2df",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;

    const encodeKey = (event: KeyboardEvent): number[] | null => {
      if (event.isComposing || event.metaKey) return null;
      if (event.ctrlKey && !event.altKey && event.key.length === 1) {
        const code = event.key.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) return [code - 64];
      }
      const escapeSequence = {
        ArrowUp: "\u001b[A",
        ArrowDown: "\u001b[B",
        ArrowRight: "\u001b[C",
        ArrowLeft: "\u001b[D",
        Home: "\u001b[H",
        End: "\u001b[F",
        PageUp: "\u001b[5~",
        PageDown: "\u001b[6~",
        Insert: "\u001b[2~",
        Delete: "\u001b[3~",
      }[event.key];
      if (escapeSequence) {
        return Array.from(new TextEncoder().encode(escapeSequence));
      }
      if (event.key === "Enter") {
        return event.shiftKey ? [0x1b, 0x0d] : [0x0d];
      }
      if (event.key === "Backspace") return [0x7f];
      if (event.key === "Tab") return [0x09];
      if (event.key === "Escape") return [0x1b];
      if (event.key.length !== 1) return null;
      const bytes = Array.from(new TextEncoder().encode(event.key));
      return event.altKey ? [0x1b, ...bytes] : bytes;
    };

    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      const inside =
        target instanceof Node && Boolean(hostRef.current?.contains(target));
      inputArmedRef.current = inside && activeRef.current;
      if (inputArmedRef.current) terminal.focus();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        !activeRef.current ||
        !inputArmedRef.current ||
        !sessionRef.current
      ) {
        return;
      }
      const bytes = encodeKey(event);
      if (!bytes) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      writeTerminal(sessionRef.current, bytes).catch(reportError);
    };
    const paste = (event: ClipboardEvent) => {
      if (
        !activeRef.current ||
        !inputArmedRef.current ||
        !sessionRef.current
      ) {
        return;
      }
      const value = event.clipboardData?.getData("text");
      if (!value) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      writeTerminal(
        sessionRef.current,
        Array.from(new TextEncoder().encode(value)),
      ).catch(reportError);
    };
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("paste", paste, true);

    const fitAndResize = () => {
      if (!hostRef.current?.offsetParent) return;
      try {
        fit.fit();
        if (sessionRef.current) {
          resizeTerminal(sessionRef.current, terminal.cols, terminal.rows).catch(
            () => undefined,
          );
        }
      } catch {
        // The host may be between layout passes while a task is switching.
      }
    };

    const observer = new ResizeObserver(fitAndResize);
    observer.observe(hostRef.current);
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (sessionRef.current) {
          writeTerminal(sessionRef.current, [0x1b, 0x0d]).catch(reportError);
        }
        return false;
      }
      return true;
    });
    const dataDisposable = terminal.onData((value) => {
      if (!sessionRef.current) return;
      writeTerminal(
        sessionRef.current,
        Array.from(new TextEncoder().encode(value)),
      ).catch(reportError);
    });

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let attached = false;
    const pendingOutput: TerminalOutput[] = [];
    const outputListenerReady = onTerminalOutput((payload) => {
      if (cancelled) return;
      const recoveryMarker = `AGENT_UI_RECOVER:${taskId}`;
      const outputText = new TextDecoder().decode(
        new Uint8Array(payload.data),
      );
      if (outputText.includes(recoveryMarker)) {
        recoveryArmedRef.current = false;
        sessionRef.current = payload.session_id;
        attached = true;
        pendingOutput.length = 0;
        terminal.reset();
        resizeTerminal(payload.session_id, terminal.cols, terminal.rows).catch(
          reportError,
        );
        terminal.writeln(
          "\r\n\x1b[33mReattached to the original PTY. Press Enter if its prompt needs to repaint.\x1b[0m",
        );
        setRecovering(false);
        setLegacyHost(true);
        onOutputActivityRef.current?.();
        return;
      }
      if (
        recoveryArmedRef.current &&
        activeRef.current &&
        payload.session_id !== sessionRef.current
      ) {
        recoveryArmedRef.current = false;
        sessionRef.current = payload.session_id;
        attached = true;
        pendingOutput.length = 0;
        terminal.reset();
        terminal.write(new Uint8Array(payload.data));
        resizeTerminal(payload.session_id, terminal.cols, terminal.rows).catch(
          reportError,
        );
        setRecovering(false);
        setLegacyHost(true);
        onOutputActivityRef.current?.();
        return;
      }
      if (!sessionRef.current) {
        if (pendingOutput.length >= 1000) pendingOutput.shift();
        pendingOutput.push(payload);
        return;
      }
      if (payload.session_id !== sessionRef.current) return;
      if (!attached) {
        pendingOutput.push(payload);
        return;
      }
      terminal.write(new Uint8Array(payload.data));
      onOutputActivityRef.current?.();
    });
    outputListenerReady.then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });

    if (!startingRef.current) {
      startingRef.current = true;
      createTerminal(taskId)
        .then(async (sessionId) => {
          if (cancelled) return;
          sessionRef.current = sessionId;
          await outputListenerReady;
          if (cancelled) return;
          let nextOffset = 0;
          try {
            const snapshot = await getTerminalSnapshot(sessionId);
            terminal.write(new Uint8Array(snapshot.data));
            nextOffset = snapshot.next_offset;
          } catch {
            // Older live hosts can still reattach to the PTY, but cannot replay
            // buffered output. The listener must be ready before we ask the
            // foreground program for a complete redraw.
            fit.fit();
            setLegacyHost(true);
            const redrawRows =
              terminal.rows > 2 ? terminal.rows - 1 : terminal.rows + 1;
            await resizeTerminal(sessionId, terminal.cols, redrawRows);
            await resizeTerminal(sessionId, terminal.cols, terminal.rows);
            terminal.writeln(
              "\r\n\x1b[33mReattached without screen history. Press Enter if the prompt needs to repaint.\x1b[0m",
            );
          }
          pendingOutput
            .filter((payload) => payload.session_id === sessionId)
            .sort((left, right) => left.offset - right.offset)
            .forEach((payload) => {
              const endOffset = payload.offset + payload.data.length;
              if (endOffset <= nextOffset) return;
              const firstByte = Math.max(0, nextOffset - payload.offset);
              terminal.write(new Uint8Array(payload.data.slice(firstByte)));
              nextOffset = endOffset;
            });
          attached = true;
          pendingOutput.length = 0;
          onOutputActivityRef.current?.();
          requestAnimationFrame(() => {
            fitAndResize();
            if (activeRef.current) {
              inputArmedRef.current = true;
              terminal.focus();
            }
          });
        })
        .catch((error) => {
          if (cancelled) return;
          terminal.writeln(
            `\r\n\x1b[31mUnable to create terminal: ${String(error)}\x1b[0m`,
          );
          reportError(error);
        });
    }

    return () => {
      cancelled = true;
      startingRef.current = false;
      observer.disconnect();
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("paste", paste, true);
      dataDisposable.dispose();
      unlisten?.();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [taskId]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = Math.round(13 * textScale);
    window.dispatchEvent(new Event("resize"));
  }, [textScale]);

  useEffect(() => {
    inputArmedRef.current = active;
    if (!active || !terminalRef.current) return;
    requestAnimationFrame(() => terminalRef.current?.focus());
  }, [active]);

  return (
    <section className="terminal-shell" aria-label="Interactive terminal">
      <div className="terminal-toolbar">
        <span className="terminal-tab active">
          <TerminalSquare size={13} />
          Terminal
        </span>
        {legacyHost && (
          <button
            className="terminal-recover"
            type="button"
            disabled={recovering}
            onClick={() => {
              recoveryArmedRef.current = true;
              setRecovering(true);
            }}
          >
            {recovering ? "Listening…" : "Recover original"}
          </button>
        )}
      </div>
      <div ref={hostRef} className="terminal-host" />
    </section>
  );
}
