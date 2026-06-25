// packages/ui/src/components/SessionSwitcher.tsx
// T7.10 — Cmd/Ctrl+K modal. Fuzzy-filter the session list and switch
// on Enter. Closes on Esc or click-outside.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSessionsStore } from "../store/sessions.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SessionSwitcher({ open, onClose }: Props): JSX.Element | null {
  const sessions = useSessionsStore((s) => s.sessions);
  const switchSession = useSessionsStore((s) => s.switchSession);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.title || s.id).toLowerCase().includes(q));
  }, [sessions, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    // Focus on next tick so the modal has mounted.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
        return;
      }
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setHighlight((h) => Math.min(filtered.length - 1, h + 1));
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        const choice = filtered[highlight];
        if (choice) {
          void switchSession(choice.id);
          onClose();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, filtered, highlight, onClose, switchSession]);

  if (!open) return null;

  return (
    <div
      className="cw-modal-backdrop"
      role="dialog"
      aria-label="Switch session"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cw-modal cw-modal-switcher">
        <input
          ref={inputRef}
          className="cw-switcher-input"
          placeholder="Switch session…"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setHighlight(0);
          }}
        />
        <ul className="cw-switcher-list">
          {filtered.length === 0 && (
            <li className="cw-row muted">No matches.</li>
          )}
          {filtered.map((s, idx) => (
            <li
              key={s.id}
              className={`cw-row ${idx === highlight ? "active" : ""}`}
              onMouseEnter={() => setHighlight(idx)}
              onClick={() => {
                void switchSession(s.id);
                onClose();
              }}
            >
              <span className="cw-row-title">{s.title || s.id}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}