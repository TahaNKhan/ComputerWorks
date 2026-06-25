// packages/ui/src/components/Settings.tsx
// T7.10 — Minimal settings dialog. Currently exposes a model picker
// for the active session.
//
// Opened via Cmd/Ctrl+, or by clicking the gear in the header.

import React, { useEffect, useState } from "react";
import { useSessionsStore } from "../store/sessions.js";
import { patchSession } from "../api/client.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

const MODEL_OPTIONS = [
  "claude-sonnet-4-6",
  "MiniMax-M3",
] as const;

export function Settings({ open, onClose }: Props): JSX.Element | null {
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const sessions = useSessionsStore((s) => s.sessions);
  const active = sessions.find((s) => s.id === activeId);
  const [draftModel, setDraftModel] = useState<string>(active?.model ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftModel(active?.model ?? "");
    setError(null);
  }, [active?.id, active?.model, open]);

  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function save(): Promise<void> {
    if (!active) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await patchSession(active.id, { model: draftModel });
      useSessionsStore.setState((s) => ({
        sessions: s.sessions.map((x) => (x.id === updated.id ? updated : x)),
      }));
      onClose();
    } catch (err) {
      setError((err as Error).message ?? "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cw-modal-backdrop" role="dialog" aria-label="Settings">
      <div className="cw-modal">
        <header className="cw-modal-header">
          <h2>Settings</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="cw-modal-body">
          {!active ? (
            <p>Select a session first.</p>
          ) : (
            <>
              <label className="cw-field">
                <span>Model</span>
                <select
                  value={draftModel}
                  onChange={(e) => setDraftModel(e.currentTarget.value)}
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <p className="cw-field-help">
                Applies to the active session on the next turn.
              </p>
            </>
          )}
          {error && <div className="cw-error">{error}</div>}
        </div>
        <footer className="cw-modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button
            className="cw-primary"
            disabled={!active || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}