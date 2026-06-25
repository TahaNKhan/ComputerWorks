// Public surface of @computerworks/server.
// Re-exports the smaller modules' public APIs. Some helpers (e.g.
// `expandHome`) appear in more than one module; we deliberately don't
// re-export the lower-level helpers to avoid name collisions. Use
// direct imports for those.

export * from "./config.js";
export * from "./session-store.js";
export * from "./audit.js";
export * from "./sse.js";
export * from "./interactive-approver.js";
export * from "./session-runtime.js";
export * from "./system-prompt.js";
export * from "./tools/index.js";
export * from "./app.js";
export * from "./start.js";
export type { ServerEvent } from "./sse.js";

// Re-export only the things that don't collide. Use direct imports
// for `expandHome`, `resolveConfigPath`, etc.
export { ConfigError } from "./config.js";
export { generateId } from "./session-store.js";
