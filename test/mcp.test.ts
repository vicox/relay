// The MCP front door, driven by a real MCP client over HTTP against a Core
// backed by the fake agent. No models, and no second model of the API: the tool
// list is asserted against the operations it is generated from.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { Core } from "../src/core.ts";
import { MCP_PATH, OPERATIONS, serve } from "../src/mcp.ts";
import { fake, putFakeOnPath, tempHome } from "./fake.ts";

putFakeOnPath();

type Json = Record<string, unknown>;

async function relay(agentArgv: string[]) {
  const core = new Core({ home: tempHome(), agents: [fake(agentArgv)], log: () => {}, killAfterMs: 100 });
  // Port 0 lets the OS pick, so tests never collide with a running relay.
  const http = await serve(core, 0);
  const port = (http.address() as { port: number }).port;

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`)));

  const call = async (tool: string, args: Json = {}): Promise<Json> => {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = ((result.content ?? []) as { text?: string }[]).map((block) => block.text ?? "").join("");
    const payload = text ? (JSON.parse(text) as Json) : {};
    if (result.isError) throw Object.assign(new Error(String(payload.message)), { code: payload.error });
    return payload;
  };

  const close = async () => {
    await client.close();
    await new Promise<void>((done) => (http as Server).close(() => done()));
  };

  return { call, client, close };
}

test("the tool list is the operation table, and nothing else", async () => {
  const { client, close } = await relay(["--id", "n"]);
  try {
    const { tools } = await client.listTools();

    assert.equal(tools.length, 7);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["forget", "interrupt", "list", "read", "send", "start", "status"],
    );
    assert.deepEqual(
      tools.map((tool) => tool.name),
      OPERATIONS.map((operation) => operation.name),
      "generated from one table, so it cannot drift",
    );

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} explains itself`);
      assert.equal(tool.inputSchema.type, "object");
    }

    // The two rules a caller cannot infer are in the descriptions.
    const send = tools.find((tool) => tool.name === "send");
    assert.match(String(send?.description), /one turn|busy/i);
    const read = tools.find((tool) => tool.name === "read");
    assert.match(String(read?.description), /idle/i);
  } finally {
    await close();
  }
});

test("a session runs end to end over MCP", async () => {
  const { call, close } = await relay(["--id", "native-mcp", "--text", "the answer"]);
  try {
    const started = await call("start", { agent: "fake" });
    assert.equal(started.state, "idle");
    assert.equal(started.nativeId, null);
    const session = String(started.session);

    const sent = await call("send", { agent: "fake", session, text: "the question", from: "chatgpt" });
    assert.equal(sent.state, "busy");

    let cursor = Number(sent.cursor);
    let text = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const reply = await call("read", { agent: "fake", session, after: cursor, wait: 2000 });
      text += String(reply.text);
      cursor = Number(reply.cursor);
      if (reply.state === "idle") break;
    }
    assert.equal(text, "the answer");

    const status = await call("status", { agent: "fake", session });
    assert.equal(status.nativeId, "native-mcp");
    assert.deepEqual((status.lastTurn as Json).ok, true);
    assert.equal((status.lastTurn as Json).from, "chatgpt");

    const listed = (await call("list", {})) as unknown as Json[];
    assert.equal(listed.length, 1);

    await call("forget", { agent: "fake", session });
    assert.deepEqual((await call("list", {})) as unknown as Json[], []);
  } finally {
    await close();
  }
});

test("errors arrive as their documented codes", async () => {
  const { call, close } = await relay(["--id", "n", "--text", "x", "--sleep", "200"]);
  try {
    await assert.rejects(call("start", { agent: "codex" }), (error: { code?: unknown }) => error.code === "unknown_agent");
    await assert.rejects(
      call("status", { agent: "fake", session: "nope" }),
      (error: { code?: unknown }) => error.code === "unknown_session",
    );

    const { session } = await call("start", { agent: "fake" });
    await call("send", { agent: "fake", session, text: "first" });
    await assert.rejects(
      call("send", { agent: "fake", session: String(session), text: "second" }),
      (error: { code?: unknown }) => error.code === "busy",
    );

    // Unknown tools are refused the same way, not with a protocol error.
    await assert.rejects(call("orchestrate", {}), (error: { code?: unknown }) => error.code === "bad_request");
  } finally {
    await close();
  }
});

test("interrupt over MCP returns the session to idle", async () => {
  const { call, close } = await relay(["--id", "n", "--text", "said before hanging", "--hang"]);
  try {
    const { session } = await call("start", { agent: "fake" });
    await call("send", { agent: "fake", session: String(session), text: "go" });
    await call("read", { agent: "fake", session: String(session), wait: 2000 });

    const outcome = await call("interrupt", { agent: "fake", session: String(session) });
    assert.deepEqual(outcome, { state: "idle", interrupted: true });

    const status = await call("status", { agent: "fake", session: String(session) });
    assert.equal(status.state, "idle");
    assert.equal((status.lastTurn as Json).ok, false);
    assert.equal((status.lastTurn as Json).error, "interrupted");
    // Output produced before the interrupt is still readable.
    const reply = await call("read", { agent: "fake", session: String(session), after: 0 });
    assert.equal(reply.text, "said before hanging");
  } finally {
    await close();
  }
});

test("anything that is not the MCP endpoint is a 404", async () => {
  const core = new Core({ home: tempHome(), agents: [fake(["--id", "n"])], log: () => {} });
  const http = await serve(core, 0);
  const port = (http.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions`);
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as Json).error, "bad_request");
  } finally {
    await new Promise<void>((done) => http.close(() => done()));
  }
});
