// The CLI, for the agents that already have a shell.
//
// It is an MCP client against the same endpoint ChatGPT uses, so there is one
// wire protocol and one description of the API. Nothing here knows anything
// about Relay that the tool list does not say.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MCP_PATH } from "./mcp.ts";

type Json = Record<string, unknown>;

class CliError extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export async function runClient(argv: string[], port: number): Promise<number> {
  const [command, ...rest] = argv;
  const { words, flags } = parseArgs(rest);
  const client = new Client({ name: "relay-cli", version: "0.1.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`)));
  } catch {
    process.stderr.write(`no relay on port ${port} -- start one with \`relay serve\`\n`);
    return 1;
  }

  try {
    switch (command) {
      case "start": {
        const started = await call(client, "start", { agent: need(words[0], "agent"), cwd: flags.get("cwd") });
        process.stdout.write(`${started.session}\n`);
        break;
      }

      case "send": {
        const [agent, session] = await address(client, words);
        await call(client, "send", { agent, session, text: message(words, 2), from: sender(flags) });
        break;
      }

      case "read": {
        const [agent, session] = await address(client, words);
        const reply = await call(client, "read", {
          agent,
          session,
          after: Number(flags.get("after") ?? 0),
          wait: flags.has("wait") ? 30_000 : 0,
        });
        if (reply.text) process.stdout.write(`${String(reply.text).replace(/\n?$/, "\n")}`);
        break;
      }

      case "ask": {
        // Sugar over send + read: no operation of its own, just the loop every
        // calling agent would otherwise have to write.
        const [agent, session] = await address(client, words);
        const sent = await call(client, "send", { agent, session, text: message(words, 2), from: sender(flags) });
        let after = Number(sent.cursor ?? 0);
        for (;;) {
          const reply = await call(client, "read", { agent, session, after, wait: 30_000 });
          if (reply.text) process.stdout.write(String(reply.text));
          after = Number(reply.cursor ?? after);
          if (reply.state === "idle") break;
        }
        process.stdout.write("\n");
        const outcome = (await call(client, "status", { agent, session })).lastTurn as Json | null;
        if (outcome && outcome.ok === false) {
          process.stderr.write(`turn failed: ${String(outcome.error)}\n`);
          return 1;
        }
        break;
      }

      case "interrupt": {
        const [agent, session] = await address(client, words);
        await call(client, "interrupt", { agent, session });
        break;
      }

      case "status": {
        const [agent, session] = await address(client, words);
        process.stdout.write(`${JSON.stringify(await call(client, "status", { agent, session }), null, 2)}\n`);
        break;
      }

      case "forget": {
        const [agent, session] = await address(client, words);
        await call(client, "forget", { agent, session });
        break;
      }

      case "list": {
        const sessions = (await call(client, "list", {})) as unknown as Json[];
        for (const entry of sessions) {
          const bound = entry.nativeId ? String(entry.nativeId) : "unbound";
          process.stdout.write(`${entry.agent}/${entry.session}  ${entry.state}  ${bound}\n`);
        }
        break;
      }

      default:
        process.stderr.write(usage());
        return 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await client.close();
  }

  return 0;
}

async function call(client: Client, tool: string, args: Json): Promise<Json> {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = ((result.content ?? []) as { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("");
  const payload = text ? (JSON.parse(text) as Json) : {};
  if (result.isError) throw new CliError(String(payload.error), String(payload.message));
  return payload;
}

/** A session id may be given as any unique prefix, which is worth a lookup. */
async function address(client: Client, args: string[]): Promise<[string, string]> {
  const agent = need(args[0], "agent");
  const prefix = need(args[1], "session");
  if (prefix.length === 36) return [agent, prefix];

  const sessions = (await call(client, "list", {})) as unknown as Json[];
  const matches = sessions.filter(
    (entry) => entry.agent === agent && String(entry.session).startsWith(prefix),
  );
  if (matches.length === 0) throw new CliError("unknown_session", `no ${agent} session starting ${prefix}`);
  if (matches.length > 1) throw new CliError("bad_request", `${prefix} matches ${matches.length} sessions`);
  return [agent, String(matches[0].session)];
}

function message(args: string[], at: number): string {
  const text = args.slice(at).join(" ");
  if (!text) throw new CliError("bad_request", "a message needs text");
  return text;
}

/**
 * The flags that take a value. Knowing which ones do is the whole point: a
 * flag's value is not a word of the message. Removing `--from` while leaving
 * what follows it among the words would append transport metadata to the text
 * and hand it to the agent, which is exactly what must never happen.
 *
 * `port` is here because `relay serve --port` and the client commands are read
 * from the same argv.
 */
const VALUED_FLAGS = new Set(["from", "cwd", "after", "port"]);

function parseArgs(argv: string[]): { words: string[]; flags: Map<string, string> } {
  const words: string[] = [];
  const flags = new Map<string, string>();
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const name = arg.slice(2);
    flags.set(name, VALUED_FLAGS.has(name) ? (argv[++at] ?? "") : "");
  }
  return { words, flags };
}

function sender(flags: Map<string, string>): string | undefined {
  return flags.get("from") || process.env.RELAY_FROM;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new CliError("bad_request", `missing ${what}`);
  return value;
}

export function usage(): string {
  return [
    "relay serve [--port 7717]",
    "",
    "relay start <agent> [--cwd <dir>]",
    "relay send <agent> <session> <text...> [--from <who>]",
    "relay read <agent> <session> [--after <n>] [--wait]",
    "relay ask <agent> <session> <text...> [--from <who>]",
    "relay status <agent> <session>",
    "relay interrupt <agent> <session>",
    "relay forget <agent> <session>",
    "relay list",
    "",
    "A session id may be any unique prefix. --from defaults to $RELAY_FROM.",
    "",
  ].join("\n");
}
