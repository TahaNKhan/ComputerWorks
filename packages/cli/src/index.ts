// packages/cli/src/index.ts
// T6.1 — CLI entry point.
// 
// Usage:
//   computerworks serve [--port=4747] [--host=127.0.0.1] [--verbose]
//   computerworks sessions list
//   computerworks sessions delete <id>
//   computerworks sessions export <id>
//   computerworks memory ls
//   computerworks memory show <name>
//   computerworks memory edit <name>

import { startServer } from "./serve.js";
import * as sessionsCmd from "./commands/sessions.js";
import * as memoryCmd from "./commands/memory.js";

async function main() {
  const [, , cmd, subCmd, ...args] = process.argv;

  switch (cmd) {
    case "serve": {
      await startServer();
      break;
    }
    case "sessions": {
      await sessionsCmd.run(subCmd, args);
      break;
    }
    case "memory": {
      await memoryCmd.run(subCmd, args);
      break;
    }
    default: {
      console.error(`Unknown command: ${cmd}`);
      console.error(`Usage:`);
      console.error(`  computerworks serve [--port=4747] [--host=127.0.0.1] [--verbose]`);
      console.error(`  computerworks sessions list`);
      console.error(`  computerworks sessions delete <id>`);
      console.error(`  computerworks sessions export <id>`);
      console.error(`  computerworks memory ls`);
      console.error(`  computerworks memory show <name>`);
      console.error(`  computerworks memory edit <name>`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
