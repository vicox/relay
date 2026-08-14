// A CLI that behaves like an agent without being one: it reads a prompt on
// stdin and emits scripted JSONL. Every turn Relay can encounter is reachable
// from these flags, so the fast suite never calls a model.
//
//   --id <id>          report a native session id (omit it to stay unbound)
//   --text <s>         say something (repeatable)
//   --echo-stdin       say exactly what arrived on stdin
//   --replay <file>    write a recorded capture back out verbatim
//   --chunk <n>        write the replay in n-byte pieces, splitting lines
//   --noise            emit lines that are not JSON, and JSON Relay ignores
//   --stderr <s>       complain on stderr
//   --sleep <ms>       stay busy for a while before exiting
//   --hang             never exit on your own
//   --ignore-sigint    make Relay escalate to SIGKILL
//   --exit-on-sigint <n>  exit cleanly when interrupted, the way Claude does
//   --exit <n>         exit with this code

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

function values(name: string): string[] {
  return argv.flatMap((arg, at) => (arg === `--${name}` ? [argv[at + 1]] : []));
}

function say(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const stdin: string = await new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => resolve(text));
});

if (flag("ignore-sigint")) process.on("SIGINT", () => {});

// Claude exits 0 after SIGINT, so an exit code cannot tell Relay whether a turn
// was interrupted. This is how that case is reproduced without a model.
const onSigint = value("exit-on-sigint");
if (onSigint !== undefined) process.on("SIGINT", () => process.exit(Number(onSigint)));

const id = value("id");
if (id) say({ type: "session", id });

if (flag("noise")) {
  process.stdout.write("not json at all\n");
  say({ type: "something-relay-has-never-heard-of", text: "ignored" });
  process.stdout.write("\n");
}

for (const text of values("text")) say({ type: "text", text });
if (flag("echo-stdin")) say({ type: "text", text: stdin });

const replay = value("replay");
if (replay) {
  const capture = readFileSync(replay, "utf8");
  const chunk = Number(value("chunk") ?? 0);
  if (chunk > 0) {
    for (let at = 0; at < capture.length; at += chunk) {
      process.stdout.write(capture.slice(at, at + chunk));
    }
  } else {
    process.stdout.write(capture);
  }
}

const complaint = value("stderr");
if (complaint) process.stderr.write(`${complaint}\n`);

const sleep = Number(value("sleep") ?? 0);
if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));

if (flag("hang")) setInterval(() => {}, 1000);
else process.exit(Number(value("exit") ?? 0));
