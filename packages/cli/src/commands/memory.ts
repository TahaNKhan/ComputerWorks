// packages/cli/src/commands/memory.ts
// T6.2 — memory subcommands.

import { createFileMemoryProvider } from "@computerworks/memory-files";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

function resolveRoot(): string {
  return process.env.COMPUTERWORKS_MEMORY_ROOT ?? `${homedir()}/.computerworks/memory`;
}

export async function run(subCmd: string | undefined, args: string[]): Promise<void> {
  const provider = createFileMemoryProvider({ root: resolveRoot() });

  switch (subCmd) {
    case "ls": {
      await cmdLs(provider);
      break;
    }
    case "show": {
      await cmdShow(provider, args);
      break;
    }
    case "edit": {
      await cmdEdit(provider, args);
      break;
    }
    default: {
      console.error(`Unknown memory subcommand: ${subCmd}`);
      console.error(`Usage:`);
      console.error(`  computerworks memory ls`);
      console.error(`  computerworks memory show <name>`);
      console.error(`  computerworks memory edit <name>`);
      process.exit(1);
    }
  }
}

async function cmdLs(provider: ReturnType<typeof createFileMemoryProvider>): Promise<void> {
  const notes = await provider.list();
  if (notes.length === 0) {
    console.log("No memory notes found.");
    return;
  }
  for (const note of notes) {
    const preview = note.preview.length > 60
      ? note.preview.slice(0, 60) + "…"
      : note.preview;
    console.log(`${note.name}  ${preview}`);
  }
}

async function cmdShow(
  provider: ReturnType<typeof createFileMemoryProvider>,
  args: string[],
): Promise<void> {
  const [name] = args;
  if (!name) {
    console.error("Usage: computerworks memory show <name>");
    process.exit(1);
  }
  try {
    const content = await provider.read(name);
    console.log(content);
  } catch (err) {
    if ((err as Error).message.includes("not found")) {
      console.error(`Memory note not found: ${name}`);
      process.exit(1);
    }
    throw err;
  }
}

async function cmdEdit(
  provider: ReturnType<typeof createFileMemoryProvider>,
  args: string[],
): Promise<void> {
  const [name] = args;
  if (!name) {
    console.error("Usage: computerworks memory edit <name>");
    process.exit(1);
  }

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  let existingContent: string;
  try {
    existingContent = await provider.read(name);
  } catch {
    existingContent = "";
  }

  // Write to a temp file
  const tmp = await globalThis.Bun?.file("/tmp/.computerworks-edit.tmp");
  const tmpPath = `/tmp/.computerworks-edit-${process.pid}.md`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(tmpPath, existingContent, "utf8");

  // Spawn editor
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [tmpPath], {
      stdio: "inherit",
      env: { ...process.env },
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Editor exited with code ${code}`));
    });
    child.on("error", reject);
  });

  // Read back and save
  const { readFileSync } = await import("node:fs");
  const newContent = readFileSync(tmpPath, "utf8");
  await provider.write(name, newContent);
  console.log(`Saved: ${name}`);
}
