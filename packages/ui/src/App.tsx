// packages/ui/src/App.tsx
// Composition root. Wires the layout, the SSE subscription, and the
// global keyboard shortcuts (Cmd/Ctrl+K session switcher,
// Cmd/Ctrl+, settings, Esc cancel).
// T10 — Adds a mobile drawer for the SessionList. On narrow screens
//        the sidebar is hidden behind a hamburger button; on tablet+
//        it stays inline.
// T12.2 — Wires the URL to the active session. On mount, reads
//         `/s/:id` from the URL and switches to that session (if
//         it exists). Browser back/forward are wired via popstate.

import React, { useEffect, useState } from "react";
import { SessionList } from "./components/SessionList.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { Settings } from "./components/Settings.js";
import { SessionSwitcher } from "./components/SessionSwitcher.js";
import { useSessionsStore } from "./store/sessions.js";
import { subscribeToSession } from "./store/stream.js";
import {
  parseSessionIdFromUrl,
  replaceSessionInUrl,
  subscribeToRouteChanges,
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
  // The SessionList component fires this by changing the active id;
  // we listen here so the close happens regardless of how the switch
  // occurred (drawer click, switcher modal, etc).
  useEffect(() => {
    setDrawerOpen(false);
  }, [activeSessionId]);

  // Load the session list once on mount.
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // T12.2 — URL-driven session selection.
  // Two pieces:
  //   1. On mount + after loadSessions: if the URL is `/s/:id`,
  //      switch to that session. If the id doesn't exist (or the
  //      load failed), reset the URL to `/` and show a banner.
  //   2. Subscribe to popstate so browser back/forward switch sessions.
  // The dependency array below deliberately re-runs when `sessions`
  // changes (so a deep link arriving before the list loaded still
  // activates once the list arrives) and when `loadSessions` /
  // `switchSession` change identity (re-mount safety).
  useEffect(() => {
    const fromUrl = parseSessionIdFromUrl();
    if (!fromUrl) {
      // No deep link — replace the current URL so the next switch
      // gets a fresh history entry (no stale one from before mount).
      replaceSessionInUrl(activeSessionId);
      return;
    }
    if (sessions.some((s) => s.id === fromUrl)) {
      void switchSession(fromUrl);
    } else {
      // Id from URL doesn't exist; clear the URL and surface the error.
      replaceSessionInUrl(null);
      useSessionsStore.setState({
        errorMessage: `Session not found: ${fromUrl}`,
      });
    }
    // We intentionally exclude `activeSessionId` — it would cause
    // an infinite loop because switchSession updates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, loadSessions, switchSession]);

  useEffect(() => {
    const unsub = subscribeToRouteChanges((id) => {
      void switchSession(id);
    });
    return unsub;
  }, [switchSession]);

  // SSE: open (or replace) the stream whenever the active session changes.
  useEffect(() => {
    if (!activeSessionId) return;
    const ctrl = subscribeToSession(activeSessionId);
    return () => ctrl.stop();
  }, [activeSessionId]);

  // Global shortcuts.
  useShortcut("switch-session", () => setSwitcherOpen(true));
  useShortcut("open-settings", () => setSettingsOpen(true));
  useShortcut("cancel", () => {
    if (activeSessionId && (status === "streaming" || status === "connecting" || status === "awaiting-approval")) {
      void cancelTurn(activeSessionId);
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