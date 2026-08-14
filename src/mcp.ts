// The MCP front door, and the only wire protocol Relay speaks.
//
// The tool list is generated from one table of the operations, so it cannot
// drift into a second model. Tool descriptions carry the two rules a caller
// cannot infer -- one turn in flight per session, read until idle -- and
// nothing else.
//
// The listener binds loopback and does no ingress, no TLS and no auth: ChatGPT
// reaches it through OpenAI's Secure MCP Tunnel, which dials outward.
// See docs/architecture.md#reaching-relay-from-chatgpt.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { RelayError, type Core } from "./core.ts";

export const DEFAULT_PORT = 7717;
export const MCP_PATH = "/mcp";

type Json = Record<string, unknown>;

type Operation = {
  name: string;
  description: string;
  properties: Json;
  required: string[];
  call: (core: Core, args: Json) => unknown;
};

const string = { type: "string" };
const integer = { type: "integer" };

/** The five operations, plus the two that addressing requires. */
export const OPERATIONS: Operation[] = [
  {
    name: "start",
    description:
      "Allocate a session with an agent. Nothing runs and no conversation exists on the agent's side until the first send.",
    properties: { agent: string, cwd: string },
    required: ["agent"],
    call: (core, args) => core.start(str(args.agent), optional(args.cwd)),
  },
  {
    name: "send",
    description:
      "Give a session a message and start a turn. Returns immediately with the cursor this turn's output begins at. " +
      "Only one turn may be in flight per session: sending to a busy session fails with `busy` and is not queued. " +
      "`from` is optional provenance for humans reading Relay's log; the agent never sees it, so write any reply " +
      "address into the message text itself.",
    properties: { agent: string, session: string, text: string, from: string },
    required: ["agent", "session", "text"],
    call: (core, args) => core.send(str(args.agent), str(args.session), str(args.text), optional(args.from) ?? null),
  },
  {
    name: "read",
    description:
      "Read what an agent has said past `after`, waiting up to `wait` milliseconds for more (capped at 30000). " +
      "Pass the cursor that send returned to get only this turn's reply. Keep reading until state is `idle`: that " +
      "is how you know the turn is over.",
    properties: { agent: string, session: string, after: integer, wait: integer },
    required: ["agent", "session"],
    call: (core, args) => core.read(str(args.agent), str(args.session), num(args.after), num(args.wait)),
  },
  {
    name: "interrupt",
    description:
      "Kill the turn in flight. The session stays addressable and the next send resumes it. An interrupted turn is " +
      "recorded as unsuccessful.",
    properties: { agent: string, session: string },
    required: ["agent", "session"],
    call: (core, args) => core.interrupt(str(args.agent), str(args.session)),
  },
  {
    name: "status",
    description:
      "Where a session stands: idle or busy, its cursor, the id its agent's CLI uses, and how its last turn ended. " +
      "A failed or interrupted turn appears in lastTurn, never in the output.",
    properties: { agent: string, session: string },
    required: ["agent", "session"],
    call: (core, args) => core.status(str(args.agent), str(args.session)),
  },
  {
    name: "list",
    description: "Every session Relay can address, for a caller that has lost track of its own.",
    properties: {},
    required: [],
    call: (core) => core.list(),
  },
  {
    name: "forget",
    description:
      "Stop addressing a session and drop its output. The agent's own transcript is untouched. Refuses while a turn " +
      "is in flight.",
    properties: { agent: string, session: string },
    required: ["agent", "session"],
    call: (core, args) => core.forget(str(args.agent), str(args.session)),
  },
];

/**
 * Stateless: a fresh MCP server per request, over one shared Core. Relay's state
 * lives in the Core, so there is nothing for a protocol session to hold.
 */
function mcpServer(core: Core): Server {
  const server = new Server({ name: "relay", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: OPERATIONS.map((operation) => ({
      name: operation.name,
      description: operation.description,
      inputSchema: {
        type: "object",
        properties: operation.properties,
        required: operation.required,
        additionalProperties: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const operation = OPERATIONS.find((candidate) => candidate.name === request.params.name);
    if (!operation) return failure("bad_request", `no tool named ${request.params.name}`);
    try {
      const result = await operation.call(core, (request.params.arguments ?? {}) as Json);
      return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
    } catch (error) {
      if (error instanceof RelayError) return failure(error.code, error.message);
      throw error;
    }
  });

  return server;
}

function failure(code: string, message: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

export function serve(core: Core, port: number = DEFAULT_PORT): Promise<HttpServer> {
  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!request.url?.startsWith(MCP_PATH)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad_request", message: `nothing at ${request.url}` }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => void transport.close());
    void mcpServer(core)
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });

  return new Promise((resolve) => {
    // Loopback only. Reaching Relay from elsewhere is transport's job, not ours.
    http.listen(port, "127.0.0.1", () => resolve(http));
  });
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new RelayError("bad_request", `expected a string, got ${typeof value}`);
  return value;
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
