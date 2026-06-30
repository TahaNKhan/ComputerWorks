// packages/ui/src/components/SessionList.tsx
// T7.4 — Sidebar that lists sessions and lets the user create, rename,
// delete, and switch between them.
// T10 — Becomes a slide-in drawer on mobile (controlled by `open`).
//        On tablet+ the `open` prop is ignored and the sidebar renders
//        inline (see global.css `@media (min-width: 768px)`).
// T19.8 — Sidebar row title slides in from the left when the
//        server pushes a `session_renamed` event with
//        `titleSource: "auto"` (i.e. the LLM-driven rename_session
//        tool). Manual renames (titleSource: "manual") don't
//        animate — the user just typed it, animating would feel
//        off.

import React, { useEffect, useRef, useState } from "react";
import { useSessionsStore } from "../store/sessions.js";

interface RowProps {
  id: string;
  title: string;
  /** T19.8 — provenance of the title. Drives the slide-in
   *  animation: "auto" → animate on change; "manual" or
   *  undefined → no animation. The reducer fills this in from
   *  the `session_renamed` SSE event; manual renames flow
   *  through `renameSession` which sets it to "manual". */
  titleSource?: "auto" | "manual";
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}

function Row(props: RowProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.title);
  // T19.8 — animation key for the title <span>. Bumped when the
  // title changes AND titleSource is "auto", which retriggers
  // the CSS keyframe via React's `key` prop. Manual renames
  // (titleSource "manual") don't bump the key — the user just
  // typed the title; animating it would feel weird.
  const [animKey, setAnimKey] = useState(0);
  const prevTitle = useRef(props.title);

  useEffect(() => {
    setDraft(props.title);
  }, [props.title]);

  // T19.8 — bump the animation key when the title changes due to
  // an SSE-driven rename (titleSource: "auto"). Cold start (no
  // change) and manual renames (titleSource: "manual") don't
  // bump the key.
  useEffect(() => {
    if (prevTitle.current !== props.title && props.titleSource === "auto") {
      setAnimKey((k) => k + 1);
    }
    prevTitle.current = props.title;
  }, [props.title, props.titleSource]);

  if (editing) {
    return (
      <li className={`cw-row ${props.active ? "active" : ""}`}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => {
            if (draft.trim()) props.onRename(draft.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (draft.trim()) props.onRename(draft.trim());
              setEditing(false);
            } else if (e.key === "Escape") {
              setDraft(props.title);
              setEditing(false);
            }
          }}
        />
      </li>
    );
  }

  return (
    <li
      className={`cw-row ${props.active ? "active" : ""}`}
      onClick={props.onSelect}
      title={new Date(props.id).toLocaleString()}
    >
      <span key={animKey} className="cw-row-title">
        {props.title || "(untitled)"}
      </span>
      <span className="cw-row-actions">
        <button
          aria-label="Rename"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          ✎
        </button>
        <button
          aria-label="Delete"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete session "${props.title || "(untitled)"}"?`)) {
              props.onDelete();
            }
          }}
        >
          ✕
        </button>
      </span>
    </li>
  );
}

interface SessionListProps {
  /** Mobile drawer open state. Ignored on tablet+ where the sidebar is inline. */
  open: boolean;
  onClose: () => void;
}

export function SessionList({ open, onClose }: SessionListProps): JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const initialized = useSessionsStore((s) => s.initialized);
  const loadSessions = useSessionsStore((s) => s.loadSessions);
  const createSession = useSessionsStore((s) => s.createSession);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const renameSession = useSessionsStore((s) => s.renameSession);
  const switchSession = useSessionsStore((s) => s.switchSession);

  useEffect(() => {
    if (!initialized) {
      void loadSessions();
    }
  }, [initialized, loadSessions]);

  // Close on Escape (drawer mode).
  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <aside
      className={`cw-sidebar ${open ? "open" : ""}`}
      aria-label="Sessions"
      aria-hidden={!open}
    >
      <div className="cw-sidebar-header">
        <h2>Sessions</h2>
        <button
          className="cw-new-session"
          onClick={() => {
            void createSession();
          }}
          aria-label="New session"
        >
          + New
        </button>
        <button
          className="cw-drawer-close"
          onClick={onClose}
          aria-label="Close sessions"
        >
          ✕
        </button>
      </div>
      <ul className="cw-session-list">
        {!initialized && <li className="cw-row muted">Loading…</li>}
        {initialized && sessions.length === 0 && (
          <li className="cw-row muted">No sessions yet. Click + New.</li>
        )}
        {sessions.map((s) => (
          <Row
            key={s.id}
            id={s.id}
            title={s.title || s.id}
            titleSource={s.titleSource}
            active={s.id === activeId}
            onSelect={() => {
              void switchSession(s.id);
              // App.tsx also auto-closes on activeSessionId change,
              // but doing it here too means the drawer closes even if
              // the active id was already this one (no-op switch).
              onClose();
            }}
            onRename={(title) => {
              void renameSession(s.id, title);
            }}
            onDelete={() => {
              void deleteSession(s.id);
            }}
          />
        ))}
      </ul>
    </aside>
  );
}