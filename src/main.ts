#!/usr/bin/env node
// One entry point, two front doors: `relay serve` is the process that owns the
// turns, everything else is a client of it.

import { Core } from "./core.ts";
import { DEFAULT_PORT, MCP_PATH, serve } from "./mcp.ts";
import { runClient, usage } from "./client.ts";

const argv = process.argv.slice(2);
const at = argv.indexOf("--port");
const port = at === -1 ? Number(process.env.RELAY_PORT ?? DEFAULT_PORT) : Number(argv[at + 1]);

if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
  process.stdout.write(usage());
} else if (argv[0] === "serve") {
  const core = new Core();
  await serve(core, port);
  process.stderr.write(`relay serving MCP on http://127.0.0.1:${port}${MCP_PATH} for ${core.agents().join(", ")}\n`);
} else {
  process.exitCode = await runClient(argv, port);
}
