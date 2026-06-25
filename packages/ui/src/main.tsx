// packages/ui/src/main.tsx
// T7.1 — Browser entry point. Vite picks this up from index.html.

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found in index.html");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);