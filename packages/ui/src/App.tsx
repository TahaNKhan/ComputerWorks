// packages/ui/src/App.tsx
// Composition root. Wires the layout, the SSE subscription, and the
// global keyboard shortcuts (Cmd/Ctrl+K session switcher,
// Cmd/Ctrl+, settings, Esc cancel).
// T10 — Adds a mobile drawer for the SessionList. On narrow screens
//        the sidebar is hidden behind a hamburger button; on tablet+
//        it stays inline.

import React, { useEffect, useState } from "react";
import { SessionList } from "./components/SessionList.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { Settings } from "./components/Settings.js";
import { SessionSwitcher } from "./components/SessionSwitcher.js";
import { useSessionsStore } from "./store/sessions.js";
import { subscribeToSession } from "./store/stream.js";
import { useShortcut, shortcutLabel } from "./lib/shortcuts.js";

export function App(): JSX.Element {
  const errorMessage = useSessionsStore((s) => s.errorMessage);
  const loadSessions = useSessionsStore((s) => s.loadSessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const status = useSessionsStore((s) => s.status);
  const cancelTurn = useSessionsStore((s) => s.cancelTurn);

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

  useEffect(() => {
    void loadSessions().then(() => {
      // T12.1 — After the session list settles, apply `?session=<id>`
      // so the active session matches the URL. This makes the page
      // bookmarkable + shareable and lets the browser back button
      // walk the session history (the popstate bridge in
      // `store/sessions.ts` does the reverse direction).
      void useSessionsStore.getState().initFromUrl();
    });
  }, [loadSessions]);

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