// packages/ui/src/App.tsx
// T7.4 — Three-pane layout (sidebar | chat | composer).
//
// Layout matches §11.3 of DESIGN.MD:
//   - Left pane: SessionList (T7.4)
//   - Center pane: ChatView (T7.5) with MessageList
//   - Bottom: Composer (T7.5)
//
// The header hosts a model picker (T7.10) and theme toggle. T7.5–T7.10
// add more pieces; this file is the composition root.

import React, { useEffect } from "react";
import { SessionList } from "./components/SessionList.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { useSessionsStore } from "./store/sessions.js";

export function App(): JSX.Element {
  const errorMessage = useSessionsStore((s) => s.errorMessage);
  const loadSessions = useSessionsStore((s) => s.loadSessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  return (
    <div className="cw-app">
      <header className="cw-header">
        <span className="cw-brand">ComputerWorks</span>
        <span className="cw-spacer" />
        <ThemeToggle />
      </header>
      <main className="cw-main">
        <SessionList />
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
      {errorMessage && (
        <div role="alert" className="cw-error-banner">
          {errorMessage}
        </div>
      )}
    </div>
  );
}