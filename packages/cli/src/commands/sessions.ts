// packages/cli/src/commands/sessions.ts
// T6.2 — sessions subcommands.

import { SessionStore } from "@computerworks/server";
import type { Message } from "@computerworks/core";

function resolveRoot(): string {
  // Allow override via environment variable
  return process.env.COMPUTERWORKS_SESSIONS_ROOT ?? "";
}

export async function run(subCmd: string | undefined, args: string[]): Promise<void> {
  const store = new SessionStore({ root: resolveRoot() });

  switch (subCmd) {
    case "list": {
      await cmdList(store);
      break;
    }
    case "delete": {
      await cmdDelete(store, args);
      break;
    }
    case "export": {
      await cmdExport(store, args);
      break;
    }
    default: {
      console.error(`Unknown sessions subcommand: ${subCmd}`);
      console.error(`Usage:`);
      console.error(`  computerworks sessions list`);
      console.error(`  computerworks sessions delete <id>`);
      console.error(`  computerworks sessions export <id>`);
      process.exit(1);
    }
  }
}

async function cmdList(store: SessionStore): Promise<void> {
  const sessions = await store.list();
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }
  for (const s of sessions) {
    const title = s.title || "(untitled)";
    console.log(`${s.id}  ${title}  (last active: ${s.updatedAt})`);
  }
}

async function cmdDelete(store: SessionStore, args: string[]): Promise<void> {
  const [id] = args;
  if (!id) {
    console.error("Usage: computerworks sessions delete <id>");
    process.exit(1);
  }
  const existing = await store.get(id);
  if (!existing) {
    console.error(`Session not found: ${id}`);
    process.exit(1);
  }
  await store.delete(id);
  console.log(`Deleted session: ${id}`);
}

async function cmdExport(store: SessionStore, args: string[]): Promise<void> {
  const [id] = args;
  if (!id) {
    console.error("Usage: computerworks sessions export <id>");
    process.exit(1);
  }
  const meta = await store.get(id);
  if (!meta) {
    console.error(`Session not found: ${id}`);
    process.exit(1);
  }
  const messages = await store.getMessages(id);

  console.log(`# ${meta.title || "Untitled Session"}\n`);
  console.log(`**ID**: ${meta.id}`);
  console.log(`**Created**: ${meta.createdAt}`);
  console.log(`**Model**: ${meta.model}\n`);
  console.log("---\n");

  for (const msg of messages) {
    const role = msg.role;
    const content = typeof msg.content === "string"
      ? msg.content
      : msg.content.map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool_use") return `[tool: ${block.name}]`;
          if (block.type === "tool_result") return `[tool result]`;
          return JSON.stringify(block);
        }).join("\n");
    console.log(`- **${role}**: ${content}`);
  }
}
