// Public surface of @computerworks/core.
export * from "./types.js";
export * from "./provider.js";
export * from "./providers/scripted.js";
export { createAnthropicProvider } from "./providers/anthropic.js";
export type { AnthropicProviderConfig, AnthropicProvider } from "./providers/anthropic.js";

// Re-export zod for downstream packages that want to type their
// tool input schemas against the core ToolDefinition contract.
export { z } from "zod";
