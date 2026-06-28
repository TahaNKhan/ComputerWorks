// packages/ui/src/App.tsx
// T14.3 — Composition root. Thin: header + main + modals.
//
// No event-handling logic, no store mutation, no SSE wiring (that's
// the store's job). Components are presentational — each one reads
// state from the store and dispatches via actions.
//
// The header has a mobile drawer (hamburger) for the SessionList
// and a global settings button. On tablet+ the SessionList is
// always inline.

import React, { useEffect, useState } from "react";
import { SessionList } from "./components/SessionList.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { Settings } from "./components/Settings.js";
import { SessionSwitcher } from "./components/SessionSwitcher.js";
import { useSessionsStore } from "./store/sessions.js";
import { stopActiveStream } from "./store/stream.js";
import {
  getSessionFromUrl,
  setSessionInUrl,
  subscribeUrlChange,
} from "./lib/router.js";
import { useShortcut, shortcutLabel } from "./lib/shortcuts.js";

export function App(): JSX.Element {
  const errorMessage = useSessionsStore((s) => s.errorMessage);
  const loadSessions = useSessionsStore((s) => s.loadSessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const sessions = useSessionsStore((s) => s.sessions);
  const status = useSessionsStore((s) => s.status);
  const cancelTurn = useSessionsStore((s) => s.cancelTurn);
  const switchSession = useSessionsStore((s) => s.switchSession);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Auto-close the mobile drawer whenever the active session changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [activeSessionId]);

  // Load the session list once on mount.
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // URL-driven session selection. On mount + after loadSessions:
  // if the URL has `?session=<id>`, switch to that session. If the
  // id doesn't exist, clear the URL and show a banner.
  useEffect(() => {
    const fromUrl = getSessionFromUrl();
    if (!fromUrl) {
      setSessionInUrl(activeSessionId);
      return;
    }
    if (sessions.some((s) => s.id === fromUrl)) {
      void switchSession(fromUrl);
    } else {
      setSessionInUrl(null);
      useSessionsStore.setState({
        errorMessage: `Session not found: ${fromUrl}`,
      });
    }
    // We intentionally exclude `activeSessionId` — it would cause
    // an infinite loop because switchSession updates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, loadSessions, switchSession]);

  // Browser back/forward — popstate switches sessions.
  useEffect(() => {
    const unsub = subscribeUrlChange((id: string | null) => {
      void switchSession(id);
    });
    return unsub;
  }, [switchSession]);

  // Global shortcuts.
  useShortcut("switch-session", () => setSwitcherOpen(true));
  useShortcut("open-settings", () => setSettingsOpen(true));
  useShortcut("cancel", () => {
    if (activeSessionId && (status === "streaming" || status === "connecting" || status === "awaiting-approval")) {
      void cancelTurn(activeSessionId);
    } else {
      // Always cancel any in-flight stream, even if the status
      // check above didn't fire (e.g. connecting just transitioned).
      stopActiveStream();
    }
    setSwitcherOpen(false);
    setSettingsOpen(false);
    setDrawerOpen(false);
  });

  return (
    <div className="cw-app">
      <header className="cw-header">
        <button
          className="cw-menu-trigger"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open sessions"
          title="Sessions"
        >
          ☰
        </button>
        <span className="cw-brand">ComputerWorks</span>
        <span className="cw-spacer" />
        <button
          className="cw-switcher-trigger"
          onClick={() => setSwitcherOpen(true)}
          title={`Switch session (${shortcutLabel("switch-session")})`}
          aria-label="Switch session"
        >
          ⌕
        </button>
        <button
          className="cw-settings-trigger"
          onClick={() => setSettingsOpen(true)}
          title={`Settings (${shortcutLabel("open-settings")})`}
          aria-label="Settings"
        >
          ⚙
        </button>
        <ThemeToggle />
      </header>
      <main className="cw-main">
        <SessionList open={drawerOpen} onClose={() => setDrawerOpen(false)} />
        <section className="cw-chat-pane">
          {activeSessionId ? (
            <>
              <ChatView />
              <Composer />
            </>
          ) : (
            <div className="cw-empty">
              <p>Select a session from the left, or click <b>+ New</b>.</p>
            </div>
          )}
        </section>
      </main>
      {drawerOpen && (
        <div
          className="cw-drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      {errorMessage && (
        <div role="alert" className="cw-error-banner">
          {errorMessage}
        </div>
      )}
      <SessionSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}